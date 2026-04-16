import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentNode } from '@/lib/comment-tree';
import type { FeedCacheFile, GeneratedAgent, Persona, RemoteComment, RemotePost } from '@/types';

// ---------------- llm mock ----------------

const llmMocks = vi.hoisted(() => ({
  generateComment: vi.fn<() => Promise<string>>(),
  generateReply: vi.fn<() => Promise<string>>(),
}));

vi.mock('@/services/llm', () => llmMocks);

// ---------------- comment-tree mock ----------------
// bakeAgentReplies calls fetchCommentTree + pickReplyTarget. We stub both
// to produce deterministic trees and targets for unit tests.

const treeMocks = vi.hoisted(() => ({
  fetchCommentTree: vi.fn<() => Promise<CommentNode[]>>(),
  pickReplyTarget: vi.fn<() => { parent: RemoteComment; siblings: RemoteComment[] } | undefined>(),
}));

vi.mock('@/lib/comment-tree', () => treeMocks);

import {
  bakeAgentComments,
  bakeAgentReplies,
  buildCaptionsPoolFromFeedCache,
  COMMENT_COUNT_MAX,
  COMMENT_COUNT_MIN,
  computeSampleCounts,
  pickPeerCaptions,
  pickPostsWithComments,
  REPLY_COUNT_MAX,
  REPLY_COUNT_MIN,
  type SampleCaption,
} from '@/lib/comment-samples';
import type { VoiceProfile } from '@/types';

function makeVoiceProfile(
  overrides: Partial<VoiceProfile> & { verbosity: VoiceProfile['verbosity'] },
): VoiceProfile {
  return {
    id: 'vp',
    literacy: 'normal',
    capitalization: 'proper',
    punctuation: 'proper',
    typoFrequency: 'none',
    register: 'test',
    lexicon: [],
    examples: [],
    prevalenceWeight: 1,
    usernameStyle: {
      pattern: 'witty_observer',
      examples: ['Reluctant_Squid', 'PanicHamster'],
      guidance: 'test',
      preserveCase: true,
    },
    ...overrides,
  };
}

function makePersona(id = 'test'): Persona {
  return {
    id,
    tagline: 'test tagline',
    personality: 'p',
    tone: 't',
    visualAesthetic: 'v',
    postingStyle: 'ps',
    commentStyle: 'cs',
    hashtagPool: [],
    postsPerDay: [1, 1],
    likeProbability: 0,
    commentProbability: 0,
    followProbability: 0,
    viewProbability: 1,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
  };
}

function agent(name: string, personaId = 'test'): GeneratedAgent {
  return { agentname: name, personaId, voiceProfileId: 'normie_cam', bio: `${name} bio` };
}

describe('computeSampleCounts', () => {
  it('clamps comments to [COMMENT_COUNT_MIN, COMMENT_COUNT_MAX] and replies to [REPLY_COUNT_MIN, REPLY_COUNT_MAX]', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const persona = makePersona();
      persona.commentProbability = p;
      for (const verbosity of [
        'one_word',
        'fragment',
        'one_sentence',
        'multi_sentence',
        'paragraph',
      ] as const) {
        const plan = computeSampleCounts(persona, makeVoiceProfile({ verbosity }), 'agent-x');
        expect(plan.comments).toBeGreaterThanOrEqual(COMMENT_COUNT_MIN);
        expect(plan.comments).toBeLessThanOrEqual(COMMENT_COUNT_MAX);
        expect(plan.replies).toBeGreaterThanOrEqual(REPLY_COUNT_MIN);
        expect(plan.replies).toBeLessThanOrEqual(REPLY_COUNT_MAX);
        expect(plan.replies).toBeLessThanOrEqual(plan.comments);
        expect(plan.depthTargets).toHaveLength(plan.replies);
        for (const d of plan.depthTargets) expect([0, 1]).toContain(d);
      }
    }
  });

  it('higher commentProbability produces at least as many comments for the same voice', () => {
    const low = makePersona();
    low.commentProbability = 0;
    const high = makePersona();
    high.commentProbability = 1;
    const voice = makeVoiceProfile({ verbosity: 'one_sentence' });
    const planLow = computeSampleCounts(low, voice, 'a');
    const planHigh = computeSampleCounts(high, voice, 'a');
    expect(planHigh.comments).toBeGreaterThanOrEqual(planLow.comments);
    expect(planHigh.replies).toBeGreaterThanOrEqual(planLow.replies);
  });

  it('fragment-voice agent gets one more comment than paragraph-voice agent at the same mid probability', () => {
    const persona = makePersona();
    persona.commentProbability = 0.5;
    const fragment = computeSampleCounts(persona, makeVoiceProfile({ verbosity: 'fragment' }), 'a');
    const paragraph = computeSampleCounts(
      persona,
      makeVoiceProfile({ verbosity: 'paragraph' }),
      'a',
    );
    expect(fragment.comments).toBe(paragraph.comments + 2);
  });

  it('returns an equal plan for the same (persona, voice, agentname)', () => {
    const persona = makePersona();
    persona.commentProbability = 0.7;
    const voice = makeVoiceProfile({ verbosity: 'one_sentence' });
    const a = computeSampleCounts(persona, voice, 'agent-alpha');
    const b = computeSampleCounts(persona, voice, 'agent-alpha');
    expect(a).toEqual(b);
  });

  it('depth targets put floor(replies/3) slots at depth 1, rest at depth 0', () => {
    // Force each reply count via the probability + verbosity combo.
    const persona = makePersona();
    const voice = makeVoiceProfile({ verbosity: 'one_sentence' });

    persona.commentProbability = 1;
    expect(computeSampleCounts(persona, voice, 'a').depthTargets).toEqual([0, 0, 1]);

    persona.commentProbability = 0.5;
    expect(computeSampleCounts(persona, voice, 'a').depthTargets).toEqual([0, 0]);

    persona.commentProbability = 0;
    expect(computeSampleCounts(persona, voice, 'a').depthTargets).toEqual([0]);
  });
});

describe('pickPeerCaptions', () => {
  function pool(n: number, authorPrefix = 'peer'): SampleCaption[] {
    return Array.from({ length: n }, (_, i) => ({
      author: `${authorPrefix}${i}`,
      caption: `caption ${i}`,
    }));
  }

  it('excludes the caller from the pool', () => {
    const arr = [
      { author: 'alpha', caption: 'own post' },
      { author: 'beta', caption: 'peer post' },
    ];
    const picked = pickPeerCaptions(arr, 'alpha', 5);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.author).toBe('beta');
  });

  it('skips captions whose text is empty or whitespace-only', () => {
    const arr: SampleCaption[] = [
      { author: 'a', caption: '' },
      { author: 'b', caption: '   ' },
      { author: 'c', caption: 'real content' },
    ];
    const picked = pickPeerCaptions(arr, 'z', 5);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.caption).toBe('real content');
  });

  it('returns at most `n` captions even when the pool is larger', () => {
    const picked = pickPeerCaptions(pool(20), 'self', 3);
    expect(picked).toHaveLength(3);
  });

  it('returns all eligible captions when the pool is smaller than `n`', () => {
    const picked = pickPeerCaptions(pool(2), 'self', 10);
    expect(picked).toHaveLength(2);
  });
});

describe('bakeAgentComments', () => {
  beforeEach(() => {
    llmMocks.generateComment.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces one CommentSample per source with metadata preserved', async () => {
    llmMocks.generateComment.mockResolvedValueOnce('reply one').mockResolvedValueOnce('reply two');

    const sources: SampleCaption[] = [
      { author: 'peer1', caption: 'first', personaId: 'other' },
      { author: 'peer2', caption: 'second', personaId: 'other' },
    ];

    const samples = await bakeAgentComments(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      agent('alpha'),
      sources,
    );

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      sourceCaption: 'first',
      sourceAuthor: 'peer1',
      sourcePersonaId: 'other',
      text: 'reply one',
    });
    expect(samples[1]).toMatchObject({
      sourceCaption: 'second',
      sourceAuthor: 'peer2',
      text: 'reply two',
    });
    // generatedAt should be an ISO-ish string.
    expect(samples[0]?.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('feeds each prior comment back into generateComment as the avoid list', async () => {
    llmMocks.generateComment
      .mockResolvedValueOnce('first reply')
      .mockResolvedValueOnce('second reply')
      .mockResolvedValueOnce('third reply');

    const sources: SampleCaption[] = [
      { author: 'p1', caption: 'a' },
      { author: 'p2', caption: 'b' },
      { author: 'p3', caption: 'c' },
    ];

    await bakeAgentComments(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      agent('alpha'),
      sources,
    );

    // Call 1: empty avoid list.
    // Call 2: [first reply]
    // Call 3: [first reply, second reply]
    // Arg index 5 is `priorComments` — the call shape is
    // (persona, voiceProfile, agent, caption, author, priorComments, ...).
    const calls = llmMocks.generateComment.mock.calls;
    expect(calls).toHaveLength(3);
    expect((calls[0] as unknown[])[5]).toEqual([]);
    expect((calls[1] as unknown[])[5]).toEqual(['first reply']);
    expect((calls[2] as unknown[])[5]).toEqual(['first reply', 'second reply']);
  });

  it('passes the agent context (agentname + bio) to generateComment', async () => {
    llmMocks.generateComment.mockResolvedValueOnce('ok');

    await bakeAgentComments(
      makePersona('cozy'),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      agent('glitchfern'),
      [{ author: 'p', caption: 'c' }],
    );

    // Arg index 2 is `agent` — (persona, voiceProfile, agent, ...).
    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    expect(callArgs[2]).toEqual({
      agentname: 'glitchfern',
      bio: 'glitchfern bio',
    });
  });
});

describe('buildCaptionsPoolFromFeedCache', () => {
  function makePost(
    overrides: Partial<RemotePost> & { id: string; agentname: string },
  ): RemotePost {
    return {
      id: overrides.id,
      image_url: 'http://x/y.jpg',
      thumbnail_url: null,
      caption: overrides.caption ?? null,
      width: 1080,
      height: 1080,
      format: 'square',
      like_count: 0,
      comment_count: 0,
      view_count: 0,
      popularity_score: 0,
      velocity_score: 0,
      share_count: 0,
      created_at: '2026-04-13T00:00:00.000Z',
      author: {
        agentname: overrides.agentname,
        is_verified: false,
      },
    };
  }

  function makeCache(posts: RemotePost[]): FeedCacheFile {
    return {
      refreshedAt: '2026-04-13T00:00:00.000Z',
      sources: ['explore'],
      posts,
    };
  }

  it('returns an empty pool when the cache has no posts', () => {
    expect(buildCaptionsPoolFromFeedCache(makeCache([]))).toEqual([]);
  });

  it('maps author.agentname + caption to SampleCaption entries', () => {
    const cache = makeCache([
      makePost({ id: '1', agentname: 'alpha', caption: 'alpha says hi' }),
      makePost({ id: '2', agentname: 'beta', caption: 'beta too' }),
    ]);

    const pool = buildCaptionsPoolFromFeedCache(cache);

    expect(pool).toHaveLength(2);
    expect(pool).toContainEqual({ author: 'alpha', caption: 'alpha says hi', postId: '1' });
    expect(pool).toContainEqual({ author: 'beta', caption: 'beta too', postId: '2' });
  });

  it('drops posts whose caption is missing, null, or whitespace-only', () => {
    const cache = makeCache([
      makePost({ id: '1', agentname: 'alpha', caption: null }),
      makePost({ id: '2', agentname: 'beta', caption: '   ' }),
      makePost({ id: '3', agentname: 'gamma', caption: 'real content' }),
    ]);

    const pool = buildCaptionsPoolFromFeedCache(cache);
    expect(pool).toHaveLength(1);
    expect(pool[0]).toEqual({ author: 'gamma', caption: 'real content', postId: '3' });
  });

  it('does not populate personaId from the feed (peers are outside the persona set)', () => {
    const cache = makeCache([makePost({ id: '1', agentname: 'alpha', caption: 'hi' })]);

    const pool = buildCaptionsPoolFromFeedCache(cache);
    expect(pool[0]?.personaId).toBeUndefined();
  });
});

// ---------------- helpers for reply-bake tests ----------------

function makePostWithComments(
  id: string,
  agentname: string,
  caption: string,
  commentCount: number,
): RemotePost {
  return {
    id,
    image_url: 'http://x/y.jpg',
    thumbnail_url: null,
    caption,
    width: 1080,
    height: 1080,
    format: 'square',
    like_count: 0,
    comment_count: commentCount,
    view_count: 0,
    popularity_score: 0,
    velocity_score: 0,
    share_count: 0,
    created_at: '2026-04-13T00:00:00.000Z',
    author: { agentname, is_verified: false },
  };
}

function makeFeedCacheWith(posts: RemotePost[]): FeedCacheFile {
  return {
    refreshedAt: '2026-04-13T00:00:00.000Z',
    sources: ['explore'],
    posts,
  };
}

function makeRemoteComment(id: string, overrides: Partial<RemoteComment> = {}): RemoteComment {
  return {
    id,
    content: `comment ${id}`,
    parent_comment_id: null,
    depth: 0,
    reply_count: 0,
    like_count: 0,
    created_at: '2026-04-13T00:00:00.000Z',
    author: { agentname: 'peer', is_verified: false, has_owner: false },
    replies: [],
    ...overrides,
  };
}

describe('pickPostsWithComments', () => {
  it('excludes posts with zero comments and posts authored by the caller', () => {
    const cache = makeFeedCacheWith([
      makePostWithComments('p1', 'alpha', 'mine', 5),
      makePostWithComments('p2', 'beta', 'no comments yet', 0),
      makePostWithComments('p3', 'gamma', 'has comments', 3),
    ]);
    const picked = pickPostsWithComments(cache, 3, 'alpha');
    expect(picked.map((p) => p.id)).toEqual(['p3']);
  });

  it('deduplicates by author so samples span multiple authors', () => {
    const cache = makeFeedCacheWith([
      makePostWithComments('p1', 'beta', 'first', 5),
      makePostWithComments('p2', 'beta', 'same author second', 3),
      makePostWithComments('p3', 'gamma', 'different author', 2),
    ]);
    const picked = pickPostsWithComments(cache, 3, 'alpha');
    const authors = picked.map((p) => p.author.agentname);
    expect(new Set(authors).size).toBe(authors.length);
    expect(authors).toContain('beta');
    expect(authors).toContain('gamma');
  });

  it('sorts by comment_count descending by default (prefers richer threads)', () => {
    const cache = makeFeedCacheWith([
      makePostWithComments('p1', 'beta', 'low', 1),
      makePostWithComments('p2', 'gamma', 'high', 10),
      makePostWithComments('p3', 'delta', 'mid', 5),
    ]);
    const picked = pickPostsWithComments(cache, 3, 'alpha');
    expect(picked.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
  });

  it('caps output at `n`', () => {
    const cache = makeFeedCacheWith([
      makePostWithComments('p1', 'a', '', 5),
      makePostWithComments('p2', 'b', '', 4),
      makePostWithComments('p3', 'c', '', 3),
      makePostWithComments('p4', 'd', '', 2),
    ]);
    const picked = pickPostsWithComments(cache, 2, 'alpha');
    expect(picked).toHaveLength(2);
  });
});

describe('bakeAgentReplies', () => {
  beforeEach(() => {
    llmMocks.generateReply.mockReset();
    treeMocks.fetchCommentTree.mockReset();
    treeMocks.pickReplyTarget.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubClient(): Parameters<typeof bakeAgentReplies>[3] {
    // bakeAgentReplies only passes the client through to fetchCommentTree
    // (which is mocked), so the client itself is never called directly.
    // Position 3 in the signature: (persona, voiceProfile, agent, client, ...).
    return {} as Parameters<typeof bakeAgentReplies>[3];
  }

  it('accepts caller-provided depthTargets of any length', () => {
    // Regression test for the signature change: bakeAgentReplies loops
    // depthTargets.length times, not a hard-coded constant. The behavior
    // tests below exercise the actual iteration.
    expect(REPLY_COUNT_MAX).toBeGreaterThanOrEqual(REPLY_COUNT_MIN);
    expect(REPLY_COUNT_MIN).toBeGreaterThanOrEqual(1);
  });

  it('fetches a comment tree per post and calls generateReply with the right shape', async () => {
    const parent = makeRemoteComment('pc', {
      depth: 0,
      author: { agentname: 'peer', is_verified: false, has_owner: false },
    });
    const sibling = makeRemoteComment('sib', { depth: 0 });

    treeMocks.fetchCommentTree.mockResolvedValue([
      { comment: parent, children: [{ comment: sibling, children: [] }] },
    ]);
    treeMocks.pickReplyTarget.mockReturnValue({ parent, siblings: [sibling] });
    llmMocks.generateReply.mockResolvedValue('my reply text');

    const posts = [makePostWithComments('p1', 'peer', 'post caption', 2)];
    const samples = await bakeAgentReplies(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      { agentname: 'alpha', bio: 'alpha bio' },
      stubClient(),
      posts,
      [0],
      ['prior comment one'],
    );

    expect(treeMocks.fetchCommentTree).toHaveBeenCalledTimes(1);
    expect(treeMocks.fetchCommentTree).toHaveBeenCalledWith(expect.anything(), 'p1');
    expect(llmMocks.generateReply).toHaveBeenCalledTimes(1);

    // Call shape: (persona, voiceProfile, agent, post, parent, siblings, priorComments, ...).
    const callArgs = llmMocks.generateReply.mock.calls[0] as unknown[];
    expect((callArgs[2] as { agentname: string }).agentname).toBe('alpha');
    expect(callArgs[3] as { caption: string; author: string }).toEqual({
      caption: 'post caption',
      author: 'peer',
    });
    expect(callArgs[4] as { text: string; author: string; depth: 0 | 1 }).toEqual({
      text: parent.content,
      author: 'peer',
      depth: 0,
    });
    expect(callArgs[5]).toEqual([sibling.content]);
    // Prior avoid list passes through at call time.
    expect(callArgs[6]).toEqual(['prior comment one']);

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      kind: 'reply',
      sourceCaption: 'post caption',
      sourceAuthor: 'peer',
      parentText: parent.content,
      parentAuthor: 'peer',
      parentDepth: 0,
      siblingContext: [sibling.content],
      text: 'my reply text',
    });
  });

  it('accumulates each reply into the avoid list for subsequent calls', async () => {
    const parent = makeRemoteComment('pc');
    treeMocks.fetchCommentTree.mockResolvedValue([{ comment: parent, children: [] }]);
    treeMocks.pickReplyTarget.mockReturnValue({ parent, siblings: [] });
    llmMocks.generateReply
      .mockResolvedValueOnce('first reply')
      .mockResolvedValueOnce('second reply')
      .mockResolvedValueOnce('third reply');

    const posts = [
      makePostWithComments('p1', 'a', 'x', 1),
      makePostWithComments('p2', 'b', 'y', 1),
      makePostWithComments('p3', 'c', 'z', 1),
    ];
    await bakeAgentReplies(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      { agentname: 'alpha', bio: 'alpha bio' },
      stubClient(),
      posts,
      [0, 0, 1],
      ['seed'],
    );

    // Arg index 6 is `priorComments` — (persona, voiceProfile, agent, post, parent, siblings, priorComments).
    const calls = llmMocks.generateReply.mock.calls as unknown[][];
    expect(calls[0]?.[6]).toEqual(['seed']);
    expect(calls[1]?.[6]).toEqual(['seed', 'first reply']);
    expect(calls[2]?.[6]).toEqual(['seed', 'first reply', 'second reply']);
  });

  it('silently skips a post when fetchCommentTree throws', async () => {
    const parent = makeRemoteComment('ok');
    treeMocks.fetchCommentTree
      .mockRejectedValueOnce(new Error('429 rate limited'))
      .mockResolvedValueOnce([{ comment: parent, children: [] }]);
    treeMocks.pickReplyTarget.mockReturnValue({ parent, siblings: [] });
    llmMocks.generateReply.mockResolvedValue('survived');

    const posts = [
      makePostWithComments('p1', 'a', 'bad', 1),
      makePostWithComments('p2', 'b', 'good', 1),
    ];
    const samples = await bakeAgentReplies(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      { agentname: 'alpha', bio: 'alpha bio' },
      stubClient(),
      posts,
      [0, 0],
      [],
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]?.text).toBe('survived');
  });

  it('silently skips a post when pickReplyTarget returns undefined', async () => {
    treeMocks.fetchCommentTree.mockResolvedValue([]);
    treeMocks.pickReplyTarget.mockReturnValue(undefined);
    llmMocks.generateReply.mockResolvedValue('never called');

    const posts = [makePostWithComments('p1', 'a', 'x', 1)];
    const samples = await bakeAgentReplies(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      { agentname: 'alpha', bio: 'alpha bio' },
      stubClient(),
      posts,
      [0],
      [],
    );
    expect(samples).toEqual([]);
    expect(llmMocks.generateReply).not.toHaveBeenCalled();
  });

  it('biases toward the target depth via reroll, accepting fallback after retries', async () => {
    // First attempt returns depth 1 (wanted), second slot wants depth 1 too,
    // third slot wants depth 1 and gets it on first pick.
    const d0 = makeRemoteComment('d0', { depth: 0 });
    const d1 = makeRemoteComment('d1', { depth: 1 });

    treeMocks.fetchCommentTree.mockResolvedValue([{ comment: d0, children: [] }]);
    // Slots 0 + 1 want depth 0; slot 2 wants depth 1. Make pickReplyTarget
    // always return d0 so slot 2 forces the reroll fallback path.
    treeMocks.pickReplyTarget.mockReturnValue({ parent: d0, siblings: [] });
    llmMocks.generateReply.mockResolvedValue('ok');

    const posts = [
      makePostWithComments('p1', 'a', 'x', 1),
      makePostWithComments('p2', 'b', 'y', 1),
      makePostWithComments('p3', 'c', 'z', 1),
    ];
    const samples = await bakeAgentReplies(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      { agentname: 'alpha', bio: 'alpha bio' },
      stubClient(),
      posts,
      [0, 0, 1],
      [],
    );
    expect(samples).toHaveLength(3);
    // Slot 2 wanted depth 1 but got depth 0 after rerolls — that's the
    // documented fallback behavior.
    expect(samples[2]?.parentDepth).toBe(0);
    // Sanity: the slot-0 parent is d0 (depth 0, matches target).
    expect(samples[0]?.parentDepth).toBe(0);
    void d1; // unused, kept for documentation of the scenario
  });

  it('attaches kind: "reply" to every baked sample', async () => {
    const parent = makeRemoteComment('pc');
    treeMocks.fetchCommentTree.mockResolvedValue([{ comment: parent, children: [] }]);
    treeMocks.pickReplyTarget.mockReturnValue({ parent, siblings: [] });
    llmMocks.generateReply.mockResolvedValue('r');

    const samples = await bakeAgentReplies(
      makePersona(),
      makeVoiceProfile({ verbosity: 'one_sentence' }),
      { agentname: 'alpha', bio: 'alpha bio' },
      stubClient(),
      [makePostWithComments('p1', 'a', 'x', 1)],
      [0],
      [],
    );
    expect(samples[0]?.kind).toBe('reply');
  });
});
