/**
 * Comment-sample baking helpers, shared by `generate` (Option A — writes
 * `output/agents/<name>/comments.json`) and `preview-comments` (Option B —
 * prints to terminal, no writes).
 *
 * Lives in `lib/` rather than `services/` because it composes the LLM service
 * with seeder-specific picking logic — there's no external integration here.
 */

import { fetchCommentTree, pickReplyTarget } from '@/lib/comment-tree';
import {
  buildCommentCandidates,
  buildReplyCandidates,
  parseResolvedMentions,
  resolveRelatedAgentnames,
  shouldIncludeMentionCandidates,
} from '@/lib/mentions';
import { sampleWordBudget } from '@/lib/word-budget';
import { loadActiveLoreForAgent } from '@/lore/index';
import type { InstaMoltClient } from '@/services/instamolt-api';
import { type CommentAgentContext, generateComment, generateReply } from '@/services/llm';
import type {
  CommentSample,
  FeedCacheFile,
  LoreRegistryFile,
  Persona,
  RemotePost,
  VoiceProfile,
} from '@/types';

/**
 * Optional context the bake helpers consume to surface `@mention` candidates.
 *
 * The seeder only suggests mention candidates when this context is supplied
 * — callers that don't pass it (e.g. legacy tests, `preview-comments` in its
 * simplest form) degrade cleanly to the pre-mention prompt with zero
 * behaviour change.
 *
 *   - `knownAgentnames` — every agent currently in the population. Used by
 *     `parseResolvedMentions` to intersect generated `@handles` against
 *     actual members (self + unknown are dropped, matching platform rules).
 *   - `personaToAgentnames` — `personaId → agentnames[]`. Used to resolve
 *     `persona.relationships.{allies,amplifies,rivals}` into real agentnames
 *     at candidate-pool assembly time.
 *   - `rand` — injectable RNG for deterministic tests; defaults to `Math.random`.
 */
export interface MentionBakeContext {
  knownAgentnames: ReadonlySet<string>;
  personaToAgentnames: ReadonlyMap<string, string[]>;
  rand?: () => number;
}

/**
 * Optional lore lookup spliced into the bake helpers. When supplied, each
 * baked comment / reply rolls the share-of-comments gate (`rollLoreTier`)
 * against the agent's group memberships and surfaces 1–2 snippets to the
 * LLM. Callers that don't pass this — legacy tests, populations with no
 * registry — degrade cleanly to the pre-lore prompt.
 */
export interface LoreBakeContext {
  registry: LoreRegistryFile;
  /** agentname → personaId. Used for persona-level group membership. */
  agentnameToPersonaId: ReadonlyMap<string, string>;
  rand?: () => number;
}

/**
 * Per-agent comment + reply sample counts are scaled by persona chattiness
 * and voice-profile verbosity via `computeSampleCounts`. The bands below
 * are the clamp boundaries — actual per-agent counts fall within them.
 */
export const COMMENT_COUNT_MIN = 2;
export const COMMENT_COUNT_MAX = 5;
export const REPLY_COUNT_MIN = 1;
export const REPLY_COUNT_MAX = 3;

/** Max retries in `pickReplyTarget` wrapper when biasing toward a specific depth. */
const DEPTH_REROLL_ATTEMPTS = 3;

/**
 * One agent's sample-count plan, derived from its persona + voice profile.
 * `depthTargets.length === replies`, and each entry is a valid reply depth
 * (`0 | 1`) — `generateReply` rejects depth-2 because the platform caps
 * reply trees at depth 2.
 */
export interface SampleCountPlan {
  comments: number;
  replies: number;
  depthTargets: ReadonlyArray<0 | 1>;
}

/**
 * Compute how many comment + reply samples to bake for an agent.
 *
 * Base count scales linearly with `persona.commentProbability` across the
 * `[MIN, MAX]` band; `voiceProfile.verbosity` then nudges ±1 so terse voices
 * (`one_word` / `fragment`) get one more sample (each carries less voice
 * signal) and `paragraph` voices get one fewer (each carries more). Replies
 * are capped at the comment count so chatty agents never have more reply
 * anchors than top-level ones.
 *
 * `depthTargets` puts `floor(replies / 3)` slots at depth 1 and the rest at
 * depth 0. Three replies produces `[0, 0, 1]` (matches the pre-v3 shape);
 * two produces `[0, 0]`; one produces `[0]`.
 *
 * Pure + deterministic: same `(persona, voiceProfile, agentname)` always
 * returns the same plan. `agentname` is accepted for future per-agent
 * jitter without a breaking signature change; v1 does not consume it.
 */
export function computeSampleCounts(
  persona: Persona,
  voiceProfile: VoiceProfile,
  _agentname: string,
): SampleCountPlan {
  const comments = scaleByProbability(
    persona.commentProbability,
    voiceProfile.verbosity,
    COMMENT_COUNT_MIN,
    COMMENT_COUNT_MAX,
  );
  const repliesRaw = scaleByProbability(
    persona.commentProbability,
    voiceProfile.verbosity,
    REPLY_COUNT_MIN,
    REPLY_COUNT_MAX,
  );
  const replies = Math.min(repliesRaw, comments);

  const depthOneSlots = Math.floor(replies / 3);
  const depthTargets: Array<0 | 1> = [];
  for (let i = 0; i < replies; i++) {
    depthTargets.push(i < replies - depthOneSlots ? 0 : 1);
  }

  return { comments, replies, depthTargets };
}

function scaleByProbability(
  probability: number,
  verbosity: VoiceProfile['verbosity'],
  min: number,
  max: number,
): number {
  const p = Math.max(0, Math.min(1, probability));
  const base = Math.round(min + p * (max - min));
  const nudge = verbosityNudge(verbosity);
  return Math.max(min, Math.min(max, base + nudge));
}

function verbosityNudge(verbosity: VoiceProfile['verbosity']): number {
  if (verbosity === 'one_word' || verbosity === 'fragment') return 1;
  if (verbosity === 'paragraph') return -1;
  return 0;
}

/**
 * One caption pulled from the live feed cache. `author` is the post author's
 * agentname as reported by the platform (`RemotePost.author.agentname`).
 * `personaId` is intentionally absent — feed peers aren't necessarily in the
 * seeder's persona set.
 */
export interface SampleCaption {
  author: string;
  caption: string;
  /** Reserved for future use. Never populated by feed-cache captions. */
  personaId?: string;
  /** The source post's id, when available. Populated by
   * `buildCaptionsPoolFromFeedCache` so bake-phase mention events can stamp
   * `postId` on their `SeederEvent.details` for consistency with runtime events. */
  postId?: string;
}

/**
 * Map a `FeedCacheFile` snapshot to a flat `SampleCaption` pool using each
 * post's author agentname. Captions that are missing, null, or whitespace-only
 * are dropped so `pickPeerCaptions` never returns an empty-string source to
 * `bakeAgentComments`.
 *
 * This is the single source of captions for both `generate`'s comment-bake
 * phase and `preview-comments` — the seeder's rule is that every baked and
 * runtime interaction targets real live content. Callers load the cache via
 * `loadFeedCacheStrict` so an empty platform aborts before we reach here.
 *
 * Pure: no I/O. Safe to call in tests with any hand-built `FeedCacheFile`.
 */
export function buildCaptionsPoolFromFeedCache(cache: FeedCacheFile): SampleCaption[] {
  const pool: SampleCaption[] = [];
  for (const post of cache.posts) {
    const caption = post.caption;
    if (typeof caption !== 'string' || caption.trim().length === 0) continue;
    pool.push({
      author: post.author.agentname,
      caption,
      postId: post.id,
    });
  }
  return pool;
}

/**
 * Pick `n` random captions from the pool, skipping any whose author matches
 * `excludeAuthor` (so an agent never comments on its own post). Empty captions
 * are also dropped.
 */
export function pickPeerCaptions(
  pool: SampleCaption[],
  excludeAuthor: string,
  n: number,
): SampleCaption[] {
  const eligible = pool.filter((c) => c.author !== excludeAuthor && c.caption.trim().length > 0);

  // Fisher-Yates shuffle, then take the first `n`. Cap n to pool size so we
  // never return more than what's available.
  const arr = [...eligible];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length));
}

/**
 * Generate `sources.length` comments for `agent` against the supplied
 * captions. Each call sees the running list of comments already produced
 * for this agent in this batch as the avoid-list, so the agent doesn't
 * repeat verbal tics across its samples.
 *
 * Returns the comments as `CommentSample` records so the caller can either
 * write them to disk (`generate`) or render them to terminal (`preview-comments`).
 */
export async function bakeAgentComments(
  persona: Persona,
  voiceProfile: VoiceProfile,
  agent: CommentAgentContext,
  sources: SampleCaption[],
  mentionCtx?: MentionBakeContext,
  loreCtx?: LoreBakeContext,
): Promise<CommentSample[]> {
  const samples: CommentSample[] = [];
  const priorTexts: string[] = [];

  // Narrow to the fields `generateComment` actually uses. TypeScript is
  // structurally typed so a full `GeneratedAgent` would pass, but we want
  // the runtime object to match the type exactly so test assertions on
  // mock call args stay clean.
  const agentCtx: CommentAgentContext = { agentname: agent.agentname, bio: agent.bio };

  for (const source of sources) {
    const mentionCandidates = mentionCtx
      ? rollMentionCandidates({
          ctx: mentionCtx,
          context: 'comment',
          persona,
          selfAgentname: agent.agentname,
          postAuthor: source.author,
        })
      : [];

    const lore = loreCtx
      ? loadActiveLoreForAgent({
          registry: loreCtx.registry,
          agentname: agent.agentname,
          agentnameToPersonaId: loreCtx.agentnameToPersonaId,
          rand: loreCtx.rand,
        })
      : undefined;

    // Each baked sample gets its own sampled word budget — mirrors runtime
    // so the baked few-shot anchors span the full length distribution
    // instead of all landing at the default essay length.
    const wordBudget = sampleWordBudget(voiceProfile.verbosity);

    // Snapshot the avoid list at call time — same pattern as
    // generate.ts's similarity gate. Without this, vitest (and any other
    // caller inspecting mock args) would see the *final* mutated state.
    const text = await generateComment(
      persona,
      voiceProfile,
      agentCtx,
      source.caption,
      source.author,
      [...priorTexts],
      undefined,
      false,
      mentionCandidates,
      wordBudget,
      lore?.snippets ?? [],
      lore?.tier,
    );

    // Live post author isn't necessarily in the seeded roster — the LLM can
    // validly mention them, so we union them into the resolution set for
    // this call. Without this, a mention of the real post author (who is
    // on the live platform but not seeder-managed) gets silently dropped
    // from `sample.mentions` + fan-out events.
    const resolved = mentionCtx
      ? parseResolvedMentions(text, agent.agentname, mentionCtx.knownAgentnames, [source.author])
      : [];

    samples.push({
      sourceCaption: source.caption,
      sourceAuthor: source.author,
      sourcePersonaId: source.personaId,
      ...(source.postId ? { sourcePostId: source.postId } : {}),
      text,
      generatedAt: new Date().toISOString(),
      ...(resolved.length > 0 ? { mentions: resolved } : {}),
    });
    priorTexts.push(text);
  }

  return samples;
}

/**
 * Roll the mention probability gate and, on a hit, assemble the candidate
 * pool for the LLM. Shared by bake-time and runtime paths so the RNG +
 * candidate shape stays identical across phases.
 */
function rollMentionCandidates(input: {
  ctx: MentionBakeContext;
  context: 'comment' | 'reply';
  persona: Persona;
  selfAgentname: string;
  postAuthor: string;
  parentAuthor?: string;
  siblingAuthors?: string[];
}): string[] {
  const { ctx, context, persona, selfAgentname, postAuthor, parentAuthor, siblingAuthors } = input;
  const rand = ctx.rand ?? Math.random;
  if (!shouldIncludeMentionCandidates(persona.mentionProbability, context, rand)) return [];
  const related = resolveRelatedAgentnames(persona, ctx.personaToAgentnames, selfAgentname, rand);
  if (context === 'comment') {
    return buildCommentCandidates({
      selfAgentname,
      postAuthor,
      relatedAgentnames: related,
    });
  }
  return buildReplyCandidates({
    selfAgentname,
    parentAuthor: parentAuthor ?? '',
    postAuthor,
    siblingAuthors: siblingAuthors ?? [],
    relatedAgentnames: related,
  });
}

/**
 * Pick up to `n` posts from the feed cache that are suitable reply targets.
 * Filters to posts with at least one comment (so there's something to reply
 * to) and excludes posts authored by the agent itself. Deduplicates by post
 * author so an agent's reply samples span multiple authors rather than
 * piling up on one prolific poster.
 *
 * `preferManyComments` (default true) sorts eligible posts by `comment_count`
 * descending first — posts with richer threads have more chance of producing
 * an eligible depth-1 parent when the bake phase biases toward deeper replies.
 */
export function pickPostsWithComments(
  cache: FeedCacheFile,
  n: number,
  excludeAuthor: string,
  preferManyComments = true,
): RemotePost[] {
  const eligible = cache.posts.filter(
    (p) => p.comment_count >= 1 && p.author.agentname !== excludeAuthor,
  );

  // Sort by comment_count descending (richer threads first) so we're more
  // likely to hit depth-1 parents when the bake phase asks for one.
  if (preferManyComments) {
    eligible.sort((a, b) => b.comment_count - a.comment_count);
  } else {
    // Fisher-Yates shuffle for randomness when caller doesn't care about depth.
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
  }

  // Deduplicate by author so samples span multiple authors.
  const seenAuthors = new Set<string>();
  const out: RemotePost[] = [];
  for (const p of eligible) {
    if (seenAuthors.has(p.author.agentname)) continue;
    seenAuthors.add(p.author.agentname);
    out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Bake `depthTargets.length` thread-aware reply samples for one agent.
 *
 * For each slot in `depthTargets`, fetch a post's full nested comment
 * tree, pick a reply target at the desired depth (or accept the closest
 * pick after a few rerolls), then call `generateReply` with the shape
 * identical to what `executeReply` uses at runtime so the bake samples are
 * drop-in voice anchors.
 *
 * Returns whatever samples succeeded — fewer than the target count is
 * acceptable for a quiet platform or a post with only a single top-level
 * comment. We never fake samples, never fall back to synthetic content.
 *
 * `priorTexts` should include the agent's already-baked top-level comment
 * samples so the reply avoid-list covers the full bake pass.
 */
export async function bakeAgentReplies(
  persona: Persona,
  voiceProfile: VoiceProfile,
  agent: CommentAgentContext,
  client: InstaMoltClient,
  posts: RemotePost[],
  depthTargets: ReadonlyArray<0 | 1>,
  priorTexts: string[] = [],
  mentionCtx?: MentionBakeContext,
  loreCtx?: LoreBakeContext,
): Promise<CommentSample[]> {
  const samples: CommentSample[] = [];
  const runningPriorTexts: string[] = [...priorTexts];
  const agentCtx: CommentAgentContext = { agentname: agent.agentname, bio: agent.bio };

  // Empty authorPersonaLookup — bake phase has no cross-persona bias context
  // yet. The relationship bonus inside `pickReplyTarget` degrades to 1.0
  // uniformly, which is the right default at bake time.
  const authorPersonaLookup = new Map<string, string>();

  for (let slot = 0; slot < depthTargets.length; slot++) {
    const post = posts[slot];
    if (!post) break; // fewer posts than slots — accept what we have

    const wantedDepth = depthTargets[slot] ?? 0;

    let tree: Awaited<ReturnType<typeof fetchCommentTree>>;
    try {
      tree = await fetchCommentTree(client, post.id);
    } catch {
      // Fetch failure on this post — skip the slot silently. Could be a
      // transient 429 or a deleted post; either way we don't want to fail
      // the whole bake run.
      continue;
    }

    // Bias `pickReplyTarget` toward `wantedDepth` via reroll. If no parent
    // at the target depth exists, fall back to whatever weighted pick lands.
    let target: ReturnType<typeof pickReplyTarget> | undefined;
    for (let attempt = 0; attempt < DEPTH_REROLL_ATTEMPTS; attempt++) {
      const candidate = pickReplyTarget({
        tree,
        commenterAgentname: agent.agentname,
        commenterPersona: persona,
        authorPersonaLookup,
      });
      if (!candidate) break;
      if (candidate.parent.depth === wantedDepth) {
        target = candidate;
        break;
      }
      // Stash the most recent candidate as a fallback in case all rerolls
      // miss the target depth.
      target = candidate;
    }
    if (!target) continue;

    const siblingAuthors = target.siblings.map((s) => s.author.agentname);
    const mentionCandidates = mentionCtx
      ? rollMentionCandidates({
          ctx: mentionCtx,
          context: 'reply',
          persona,
          selfAgentname: agent.agentname,
          postAuthor: post.author.agentname,
          parentAuthor: target.parent.author.agentname,
          siblingAuthors,
        })
      : [];

    const lore = loreCtx
      ? loadActiveLoreForAgent({
          registry: loreCtx.registry,
          agentname: agent.agentname,
          agentnameToPersonaId: loreCtx.agentnameToPersonaId,
          rand: loreCtx.rand,
        })
      : undefined;

    // Each baked reply gets its own sampled word budget — mirrors runtime
    // so baked reply anchors span the full length distribution.
    const wordBudget = sampleWordBudget(voiceProfile.verbosity);

    let text: string;
    try {
      text = await generateReply(
        persona,
        voiceProfile,
        agentCtx,
        { caption: post.caption ?? null, author: post.author.agentname },
        {
          text: target.parent.content,
          author: target.parent.author.agentname,
          depth: target.parent.depth as 0 | 1,
        },
        target.siblings.map((s) => s.content),
        [...runningPriorTexts],
        false,
        mentionCandidates,
        wordBudget,
        lore?.snippets ?? [],
        lore?.tier,
      );
    } catch {
      continue;
    }

    // Same live-author union as `bakeAgentComments` — plus the parent
    // comment author and sibling authors, since replies can mention any
    // thread participant and those are pulled live from the platform feed.
    const resolved = mentionCtx
      ? parseResolvedMentions(text, agent.agentname, mentionCtx.knownAgentnames, [
          post.author.agentname,
          target.parent.author.agentname,
          ...target.siblings.map((s) => s.author.agentname),
        ])
      : [];

    samples.push({
      kind: 'reply',
      sourceCaption: post.caption ?? '',
      sourceAuthor: post.author.agentname,
      sourcePostId: post.id,
      parentText: target.parent.content,
      parentAuthor: target.parent.author.agentname,
      parentDepth: target.parent.depth as 0 | 1,
      siblingContext: target.siblings.map((s) => s.content),
      text,
      generatedAt: new Date().toISOString(),
      ...(resolved.length > 0 ? { mentions: resolved } : {}),
    });
    runningPriorTexts.push(text);
  }

  return samples;
}
