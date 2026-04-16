import { describe, expect, it, vi } from 'vitest';
import {
  buildTree,
  fetchCommentTree,
  findSiblings,
  flattenTree,
  pickReplyTarget,
} from '@/lib/comment-tree';
import type { InstaMoltClient } from '@/services/instamolt-api';
import type { Persona, RemoteComment } from '@/types';

function makeComment(id: string, overrides: Partial<RemoteComment> = {}): RemoteComment {
  return {
    id,
    content: `comment ${id}`,
    parent_comment_id: null,
    depth: 0,
    reply_count: 0,
    like_count: 0,
    created_at: '2026-04-11T00:00:00Z',
    author: { agentname: 'author', is_verified: false, has_owner: false },
    replies: [],
    ...overrides,
  };
}

function makePersona(id: string, relationships: Partial<Persona['relationships']> = {}): Persona {
  return {
    id,
    tagline: 'a persona',
    personality: '',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: [],
    postsPerDay: [1, 2],
    likeProbability: 0.5,
    commentProbability: 0.5,
    followProbability: 0.5,
    viewProbability: 1,
    relationships: {
      rivals: [],
      allies: [],
      amplifies: [],
      targets: [],
      ...relationships,
    },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
  };
}

describe('buildTree', () => {
  it('links children to their parents by parent_comment_id', () => {
    const flat = [
      makeComment('root1', { depth: 0 }),
      makeComment('child1', { depth: 1, parent_comment_id: 'root1' }),
      makeComment('child2', { depth: 1, parent_comment_id: 'root1' }),
      makeComment('grandchild', { depth: 2, parent_comment_id: 'child1' }),
    ];
    const tree = buildTree(flat);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.comment.id).toBe('root1');
    expect(tree[0]?.children.map((c) => c.comment.id)).toEqual(['child1', 'child2']);
    expect(tree[0]?.children[0]?.children.map((c) => c.comment.id)).toEqual(['grandchild']);
  });

  it('promotes orphans to roots when their parent is missing from the list', () => {
    const flat = [
      makeComment('root1', { depth: 0 }),
      makeComment('orphan', { depth: 1, parent_comment_id: 'deleted-parent' }),
    ];
    const tree = buildTree(flat);
    expect(tree.map((n) => n.comment.id)).toEqual(['root1', 'orphan']);
  });

  it('returns an empty array for an empty input', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('flattenTree', () => {
  it('returns comments in DFS order', () => {
    const flat = [
      makeComment('a', { depth: 0 }),
      makeComment('a1', { depth: 1, parent_comment_id: 'a' }),
      makeComment('a2', { depth: 1, parent_comment_id: 'a' }),
      makeComment('a1a', { depth: 2, parent_comment_id: 'a1' }),
      makeComment('b', { depth: 0 }),
    ];
    const tree = buildTree(flat);
    expect(flattenTree(tree).map((c) => c.id)).toEqual(['a', 'a1', 'a1a', 'a2', 'b']);
  });
});

describe('findSiblings', () => {
  it('returns sibling roots when the target is a root comment', () => {
    const tree = buildTree([makeComment('r1'), makeComment('r2'), makeComment('r3')]);
    const siblings = findSiblings(tree, 'r1');
    expect(siblings.map((c) => c.id)).toEqual(['r2', 'r3']);
  });

  it('returns siblings when the target is a nested reply', () => {
    const tree = buildTree([
      makeComment('root'),
      makeComment('c1', { depth: 1, parent_comment_id: 'root' }),
      makeComment('c2', { depth: 1, parent_comment_id: 'root' }),
      makeComment('c3', { depth: 1, parent_comment_id: 'root' }),
    ]);
    const siblings = findSiblings(tree, 'c2');
    expect(siblings.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('caps the result at the given limit', () => {
    const tree = buildTree([
      makeComment('r1'),
      makeComment('r2'),
      makeComment('r3'),
      makeComment('r4'),
      makeComment('r5'),
    ]);
    const siblings = findSiblings(tree, 'r1', 2);
    expect(siblings).toHaveLength(2);
  });

  it('returns an empty array when the target is not in the tree', () => {
    const tree = buildTree([makeComment('a')]);
    expect(findSiblings(tree, 'missing')).toEqual([]);
  });
});

describe('fetchCommentTree', () => {
  it('maps a nested server response directly into CommentNode[] (no rebuild from parent_comment_id)', async () => {
    // Platform returns comments as a nested tree per openapi.json — each
    // Comment carries a required `replies: Comment[]` array.
    const nested = [
      makeComment('root', {
        replies: [
          makeComment('child', {
            depth: 1,
            parent_comment_id: 'root',
            replies: [
              makeComment('grandchild', {
                depth: 2,
                parent_comment_id: 'child',
                replies: [],
              }),
            ],
          }),
        ],
      }),
    ];
    const client = {
      getPostComments: vi.fn().mockResolvedValue({ comments: nested }),
    } as unknown as InstaMoltClient;

    const tree = await fetchCommentTree(client, 'post-1');
    expect(client.getPostComments).toHaveBeenCalledWith('post-1');
    expect(tree).toHaveLength(1);
    expect(tree[0]?.comment.id).toBe('root');
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.comment.id).toBe('child');
    // The depth-2 grandchild must survive the mapping — the old flat-tree
    // rebuild dropped everything except top-level because parent_comment_id
    // was used as the only link.
    expect(tree[0]?.children[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]?.comment.id).toBe('grandchild');
  });

  it('returns an empty tree when the API returns no comments', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({ comments: [] }),
    } as unknown as InstaMoltClient;
    const tree = await fetchCommentTree(client, 'post-1');
    expect(tree).toEqual([]);
  });

  it('defensively tolerates a missing `replies` field on a server payload', async () => {
    // Should never happen per openapi (replies is required) but the
    // defensive coalesce in mapNestedToNodes makes the seeder resilient
    // to legacy / partial payloads.
    const partial = [{ ...makeComment('lone'), replies: undefined as unknown as never }];
    const client = {
      getPostComments: vi.fn().mockResolvedValue({ comments: partial }),
    } as unknown as InstaMoltClient;

    const tree = await fetchCommentTree(client, 'post-1');
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toEqual([]);
  });
});

describe('pickReplyTarget', () => {
  const me = 'alice';
  const myPersona = makePersona('friendly', { rivals: ['rival_persona'] });
  const lookup = new Map<string, string>([
    ['rival_agent', 'rival_persona'],
    ['neutral_agent', 'neutral_persona'],
  ]);
  const now = Date.parse('2026-04-11T00:00:00Z');

  it('skips depth-2 comments entirely (server rejects replies beyond depth 2)', () => {
    const tree = buildTree([
      makeComment('root', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: '2026-04-11T00:00:00Z',
      }),
      makeComment('c1', {
        depth: 1,
        parent_comment_id: 'root',
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: '2026-04-11T00:00:00Z',
      }),
      makeComment('c2', {
        depth: 2,
        parent_comment_id: 'c1',
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: '2026-04-11T00:00:00Z',
      }),
    ]);
    // Force picks many times and assert depth-2 never comes out.
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const target = pickReplyTarget({
        tree,
        commenterAgentname: me,
        commenterPersona: myPersona,
        authorPersonaLookup: lookup,
        now,
      });
      if (target) seen.add(target.parent.id);
    }
    expect(seen.has('c2')).toBe(false);
    expect(seen.size).toBeGreaterThan(0);
  });

  it('skips comments authored by the commenter itself', () => {
    const tree = buildTree([
      makeComment('mine', { author: { agentname: me, is_verified: false, has_owner: false } }),
      makeComment('theirs', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
      }),
    ]);
    for (let i = 0; i < 20; i++) {
      const target = pickReplyTarget({
        tree,
        commenterAgentname: me,
        commenterPersona: myPersona,
        authorPersonaLookup: lookup,
        now,
      });
      expect(target?.parent.id).toBe('theirs');
    }
  });

  it('returns undefined when the tree only contains depth-2 and own comments', () => {
    const tree = buildTree([
      makeComment('mine', { author: { agentname: me, is_verified: false, has_owner: false } }),
      makeComment('d2', {
        depth: 2,
        parent_comment_id: 'mine',
        author: { agentname: 'other', is_verified: false, has_owner: false },
      }),
    ]);
    const res = pickReplyTarget({
      tree,
      commenterAgentname: me,
      commenterPersona: myPersona,
      authorPersonaLookup: lookup,
      now,
    });
    expect(res).toBeUndefined();
  });

  it('applies the relationship bonus — rival comments dominate neutral ones', () => {
    const tree = buildTree([
      makeComment('rival1', {
        author: { agentname: 'rival_agent', is_verified: false, has_owner: false },
        created_at: '2026-04-11T00:00:00Z',
      }),
      makeComment('neutral1', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: '2026-04-11T00:00:00Z',
      }),
    ]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const target = pickReplyTarget({
        tree,
        commenterAgentname: me,
        commenterPersona: myPersona,
        authorPersonaLookup: lookup,
        now,
      });
      if (target) counts.set(target.parent.id, (counts.get(target.parent.id) ?? 0) + 1);
    }
    const rivalCount = counts.get('rival1') ?? 0;
    const neutralCount = counts.get('neutral1') ?? 0;
    // rivals get 1.5x weight — rival_count should be ~60% of picks.
    // Allow a wide margin for randomness.
    expect(rivalCount).toBeGreaterThan(neutralCount);
  });

  it('applies recency decay — 24h-old comments score much lower than fresh ones', () => {
    const tree = buildTree([
      makeComment('fresh', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: new Date(now).toISOString(),
      }),
      makeComment('old', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: new Date(now - 72 * 3_600_000).toISOString(), // 3 days
      }),
    ]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const target = pickReplyTarget({
        tree,
        commenterAgentname: me,
        commenterPersona: myPersona,
        authorPersonaLookup: lookup,
        now,
      });
      if (target) counts.set(target.parent.id, (counts.get(target.parent.id) ?? 0) + 1);
    }
    const freshCount = counts.get('fresh') ?? 0;
    const oldCount = counts.get('old') ?? 0;
    // exp(-72/24) = exp(-3) ≈ 0.05, so fresh should win ~95:5.
    expect(freshCount).toBeGreaterThan(oldCount * 5);
  });

  it('applies the activity boost — high reply_count comments score higher', () => {
    const tree = buildTree([
      makeComment('quiet', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        reply_count: 0,
      }),
      makeComment('active', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        reply_count: 10,
      }),
    ]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const target = pickReplyTarget({
        tree,
        commenterAgentname: me,
        commenterPersona: myPersona,
        authorPersonaLookup: lookup,
        now,
      });
      if (target) counts.set(target.parent.id, (counts.get(target.parent.id) ?? 0) + 1);
    }
    expect(counts.get('active') ?? 0).toBeGreaterThan(counts.get('quiet') ?? 0);
  });

  it('includes siblings of the chosen parent in the return value', () => {
    // Three top-level comments, no relationships, fresh timestamps. With
    // random: () => 0 the first cumulative candidate wins (r1), and
    // findSiblings('r1') returns the other two roots.
    const tree = buildTree([
      makeComment('r1', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: new Date(now).toISOString(),
      }),
      makeComment('r2', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: new Date(now).toISOString(),
      }),
      makeComment('r3', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: new Date(now).toISOString(),
      }),
    ]);
    const target = pickReplyTarget({
      tree,
      commenterAgentname: me,
      commenterPersona: myPersona,
      authorPersonaLookup: lookup,
      now,
      random: () => 0,
    });
    expect(target).toBeDefined();
    expect(target?.parent.id).toBe('r1');
    expect(target?.siblings.map((s) => s.id).sort()).toEqual(['r2', 'r3']);
    expect(target?.siblings.every((s) => s.id !== target.parent.id)).toBe(true);
  });

  it('skips candidates with malformed created_at (Date.parse → NaN) instead of poisoning totals', () => {
    const me = 'me';
    const myPersona = makePersona('my_persona');
    const lookup = new Map<string, string>([['neutral_agent', 'neutral']]);
    const now = Date.parse('2026-04-14T12:00:00Z');

    // One valid candidate, one with garbage timestamp. Prior behavior:
    // the NaN weight slipped past the `weight <= 0` guard, poisoned
    // `total`, and degraded selection. Expect the valid candidate to be
    // picked and the NaN one to be excluded.
    const tree = buildTree([
      makeComment('bad', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: 'not-a-real-timestamp',
      }),
      makeComment('good', {
        author: { agentname: 'neutral_agent', is_verified: false, has_owner: false },
        created_at: new Date(now).toISOString(),
      }),
    ]);
    const target = pickReplyTarget({
      tree,
      commenterAgentname: me,
      commenterPersona: myPersona,
      authorPersonaLookup: lookup,
      now,
      random: () => 0,
    });
    expect(target).toBeDefined();
    expect(target?.parent.id).toBe('good');
  });
});
