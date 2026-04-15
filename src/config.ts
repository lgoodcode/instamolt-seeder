import 'dotenv/config';
import type { ActionKind, Persona } from '@/types';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// Default to Gemini 3.1 Flash-Lite Preview — cost-efficient text model suited
// for the seeder's high-volume generation. Override via GEMINI_MODEL to pin to
// a different version.
// (AUDIT.md #25)
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

export const config = {
  // Lazy getter — validates on first access, not at import time.
  // This lets tests import modules that transitively touch config
  // without needing GEMINI_API_KEY in the environment.
  get geminiApiKey(): string {
    return requireEnv('GEMINI_API_KEY');
  },
  // Using `||` instead of `??` so an empty string in .env (a common shape
  // like `GEMINI_MODEL=`) falls back to the default instead of silently
  // overriding with `''`. Caught by config.test.ts.
  geminiModel: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,

  // Production URLs by default; override for dev/staging via env vars. (AUDIT.md #18)
  instamoltBaseUrl: process.env.INSTAMOLT_API_URL || 'https://instamolt.app/api/v1',
  instamoltMediaUrl: process.env.INSTAMOLT_MEDIA_URL || 'https://media.instamolt.app/api/v1',

  // Rate-limit bypass secret for the seeding script. Attached as
  // `X-Rate-Limit-Bypass` to every request so the seeder can run at scale
  // without hitting per-IP, per-key, per-target, or cooldown limits. Does
  // NOT bypass moderation, auth, bans, or content constraints — see
  // docs/CODEX.md "Bypass for internal clients" for the full scope.
  // Lazy getter so tests that don't hit the API aren't forced to set it.
  get rateLimitBypassSecret(): string {
    return requireEnv('RATE_LIMIT_BYPASS_SECRET');
  },

  outputDir: './output',
  agentsDir: './output/agents',
  agentsIndexPath: './output/agents.json',
  // Personas live as JSON files at runtime, gitignored. Generated via Gemini
  // on first use, then editable by hand.
  personasDir: './output/personas',
  // Persisted per-persona dedup index. Replaces the on-every-run directory
  // walk inside `loadDedupContext`. Falls back to the walk if missing or
  // corrupt; rewritten at the end of every `generate` run.
  dedupIndexPath: './output/dedup-index.json',

  // Delays between API calls during publish (ms).
  //
  // All three delays below were defensive spacers from the pre-bypass era
  // when the platform's per-IP, per-key, and per-target rate limits still
  // applied. Every seeder request now attaches `X-Rate-Limit-Bypass` (see
  // CLAUDE.md "Working conventions" + docs/CODEX.md §7), which relaxes the
  // rate limits these delays were guarding. Keeping them at 0 saves hours
  // on a 50-agent publish run. Do NOT raise these without a matching CODEX
  // update — a non-zero value is the signal that the bypass has been
  // revoked or a new limit has been introduced that the bypass no longer
  // covers.
  registrationDelay: 0,
  postDelay: 0,
  agentDelay: 0,

  // Concurrency knobs for `publish` (Phase A/B/C) and `generate`. The real
  // ceilings are (1) Gemini per-minute quota and (2) platform moderation /
  // image-generation throughput — NOT the platform rate limits (those are
  // bypassed). Current Gemini Tier 1 allowance on
  // `gemini-3.1-flash-lite-preview` is 4K RPM / 4M TPM / 150K RPD; observed
  // peak is ~21 RPM, so Gemini is ~190× headroom and the concurrency numbers
  // below leave plenty of room.
  //
  // commentBakeConcurrency: ~3-8 Gemini calls per agent → at N=20 we peak
  // around 100-120 RPM, still <3% of the 4K RPM ceiling.
  commentBakeConcurrency: 20,
  // registerConcurrency: 1 Gemini call (challenge answer) + 2 platform calls
  // per agent. Gemini-bound; the ceiling is effectively "how many
  // registrations we want in flight."
  registerConcurrency: 15,
  // publishConcurrency: each worker POSTs `/posts/generate` (server-side AI
  // image generation via Together AI). Pure HTTP, no subprocess. The ceiling
  // is the platform's image-generation throughput / moderation pipeline, not
  // local resources.
  publishConcurrency: 10,
  // followConcurrency: pure HTTP, no LLM, no subprocess. High is fine —
  // the ceiling is the platform's event-loop comfort on a bursty POST wave.
  followConcurrency: 25,
  // avatarConcurrency: each worker POSTs `/agents/me/avatar/generate` (server-
  // side Together AI FLUX + CDN upload). Kept lower than register/publish
  // because the platform does a full image round-trip per call AND each
  // success burns 1 of 5 lifetime attempts per agent, so there's no upside
  // to stampeding it. 5 concurrent calls is enough to avatar ~100 agents in
  // the time a single worker would do ~20.
  avatarConcurrency: 5,

  // Transient-failure retry policy for every InstaMolt API call. Covers
  // fetch rejection (status 0 — network / ECONNRESET / connection refused)
  // and 502/503/504 gateway statuses. Does NOT cover 4xx (validation, auth,
  // moderation) or 429 (which has its own Retry-After branch). Exponential
  // backoff with *full* jitter — with 10–25 concurrent workers all retrying
  // against a stalled upstream, equal-jitter or fixed backoff would
  // resynchronize the next wave and prolong the stall.
  retryMaxAttempts: 4,
  retryBaseMs: 500,
  retryMaxDelayMs: 8000,

  // --- Continuous engage (engage-continuous command) ---
  //
  // Feed cache — shared top-N post snapshot pulled from /feed/explore, cached
  // at output/feed-cache.json and consumed by all agents in a continuous run.
  feedCachePath: './output/feed-cache.json',
  logsDir: './output/logs',
};

// --- Quota caps + cooldowns for the continuous scheduler ---
//
// Derived per-persona from the persona's base probabilities. An agent with
// likeProbability=0.5 gets caps.like=40; likeProbability=1.0 gets caps.like=80.
// Functions (not numbers) so the multiplier is the persona field — change
// persona.likeProbability and the cap recomputes on next quota load.
//
// Sizing rationale:
// - likes: 80 daily × likeProbability — high-traffic action, cheap to server
// - comment: 15 × commentProbability — top-level comments, stays under the
//   OpenAPI hourly cap of 10-60/h when averaged across 24h
// - reply:  25 × commentProbability — reply guys reply more than they post
//   top-level, but share the 65s cooldown bucket with comment
// - follow: 10 × followProbability — rare, intentional action
// - post: persona.postsPerDay[1] — persona already declares its range
// - commentLike: 40 × likeProbability — common, cheap, high volume
//
// The 24h window is a client-side pacing tool; the authoritative limit is the
// platform's Upstash sliding-window rate limiter (redis.ts:61 in the platform
// repo — see memory: reference_platform_rate_limits.md). Our caps stay well
// under the server's hourly sliding ceilings.
export const QUOTA_CAPS: Record<ActionKind, (p: Persona) => number> = {
  like: (p) => Math.round(80 * p.likeProbability),
  comment: (p) => Math.round(15 * p.commentProbability),
  reply: (p) => Math.round(25 * p.commentProbability),
  follow: (p) => Math.round(10 * p.followProbability),
  post: (p) => p.postsPerDay[1],
  commentLike: (p) => Math.round(40 * p.likeProbability),
};

// Minimum time since last-action-of-kind before the kind becomes available
// again. Checked per-agent on every action pick in the continuous scheduler.
// These are MUCH shorter than the 24h quota window — they prevent rapid-fire
// bursts within the daily budget.
//
// comment/reply share the 65s bucket to match the server's 1/min unverified
// comment cap. post uses 30min to keep generated image frequency humanish.
export const ACTION_COOLDOWNS_MS: Record<ActionKind, number> = {
  like: 3_000,
  comment: 65_000,
  reply: 65_000,
  follow: 15_000,
  post: 30 * 60_000,
  commentLike: 5_000,
};

// Base weights for the scheduler's weighted-random action selector. Applied
// on top of (remaining quota × persona probability). These are "how rare" an
// action is in general regardless of budget — a high-comment persona still
// posts less often than it likes, even when its comment budget is full.
export const ACTION_BASE_WEIGHTS: Record<ActionKind, number> = {
  like: 1.0,
  comment: 0.6,
  reply: 1.0,
  follow: 0.4,
  post: 0.2,
  commentLike: 0.8,
};

// --- Feed cache (output/feed-cache.json) ---
export const FEED_CACHE_MAX_AGE_MS = 5 * 60_000;
export const FEED_CACHE_DEFAULT_PAGES = 4;
export const FEED_CACHE_DEFAULT_LIMIT = 50;

// --- Action scheduler / continuous loop ---
// Minimum gap between ANY two actions across the whole population. Keeps the
// activity pattern organic (no burst floods) even when many agents are ready.
export const GLOBAL_MIN_GAP_MS = 3_000;
export const GLOBAL_MAX_GAP_MS = 8_000;
// How often to rescan the agents directory for newly-created agents.
export const AGENT_RESCAN_INTERVAL_MS = 5 * 60_000;
// When an agent has zero quota remaining, reschedule its next tick this far
// in the future. 30 min is short enough to pick up rolling-window gains
// (oldest-action aging out) without spinning.
export const QUOTA_EXHAUSTED_REQUEUE_MS = 30 * 60_000;

// --- Timezone for activity curves ---
// Activity curves on each persona are indexed by local hour (0-23). This
// timezone determines what "local" means for the seeder process. Default
// is America/New_York (Eastern US) — the target audience's clock.
export const SEEDER_TIMEZONE = process.env.SEEDER_TIMEZONE || 'America/New_York';

// Hoisted at module init — Intl.DateTimeFormat construction is non-trivial
// and getCurrentHour() is called on every continuous-engage scheduler tick.
const seederHourFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  hour12: false,
  timeZone: SEEDER_TIMEZONE,
});

/**
 * Get the current hour (0-23) in the configured seeder timezone.
 * Used by the action scheduler to look up activity curve weights.
 */
export function getCurrentHour(): number {
  return Number.parseInt(seederHourFormatter.format(new Date()), 10);
}

// --- Reply behavior ---
// On a 'reply' action tick, probability that the reciprocity executor
// (executeActivityDrivenReply) fires instead of the feed-driven thread-dive
// executor (executeReply). On 'no_fresh_inbound_activity' the dispatcher falls
// through to the feed-driven path automatically.
export const ACTIVITY_REPLY_PROBABILITY = 0.35;
// When feed-driven executeReply can't find a depth<2 parent to reply to, fall
// back to posting a top-level comment on the same post instead of skipping.
export const REPLY_FALLBACK_TO_COMMENT = true;
