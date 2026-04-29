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

  // Concurrency knobs for `publish` (Phase A/B/C) and `generate`. Three
  // ceilings bind here — NOT the platform's per-IP/per-key rate limits
  // (those are bypassed by `X-Rate-Limit-Bypass`):
  //
  //   (1) Gemini per-minute quota — Tier 1 on
  //       `gemini-3.1-flash-lite-preview` is 4K RPM / 4M TPM / 150K RPD;
  //       observed peak is ~21 RPM (~190× headroom). Not the binding
  //       constraint for any current knob.
  //
  //   (2) Together AI FLUX.1 Schnell quota — 600 RPM on the current
  //       account tier (the LLM tier on Together also governs image
  //       models on this account — confirm on the Together dashboard
  //       when changing tier or model). Binds for every call that hits
  //       `/posts/generate` or `/agents/me/avatar/generate`, because both
  //       endpoints run FLUX.1 Schnell server-side. We target ~33%
  //       utilization (~200 RPM sustained) to leave 400 RPM headroom for
  //       retries, circuit-breaker reopen probes, and Together-side jitter.
  //
  //   (3) Platform moderation pipeline — NOT bypassed. Current headroom
  //       is comfortable; not the binding constraint for any knob.
  //
  // Three safeguards stack on top of these knobs:
  //   - The publish circuit breaker below (`publishCircuit*` +
  //     src/lib/circuit-breaker.ts) trips on 5 failures in 15s and cools
  //     off 30s–5min, with a 5-trip abort ceiling.
  //   - The per-call retry policy below (`retryMaxAttempts`) with full
  //     jitter absorbs transient 502/503/504 and network failures.
  //   - 429 responses honor `Retry-After` on a dedicated branch.
  //
  // If Together tier or FLUX model changes, recompute the budget and
  // adjust the numbers below in lockstep with `tests/config.test.ts`,
  // `docs/BLUEPRINT.md` §Concurrency, and the rate-limit-bypass bullet in
  // CLAUDE.md.
  //
  // commentBakeConcurrency: ~3-8 Gemini calls per agent → at N=20 we peak
  // around 100-120 RPM, still <3% of the 4K RPM ceiling. No Together load.
  commentBakeConcurrency: 20,
  // registerConcurrency: 1 Gemini call (challenge answer) + 2 platform calls
  // per agent. Gemini-bound, no Together load; the ceiling is effectively
  // "how many registrations we want in flight."
  registerConcurrency: 15,
  // publishConcurrency: each worker POSTs `/posts/generate` (server-side
  // Together AI FLUX.1 Schnell + moderation). 8 concurrent × ~3s per FLUX
  // call ≈ ~160 RPM peak (~9% of the 1,800 RPM Tier 2 Together ceiling).
  // Deliberately low per-machine so 6 machines can run concurrently: 6 ×
  // 160 RPM = 960 RPM worst-case coincidental peak, 53% utilization. The
  // old value 10 targeted single-machine throughput; new value optimises
  // for horizontal scaling. Paired with async growth-tick architecture
  // (see docs/BLUEPRINT.md §Growth) so growth no longer blocks engage.
  publishConcurrency: 8,
  // followConcurrency: pure HTTP, no LLM, no Together, no subprocess.
  // High is fine — the ceiling is the platform's event-loop comfort on a
  // bursty POST wave.
  followConcurrency: 25,
  // avatarConcurrency: each worker POSTs `/agents/me/avatar/generate`
  // (server-side Together AI FLUX.1 Schnell + CDN upload). Same 600 RPM
  // Together ceiling as publishConcurrency; matched at 10 to target
  // ~200 RPM sustained (33%). The 5-lifetime-slots-per-agent concern
  // doesn't argue against high concurrency — re-runs skip agents that
  // already have `avatarUrl` on disk, so there's no "wasted slot" risk
  // from parallelism. At N=10 a 200-agent avatar phase clears in ~60s.
  avatarConcurrency: 10,

  // --- View simulation ---
  //
  // Authenticated `GET /posts/{id}` increments view_count once per (agent,
  // post, 24h) on the platform. The seeder fans these out from random
  // registered agents to manufacture a believable view-to-engagement ratio
  // (real platforms see ~20-50 views per like, ~100-300 per comment). All
  // platform rate limits on this endpoint are bypassed, so the only cost
  // is HTTP throughput.
  //
  // - viewsPerPublishedPost: how many other agents authenticated-read each
  //   post immediately after it lands during `publish-drafts` Phase B.
  //   Seeds the post with an opening view count before explore picks it up.
  //   30 = a post lands with 30 views = roughly comparable to a real post
  //   that's been on a fresh feed for a couple of minutes.
  // - lurkViewsPerAgent: per-agent feed-slice read at the top of every
  //   engage cycle / continuous-engage tick. Each agent reads the top N
  //   posts in its sliced feed window before deciding whether to engage —
  //   produces views that vastly outnumber engagement events, matching how
  //   real users scroll past most content.
  // - viewConcurrency: bounded fanout for both paths. Pure HTTP, no LLM,
  //   no Together — high is fine; the ceiling is platform event-loop
  //   comfort on a bursty GET wave.
  viewsPerPublishedPost: 30,
  lurkViewsPerAgent: 5,
  viewConcurrency: 15,

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

  // --- Publish Phase B / Phase A.5 circuit breaker ---
  //
  // Image generation on the platform runs through a saturation-prone pipeline
  // (Together AI FLUX + Gemini moderation) with a 50/min fleet cap and a
  // 1/min per-agent cap that are NOT bypassed by RATE_LIMIT_BYPASS_SECRET.
  // When the fleet cap is hit (visible as waves of 429 RATE_LIMIT_EXCEEDED or
  // 502 GENERATION_FAILED), the shared CircuitBreaker in
  // src/lib/circuit-breaker.ts opens and pauses Phase B workers for a
  // cool-off window. Default tuning:
  //   - failureThreshold=5 / windowMs=15_000 → 5 image-gen failures in 15s
  //     is the tripwire. Anything less is routine transient noise.
  //   - coolOffMs=30_000 → initial pause is 30s, enough for the fleet's
  //     sliding-window rate limiter to drain. If a 429 body carries a larger
  //     `retry_after`, we honor that instead.
  //   - maxCoolOffMs=300_000 → a chronically stalled upstream can back us off
  //     to 5min between probes before hitting maxTrips.
  //   - maxTrips=5 → 5 consecutive re-opens (half-open probe fails, breaker
  //     re-opens with doubled cool-off) aborts Phase B with CircuitAbortError
  //     so the operator sees a clean stop instead of an hour of churn.
  publishCircuitFailureThreshold: 5,
  publishCircuitWindowMs: 15_000,
  publishCircuitCoolOffMs: 30_000,
  publishCircuitMaxCoolOffMs: 300_000,
  publishCircuitMaxTrips: 5,

  // --- Continuous engage (engage-continuous command) ---
  //
  // Feed cache — shared top-N post snapshot pulled from /feed/explore, cached
  // at output/feed-cache.json and consumed by all agents in a continuous run.
  feedCachePath: './output/feed-cache.json',
  logsDir: './output/logs',

  // --- Shared lore registry (cults / secret societies / fan clubs / circlejerks / collabs) ---
  //
  // Population-wide narrative state at `output/lore-registry.json`. Synthesized
  // by `pnpm seed-lore` (auto-runs at the end of `generate`); referenced
  // cryptically in comments + replies during bake and engage. See
  // `src/lore/registry.ts` for the I/O and `src/lore/prompt.ts` for the
  // share-of-comments math.
  loreRegistryPath: './output/lore-registry.json',
  // Per-Gemini-call concurrency for the bake phase. Each group runs
  // generateLoreGroup (one call) + generateLoreEntries (one call). 5 in
  // flight × ~1 RPS each is well under the Gemini ceiling and gives the
  // synthesis loop ~5× speedup on a 30-group registry.
  loreBakeConcurrency: 5,

  // --- Lore share-of-comments targets ---
  //
  // The operator's distribution: ~10–15% of comments lean cryptic, ~20%
  // are circlejerk-flavored, ~10% are fan-club-flavored, the rest are
  // normal. These are PER-COMMENT roll probabilities applied at the call
  // site in engage / comment-samples bake; the agent must also be a member
  // of a group of the matching archetype for the roll to fire.
  //
  // The roll order is: cryptic > circlejerk > fan_club (highest tonal
  // load first). At most one tier fires per comment — once we roll into a
  // tier, subsequent tiers are skipped on this call.
  loreCrypticShare: 0.12, // 10–15% target band, default mid
  loreCirclejerkShare: 0.2,
  loreFanClubShare: 0.1,
  // Snippets surfaced to the LLM per allusion roll. >1 lets the LLM pick
  // which entry fits the moment instead of having to bend a single one.
  // 2 keeps the prompt compact while still giving choice.
  loreSnippetsPerAllusion: 2,
  // Saturation rolloff. When an entry's `referenceCount` >= this value, it
  // drops to half weight in the picker so the same in-joke doesn't get
  // hammered across thousands of comments.
  loreEntrySaturationThreshold: 12,

  // --- Lore catalog scope ---
  //
  // Bake-time defaults. Operator can override via `pnpm seed-lore --groups N`.
  // At 30 groups across ~3K agents, the average agent lands in 1–2 groups
  // (most groups are persona-clustered with 50–200 members each; a handful
  // are tight agent-specific cabals with 2–5 members).
  loreDefaultGroupCount: 30,
  // Lore entries (events / in-jokes / rituals / slang / prophecies /
  // manifestos) per group. 6 gives Gemini enough room to span the range
  // while keeping the prompt window manageable.
  loreEntriesPerGroup: 6,
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
  // follow: raised 10 → 25 to accommodate the new-agent follow burst (5 follows
  // spent on day 1) plus background follows. Median persona (0.2) → cap 5;
  // Tier 1 (~0.3) → cap 7-8; Tier 3 (~0.15) → cap 3-4. Burst logic must clamp
  // to min(5, remainingQuota) so Tier 3 agents only fire 3-4 burst follows.
  follow: (p) => Math.round(25 * p.followProbability),
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
//
// Retuned for viral engagement shaping: reach = likes_received + comments_made
// on the platform, so comments/replies get boosted because they directly
// increment the commenter's comments_made counter. Posts are down-weighted
// because they fire on wall-clock cadence (not the weighted picker) and the
// old 0.2 weight was redundant with the cadence gate. Follows go down because
// the new-agent follow burst (Phase 6) covers the bulk of follow volume.
export const ACTION_BASE_WEIGHTS: Record<ActionKind, number> = {
  like: 0.9,
  comment: 1.6,
  reply: 1.5,
  follow: 0.3,
  post: 0.1,
  commentLike: 0.8,
};

// Per-tier multiplier applied AFTER ACTION_BASE_WEIGHTS in the weighted picker.
// Tier 1 agents skew harder toward comments/replies (they're the ones climbing
// the leaderboard via comments_made); Tier 3 agents engage less across the
// board. Tier 2 is no-op baseline. Missing tier defaults to Tier 2.
export const ACTION_WEIGHT_TIER_MULTIPLIERS: Record<
  1 | 2 | 3,
  Partial<Record<ActionKind, number>>
> = {
  1: { like: 0.8, comment: 1.3, reply: 1.3 },
  2: {},
  3: { like: 0.8, comment: 0.8, reply: 0.8, follow: 0.8, post: 0.8, commentLike: 0.8 },
};

// --- Feed cache (output/feed-cache.json) ---
// MAX_AGE: 5 → 3 min — the new tighter pacing produces more actions per minute
// so a fresher cache keeps the popularity/velocity signal current.
// DEFAULT_PAGES: 4 → 3 — reduces refresh cost now that the cache turns over faster.
export const FEED_CACHE_MAX_AGE_MS = 3 * 60_000;
export const FEED_CACHE_DEFAULT_PAGES = 3;
export const FEED_CACHE_DEFAULT_LIMIT = 50;

/** Probability that a post-generation call injects hashtags from the trending
 * pool. 0.6 means ~60% of new posts use trending tags, ~40% pure organic. */
export const TRENDING_HASHTAG_BIAS = 0.6;

// --- Action scheduler / continuous loop ---
// Minimum gap between ANY two actions across the whole population. Tightened
// from 3s → 500ms to unlock higher fleet throughput. Combined with async growth
// ticks (Phase 0/infra) the loop no longer blocks on publish.
export const GLOBAL_MIN_GAP_MS = 500;
export const GLOBAL_MAX_GAP_MS = 1_200;
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
export const ACTIVITY_REPLY_PROBABILITY = 0.55;
// When feed-driven executeReply can't find a depth<2 parent to reply to, fall
// back to posting a top-level comment on the same post instead of skipping.
export const REPLY_FALLBACK_TO_COMMENT = true;

// --- Same-register cap ---
// Prevents disagree/love pile-ons on a single post. When two or more recent
// seeder comments on the same post used the same register, the next candidate
// register pivots down the fallback chain (disagree → conversational → love
// → skip) or the comment is skipped entirely. Keeps the rivalry graph from
// reading as coordinated bot behavior when multiple rivals all fire on the
// same target post in quick succession.
//
// Source data: `src/lib/runtime-global-log.ts` tail read, filtered to
// registers-with-hints only (unclassified comments don't count).
export const SAME_REGISTER_CAP = 2;
export const SAME_REGISTER_WINDOW_MS = 30 * 60_000;

// --- Comment/reply word budget retry ---
// When a generated comment/reply exceeds the sampled word cap by this
// multiplier, `generateComment` / `generateReply` will regenerate ONCE with a
// stricter prompt before falling back to sentence-boundary truncation. Kept
// tight enough that a 5-word budget doesn't tolerate a 15-word reply.
export const WORD_BUDGET_OVERFLOW_MULTIPLIER = 1.2;
