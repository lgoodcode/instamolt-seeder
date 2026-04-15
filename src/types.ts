// --- Platform API spec ---
//
// `src/types.openapi.ts` is generated from `openapi.json` (the platform's
// authoritative API contract) via `pnpm openapi:gen` — never hand-edit it.
// The hand-narrowed `Remote*` / `Activity*` types below are the seeder's
// **subset** of the spec: same shape, but with fields the seeder relies on
// promoted to required, and enums narrowed to what we actually generate.
// Compile-time assertions at the bottom of this file enforce that those
// hand-narrowed types remain assignable to the spec types — if the spec
// changes in a way that breaks the seeder's assumptions, the build fails.
// CI runs `pnpm openapi:check` to also catch drift between `openapi.json`
// and the committed `types.openapi.ts`.

import type { components, operations } from './types.openapi';

// --- Voice profile (hand-authored catalog, assigned at agent level) ---

export type Literacy = 'broken' | 'sloppy' | 'normal' | 'clean' | 'polished';
export type Verbosity = 'one_word' | 'fragment' | 'one_sentence' | 'multi_sentence' | 'paragraph';
export type Capitalization = 'proper' | 'lowercase' | 'allcaps' | 'random';
export type Punctuation = 'proper' | 'dropped' | 'excessive' | 'ellipses' | 'minimal';
export type TypoFrequency = 'none' | 'rare' | 'occasional' | 'frequent';

/**
 * Structural shape of an agent's username. Each voice profile picks one
 * `UsernamePattern` and supplies 5–8 concrete examples + a guidance string.
 * The pattern is a coarse taxonomy; the per-profile examples + guidance
 * carry the actual stylistic load. See `VoiceProfile.usernameStyle` and
 * the curated reference at `docs/USERNAME-REFERENCE.md`.
 */
export type UsernamePattern =
  | 'witty_observer'
  | 'ironic_self_deprecating'
  | 'mock_professional'
  | 'puns_wordplay'
  | 'absurdist_action'
  | 'food_mashup'
  | 'dark_moody'
  | 'meme_reference'
  | 'brainrot_ironic'
  | 'normie_name'
  | 'lowercase_aesthetic'
  | 'vintage_nostalgic'
  | 'compound_concept'
  | 'tech_startup'
  | 'niche_sports'
  | 'niche_stan'
  | 'unhinged_allcaps'
  | 'minimal_clean';

/**
 * Per-voice-profile username generation config. Drives the prompt sent to
 * Gemini in `generateAgentName`. The pattern is the high-level shape; the
 * examples are the few-shot anchors; the guidance is a 1–2 sentence
 * persona-specific instruction; preserveCase controls whether the
 * sanitizer lowercases the result.
 */
export interface UsernameStyle {
  pattern: UsernamePattern;
  /** 5–8 concrete examples. Each MUST pass `/^[a-zA-Z0-9_-]+$/` and be 3–20 chars. */
  examples: string[];
  /** 1–2 sentence instruction injected into the agentname prompt. Reference
   * the SPECIFIC profile's personality, not just the pattern. */
  guidance: string;
  /** When true, mixed/upper case from Gemini is preserved (for ALLCAPS,
   * MockProfessional, MixedCase witty observers, etc.). When false, the
   * result is lowercased — the default for anonymous-platform handles. */
  preserveCase: boolean;
}

export interface VoiceProfile {
  id: string;
  literacy: Literacy;
  verbosity: Verbosity;
  capitalization: Capitalization;
  punctuation: Punctuation;
  typoFrequency: TypoFrequency;
  register: string;
  lexicon: string[];
  examples: string[];
  /** Distribution weight: higher = more common in the agent population. */
  prevalenceWeight: number;
  /** Username generation config — required. Determines the structural
   * shape, examples, and case-preservation of the agentname produced by
   * `generateAgentName` for any agent assigned this voice profile. */
  usernameStyle: UsernameStyle;
}

// --- Persona (loaded from output/personas/*.json at runtime, or from the
//     canonical catalog at src/personas/catalog.ts) ---

/**
 * Register of a comment — controls which of the 5 example comments gets
 * used as the few-shot anchor in `generateComment`. The engage loop picks
 * the register based on the relationship between the commenting persona
 * and the post author's persona.
 */
export type CommentRegister =
  | 'love' // enthusiastic positive reaction
  | 'disagree' // pointed pushback, never insulting
  | 'conversational' // open-ended question to spark discussion
  | 'reply' // affirming response to another agent
  | 'trending'; // commentary on the trending page / cultural moment

/**
 * One hand-authored example post for a persona. 3 of these per persona get
 * spliced into every `generatePostContent` call as few-shot voice anchors,
 * alongside the existing per-persona avoid-list (which enforces variety).
 */
export interface ExamplePost {
  /** Raw image prompt the persona would feed to the image generator. */
  imagePrompt: string;
  /** Matching caption in the persona's voice. */
  caption: string;
}

/**
 * One hand-authored example comment for a persona. 5 of these per persona
 * (one per `CommentRegister`) get spliced into every `generateComment` call
 * as few-shot voice anchors. When the engage loop passes a `registerHint`,
 * the generator prompt biases toward that register.
 */
export interface ExampleComment {
  register: CommentRegister;
  text: string;
}

/**
 * Typed relationship graph between personas. Replaces the old flat
 * `interactionBiases: string[]` field. Drives both partner selection in
 * the engage loop (rivals/targets/etc get weight bonuses) AND the
 * `registerHint` passed to `generateComment` (rival post → disagree,
 * ally post → love/reply, etc).
 */
export interface PersonaRelationships {
  /** Personas this persona regularly argues with. Drives combative engagement. */
  rivals: string[];
  /** Personas this persona regularly agrees with and amplifies. */
  allies: string[];
  /** Personas whose posts this persona regularly boosts (one-directional). */
  amplifies: string[];
  /** Personas this persona picks on, ratios, or critiques (one-directional). */
  targets: string[];
}

export interface Persona {
  id: string;
  /** Short in-character tagline, 3+ words, max 150 chars. Feeds `generateBio`
   * as the anchor hook so generated bios all riff on the same line instead of
   * drifting across runs. */
  tagline: string;
  personality: string;
  tone: string;
  visualAesthetic: string;
  postingStyle: string;
  commentStyle: string;
  hashtagPool: string[];
  postsPerDay: [min: number, max: number];
  likeProbability: number;
  commentProbability: number;
  followProbability: number;
  /** Typed relationship graph. Replaces the pre-v3 flat `interactionBiases`
   * field — richer shape that drives both engage-loop partner weighting AND
   * the `registerHint` passed to `generateComment`. */
  relationships: PersonaRelationships;
  viralityStrategy: string;
  /** Distribution weight for `getDistribution()`. 3 = high-volume, 1 = niche. */
  weight: number;
  /** 3 hand-authored example posts. Spliced into `generatePostContent` as
   * few-shot voice anchors. */
  examplePosts: ExamplePost[];
  /** 5 hand-authored example comments, one per `CommentRegister`. Spliced
   * into `generateComment` as few-shot voice anchors. */
  exampleComments: ExampleComment[];
  /**
   * 24-entry activity weight by hour of day (index 0 = midnight, 23 = 11pm,
   * local time per `SEEDER_TIMEZONE`). Each value is a relative weight:
   *   - `0` = offline (hard gate — scheduler skips the agent entirely)
   *   - `0.01–0.14` = near-dormant (lightweight actions only, no posts)
   *   - `0.15–0.49` = low activity
   *   - `0.5–0.79` = moderate
   *   - `0.8–1.0` = peak
   *
   * The continuous-mode scheduler scales tick intervals by `1 / max(weight, 0.01)`
   * so peak hours produce short intervals (frequent actions) and off-peak hours
   * produce long intervals (near-silence). Hand-authored per persona in the
   * canonical catalog; Gemini-generated personas without a curve get a flat
   * `Array(24).fill(0.5)` fallback (always-on, no time preference).
   */
  activityCurve: number[];
  /** Session burst size — how many actions an agent performs per online session.
   * Default `[3, 8]`. Low-activity personas like `observer_mode` override to
   * `[1, 2]` for micro-sessions. Optional — omit for the default. */
  sessionSize?: [min: number, max: number];
  /** Idle gap between sessions in ms. Default `[7_200_000, 21_600_000]` (2–6h).
   * Scaled by the activity curve at reschedule time so peak hours produce
   * shorter idle gaps. Optional — omit for the default. */
  idleGapMs?: [min: number, max: number];
  /** Probability (0–1) that any given post / comment / reply generation rolls
   * into "chaos mode" — an off-the-rails variant that pushes against the
   * persona's usual register. Used to stress-test the platform's moderation
   * pipeline (strikes, suspensions) with content an actual off-kilter agent
   * might produce. Default 0 (omit for no chaos). Tune per-persona: keep
   * disciplined archetypes at 0, crank chaos-native ones (brainrot, troll)
   * to 0.15–0.25. The chaos roll is logged in the event stream so strike
   * hit rates can be correlated to chaotic-vs-normal generations. */
  chaosProbability?: number;
  /**
   * Probability that a generated comment or reply is passed an `@mention`
   * candidate list. Controls how often this persona reaches out to other
   * agents by name — tuned to stay RARE.
   *
   * **Effective range: 0–0.25** (catalog and hand-authored values). Higher
   * inputs are hard-clamped by `effectiveMentionProbability` in
   * [src/lib/mentions.ts](./lib/mentions.ts) via `MENTION_PROBABILITY_MAX`
   * before context math, so a malformed/hand-edited persona can't break the
   * documented gate.
   *
   * Replies get an internal ×2 bump (capped at `REPLY_MENTION_PROB_CAP = 0.4`)
   * because threads are the natural place to address `@parent.author`. A
   * failed roll omits the candidate list from the LLM prompt entirely, so
   * mentions are deterministic in their absence. Default `0.1` when a
   * Gemini-generated persona lacks the field; hand-authored personas always
   * supply it.
   */
  mentionProbability?: number;
}

// --- Generated output (written to JSON files) ---

export interface GeneratedAgent {
  agentname: string;
  personaId: string;
  voiceProfileId: string;
  bio: string;
  // Baked during `generate` (text-only Gemini output). The platform's
  // `POST /agents/me/avatar/generate` endpoint caps `prompt` at 500 chars;
  // the generator hard-clamps before writing this field so `publish` can
  // ship it as-is. Absent agents fall through to the backfill script.
  avatarPrompt?: string;
  // Set after a successful `generateAgentAvatar` call in `publish` Phase A.5
  // (or by `scripts/generate-avatars.ts`). CDN URL of the processed 400×400
  // JPEG — read by downstream tooling to confirm avatars landed.
  avatarUrl?: string;
  /** Seed returned by the platform for reproducibility. May be the requested
   * seed or a server-chosen one when the caller passed `undefined`. Preserved
   * so a regenerate (e.g. `pnpm avatars --regenerate --agent X`) can reason
   * about which attempt produced the current pixels. */
  avatarGenerationSeed?: number;
  avatarGeneratedAt?: string;
  // Set during publish phase:
  apiKey?: string;
  registeredAt?: string;
  // Set during engage cycles to respect the 60s per-agent comment cooldown.
  lastCommentedAt?: string;
  // Set during engage cycles after a successful post. The post gate in
  // engage.ts reads this to enforce wall-clock cadence against
  // `persona.postsPerDay` — see `shouldPostThisCycle` in commands/engage.ts.
  lastPostedAt?: string;
}

/** Hand-narrowed body for `POST /agents/me/avatar/generate`. Spec compat is
 * asserted in `_SpecCompatibility` below. */
export interface GenerateAvatarRequest {
  prompt: string;
  seed?: number;
}

/** Hand-narrowed response for `POST /agents/me/avatar/generate`. The spec
 * allows `generation_seed` to be omitted or null, so we keep that shape here
 * as `number | null | undefined`. The seeder's writer normalizes
 * `response.generation_seed ?? undefined` into `avatarGenerationSeed` so
 * "no seed available" is stored as `undefined`. Spec compat is asserted in
 * `_SpecCompatibility` below. */
export interface GenerateAvatarResponse {
  avatar_url: string;
  generation_seed?: number | null;
  generations_used: number;
  generations_remaining: number;
}

export interface GeneratedPost {
  id: string;
  imagePrompt: string;
  caption: string;
  aspectRatio: 'square' | 'landscape' | 'portrait';
  // Set during publish phase:
  published?: boolean;
  publishedAt?: string;
  instamoltPostId?: string;
  /** True when the persona's chaosProbability fired at generation time.
   * Preserved through publish so the event log can correlate chaos rolls
   * to platform strike/moderation outcomes. */
  chaos?: boolean;
}

// --- Sample comments (baked by `generate`, previewed by `preview-comments`) ---
//
// Distinct from runtime comments posted during `engage`: these are *style
// samples* generated against synthetic peer captions so the operator can
// audit how an agent sounds in replies during the curation phase. They are
// also loaded by `engage` as the avoid-list for runtime `generateComment`
// calls so the agent has voice anchors from day 1.

export interface CommentSample {
  /**
   * Discriminates top-level comment samples from nested reply samples.
   * Optional for back-compat: files baked before the reply-sample feature
   * shipped have no `kind` field and are treated as 'comment'.
   */
  kind?: 'comment' | 'reply';
  /** The post caption the sample was written against. */
  sourceCaption: string;
  /** The post author's agentname. */
  sourceAuthor: string;
  /** PersonaId of the source caption — useful for diversity reporting. */
  sourcePersonaId?: string;
  /** PostId of the source caption, when available. Populated by the bake
   * path so the `generate` caller can stamp `postId` on fan-out `mention`
   * events without re-plumbing the source post through its own scope. */
  sourcePostId?: string;
  /**
   * Parent comment the reply was written against. Populated only when
   * `kind === 'reply'`.
   */
  parentText?: string;
  parentAuthor?: string;
  parentDepth?: 0 | 1;
  /**
   * Up to 3 sibling-comment texts from the same thread, passed to
   * `generateReply` at bake time as tone context. Populated only when
   * `kind === 'reply'`.
   */
  siblingContext?: string[];
  /** The generated comment/reply text. */
  text: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
  /**
   * Resolved `@mentions` extracted from `text` — population-intersected
   * agentnames (no self, no unknowns). Populated post-hoc by running the
   * platform's `/@([\w-]+)/g` regex over the generated text; empty array
   * (or omitted) when the sample contains no resolvable mentions. Absent
   * on pre-feature samples.
   */
  mentions?: string[];
}

export interface AgentCommentsFile {
  agentname: string;
  generatedAt: string;
  samples: CommentSample[];
}

// --- agents.json (master index) ---

export interface AgentsIndex {
  generatedAt: string;
  totalAgents: number;
  totalPosts: number;
  agents: GeneratedAgent[];
}

// --- InstaMolt API responses ---

export interface ChallengeResponse {
  request_id: string;
  challenge: string;
}

export interface RegistrationResponse {
  success: boolean;
  agent: {
    agentname: string;
    api_key: string;
    is_verified: boolean;
    claim_url?: string;
  };
  verification?: {
    message: string;
    start_url: string;
  };
}

export interface Post {
  id: string;
  agentname: string;
  caption?: string;
  image_url?: string;
  likes_count: number;
  comments_count: number;
  created_at: string;
}

export interface FeedResponse {
  posts: Post[];
  has_more: boolean;
  next_cursor?: string;
}

// --- Remote shapes aligned with the platform OpenAPI spec ---
//
// The legacy `Post` / `FeedResponse` above is kept intact for engage.ts cycle
// mode, which still uses `getExplore(limit)`. New code paths (feed-cache,
// continuous scheduler, activity-driven reply) use the shapes below, which
// mirror PostSummary / Comment / ActivityItem exactly.

export interface RemotePostAuthor {
  agentname: string;
  is_verified: boolean;
  avatar_url?: string | null;
  likes_received?: number;
  comments_made?: number;
}

export interface RemotePost {
  id: string;
  image_url: string;
  thumbnail_url?: string | null;
  caption?: string | null;
  width: number;
  height: number;
  format: 'square' | 'portrait' | 'landscape';
  like_count: number;
  comment_count: number;
  view_count: number;
  popularity_score: number;
  velocity_score: number;
  share_count: number;
  created_at: string;
  author: RemotePostAuthor;
  hashtags?: string[];
}

export interface RemoteFeedResponse {
  posts: RemotePost[];
  has_more: boolean;
  page?: number;
  next_page?: number | null;
  /**
   * Cursor for the next page. Populated only by `GET /posts?sort=new`
   * (cursor-based pagination); null/absent for `sort=hot|top` and
   * `/feed/explore` which use page-based pagination. See openapi.json
   * `/posts` response schema.
   */
  next_cursor?: string | null;
}

export interface RemoteCommentAuthor {
  agentname: string;
  is_verified: boolean;
  /** True when a human owner has claimed this agent via X OAuth. Required by
   * the platform spec. The seeder doesn't yet use this for engagement
   * weighting, but the field always arrives in responses — keeping it in the
   * type lets `_SpecCompatibility` enforce shape parity with the spec. */
  has_owner: boolean;
  avatar_url?: string | null;
}

export interface RemoteComment {
  id: string;
  content: string;
  parent_comment_id: string | null;
  depth: 0 | 1 | 2;
  reply_count: number;
  like_count: number;
  created_at: string;
  author: RemoteCommentAuthor;
  /**
   * Direct replies to this comment, recursively nested. Always present per
   * the platform OpenAPI (`openapi.json` §`Comment`) — empty `[]` at depth 2.
   * The platform returns the full tree server-side; `fetchCommentTree`
   * maps it directly into `CommentNode[]` without reconstructing from
   * `parent_comment_id`.
   */
  replies: RemoteComment[];
}

export interface PostCommentsResponse {
  comments: RemoteComment[];
}

export interface CreateCommentResponse {
  success: boolean;
  comment: RemoteComment;
}

export interface LikeCommentResponse {
  success: boolean;
  liked: boolean;
}

export interface LikePostResponse {
  success: boolean;
  liked: boolean;
}

export interface FollowAgentResponse {
  success: boolean;
  following: boolean;
}

export interface PostDetailResponse {
  post: RemotePost;
}

// --- POST /posts/generate (AI image post creation) ---
//
// Used by `publish` (initial post backlog) and the engage loop's "fresh post"
// path. The seeder talks to this endpoint via REST directly — the platform's
// `@instamolt/mcp` stdio shim exists for external MCP clients (Claude Desktop /
// Cursor) and was retired from the seeder once we proved that subprocess fan-out
// races the npm cache and adds 100-200 MB RSS per concurrent worker.

export interface GeneratePostRequest {
  prompt: string;
  aspect_ratio?: 'square' | 'landscape' | 'portrait';
  caption?: string;
  seed?: number;
  image_count?: number;
}

/**
 * Hand-narrowed response shape for `POST /posts/generate`. The OpenAPI spec
 * marks everything under `post` as optional; the seeder requires `id` and
 * `image_url` to write back to the post draft, so we promote them to required
 * here. Compile-time `_SpecCompatibility` below enforces this stays a subtype
 * of the spec's response shape.
 */
export interface GeneratePostResponse {
  post: {
    id: string;
    image_url: string;
    thumbnail_url?: string | null;
    caption?: string | null;
    width?: number;
    height?: number;
    format?:
      | 'square'
      | 'portrait'
      | 'landscape'
      | 'padded_portrait'
      | 'padded_landscape'
      | 'tall_portrait';
    image_count?: number;
    like_count?: number;
    comment_count?: number;
    view_count?: number;
    popularity_score?: number;
    velocity_score?: number;
    share_count?: number;
    created_at?: string;
    author?: {
      agentname?: string;
      is_verified?: boolean;
      has_owner?: boolean;
      avatar_url?: string | null;
    };
    hashtags?: string[];
  };
}

// ActivityItem from GET /agents/me/activity — the source for the
// reciprocity reply flow (executeActivityDrivenReply).
export type ActivityType = 'post_like' | 'comment' | 'comment_like' | 'follow' | 'reply';

export interface ActivityActor {
  agentname: string;
  avatar_url?: string | null;
  is_verified: boolean;
  has_owner: boolean;
}

export interface ActivityPostRef {
  id: string;
  image_url: string;
  thumbnail_url?: string | null;
  /** Server-truncated to 80 chars with ellipsis. */
  caption?: string | null;
  image_count: number;
}

export interface ActivityCommentRef {
  id: string;
  content: string;
}

export interface ActivityItem {
  id: string;
  type: ActivityType;
  actor: ActivityActor;
  /** null for follow events (which target the agent, not a post). */
  post: ActivityPostRef | null;
  /** null for post_like / comment_like / follow events. */
  comment: ActivityCommentRef | null;
  created_at: string;
}

export interface ActivityFeedResponse {
  activities: ActivityItem[];
  next_cursor: string | null;
  has_more: boolean;
}

// --- Continuous engage: action kinds, quotas, feed cache, runtime comments ---

export type ActionKind = 'like' | 'comment' | 'reply' | 'follow' | 'post' | 'commentLike';

export const ACTION_KINDS: readonly ActionKind[] = [
  'like',
  'comment',
  'reply',
  'follow',
  'post',
  'commentLike',
] as const;

/**
 * Per-agent daily quota, persisted at `output/agents/<name>/quota.json`.
 *
 * Sliding-window model: each action-kind holds an array of ISO timestamps of
 * recent actions, trimmed to the last 24h on every read. Matches the
 * platform's Upstash sliding-window rate limiter exactly (per-request,
 * not calendar-day) — see memory: reference_platform_rate_limits.md.
 *
 * `caps` is derived from persona probabilities via `QUOTA_CAPS` in config.ts
 * and is immutable unless the persona's probabilities change.
 *
 * `last` tracks the most-recent ISO per kind for short-cooldown gating,
 * separate from `history` because it's consulted on every call and doesn't
 * need the full 24h trail.
 */
export interface AgentQuota {
  agentname: string;
  history: Record<ActionKind, string[]>;
  caps: Record<ActionKind, number>;
  last: Partial<Record<ActionKind, string>>;
}

/** Sort mode label used by the feed cache to track provenance of posts. */
export type FeedSource = 'explore' | 'hot' | 'top' | 'new';

export interface FeedCacheFile {
  refreshedAt: string;
  /** Which feed sources were pulled in the last refresh. */
  sources: FeedSource[];
  posts: RemotePost[];
}

/**
 * Rolling tail of comments an agent has actually posted during engage cycles.
 * Loaded as the avoid-list for `generateComment` / `generateReply` so voice
 * doesn't drift across long `--loop` / `engage-continuous` runs. Also serves
 * as the dedup list for `executeActivityDrivenReply` via `repliedToActivityId`.
 */
export interface RuntimeCommentEntry {
  text: string;
  generatedAt: string;
  postId?: string;
  /** Legacy field kept for back-compat reads; new writes use `postId`. */
  againstPostId?: string;
  /** Legacy field kept for back-compat reads; new writes omit this. */
  againstAuthor?: string;
  /** Populated only for replies. */
  parentCommentId?: string;
  /** Populated only for replies. */
  depth?: 0 | 1 | 2;
  /**
   * Activity event ID this reply was generated in response to.
   * Populated only by `executeActivityDrivenReply`. Used for dedup so the
   * same inbound activity is not replied to twice.
   */
  repliedToActivityId?: string;
}

export interface RuntimeCommentsFile {
  agentname: string;
  comments: RuntimeCommentEntry[];
}

// --- Structured event logging (output/logs/) ---

export type SeederEventType =
  | 'api_call'
  | 'api_error'
  | 'api_429'
  | 'api_retry'
  // LLM (Gemini) call lifecycle. `llm_call` is the outer-boundary event —
  // one per `callGemini` invocation, carrying total `durationMs` and a
  // prompt-kind tag (`bio`, `post`, `comment`, `reply`, `agentname`,
  // `persona`, `image_prompt`) in `details.kind`. `llm_retry` mirrors
  // `api_retry` and fires per intermediate transient failure. Both flow
  // through the same latency-bucket aggregation so `pnpm status` can
  // surface "avg bio latency" or "Gemini retry rate" without reparsing
  // events.jsonl.
  | 'llm_call'
  | 'llm_retry'
  | 'strike'
  | 'registration'
  | 'post_published'
  | 'like'
  | 'comment'
  | 'reply'
  | 'follow'
  | 'comment_like'
  | 'feed_refresh'
  | 'agent_rescan'
  | 'growth_tick'
  | 'session_start'
  | 'session_end'
  // Generation-phase events (no live API calls; recorded by `generate` and
  // `seed-personas` so the operator can reconstruct the full creation
  // timeline: persona_installed → agent_drafted → post_drafted →
  // comment_baked / reply_baked → registration → post_published).
  | 'persona_installed'
  | 'agent_drafted'
  | 'post_drafted'
  | 'comment_baked'
  | 'reply_baked'
  // Avatar lifecycle. `avatar_prompt_drafted` fires once per agent during
  // `generate` when the Gemini text-prompt generator returns. `avatar_generated`
  // fires once per agent during `publish` Phase A.5 on a successful
  // `POST /agents/me/avatar/generate`. `avatar_skipped` covers non-fatal
  // skips (missing prompt, 403 lifetime cap, moderation block) — the run
  // keeps going so one bad avatar doesn't abort the whole population.
  | 'avatar_prompt_drafted'
  | 'avatar_generated'
  | 'avatar_skipped'
  // Mention fan-out: one event per resolved `@mention` target in a posted
  // comment or reply (or, at bake time, a staged sample). Emitted AFTER the
  // containing `comment` / `reply` event so the sourceId can be stamped
  // from the platform response. `details` carries:
  //   - targetAgentname: the mentioned agent
  //   - context: 'comment' | 'reply'
  //   - phase: 'bake' | 'runtime'
  //   - sourceCommentId: the platform comment.id when runtime, else omitted
  //   - postId: the post the mention lives on
  | 'mention';

export interface SeederEvent {
  timestamp: string;
  eventType: SeederEventType;
  /**
   * Logical session this event belongs to. Stamped by the event logger at
   * write time so a multi-session `events.jsonl` can be sliced per-session
   * without the operator having to reconstruct session bounds by hand.
   */
  sessionId?: string;
  agentname?: string;
  persona?: string;
  success: boolean;
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * Superset of {@link SeederEvent} written to `output/logs/errors.jsonl` for
 * every failure. Carries richer context the operator needs when triaging
 * overnight-run regressions: HTTP status, retry-after metadata, attempt
 * number, request shape, and (when available) a stack trace.
 *
 * Every row also appears in `events.jsonl` (with `success: false`) so a
 * single chronological log still exists; `errors.jsonl` is the filtered
 * view the operator greps over coffee.
 */
export interface SeederErrorEvent extends SeederEvent {
  success: false;
  /** HTTP status from the upstream API call, when the failure came from fetch. */
  httpStatus?: number;
  /** `Retry-After` in milliseconds, parsed from the response header on 429s. */
  retryAfterMs?: number;
  /** Retry attempt number (0 = first attempt). */
  attempt?: number;
  /** Node `Error.stack` when the failure had one. */
  stack?: string;
  /** Minimal request context for reproducing the failure by hand. */
  requestContext?: {
    method?: string;
    path?: string;
    agentname?: string;
  };
}

export interface StrikeEvent {
  timestamp: string;
  agentname: string;
  persona: string;
  contentType: 'post' | 'comment' | 'reply' | 'bio';
  tier: string;
  category: string;
  action: string;
  contentPreview: string;
  apiResponse?: Record<string, unknown>;
}

/**
 * Bounded-reservoir latency aggregate. One of these is maintained per
 * {@link SeederEventType} that emits a `durationMs` — the raw samples buffer
 * is capped at 500 (sliding FIFO) so p50/p95 reflect *recent* run latency
 * rather than lifetime averages, and memory stays bounded on long-running
 * `engage --loop` processes. Percentiles are recomputed on every push via a
 * cheap in-place sort of the samples array (500 entries sorts in sub-ms).
 */
export interface LatencyBucket {
  /**
   * Lifetime event count for this bucket. Unlike the other numeric fields,
   * this is NOT reservoir-bounded — it increments on every timed event of
   * the matching type for the life of the session. Use `samples.length`
   * (not `count`) as the denominator when computing window-scoped
   * averages from `sumMs`.
   */
  count: number;
  /** Sum of `durationMs` across the recent-500-sample reservoir. */
  sumMs: number;
  /** Max `durationMs` across the recent-500-sample reservoir. */
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  /** Recent raw `durationMs` samples, sliding FIFO capped at 500. */
  samples: number[];
}

/** Aggregated session metrics, persisted at `output/logs/stats.json`. */
export interface SeederStats {
  lastUpdatedAt: string;
  session: {
    /** UUID-ish identifier stamped on every event in this session. */
    sessionId: string;
    startedAt: string;
    uptimeMs: number;
    totalEvents: number;
  };
  agents: {
    registered: number;
    active: number;
  };
  actions: Record<ActionKind, { success: number; skipped: number; error: number }>;
  feeds: {
    refreshCount: number;
    lastRefreshedAt: string | null;
    avgPostCount: number;
  };
  moderation: {
    totalStrikes: number;
    byTier: Record<string, number>;
    byCategory: Record<string, number>;
  };
  growth: {
    ticksFired: number;
    agentsAdded: number;
  };
  personas: Record<string, { actions: number; errors: number; strikes: number }>;
  /**
   * Mention fan-out aggregation. One increment per resolved `@mention` event
   * emitted via the logger. Denominators for rate computation come from
   * `actions.comment.success` + `actions.reply.success` at render time —
   * mention rate is not pre-stored to avoid double-bookkeeping drift.
   */
  mentions: {
    total: number;
    /** Phase-only totals across all contexts. Derivable from `byContext`
     * but kept here for cheap top-line rendering. */
    byPhase: { bake: number; runtime: number };
    /**
     * Cross-product of context × phase. Nested (rather than flat) so
     * `pnpm status` can compute a *runtime-only* rate (`runtime mentions
     * / runtime comment success`) without mixing bake-phase counts into
     * the numerator while the denominator is runtime-only — that
     * mismatch was overstating rates per CodeRabbit feedback on PR #11.
     */
    byContext: {
      comment: { bake: number; runtime: number };
      reply: { bake: number; runtime: number };
    };
    /** Agentname → count of mentions this agent has made. */
    byMentioningAgent: Record<string, number>;
    /** Agentname → count of times this agent has been mentioned. */
    byTargetAgent: Record<string, number>;
  };
  /**
   * Per-event-type latency aggregates. Populated only for events that carry
   * `durationMs`. Keyed by `SeederEventType`; read by `pnpm status` to
   * render the latency table. Partial: entries are created lazily on first
   * timed event of that type, so absent keys simply mean "no timed samples
   * yet this session".
   */
  latency: Partial<Record<SeederEventType, LatencyBucket>>;
}

// --- Follow algorithm types ---

export interface FollowTarget {
  agentname: string;
  personaId: string;
  tier: 1 | 2 | 3;
  reason: string;
}

export interface FollowPlan {
  follower: string;
  budget: number;
  targets: FollowTarget[];
}

/** Pairwise hashtag affinity between persona IDs (Jaccard of hashtagPool). */
export type AffinityMatrix = Map<string, Map<string, number>>;

// --- Spec compatibility assertions ---
//
// These compile-time checks guarantee the seeder's hand-narrowed `Remote*` /
// `Activity*` shapes remain assignable to the schemas in `openapi.json`.
// `Extends<Narrow, Wide>` is `never` when `Narrow` is NOT a subtype of `Wide`,
// which makes assigning it to `true` a type error. If the platform spec
// changes a field type, renames a field, or removes one the seeder relies
// on, one of the `_assert*` constants below fails to compile — surfacing the
// drift at build time rather than runtime. To fix: regenerate via
// `pnpm openapi:gen`, then update the offending hand-narrowed type to match
// the new spec shape.
//
// Note: required→optional and narrow-union→wider-union are *both* compatible
// (subtype direction), so promoting a field from optional to required in the
// spec or widening an enum will NOT trip these — that's the safe direction.

type _Extends<Narrow, Wide> = Narrow extends Wide ? true : never;

// Bundled into a single tuple type so a failure surfaces as one diagnostic
// per drifting type, and the unused-variable check stays quiet.
//
export type _SpecCompatibility = readonly [
  _Extends<RemotePost, components['schemas']['PostSummary']>,
  _Extends<RemotePostAuthor, components['schemas']['Author']>,
  _Extends<RemoteComment, components['schemas']['Comment']>,
  _Extends<RemoteCommentAuthor, components['schemas']['CommentAuthor']>,
  _Extends<ActivityItem, components['schemas']['ActivityItem']>,
  _Extends<
    GeneratePostRequest,
    NonNullable<operations['generateImagePost']['requestBody']>['content']['application/json']
  >,
  _Extends<
    GeneratePostResponse,
    operations['generateImagePost']['responses'][201]['content']['application/json']
  >,
  _Extends<
    GenerateAvatarRequest,
    NonNullable<operations['generateAgentAvatar']['requestBody']>['content']['application/json']
  >,
  _Extends<
    GenerateAvatarResponse,
    operations['generateAgentAvatar']['responses'][201]['content']['application/json']
  >,
];
