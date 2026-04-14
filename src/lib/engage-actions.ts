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

import { REPLY_FALLBACK_TO_COMMENT } from '@/config';
import {
  type CommentNode,
  fetchCommentTree,
  flattenTree,
  pickReplyTarget,
} from '@/lib/comment-tree';
import { type LiveFeedCache, markEngaged, pickPost } from '@/lib/feed-cache';
import { checkAvailability, consume, persistQuota } from '@/lib/quota';
import { pickRegisterHint, relationshipMultiplier } from '@/lib/relationships';
import {
  appendRuntimeComment,
  loadPriorComments,
  loadRuntimeCommentsFile,
} from '@/lib/runtime-comments';
import { type InstaMoltClient, ParentDeletedError } from '@/services/instamolt-api';
import { generateComment, generatePostContent, generateReply, rollChaos } from '@/services/llm';
import type {
  ActionKind,
  ActivityItem,
  AgentQuota,
  FeedCacheFile,
  GeneratedAgent,
  Persona,
  RemoteComment,
  RemotePost,
} from '@/types';

export interface EngageContext {
  client: InstaMoltClient;
  feedCache: FeedCacheFile | LiveFeedCache;
  personas: Map<string, Persona>;
  /** Map from agentname → personaId for every known registered agent. */
  authorPersonaLookup: Map<string, string>;
  /** When true, skip external side effects (API / MCP) but run everything else. */
  dryRun: boolean;
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
 * Build a persona-aware scoring function for `pickPost`. Relationship-
 * relevant authors get the weight bonus from `RELATIONSHIP_WEIGHT`; unrelated
 * authors get the neutral 1.0. A tiny `1 + log1p(popularity_score)` nudge
 * biases picks toward posts the feed algorithm ranks highly, matching how
 * a real user's attention tends to drift.
 */
function buildPostScorer(
  persona: Persona,
  authorPersonaLookup: Map<string, string>,
): (post: RemotePost) => number {
  return (post) => {
    const authorPid = authorPersonaLookup.get(post.author.agentname);
    const rel = relationshipMultiplier(persona, authorPid);
    const popularityNudge = 1 + Math.log1p(Math.max(0, post.popularity_score));
    return rel * popularityNudge;
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
  const registerHint = pickRegisterHint(persona, authorPid);
  const chaos = rollChaos(persona);

  let text: string;
  try {
    text = await generateComment(
      persona,
      { agentname: agent.agentname, bio: agent.bio },
      post.caption,
      post.author.agentname,
      [...priorComments],
      registerHint,
      chaos,
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

  try {
    await ctx.client.commentOnPost(post.id, text);
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

  const chaos = rollChaos(persona);
  let content: Awaited<ReturnType<typeof generatePostContent>>;
  try {
    content = await generatePostContent(persona, 1, 1, [], [], chaos);
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

  const target = pickReplyTarget({
    tree,
    commenterAgentname: agent.agentname,
    commenterPersona: persona,
    authorPersonaLookup: ctx.authorPersonaLookup,
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

  let text: string;
  try {
    text = await generateReply(
      persona,
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

  try {
    await ctx.client.commentOnPost(post.id, text, target.parent.id);
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

  let text: string;
  try {
    text = await generateReply(
      persona,
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

  try {
    await ctx.client.commentOnPost(activity.post.id, text, parent.id);
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

  // ── Activity momentum: detect high inbound engagement ──
  // Count inbound events in the last hour. If the count exceeds a
  // threshold, flag this result as bonus-eligible so the continuous loop
  // can inject a bonus session via the scheduler.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentInbound = (feed.activities ?? []).filter(
    (a) => a.actor.agentname !== agent.agentname && Date.parse(a.created_at) > oneHourAgo,
  ).length;
  const momentumThreshold = 3 + (persona.postsPerDay[1] ?? 3);
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
