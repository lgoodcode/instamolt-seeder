/**
 * Comment tree helpers for nested-reply targeting in the continuous engage
 * scheduler.
 *
 * The platform returns a **nested tree** per `GET /posts/{id}/comments`
 * (see `openapi.json` §`Comment`): every `Comment` carries a required
 * `replies: Comment[]` recursively, up to 3 levels (depth 0, 1, 2, with
 * `replies: []` at depth 2). `fetchCommentTree` maps the server tree
 * directly into `CommentNode[]` via `mapNestedToNodes` — no
 * reconstruction-from-flat needed because the server already built it.
 *
 * `buildTree` is still exported for the flat-to-tree case (e.g.
 * reconstructing a tree from an activity-feed page where comments land
 * un-nested). It is not on the happy path for `fetchCommentTree` anymore.
 *
 * `pickReplyTarget` is the core of the reply-selection flow used by
 * `executeReply`: given a tree, the commenting agent's persona, and a
 * lookup map from agentname → personaId (so we can resolve relationship
 * bonuses), it picks a `depth < 2` comment to reply to using a weighted
 * random draw over three signals:
 *
 * - **relationshipBonus** — typed-relationship buckets get multipliers
 *   from `src/lib/relationships.ts` (rivals 1.5x, targets 2.0x, …).
 * - **recencyDecay** — `exp(-ageHours / 24)` so a day-old thread scores
 *   ~0.37x its just-posted self; older threads still pickable but rare.
 * - **activityBoost** — `(1 + reply_count)` so comments that already have
 *   replies (active conversations) are preferred over dead-end threads.
 *
 * Self-comments (author.agentname === commenterAgentname) and
 * depth-2 comments are hard-filtered — the server rejects replies to
 * depth-2 comments with 400, and replying to yourself is weird.
 *
 * When no candidate passes the filters, returns `undefined` so the caller
 * (`executeReply`) can fall back to a top-level `executeComment` via the
 * `REPLY_FALLBACK_TO_COMMENT` config flag.
 */

import { relationshipMultiplier } from '@/lib/relationships';
import type { InstaMoltClient } from '@/services/instamolt-api';
import type { Persona, RemoteComment } from '@/types';

export interface CommentNode {
  comment: RemoteComment;
  children: CommentNode[];
}

/**
 * Build a tree from a flat comment list. Parents are linked by
 * `parent_comment_id`; orphans (parent_comment_id references a missing
 * comment) become additional roots so they are still reachable. The order
 * of roots follows the server's response order.
 */
export function buildTree(comments: RemoteComment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const c of comments) {
    byId.set(c.id, { comment: c, children: [] });
  }

  const roots: CommentNode[] = [];
  for (const c of comments) {
    const node = byId.get(c.id);
    if (!node) continue;
    if (c.parent_comment_id && byId.has(c.parent_comment_id)) {
      const parent = byId.get(c.parent_comment_id);
      parent?.children.push(node);
    } else {
      // Either a true top-level comment, or an orphan whose parent was
      // filtered out (e.g. deleted). Either way we treat it as a root.
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Recursively map a server-nested comment tree into `CommentNode[]`. The
 * server guarantees `replies` is always an array (empty `[]` at depth 2),
 * but we defensively coalesce against legacy / malformed payloads that
 * might omit it.
 */
export function mapNestedToNodes(nested: RemoteComment[]): CommentNode[] {
  return nested.map((c) => ({
    comment: c,
    children: mapNestedToNodes(c.replies ?? []),
  }));
}

/** Fetch the comment tree for a post and map it into `CommentNode[]`. */
export async function fetchCommentTree(
  client: InstaMoltClient,
  postId: string,
): Promise<CommentNode[]> {
  const res = await client.getPostComments(postId);
  return mapNestedToNodes(res.comments ?? []);
}

/**
 * Flatten a tree back to a linear list in depth-first order. Used internally
 * by `pickReplyTarget` and exported for callers that want to iterate every
 * comment (e.g. the `siblings` lookup inside `executeActivityDrivenReply`).
 */
export function flattenTree(nodes: CommentNode[]): RemoteComment[] {
  const out: RemoteComment[] = [];
  const walk = (ns: CommentNode[]): void => {
    for (const n of ns) {
      out.push(n.comment);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Return up to `limit` siblings of a given comment (other children of the
 * same parent). If the comment is a top-level root, siblings are other
 * top-level roots. Excludes the comment itself.
 */
export function findSiblings(tree: CommentNode[], commentId: string, limit = 3): RemoteComment[] {
  // Search for the node and its siblings in one DFS pass so we don't
  // need to re-walk the tree.
  const search = (nodes: CommentNode[], parentSiblings: CommentNode[]): CommentNode[] | null => {
    for (const n of nodes) {
      if (n.comment.id === commentId) return parentSiblings;
      if (n.children.length > 0) {
        const found = search(n.children, n.children);
        if (found) return found;
      }
    }
    return null;
  };

  const siblings = search(tree, tree);
  if (!siblings) return [];
  return siblings
    .filter((n) => n.comment.id !== commentId)
    .slice(0, limit)
    .map((n) => n.comment);
}

export interface PickReplyTargetOptions {
  tree: CommentNode[];
  /** The agent doing the replying — used to filter out self-comments. */
  commenterAgentname: string;
  /** The commenter's persona for relationship-bonus weighting. */
  commenterPersona: Persona;
  /** Lookup from an agentname to a known persona id for relationship scoring. */
  authorPersonaLookup: Map<string, string>;
  /** Test seam: inject a deterministic RNG. Defaults to Math.random. */
  random?: () => number;
  /**
   * Test seam: inject a fixed "now" so recency decay is reproducible.
   * Defaults to Date.now().
   */
  now?: number;
}

export interface ReplyTarget {
  parent: RemoteComment;
  siblings: RemoteComment[];
}

const SIBLING_CONTEXT_LIMIT = 3;

/**
 * Weighted-random pick of a depth<2 comment to reply to. Returns undefined
 * when no eligible comment exists (empty tree, all depth-2, all
 * self-authored, or all zero-weight).
 */
export function pickReplyTarget(opts: PickReplyTargetOptions): ReplyTarget | undefined {
  const rng = opts.random ?? Math.random;
  const now = opts.now ?? Date.now();

  const flat = flattenTree(opts.tree);
  interface Candidate {
    comment: RemoteComment;
    weight: number;
  }
  const candidates: Candidate[] = [];

  for (const comment of flat) {
    if (comment.depth === 2) continue;
    if (comment.author.agentname === opts.commenterAgentname) continue;

    const authorPersonaId = opts.authorPersonaLookup.get(comment.author.agentname);
    const relBonus = relationshipMultiplier(opts.commenterPersona, authorPersonaId);

    const ageHours = Math.max(0, (now - Date.parse(comment.created_at)) / 3_600_000);
    const recency = Math.exp(-ageHours / 24);

    const activity = 1 + comment.reply_count;

    const weight = relBonus * recency * activity;
    if (weight <= 0) continue;
    candidates.push({ comment, weight });
  }

  if (candidates.length === 0) return undefined;

  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return undefined;
  let r = rng() * total;
  let chosen: Candidate | undefined;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) {
      chosen = c;
      break;
    }
  }
  if (!chosen) chosen = candidates[candidates.length - 1];
  if (!chosen) return undefined;

  const siblings = findSiblings(opts.tree, chosen.comment.id, SIBLING_CONTEXT_LIMIT);
  return { parent: chosen.comment, siblings };
}
