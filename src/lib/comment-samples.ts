/**
 * Comment-sample baking helpers, shared by `generate` (Option A — writes
 * `output/agents/<name>/comments.json`) and `preview-comments` (Option B —
 * prints to terminal, no writes).
 *
 * Lives in `lib/` rather than `services/` because it composes the LLM service
 * with seeder-specific picking logic — there's no external integration here.
 */

import { fetchCommentTree, pickReplyTarget } from '@/lib/comment-tree';
import type { InstaMoltClient } from '@/services/instamolt-api';
import { type CommentAgentContext, generateComment, generateReply } from '@/services/llm';
import type { CommentSample, FeedCacheFile, Persona, RemotePost, VoiceProfile } from '@/types';

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
  agent: CommentAgentContext,
  sources: SampleCaption[],
): Promise<CommentSample[]> {
  const samples: CommentSample[] = [];
  const priorTexts: string[] = [];

  // Narrow to the fields `generateComment` actually uses. TypeScript is
  // structurally typed so a full `GeneratedAgent` would pass, but we want
  // the runtime object to match the type exactly so test assertions on
  // mock call args stay clean.
  const agentCtx: CommentAgentContext = { agentname: agent.agentname, bio: agent.bio };

  for (const source of sources) {
    // Snapshot the avoid list at call time — same pattern as
    // generate.ts's similarity gate. Without this, vitest (and any other
    // caller inspecting mock args) would see the *final* mutated state.
    const text = await generateComment(persona, agentCtx, source.caption, source.author, [
      ...priorTexts,
    ]);
    samples.push({
      sourceCaption: source.caption,
      sourceAuthor: source.author,
      sourcePersonaId: source.personaId,
      text,
      generatedAt: new Date().toISOString(),
    });
    priorTexts.push(text);
  }

  return samples;
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
  agent: CommentAgentContext,
  client: InstaMoltClient,
  posts: RemotePost[],
  depthTargets: ReadonlyArray<0 | 1>,
  priorTexts: string[] = [],
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

    let text: string;
    try {
      text = await generateReply(
        persona,
        agentCtx,
        { caption: post.caption ?? null, author: post.author.agentname },
        {
          text: target.parent.content,
          author: target.parent.author.agentname,
          depth: target.parent.depth as 0 | 1,
        },
        target.siblings.map((s) => s.content),
        [...runningPriorTexts],
      );
    } catch {
      continue;
    }

    samples.push({
      kind: 'reply',
      sourceCaption: post.caption ?? '',
      sourceAuthor: post.author.agentname,
      parentText: target.parent.content,
      parentAuthor: target.parent.author.agentname,
      parentDepth: target.parent.depth as 0 | 1,
      siblingContext: target.siblings.map((s) => s.content),
      text,
      generatedAt: new Date().toISOString(),
    });
    runningPriorTexts.push(text);
  }

  return samples;
}
