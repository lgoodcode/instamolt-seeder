/**
 * Shared action executors for the continuous engage scheduler.
 *
 * Each executor is a pure pipeline for ONE action kind:
 *
 *   checkAvailability  →  pick target from server state  →  generate text (LLM)
 *   →  dry-run short-circuit or real API call  →  consume quota + persist
 *   →  optional runtime-comments append  →  return ActionResult
 *
 * All executors share the same `(ctx, agent, persona, quota) → ActionResult`
 * shape so the scheduler's `dispatchAction` can route generically. Quota is
 * only consumed on success — skipped / error results leave the quota intact
 * so the agent can try again on the next tick.
 *
 * **Not called by cycle-mode engage.** `src/commands/engage.ts` keeps its
 * own inline action loop intentionally (per the "don't rewrite working
 * code" rule). These executors are only consumed by `engage-continuous.ts`.
 *
 * **Dry-run mode:** every executor honors `ctx.dryRun` — in that mode the
 * external side effect is skipped, but the full target-resolution and LLM
 * call still run so the logs show what WOULD have happened. Quota is NOT
 * consumed in dry-run so a dry-run pass doesn't poison the next live run.
 *
 * Reply executors (`executeReply`, `executeActivityDrivenReply`) live
 * alongside these in Phase 6.
 */

import { REPLY_FALLBACK_TO_COMMENT, SAME_REGISTER_CAP, SAME_REGISTER_WINDOW_MS } from '@/config';
import {
  type CommentNode,
  fetchCommentTree,
  flattenTree,
  pickReplyTarget,
} from '@/lib/comment-tree';
import { logEvent, logMentions } from '@/lib/event-logger';
import { type LiveFeedCache, markEngaged, pickPost } from '@/lib/feed-cache';
import {
  buildCommentCandidates,
  buildMentionLookup,
  buildReplyCandidates,
  parseResolvedMentions,
  resolveRelatedAgentnames,
  shouldIncludeMentionCandidates,
} from '@/lib/mentions';
import { checkAvailability, consume, persistQuota } from '@/lib/quota';
import { pickRegisterHint, pivotRegister, relationshipMultiplier } from '@/lib/relationships';
import {
  appendRuntimeComment,
  loadPriorComments,
  loadRuntimeCommentsFile,
} from '@/lib/runtime-comments';
import { appendGlobalComment, recentRegistersForPost } from '@/lib/runtime-global-log';
import { rollTrendingHashtags } from '@/lib/trending-pool';
import { sampleWordBudget } from '@/lib/word-budget';
import { loadActiveLoreForAgent, parseResolvedLoreReferences } from '@/lore/index';
import { type InstaMoltClient, ParentDeletedError } from '@/services/instamolt-api';
import { generateComment, generatePostContent, generateReply, rollChaos } from '@/services/llm';
import type {
  ActionKind,
  ActivityItem,
  AgentQuota,
  CommentRegister,
  FeedCacheFile,
  FeedSource,
  GeneratedAgent,
  Persona,
  RemoteComment,
  RemotePost,
  VoiceProfile,
} from '@/types';
import { resolveVoiceProfile } from '@/voice-profiles/index';

export interface EngageContext {
  client: InstaMoltClient;
  feedCache: FeedCacheFile | LiveFeedCache;
  personas: Map<string, Persona>;
  voiceProfiles: Map<string, VoiceProfile>;
  authorPersonaLookup: Map<string, string>;
  dryRun: boolean;
  /** Optional shared lore registry. When supplied, comment + reply
   * executors roll the lore-share gate and pass snippets through to the
   * LLM. Continuous engage loads this once at scheduler init and threads
   * it into every per-tick context. */
  loreRegistry?: import('@/types').LoreRegistryFile;
}

export type ActionResult =
  | {
      status: 'ok';
      kind: ActionKind;
      detail: string;
      bonusEligible?: boolean;
      /** True when the persona's chaosProbability fired for this generation.
       * Only set on content-producing actions (post/comment/reply). Used by
       * the scheduler to tag event-logger entries so strike hit rates can be
       * correlated to chaos rolls. */
      chaos?: boolean;
    }
  | { status: 'skipped'; kind: ActionKind; reason: string }
  | { status: 'error'; kind: ActionKind; error: string };

/**
 * Per-persona source weights used by `buildPostScorer`. Composes with the
 * positional decay + popularity term so a `community` persona still engages
 * with explore/hot content, just with a gentler pull than `/posts?sort=new`.
 */
const SOURCE_WEIGHTS: Record<NonNullable<Persona['feedPreference']>, Record<FeedSource, number>> = {
  trendsetter: { explore: 0.15, hot: 0.5, top: 0.1, new: 0.25 },
  community: { explore: 0.2, hot: 0.15, top: 0.15, new: 0.5 },
  explorer: { explore: 0.45, hot: 0.15, top: 0.25, new: 0.15 },
};

/** Positional decay slope. `1 / (1 + k * rank)` gives rank=10 → ~0.5× weight,
 * rank=20 → ~0.33×, rank=50 → ~0.17×. Models attention drop-off with scroll
 * depth. Tuned so even rank=100 posts are still non-negligible (~0.09×) but
 * the #1 post dominates the pick distribution. */
const POSITIONAL_DECAY_K = 0.1;

/**
 * Build a persona-aware scoring function for `pickPost`. Combines four terms:
 *
 *   1. `relationshipMultiplier` — graph-aware bonus (targets 2.0×, allies 1.2×, etc.)
 *   2. `popularityTerm` — blended `log1p(popularity) + log1p(velocity)` so both
 *      the platform's decayed score AND raw trending velocity nudge the pick
 *   3. `positionalDecay` — `1 / (1 + k × rank)` against each post's source rank
 *      so higher-ranked posts are exponentially more likely to be picked
 *   4. `sourceWeight` — per-persona feed-source bias so a `trendsetter` chases
 *      hot content while a `community` persona leans on /sort=new
 *
 * Mirrors how human attention actually works: scrolling a ranked feed with
 * decaying focus, preferring trending + recent posts, pulled harder toward
 * authors they have a relationship with.
 */
function buildPostScorer(
  persona: Persona,
  authorPersonaLookup: Map<string, string>,
): (post: RemotePost) => number {
  const pref = persona.feedPreference ?? 'explorer';
  const sourceWeightMap = SOURCE_WEIGHTS[pref];
  return (post) => {
    const authorPid = authorPersonaLookup.get(post.author.agentname);
    const rel = relationshipMultiplier(persona, authorPid);
    const rank = post._sourceRank ?? 0;
    const source = post._source ?? 'explore';
    const positionalDecay = 1 / (1 + POSITIONAL_DECAY_K * rank);
    const popularityTerm =
      1 +
      0.6 * Math.log1p(Math.max(0, post.popularity_score)) +
      0.4 * Math.log1p(Math.max(0, post.velocity_score ?? 0));
    const sourceWeight = sourceWeightMap[source] ?? 1.0;
    return rel * popularityTerm * positionalDecay * sourceWeight;
  };
}

/**
 * Common availability gate: if the kind isn't available, return a skipped
 * result. Keeps every executor's top-line uniform.
 */
function gate(quota: AgentQuota, kind: ActionKind): ActionResult | null {
  const avail = checkAvailability(quota, kind);
  if (avail.ok) return null;
  return { status: 'skipped', kind, reason: avail.reason };
}

export async function executeLike(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
): Promise<ActionResult> {
  const gated = gate(quota, 'like');
  if (gated) return gated;

  const post = pickPost(ctx.feedCache, {
    excludeAuthor: agent.agentname,
    agentname: agent.agentname,
    score: buildPostScorer(persona, ctx.authorPersonaLookup),
  });
  if (!post) return { status: 'skipped', kind: 'like', reason: 'no_candidate_post' };

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: 'like',
      detail: `[DRY] would like post ${post.id} by @${post.author.agentname}`,
    };
  }

  try {
    const res = await ctx.client.likePost(post.id);
    // The endpoint is a TOGGLE per openapi.json: a second call un-likes.
    // If the response says we just un-liked (we'd previously liked this
    // post in a prior cycle), re-toggle to restore the intended state.
    // Quota is consumed once since the net user-visible action is one like.
    if (res.liked === false) {
      try {
        await ctx.client.likePost(post.id);
      } catch (err) {
        return { status: 'error', kind: 'like', error: `re-toggle failed: ${err}` };
      }
    }
  } catch (err) {
    return { status: 'error', kind: 'like', error: String(err) };
  }

  consume(quota, 'like');
  await persistQuota(quota);
  if ('file' in ctx.feedCache) markEngaged(ctx.feedCache, agent.agentname, post.id);
  return {
    status: 'ok',
    kind: 'like',
    detail: `liked post ${post.id} by @${post.author.agentname}`,
  };
}

export async function executeComment(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
  opts?: { post?: RemotePost; consumeAs?: ActionKind },
): Promise<ActionResult> {
  // The `consumeAs` override lets the reply-fallback path reuse this
  // executor while charging the caller's original quota bucket (e.g.
  // `reply`) rather than `comment`. The gate + consume + result `kind`
  // all follow `consumeAs` when provided so the call site's semantics
  // are preserved end-to-end.
  const consumeAs: ActionKind = opts?.consumeAs ?? 'comment';
  const gated = gate(quota, consumeAs);
  if (gated) return gated;

  const post =
    opts?.post ??
    pickPost(ctx.feedCache, {
      excludeAuthor: agent.agentname,
      agentname: agent.agentname,
      score: buildPostScorer(persona, ctx.authorPersonaLookup),
    });
  if (!post) return { status: 'skipped', kind: consumeAs, reason: 'no_candidate_post' };
  if (!post.caption) {
    return { status: 'skipped', kind: consumeAs, reason: 'post_has_no_caption' };
  }

  const priorComments = await loadPriorComments(agent.agentname);
  const authorPid = ctx.authorPersonaLookup.get(post.author.agentname);
  const initialRegisterHint = pickRegisterHint(persona, authorPid);
  const chaos = rollChaos(persona);

  // Tier 1 COMMENT → REPLY substitution: on posts authored by a Tier 1
  // persona, a top-level comment tick has a 35% chance to become a reply
  // instead, creating visible thread density on the leaderboard-climbing
  // agents' posts. Only fires when this is a genuine comment action (not
  // a reply fallback already routed through `consumeAs: 'reply'`) and
  // `executeReply` is available to consume it from.
  if (consumeAs === 'comment' && !opts?.post) {
    const postAuthorPersona = authorPid ? ctx.personas.get(authorPid) : undefined;
    if (postAuthorPersona?.engagementTier === 1 && Math.random() < 0.35) {
      // Substitute: run executeReply directly. It will pick its own post
      // (weighted-random, with Tier 1 bias) — accepting that the specific
      // `post` we just picked might not be the one it ends up replying to.
      // That's fine: the goal is "spend this tick on a threaded reply"
      // not "thread-reply on this exact post."
      return executeReply(ctx, agent, persona, quota);
    }
  }

  // Same-register cap: count recent seeder comments on this post by register.
  // Any register that's already hit `SAME_REGISTER_CAP` gets pivoted down the
  // fallback chain (disagree → conversational → love → skip). Only applies
  // when there IS a register hint — unclassified comments don't count toward
  // the cap and pass through unchanged.
  let registerHint: CommentRegister | undefined = initialRegisterHint;
  if (initialRegisterHint) {
    const recent = await recentRegistersForPost(post.id, SAME_REGISTER_WINDOW_MS);
    const counts = recent.reduce<Record<string, number>>((acc, r) => {
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});
    const saturated = new Set<string>();
    for (const [reg, count] of Object.entries(counts)) {
      if (count >= SAME_REGISTER_CAP) saturated.add(reg);
    }
    const pivoted = pivotRegister(initialRegisterHint, saturated);
    if (!pivoted) {
      return {
        status: 'skipped',
        kind: consumeAs,
        reason: `register_saturated:${initialRegisterHint}`,
      };
    }
    registerHint = pivoted;
  }

  // Resolve the agent's voice profile — drives the formatVoiceBlock + shape
  // allowlist in `generateComment` and the verbosity-shifted word budget.
  // A missing profile is a hard error upstream of this function (agents are
  // assigned one at generate time), so we surface it as an action error.
  const resolvedVoice = resolveVoiceProfile(ctx.voiceProfiles, agent);
  if ('error' in resolvedVoice) {
    return { status: 'error', kind: consumeAs, error: resolvedVoice.error };
  }
  const voiceProfile = resolvedVoice.profile;
  const wordBudget = sampleWordBudget(voiceProfile.verbosity);

  // Lazy mention-lookup cache — `buildMentionLookup` walks the full agent
  // map, so defer it until either the probability gate passes (for
  // candidate surfacing) or the generated text actually contains `@` (for
  // post-hoc parsing). On the hot path (persona with `mentionProbability
  // = 0` and no `@` in the output), we skip both.
  let mentionStateCache: ReturnType<typeof buildMentionLookup> | undefined;
  const getMentionState = (): ReturnType<typeof buildMentionLookup> => {
    mentionStateCache ??= buildMentionLookup(ctx.authorPersonaLookup);
    return mentionStateCache;
  };

  const mentionCandidates = shouldIncludeMentionCandidates(persona.mentionProbability, 'comment')
    ? buildCommentCandidates({
        selfAgentname: agent.agentname,
        postAuthor: post.author.agentname,
        relatedAgentnames: resolveRelatedAgentnames(
          persona,
          getMentionState().personaToAgentnames,
          agent.agentname,
        ),
      })
    : [];

  // Lore allusion roll. No-op when ctx.loreRegistry is undefined (the
  // continuous scheduler always sets it once registry exists, but unit
  // tests skip it).
  const lore = ctx.loreRegistry
    ? loadActiveLoreForAgent({
        registry: ctx.loreRegistry,
        agentname: agent.agentname,
        agentnameToPersonaId: ctx.authorPersonaLookup,
      })
    : { tier: undefined, snippets: [], groups: [] };

  let text: string;
  try {
    text = await generateComment(
      persona,
      voiceProfile,
      { agentname: agent.agentname, bio: agent.bio },
      post.caption,
      post.author.agentname,
      [...priorComments],
      registerHint,
      chaos,
      mentionCandidates,
      wordBudget,
      lore.snippets,
      lore.tier,
    );
  } catch (err) {
    return { status: 'error', kind: consumeAs, error: `llm: ${err}` };
  }

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: consumeAs,
      detail: `[DRY] would comment on post ${post.id} by @${post.author.agentname}: "${text.slice(0, 60)}"`,
      ...(chaos ? { chaos: true } : {}),
    };
  }

  let commentResponse: Awaited<ReturnType<typeof ctx.client.commentOnPost>>;
  try {
    commentResponse = await ctx.client.commentOnPost(post.id, text);
  } catch (err) {
    return { status: 'error', kind: consumeAs, error: String(err) };
  }

  consume(quota, consumeAs);
  await persistQuota(quota);
  if ('file' in ctx.feedCache) markEngaged(ctx.feedCache, agent.agentname, post.id);
  await appendRuntimeComment(agent.agentname, {
    text,
    postId: post.id,
    againstAuthor: post.author.agentname,
  });
  // Feed the cross-agent cap query. `register` is omitted when there's no
  // relationship hint so the cap only applies to classifiable comments.
  await appendGlobalComment({
    postId: post.id,
    agentname: agent.agentname,
    register: registerHint,
    kind: 'comment',
  });

  // Mention fan-out — emit after the comment succeeds so stats.mentions
  // only credits resolvable targets that landed on the platform. Cheap
  // `text.includes('@')` short-circuit avoids the full-population
  // `buildMentionLookup` walk on the overwhelming majority of comments
  // that have no `@` in the body.
  if (text.includes('@')) {
    const resolvedMentions = parseResolvedMentions(
      text,
      agent.agentname,
      getMentionState().knownAgentnames,
      // Live post author isn't necessarily seeder-managed — platform
      // accepts `@` for any registered handle, so union the post author
      // into the resolution set for this call.
      [post.author.agentname],
    );
    if (resolvedMentions.length > 0) {
      logMentions({
        agentname: agent.agentname,
        persona: persona.id,
        targets: resolvedMentions,
        context: 'comment',
        phase: 'runtime',
        postId: post.id,
        sourceCommentId: commentResponse.comment.id,
      });
    }
  }
  // Lore reference resolution — was a surfaced snippet alluded to in the
  // generated text? One event per matched snippet.
  if (lore.snippets.length > 0) {
    const refs = parseResolvedLoreReferences(text, lore.snippets);
    for (const ref of refs) {
      logEvent({
        eventType: 'lore_referenced',
        agentname: agent.agentname,
        persona: persona.id,
        success: true,
        details: {
          groupId: ref.groupId,
          entryId: ref.entryId,
          tier: lore.tier,
          context: 'comment',
          postId: post.id,
          sourceCommentId: commentResponse.comment.id,
        },
      });
    }
  }

  return {
    status: 'ok',
    kind: consumeAs,
    detail: `commented on @${post.author.agentname}: "${text.slice(0, 40)}..."`,
    ...(chaos ? { chaos: true } : {}),
  };
}

export async function executeFollow(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
): Promise<ActionResult> {
  const gated = gate(quota, 'follow');
  if (gated) return gated;

  const post = pickPost(ctx.feedCache, {
    excludeAuthor: agent.agentname,
    agentname: agent.agentname,
    score: buildPostScorer(persona, ctx.authorPersonaLookup),
  });
  if (!post) return { status: 'skipped', kind: 'follow', reason: 'no_candidate_post' };

  const target = post.author.agentname;

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: 'follow',
      detail: `[DRY] would follow @${target}`,
    };
  }

  try {
    const res = await ctx.client.followAgent(target);
    // The endpoint is a TOGGLE per openapi.json: a second call unfollows.
    // If the response says we just unfollowed (i.e. we'd already followed
    // this agent in a prior cycle), re-toggle to restore the intended
    // state. Quota is consumed once since the net user-visible action is
    // one follow. Genuine 400/409 errors (e.g. self-follow) propagate.
    if (res.following === false) {
      try {
        await ctx.client.followAgent(target);
      } catch (err) {
        return { status: 'error', kind: 'follow', error: `re-toggle failed: ${err}` };
      }
    }
  } catch (err) {
    return { status: 'error', kind: 'follow', error: String(err) };
  }

  consume(quota, 'follow');
  await persistQuota(quota);
  if ('file' in ctx.feedCache) markEngaged(ctx.feedCache, agent.agentname, post.id);
  return { status: 'ok', kind: 'follow', detail: `followed @${target}` };
}

export async function executePost(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
): Promise<ActionResult> {
  const gated = gate(quota, 'post');
  if (gated) return gated;

  if (!agent.apiKey) {
    return { status: 'skipped', kind: 'post', reason: 'no_api_key' };
  }

  const resolved = resolveVoiceProfile(ctx.voiceProfiles, agent);
  if ('error' in resolved) {
    return { status: 'error', kind: 'post', error: resolved.error };
  }
  const voiceProfile = resolved.profile;

  const chaos = rollChaos(persona);
  const trendingHashtags = await rollTrendingHashtags(persona);
  let content: Awaited<ReturnType<typeof generatePostContent>>;
  try {
    content = await generatePostContent(
      persona,
      voiceProfile,
      1,
      1,
      [],
      [],
      chaos,
      trendingHashtags,
    );
  } catch (err) {
    return { status: 'error', kind: 'post', error: `llm: ${err}` };
  }

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: 'post',
      detail: `[DRY] would create post: "${content.caption.slice(0, 60)}"`,
      ...(chaos ? { chaos: true } : {}),
    };
  }

  let result: Awaited<ReturnType<typeof ctx.client.generatePost>>;
  try {
    result = await ctx.client.generatePost({
      prompt: content.imagePrompt,
      caption: content.caption,
      aspect_ratio: content.aspectRatio,
    });
  } catch (err) {
    return { status: 'error', kind: 'post', error: String(err) };
  }

  consume(quota, 'post');
  await persistQuota(quota);
  return {
    status: 'ok',
    kind: 'post',
    detail: `posted ${result.post.id}: "${content.caption.slice(0, 40)}..."`,
    ...(chaos ? { chaos: true } : {}),
  };
}

export async function executeCommentLike(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
): Promise<ActionResult> {
  const gated = gate(quota, 'commentLike');
  if (gated) return gated;

  // Only posts with at least one comment are viable targets for liking
  // a comment. The feed cache's `comment_count` is the server-reported
  // count so this filter is accurate.
  const post = pickPost(ctx.feedCache, {
    excludeAuthor: agent.agentname,
    agentname: agent.agentname,
    minCommentCount: 1,
    score: buildPostScorer(persona, ctx.authorPersonaLookup),
  });
  if (!post) {
    return { status: 'skipped', kind: 'commentLike', reason: 'no_post_with_comments' };
  }

  let tree: CommentNode[];
  try {
    tree = await fetchCommentTree(ctx.client, post.id);
  } catch (err) {
    return { status: 'error', kind: 'commentLike', error: `fetch_tree: ${err}` };
  }

  // Pick the most relationship-relevant non-self comment. Weighting is
  // relationship × (1 + like_count) so comments that are already popular
  // get a modest extra bump.
  const flat = flattenTree(tree).filter((c) => c.author.agentname !== agent.agentname);
  if (flat.length === 0) {
    return {
      status: 'skipped',
      kind: 'commentLike',
      reason: 'no_likeable_comments',
    };
  }

  const weighted = flat.map((c) => {
    const authorPid = ctx.authorPersonaLookup.get(c.author.agentname);
    const rel = relationshipMultiplier(persona, authorPid);
    return { comment: c, weight: rel * (1 + c.like_count) };
  });
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) {
    return { status: 'skipped', kind: 'commentLike', reason: 'zero_weight' };
  }
  let r = Math.random() * total;
  let chosen = weighted[0]?.comment;
  for (const { comment, weight } of weighted) {
    r -= weight;
    if (r <= 0) {
      chosen = comment;
      break;
    }
  }
  if (!chosen) {
    return { status: 'skipped', kind: 'commentLike', reason: 'no_chosen' };
  }

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: 'commentLike',
      detail: `[DRY] would like comment ${chosen.id} by @${chosen.author.agentname}`,
    };
  }

  try {
    await ctx.client.likeComment(post.id, chosen.id);
  } catch (err) {
    return { status: 'error', kind: 'commentLike', error: String(err) };
  }

  consume(quota, 'commentLike');
  await persistQuota(quota);
  if ('file' in ctx.feedCache) markEngaged(ctx.feedCache, agent.agentname, post.id);
  return {
    status: 'ok',
    kind: 'commentLike',
    detail: `liked comment ${chosen.id} by @${chosen.author.agentname}`,
  };
}

/**
 * Feed-driven reply — pick a post from the feed cache (prefer ones with
 * active comment threads), fetch its full comment tree, weight-pick a
 * depth<2 comment to reply to, generate a reply in voice, and post it.
 *
 * Falls back to a top-level `executeComment` on the same post when no
 * eligible parent exists AND `REPLY_FALLBACK_TO_COMMENT` is enabled.
 *
 * Parent-existence invariant: the parent_comment_id is always resolved
 * from a tree fetched within this same tick, so it must exist on the
 * server right now. If it disappears between fetch and POST, the
 * `ParentDeletedError` catch returns 'skipped' WITHOUT consuming quota.
 */
export async function executeReply(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
): Promise<ActionResult> {
  const gated = gate(quota, 'reply');
  if (gated) return gated;

  const post = pickPost(ctx.feedCache, {
    excludeAuthor: agent.agentname,
    agentname: agent.agentname,
    minCommentCount: 1,
    score: buildPostScorer(persona, ctx.authorPersonaLookup),
  });
  if (!post) return { status: 'skipped', kind: 'reply', reason: 'no_post_with_comments' };

  let tree: CommentNode[];
  try {
    tree = await fetchCommentTree(ctx.client, post.id);
  } catch (err) {
    return { status: 'error', kind: 'reply', error: `fetch_tree: ${err}` };
  }

  // Resolve post author's tier so pickReplyTarget can bias depth>0 parents
  // on Tier 1 posts (deeper threads → observer-visible activity).
  const postAuthorPid = ctx.authorPersonaLookup.get(post.author.agentname);
  const postAuthorPersona = postAuthorPid ? ctx.personas.get(postAuthorPid) : undefined;
  const target = pickReplyTarget({
    tree,
    commenterAgentname: agent.agentname,
    commenterPersona: persona,
    authorPersonaLookup: ctx.authorPersonaLookup,
    authorTier: postAuthorPersona?.engagementTier,
  });

  if (!target) {
    if (REPLY_FALLBACK_TO_COMMENT) {
      // Drop a top-level comment on the SAME post we already picked (and
      // whose tree we already fetched) rather than re-entering pickPost.
      // The reply slot consumes reply quota — not comment quota — so the
      // agent's engagement budget stays faithful to the scheduled action.
      return executeComment(ctx, agent, persona, quota, { post, consumeAs: 'reply' });
    }
    return { status: 'skipped', kind: 'reply', reason: 'no_eligible_parent' };
  }

  const priorComments = await loadPriorComments(agent.agentname);
  const chaos = rollChaos(persona);

  const resolvedVoice = resolveVoiceProfile(ctx.voiceProfiles, agent);
  if ('error' in resolvedVoice) {
    return { status: 'error', kind: 'reply', error: resolvedVoice.error };
  }
  const voiceProfile = resolvedVoice.profile;
  const wordBudget = sampleWordBudget(voiceProfile.verbosity);

  let mentionStateCache: ReturnType<typeof buildMentionLookup> | undefined;
  const getMentionState = (): ReturnType<typeof buildMentionLookup> => {
    mentionStateCache ??= buildMentionLookup(ctx.authorPersonaLookup);
    return mentionStateCache;
  };

  const mentionCandidates = shouldIncludeMentionCandidates(persona.mentionProbability, 'reply')
    ? buildReplyCandidates({
        selfAgentname: agent.agentname,
        parentAuthor: target.parent.author.agentname,
        postAuthor: post.author.agentname,
        siblingAuthors: target.siblings.map((s) => s.author.agentname),
        relatedAgentnames: resolveRelatedAgentnames(
          persona,
          getMentionState().personaToAgentnames,
          agent.agentname,
        ),
      })
    : [];

  const lore = ctx.loreRegistry
    ? loadActiveLoreForAgent({
        registry: ctx.loreRegistry,
        agentname: agent.agentname,
        agentnameToPersonaId: ctx.authorPersonaLookup,
      })
    : { tier: undefined, snippets: [], groups: [] };

  let text: string;
  try {
    text = await generateReply(
      persona,
      voiceProfile,
      { agentname: agent.agentname, bio: agent.bio },
      { caption: post.caption ?? null, author: post.author.agentname },
      {
        text: target.parent.content,
        author: target.parent.author.agentname,
        depth: target.parent.depth as 0 | 1,
      },
      target.siblings.map((s) => s.content),
      [...priorComments],
      chaos,
      mentionCandidates,
      wordBudget,
      lore.snippets,
      lore.tier,
    );
  } catch (err) {
    return { status: 'error', kind: 'reply', error: `llm: ${err}` };
  }

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: 'reply',
      detail: `[DRY] would reply to ${target.parent.id} on post ${post.id}: "${text.slice(0, 60)}"`,
      ...(chaos ? { chaos: true } : {}),
    };
  }

  let replyResponse: Awaited<ReturnType<typeof ctx.client.commentOnPost>>;
  try {
    replyResponse = await ctx.client.commentOnPost(post.id, text, target.parent.id);
  } catch (err) {
    if (err instanceof ParentDeletedError) {
      return { status: 'skipped', kind: 'reply', reason: 'parent_deleted' };
    }
    return { status: 'error', kind: 'reply', error: String(err) };
  }

  consume(quota, 'reply');
  await persistQuota(quota);
  if ('file' in ctx.feedCache) markEngaged(ctx.feedCache, agent.agentname, post.id);
  await appendRuntimeComment(agent.agentname, {
    text,
    postId: post.id,
    parentCommentId: target.parent.id,
    depth: (target.parent.depth + 1) as 1 | 2,
    againstAuthor: target.parent.author.agentname,
  });
  // Replies don't carry a registerHint (reply voice is anchored in parent
  // tone), so `register` is always undefined here — recent-replies counts
  // still flow into the global log but never count toward the cap.
  await appendGlobalComment({
    postId: post.id,
    agentname: agent.agentname,
    kind: 'reply',
  });

  if (text.includes('@')) {
    const resolvedMentions = parseResolvedMentions(
      text,
      agent.agentname,
      getMentionState().knownAgentnames,
      // Live thread participants (post author, parent author, sibling
      // authors) aren't necessarily seeder-managed — union them in so
      // the platform's broader `@`-resolution surface is mirrored here.
      [
        post.author.agentname,
        target.parent.author.agentname,
        ...target.siblings.map((s) => s.author.agentname),
      ],
    );
    if (resolvedMentions.length > 0) {
      logMentions({
        agentname: agent.agentname,
        persona: persona.id,
        targets: resolvedMentions,
        context: 'reply',
        phase: 'runtime',
        postId: post.id,
        sourceCommentId: replyResponse.comment.id,
      });
    }
  }
  if (lore.snippets.length > 0) {
    const refs = parseResolvedLoreReferences(text, lore.snippets);
    for (const ref of refs) {
      logEvent({
        eventType: 'lore_referenced',
        agentname: agent.agentname,
        persona: persona.id,
        success: true,
        details: {
          groupId: ref.groupId,
          entryId: ref.entryId,
          tier: lore.tier,
          context: 'reply',
          postId: post.id,
          sourceCommentId: replyResponse.comment.id,
        },
      });
    }
  }

  return {
    status: 'ok',
    kind: 'reply',
    detail: `replied to @${target.parent.author.agentname} in thread on @${post.author.agentname}`,
    ...(chaos ? { chaos: true } : {}),
  };
}

/**
 * Reciprocity-flavored reply: drain the agent's own /agents/me/activity
 * feed for inbound comment/reply events and respond to one. This is the
 * "agent replies to commenters on their own content" flow the user asked
 * for — reactive rather than exploratory.
 *
 * Dedup: every successfully-posted activity-driven reply records its
 * `repliedToActivityId` in runtime-comments.json. On load we skip any
 * activity whose id is already in that list, so we never respond to the
 * same inbound event twice. Once an activity rolls off the 50-entry
 * runtime cache, it becomes eligible again — at which point the server's
 * duplicate-text dedup catches any exact repeats.
 */
export async function executeActivityDrivenReply(
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
): Promise<ActionResult> {
  const gated = gate(quota, 'reply');
  if (gated) return gated;

  let feed: { activities: ActivityItem[] };
  try {
    feed = await ctx.client.getMyActivity({
      limit: 30,
      types: ['comment', 'reply'],
    });
  } catch (err) {
    return { status: 'error', kind: 'reply', error: `activity_fetch: ${err}` };
  }

  // Build the already-replied set from runtime-comments.json so we don't
  // respond to the same activity twice.
  const runtime = await loadRuntimeCommentsFile(agent.agentname);
  const alreadyReplied = new Set<string>();
  for (const entry of runtime.comments) {
    if (entry.repliedToActivityId) alreadyReplied.add(entry.repliedToActivityId);
  }

  const candidates = (feed.activities ?? []).filter((a) => {
    if (alreadyReplied.has(a.id)) return false;
    if (!a.post || !a.comment) return false;
    if (a.actor.agentname === agent.agentname) return false;
    return true;
  });

  if (candidates.length === 0) {
    return {
      status: 'skipped',
      kind: 'reply',
      reason: 'no_fresh_inbound_activity',
    };
  }

  // Most-recent-first is the server's default ordering; just take the head.
  const activity = candidates[0];
  if (!activity?.post || !activity.comment) {
    return { status: 'skipped', kind: 'reply', reason: 'no_fresh_inbound_activity' };
  }

  // Confirm the parent comment still exists AND get siblings for context.
  let tree: CommentNode[];
  try {
    tree = await fetchCommentTree(ctx.client, activity.post.id);
  } catch (err) {
    return { status: 'error', kind: 'reply', error: `fetch_tree: ${err}` };
  }

  const flat = flattenTree(tree);
  const parent = flat.find((c) => c.id === activity.comment?.id);
  if (!parent || parent.depth === 2) {
    return {
      status: 'skipped',
      kind: 'reply',
      reason: 'parent_deleted_or_max_depth',
    };
  }

  // Siblings: other children of the same parent_comment_id (or other roots
  // if the parent is top-level). Cap at 3 for prompt budget.
  const siblingComments: RemoteComment[] = flat
    .filter((c) => c.parent_comment_id === parent.parent_comment_id && c.id !== parent.id)
    .slice(0, 3);

  const priorComments = await loadPriorComments(agent.agentname);
  const chaos = rollChaos(persona);

  let mentionStateCache: ReturnType<typeof buildMentionLookup> | undefined;
  const getMentionState = (): ReturnType<typeof buildMentionLookup> => {
    mentionStateCache ??= buildMentionLookup(ctx.authorPersonaLookup);
    return mentionStateCache;
  };

  const mentionCandidates = shouldIncludeMentionCandidates(
    persona.mentionProbability,
    'reply-activity',
  )
    ? buildReplyCandidates({
        selfAgentname: agent.agentname,
        parentAuthor: parent.author.agentname,
        postAuthor: agent.agentname, // own post
        siblingAuthors: siblingComments.map((s) => s.author.agentname),
        relatedAgentnames: resolveRelatedAgentnames(
          persona,
          getMentionState().personaToAgentnames,
          agent.agentname,
        ),
        // 55/45 split: triggering agent leads the candidate list 55% of
        // the time; on 45% the relationship graph leads so the reply
        // doesn't always read as "@thanks for commenting."
        preferTriggeringAgent: true,
      })
    : [];

  const resolvedVoice = resolveVoiceProfile(ctx.voiceProfiles, agent);
  if ('error' in resolvedVoice) {
    return { status: 'error', kind: 'reply', error: resolvedVoice.error };
  }
  const voiceProfile = resolvedVoice.profile;
  const wordBudget = sampleWordBudget(voiceProfile.verbosity);

  const lore = ctx.loreRegistry
    ? loadActiveLoreForAgent({
        registry: ctx.loreRegistry,
        agentname: agent.agentname,
        agentnameToPersonaId: ctx.authorPersonaLookup,
      })
    : { tier: undefined, snippets: [], groups: [] };

  let text: string;
  try {
    text = await generateReply(
      persona,
      voiceProfile,
      { agentname: agent.agentname, bio: agent.bio },
      {
        caption: activity.post.caption ?? null,
        author: agent.agentname, // self-post — the activity is ON the agent's content
      },
      {
        text: parent.content,
        author: parent.author.agentname,
        depth: parent.depth as 0 | 1,
      },
      siblingComments.map((s) => s.content),
      [...priorComments],
      chaos,
      mentionCandidates,
      wordBudget,
      lore.snippets,
      lore.tier,
    );
  } catch (err) {
    return { status: 'error', kind: 'reply', error: `llm: ${err}` };
  }

  if (ctx.dryRun) {
    return {
      status: 'ok',
      kind: 'reply',
      detail: `[DRY] would reply to activity ${activity.id} from @${activity.actor.agentname}: "${text.slice(0, 60)}"`,
      ...(chaos ? { chaos: true } : {}),
    };
  }

  let activityReplyResponse: Awaited<ReturnType<typeof ctx.client.commentOnPost>>;
  try {
    activityReplyResponse = await ctx.client.commentOnPost(activity.post.id, text, parent.id);
  } catch (err) {
    if (err instanceof ParentDeletedError) {
      return { status: 'skipped', kind: 'reply', reason: 'parent_deleted' };
    }
    return { status: 'error', kind: 'reply', error: String(err) };
  }

  consume(quota, 'reply');
  await persistQuota(quota);
  await appendRuntimeComment(agent.agentname, {
    text,
    postId: activity.post.id,
    parentCommentId: parent.id,
    depth: (parent.depth + 1) as 1 | 2,
    againstAuthor: parent.author.agentname,
    repliedToActivityId: activity.id,
  });
  await appendGlobalComment({
    postId: activity.post.id,
    agentname: agent.agentname,
    kind: 'reply',
  });

  if (text.includes('@')) {
    const resolvedMentions = parseResolvedMentions(
      text,
      agent.agentname,
      getMentionState().knownAgentnames,
      // Activity-driven replies sit on the agent's own post, but the
      // parent comment author + sibling commenters aren't necessarily
      // seeder-managed — union them in for the platform-wide surface.
      [parent.author.agentname, ...siblingComments.map((s) => s.author.agentname)],
    );
    if (resolvedMentions.length > 0) {
      logMentions({
        agentname: agent.agentname,
        persona: persona.id,
        targets: resolvedMentions,
        context: 'reply',
        phase: 'runtime',
        postId: activity.post.id,
        sourceCommentId: activityReplyResponse.comment.id,
      });
    }
  }
  if (lore.snippets.length > 0) {
    const refs = parseResolvedLoreReferences(text, lore.snippets);
    for (const ref of refs) {
      logEvent({
        eventType: 'lore_referenced',
        agentname: agent.agentname,
        persona: persona.id,
        success: true,
        details: {
          groupId: ref.groupId,
          entryId: ref.entryId,
          tier: lore.tier,
          context: 'reply',
          postId: activity.post.id,
          sourceCommentId: activityReplyResponse.comment.id,
        },
      });
    }
  }

  // ── Activity momentum: detect high inbound engagement ──
  // Count inbound events in the last hour. If the count exceeds a
  // threshold, flag this result as bonus-eligible so the continuous loop
  // can inject a bonus session via the scheduler.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentInbound = (feed.activities ?? []).filter(
    (a) => a.actor.agentname !== agent.agentname && Date.parse(a.created_at) > oneHourAgo,
  ).length;
  const momentumThreshold = 2 + (persona.postsPerDay[1] ?? 3);
  const bonusEligible = recentInbound >= momentumThreshold;

  return {
    status: 'ok',
    kind: 'reply',
    detail: `replied to @${activity.actor.agentname} on own post (activity ${activity.id})`,
    bonusEligible,
    ...(chaos ? { chaos: true } : {}),
  };
}

/**
 * Route an `ActionKind` to the right executor. When `kind === 'reply'`,
 * splits reciprocity vs thread-dive by `ACTIVITY_REPLY_PROBABILITY` (see
 * `src/config.ts`); a 'no_fresh_inbound_activity' skip from the reciprocity
 * path falls through to the feed-driven path automatically so the reply
 * slot isn't wasted on an empty inbox.
 */
export async function dispatchAction(
  kind: ActionKind,
  ctx: EngageContext,
  agent: GeneratedAgent,
  persona: Persona,
  quota: AgentQuota,
  activityReplyProbability: number,
): Promise<ActionResult> {
  switch (kind) {
    case 'like':
      return executeLike(ctx, agent, persona, quota);
    case 'comment':
      return executeComment(ctx, agent, persona, quota);
    case 'reply': {
      if (Math.random() < activityReplyProbability) {
        const r = await executeActivityDrivenReply(ctx, agent, persona, quota);
        if (r.status === 'skipped' && r.reason === 'no_fresh_inbound_activity') {
          return executeReply(ctx, agent, persona, quota);
        }
        return r;
      }
      return executeReply(ctx, agent, persona, quota);
    }
    case 'follow':
      return executeFollow(ctx, agent, persona, quota);
    case 'post':
      return executePost(ctx, agent, persona, quota);
    case 'commentLike':
      return executeCommentLike(ctx, agent, persona, quota);
  }
}
