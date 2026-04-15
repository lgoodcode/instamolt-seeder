import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionKind,
  AgentQuota,
  GeneratedAgent,
  Persona,
  RemoteComment,
  RemotePost,
  VoiceProfile,
} from '@/types';

// --- In-memory fs mock (quota.ts + runtime-comments.ts both hit disk) ---
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsState.files.set(path, content);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const content = fsState.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    fsState.files.set(to, content);
    fsState.files.delete(from);
  }),
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

// --- Mock llm so we don't hit Gemini ---
vi.mock('@/services/llm', () => ({
  generateComment: vi.fn(async () => 'canned generated comment text'),
  generatePostContent: vi.fn(async () => ({
    imagePrompt: 'test image prompt',
    caption: 'test caption',
    aspectRatio: 'square',
  })),
  generateReply: vi.fn(async () => 'canned reply text'),
  rollChaos: vi.fn(() => false),
}));

import {
  dispatchAction,
  type EngageContext,
  executeActivityDrivenReply,
  executeComment,
  executeCommentLike,
  executeFollow,
  executeLike,
  executePost,
  executeReply,
} from '@/lib/engage-actions';
import { initQuota } from '@/lib/quota';
import {
  InstaMoltApiError,
  type InstaMoltClient,
  ParentDeletedError,
} from '@/services/instamolt-api';

// --- Fixture builders ---

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'test_persona',
    tagline: 'a persona',
    personality: '',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: [],
    postsPerDay: [2, 5],
    likeProbability: 0.5,
    commentProbability: 0.5,
    followProbability: 0.5,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
    ...overrides,
  };
}

function makeAgent(agentname: string): GeneratedAgent {
  return {
    agentname,
    personaId: 'test_persona',
    voiceProfileId: 'test_voice',
    bio: 'a bio',
    apiKey: 'fake-key',
  };
}

function makePost(id: string, author = 'otheragent'): RemotePost {
  return {
    id,
    image_url: `https://cdn/${id}.jpg`,
    thumbnail_url: null,
    caption: `caption for ${id}`,
    width: 1080,
    height: 1080,
    format: 'square',
    like_count: 5,
    comment_count: 2,
    view_count: 100,
    popularity_score: 1.5,
    velocity_score: 1.0,
    share_count: 0,
    created_at: '2026-04-11T00:00:00Z',
    author: { agentname: author, is_verified: false },
  };
}

function makeComment(id: string, overrides: Partial<RemoteComment> = {}): RemoteComment {
  return {
    id,
    content: `content ${id}`,
    parent_comment_id: null,
    depth: 0,
    reply_count: 0,
    like_count: 0,
    created_at: '2026-04-11T00:00:00Z',
    author: { agentname: 'commenter', is_verified: false, has_owner: false },
    replies: [],
    ...overrides,
  };
}

const TEST_VOICE_PROFILE: VoiceProfile = {
  id: 'test_voice',
  literacy: 'normal',
  verbosity: 'one_sentence',
  capitalization: 'lowercase',
  punctuation: 'dropped',
  typoFrequency: 'none',
  register: 'test register',
  lexicon: ['vibe'],
  examples: ['test utterance'],
  prevalenceWeight: 1,
  usernameStyle: {
    pattern: 'witty_observer',
    examples: ['Reluctant_Squid'],
    guidance: 'test guidance',
    preserveCase: true,
  },
};

function makeCtx(overrides: Partial<EngageContext> & { client: InstaMoltClient }): EngageContext {
  const base: EngageContext = {
    client: overrides.client,
    feedCache: {
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [makePost('p1'), makePost('p2', 'another')],
    },
    personas: new Map(),
    voiceProfiles: new Map([['test_voice', TEST_VOICE_PROFILE]]),
    authorPersonaLookup: new Map(),
    dryRun: false,
  };
  return { ...base, ...overrides };
}

function makeFreshQuota(agentname: string, persona: Persona): AgentQuota {
  return initQuota(agentname, persona);
}

/** Turn a specific action kind into exhausted state in the given quota. */
function exhaustKind(quota: AgentQuota, kind: ActionKind): void {
  const cap = quota.caps[kind];
  const now = new Date().toISOString();
  for (let i = 0; i < cap; i++) quota.history[kind].push(now);
}

beforeEach(() => {
  fsState.files.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeLike', () => {
  it('returns skipped when quota is exhausted — no API call made', async () => {
    const client = { likePost: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const agent = makeAgent('alice');
    const persona = makePersona({ likeProbability: 0.1 });
    const quota = makeFreshQuota('alice', persona);
    exhaustKind(quota, 'like');

    const res = await executeLike(ctx, agent, persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('quota_exhausted');
    expect(client.likePost).not.toHaveBeenCalled();
  });

  it('skips when the feed cache has no candidate posts for this agent', async () => {
    const client = { likePost: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('own', 'alice')], // only the agent's own post
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_candidate_post');
  });

  it('calls client.likePost and consumes quota on success', async () => {
    const client = {
      likePost: vi.fn().mockResolvedValue({ success: true, liked: true }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(client.likePost).toHaveBeenCalledOnce();
    expect(quota.history.like).toHaveLength(1);
    expect(quota.last.like).toBeDefined();
  });

  it('re-toggles when the first call returns liked: false (un-toggle restore)', async () => {
    // First call un-likes (we'd previously liked this post in a prior cycle),
    // second call re-likes to restore the intended state. Quota is consumed
    // exactly once for the net like.
    const likePost = vi
      .fn()
      .mockResolvedValueOnce({ success: true, liked: false })
      .mockResolvedValueOnce({ success: true, liked: true });
    const client = { likePost } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(likePost).toHaveBeenCalledTimes(2);
    expect(quota.history.like).toHaveLength(1);
  });

  it('dry-run: does NOT call the API and does NOT consume quota', async () => {
    const client = { likePost: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client, dryRun: true });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.detail).toMatch(/\[DRY\]/);
    expect(client.likePost).not.toHaveBeenCalled();
    expect(quota.history.like).toHaveLength(0);
  });

  it('returns error and does NOT consume quota on API failure', async () => {
    const client = {
      likePost: vi.fn().mockRejectedValue(new Error('network')),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    expect(quota.history.like).toHaveLength(0);
  });
});

describe('executeComment', () => {
  it('calls commentOnPost and appends to runtime-comments.json on success', async () => {
    const client = {
      commentOnPost: vi.fn().mockResolvedValue({
        comment: { id: 'c-new', content: 'canned generated comment text' },
      }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeComment(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(client.commentOnPost).toHaveBeenCalledOnce();
    expect(quota.history.comment).toHaveLength(1);
    // path.join uses the platform separator, so find the runtime file by
    // suffix instead of hard-coding the separator.
    const runtimeKey = Array.from(fsState.files.keys()).find((k) =>
      k.endsWith('runtime-comments.json'),
    );
    expect(runtimeKey).toBeDefined();
    if (runtimeKey) {
      const parsed = JSON.parse(fsState.files.get(runtimeKey) as string);
      expect(parsed.comments[0].text).toBe('canned generated comment text');
      // Feed cache had two posts, so pickPost can pick either; just
      // assert it's one of them.
      expect(['p1', 'p2']).toContain(parsed.comments[0].postId);
    }
  });

  it('skips when the candidate post has no caption', async () => {
    const client = { commentOnPost: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [{ ...makePost('p1'), caption: null }],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeComment(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('post_has_no_caption');
    expect(client.commentOnPost).not.toHaveBeenCalled();
  });

  it('does NOT consume quota when commentOnPost fails', async () => {
    const client = {
      commentOnPost: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeComment(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    expect(quota.history.comment).toHaveLength(0);
  });
});

describe('executeFollow', () => {
  it('follows the candidate post author and consumes quota', async () => {
    const client = {
      followAgent: vi.fn().mockResolvedValue({ success: true, following: true }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeFollow(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(client.followAgent).toHaveBeenCalledOnce();
    expect(quota.history.follow).toHaveLength(1);
  });

  it('re-toggles when the first call returns following: false (un-toggle restore)', async () => {
    // The follow endpoint is a TOGGLE per openapi.json: a second call against
    // an already-followed agent unfollows them. executeFollow must detect this
    // and re-toggle to restore the intended end state. Quota is consumed
    // exactly once for the net follow.
    const followAgent = vi
      .fn()
      .mockResolvedValueOnce({ success: true, following: false })
      .mockResolvedValueOnce({ success: true, following: true });
    const client = { followAgent } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeFollow(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(followAgent).toHaveBeenCalledTimes(2);
    expect(quota.history.follow).toHaveLength(1);
  });

  it('returns error and does NOT consume quota on API failure', async () => {
    // Genuine errors from the server (e.g. self-follow 400, validation 400)
    // surface as `error` and do not consume quota.
    const client = {
      followAgent: vi
        .fn()
        .mockRejectedValue(
          new InstaMoltApiError('POST', '/agents/x/follow', 400, 'cannot follow yourself'),
        ),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeFollow(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    expect(quota.history.follow).toHaveLength(0);
  });
});

describe('executePost', () => {
  it('generates content, calls generatePost, and consumes quota on success', async () => {
    const client = {
      generatePost: vi.fn(async () => ({
        post: { id: 'new-post-id', image_url: 'https://cdn/new.jpg' },
      })),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executePost(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(quota.history.post).toHaveLength(1);
  });

  it('skips when agent has no apiKey', async () => {
    const client = {} as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executePost(
      ctx,
      { ...makeAgent('alice'), apiKey: undefined },
      persona,
      quota,
    );
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_api_key');
  });

  it('dry-run: does not call generatePost and does not consume quota', async () => {
    const client = {} as unknown as InstaMoltClient;
    const ctx = makeCtx({ client, dryRun: true });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executePost(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.detail).toMatch(/\[DRY\]/);
    expect(quota.history.post).toHaveLength(0);
  });
});

describe('executeCommentLike', () => {
  it('fetches tree, picks a non-self comment, and likes it', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [
          makeComment('c1'),
          makeComment('c2', {
            author: { agentname: 'alice', is_verified: false, has_owner: false },
          }), // self
          makeComment('c3'),
        ],
      }),
      likeComment: vi.fn().mockResolvedValue({ success: true, liked: true }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeCommentLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(client.likeComment).toHaveBeenCalledOnce();
    const [, commentIdArg] = (client.likeComment as ReturnType<typeof vi.fn>).mock.calls[0];
    // Should NEVER like the self-authored comment
    expect(commentIdArg).not.toBe('c2');
    expect(quota.history.commentLike).toHaveLength(1);
  });

  it('skips when the feed cache has no posts with comment_count >= 1', async () => {
    const client = { getPostComments: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [{ ...makePost('p1'), comment_count: 0 }],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeCommentLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    expect(client.getPostComments).not.toHaveBeenCalled();
  });

  it('skips when the fetched tree has no likeable comments', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [
          makeComment('c1', {
            author: { agentname: 'alice', is_verified: false, has_owner: false },
          }),
        ],
      }),
      likeComment: vi.fn(),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeCommentLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_likeable_comments');
    expect(client.likeComment).not.toHaveBeenCalled();
  });
});

describe('executeReply (feed-driven)', () => {
  it('fetches tree, picks a non-self depth<2 parent, and posts with parent_comment_id', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [
          makeComment('root', { depth: 0 }),
          makeComment('child', { depth: 1, parent_comment_id: 'root' }),
        ],
      }),
      commentOnPost: vi.fn().mockResolvedValue({ comment: { id: 'new' } }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')], // 1 post with comment_count: 2
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(client.commentOnPost).toHaveBeenCalledOnce();
    const callArgs = (client.commentOnPost as ReturnType<typeof vi.fn>).mock.calls[0];
    // commentOnPost(postId, text, parentCommentId)
    expect(callArgs[2]).toBeDefined(); // parent id must be passed
    expect(quota.history.reply).toHaveLength(1);
  });

  it('does NOT consume quota on ParentDeletedError', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [makeComment('c1')],
      }),
      commentOnPost: vi.fn().mockRejectedValue(new ParentDeletedError('p1', 'c1')),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('parent_deleted');
    expect(quota.history.reply).toHaveLength(0);
  });

  it('falls back to a top-level comment when no eligible parent exists, consuming reply quota on the same post', async () => {
    const client = {
      // Empty tree — no candidates for pickReplyTarget
      getPostComments: vi.fn().mockResolvedValue({ comments: [] }),
      // Top-level comment path uses commentOnPost WITHOUT parentCommentId
      commentOnPost: vi.fn().mockResolvedValue({ comment: { id: 'new' } }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeReply(ctx, makeAgent('alice'), persona, quota);
    // The fallback now reports as the original action kind ('reply') and
    // consumes reply quota — the comment is just the physical shape of
    // the action, not a re-classification of the budget.
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.kind).toBe('reply');
    expect(quota.history.reply).toHaveLength(1);
    expect(quota.history.comment).toHaveLength(0);
    // The comment is posted on the SAME post the reply executor picked,
    // WITHOUT a parent_comment_id (top-level, not a threaded reply).
    expect(client.commentOnPost).toHaveBeenCalledTimes(1);
    expect(client.commentOnPost).toHaveBeenCalledWith('p1', expect.any(String));
  });

  it('dry-run: does not call commentOnPost and does not consume quota', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [makeComment('c1')],
      }),
      commentOnPost: vi.fn(),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      dryRun: true,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.detail).toMatch(/\[DRY\]/);
    expect(client.commentOnPost).not.toHaveBeenCalled();
    expect(quota.history.reply).toHaveLength(0);
  });
});

describe('executeActivityDrivenReply', () => {
  it('fetches /me/activity, posts a reply with parent_comment_id, and records repliedToActivityId', async () => {
    const client = {
      getMyActivity: vi.fn().mockResolvedValue({
        activities: [
          {
            id: 'act-1',
            type: 'comment',
            actor: {
              agentname: 'commenter',
              is_verified: false,
              has_owner: false,
            },
            post: { id: 'mypost', image_url: '', caption: 'my post', image_count: 1 },
            comment: { id: 'c1', content: 'nice' },
            created_at: '2026-04-11T00:00:00Z',
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
      getPostComments: vi.fn().mockResolvedValue({
        comments: [
          makeComment('c1', {
            author: { agentname: 'commenter', is_verified: false, has_owner: false },
          }),
        ],
      }),
      commentOnPost: vi.fn().mockResolvedValue({ comment: { id: 'new' } }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeActivityDrivenReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    expect(client.commentOnPost).toHaveBeenCalledOnce();
    expect(quota.history.reply).toHaveLength(1);

    // runtime-comments.json should carry repliedToActivityId for dedup
    const runtimeKey = Array.from(fsState.files.keys()).find((k) =>
      k.endsWith('runtime-comments.json'),
    );
    expect(runtimeKey).toBeDefined();
    if (runtimeKey) {
      const parsed = JSON.parse(fsState.files.get(runtimeKey) as string);
      expect(parsed.comments[0].repliedToActivityId).toBe('act-1');
    }
  });

  it('returns no_fresh_inbound_activity when the feed is empty', async () => {
    const client = {
      getMyActivity: vi.fn().mockResolvedValue({
        activities: [],
        next_cursor: null,
        has_more: false,
      }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeActivityDrivenReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_fresh_inbound_activity');
  });

  it('dedupes activities already recorded in runtime-comments.json', async () => {
    // Pre-populate runtime-comments.json with the activity we're about to receive
    const agent = makeAgent('alice');
    const { join } = await import('node:path');
    const runtimePath = join('./output/agents', agent.agentname, 'runtime-comments.json');
    fsState.files.set(
      runtimePath,
      JSON.stringify({
        agentname: 'alice',
        comments: [
          {
            text: 'already replied',
            generatedAt: '2026-04-10T00:00:00Z',
            repliedToActivityId: 'act-1',
          },
        ],
      }),
    );

    const client = {
      getMyActivity: vi.fn().mockResolvedValue({
        activities: [
          {
            id: 'act-1',
            type: 'comment',
            actor: { agentname: 'commenter', is_verified: false, has_owner: false },
            post: { id: 'mypost', image_url: '', caption: 'my post', image_count: 1 },
            comment: { id: 'c1', content: 'nice' },
            created_at: '2026-04-11T00:00:00Z',
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
      getPostComments: vi.fn(),
      commentOnPost: vi.fn(),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota(agent.agentname, persona);

    const res = await executeActivityDrivenReply(ctx, agent, persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_fresh_inbound_activity');
    expect(client.commentOnPost).not.toHaveBeenCalled();
    expect(quota.history.reply).toHaveLength(0);
  });

  it('skips when the parent comment no longer exists in the fresh tree', async () => {
    const client = {
      getMyActivity: vi.fn().mockResolvedValue({
        activities: [
          {
            id: 'act-1',
            type: 'comment',
            actor: { agentname: 'commenter', is_verified: false, has_owner: false },
            post: { id: 'mypost', image_url: '', caption: 'my post', image_count: 1 },
            comment: { id: 'c1', content: 'nice' },
            created_at: '2026-04-11T00:00:00Z',
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
      // Tree comes back empty — the comment we wanted to reply to is gone
      getPostComments: vi.fn().mockResolvedValue({ comments: [] }),
      commentOnPost: vi.fn(),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeActivityDrivenReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') {
      expect(res.reason).toBe('parent_deleted_or_max_depth');
    }
    expect(quota.history.reply).toHaveLength(0);
  });
});

describe('dispatchAction', () => {
  it('routes to executeLike for kind=like', async () => {
    const client = {
      likePost: vi.fn().mockResolvedValue({ success: true, liked: true }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await dispatchAction('like', ctx, makeAgent('alice'), persona, quota, 0.35);
    expect(res.kind).toBe('like');
    expect(client.likePost).toHaveBeenCalledOnce();
  });

  it('routes to executeActivityDrivenReply first when activity prob is 1.0', async () => {
    const client = {
      getMyActivity: vi.fn().mockResolvedValue({
        activities: [],
        next_cursor: null,
        has_more: false,
      }),
      getPostComments: vi.fn().mockResolvedValue({
        comments: [makeComment('c1')],
      }),
      commentOnPost: vi.fn().mockResolvedValue({ comment: { id: 'new' } }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    // With activityReplyProbability=1.0, executeActivityDrivenReply fires
    // first. The mocked activity feed is empty, so it skips with
    // no_fresh_inbound_activity → falls through to executeReply.
    const res = await dispatchAction('reply', ctx, makeAgent('alice'), persona, quota, 1.0);
    expect(client.getMyActivity).toHaveBeenCalled(); // reciprocity tried first
    expect(client.getPostComments).toHaveBeenCalled(); // fell through to feed-driven
    expect(res.status).toBe('ok');
    expect(res.kind).toBe('reply');
  });
});

// --- Depth-upgrade error-path coverage ---------------------------------
//
// These cases cover the error/skip branches that the happy-path tests above
// don't exercise: surface-level mapping of InstaMoltApiError (4xx vs 5xx),
// quota-exhaustion gating for comment/post (not just like), feed-cache
// emptiness for non-like actions, MCP failures, moderation-style rejections,
// and the runtime-comments append-on-success invariant for BOTH comment and
// reply.
//
// Finding: the executors do NOT differentiate 429 / 4xx / 5xx at all — every
// InstaMoltApiError (and every plain Error) collapses into `{ status: 'error',
// error: String(err) }` without retry or special handling. The `request()`
// layer retries 429 ONCE internally (see tests/services/instamolt-api.test.ts);
// past that, the executor just surfaces the error. Tests below assert that
// current-behavior-as-contract so any future differentiation is a visible
// diff.
describe('executeLike: error-path depth coverage', () => {
  it('surfaces an InstaMoltApiError 429 as { status: error } — no retry at this layer', async () => {
    const err = new InstaMoltApiError('POST', '/posts/p1/like', 429, 'rate limited', 60_000);
    const client = {
      likePost: vi.fn().mockRejectedValue(err),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/429/);
    // Quota must NOT be consumed when the API call failed.
    expect(quota.history.like).toHaveLength(0);
    // No retry happens at the executor layer — request() handles 429 retry
    // internally, and an InstaMoltApiError escaping here means that retry
    // already exhausted.
    expect(client.likePost).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 400 InstaMoltApiError as error (same as any other failure — no special 4xx branch)', async () => {
    const client = {
      likePost: vi
        .fn()
        .mockRejectedValue(new InstaMoltApiError('POST', '/posts/p1/like', 400, 'bad request')),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/400/);
    expect(quota.history.like).toHaveLength(0);
  });

  it('surfaces a 500 InstaMoltApiError as error (no retry at the executor layer)', async () => {
    const client = {
      likePost: vi
        .fn()
        .mockRejectedValue(new InstaMoltApiError('POST', '/posts/p1/like', 500, 'server error')),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/500/);
    expect(quota.history.like).toHaveLength(0);
    // Current behavior: exactly one attempt. No 5xx retry here.
    expect(client.likePost).toHaveBeenCalledTimes(1);
  });

  it('skips with no_candidate_post when the feed cache has zero posts at all', async () => {
    const client = { likePost: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeLike(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('no_candidate_post');
    // MUST NOT throw; must NOT call the API.
    expect(client.likePost).not.toHaveBeenCalled();
  });
});

describe('executeComment: error-path depth coverage', () => {
  it('returns skipped with quota_exhausted when the comment slot is at cap', async () => {
    const client = { commentOnPost: vi.fn() } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona({ commentProbability: 0.5 });
    const quota = makeFreshQuota('alice', persona);
    exhaustKind(quota, 'comment');

    const res = await executeComment(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('quota_exhausted');
    // Gate is first thing the executor does — no API call at all.
    expect(client.commentOnPost).not.toHaveBeenCalled();
  });

  it('surfaces a 403 moderation-block-style InstaMoltApiError as error (no dedicated skip reason)', async () => {
    // Finding: the source does not differentiate moderation-style 403s from
    // any other error — they collapse into { status: 'error' }. This test
    // pins that current behavior so any future moderation-aware branch is
    // visible in a diff.
    const client = {
      commentOnPost: vi
        .fn()
        .mockRejectedValue(
          new InstaMoltApiError('POST', '/posts/p1/comments', 403, 'blocked by moderation'),
        ),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeComment(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/403/);
    expect(quota.history.comment).toHaveLength(0);
    // And since we errored before reaching the append, runtime-comments.json
    // must NOT have been written.
    const runtimeKey = Array.from(fsState.files.keys()).find((k) =>
      k.endsWith('runtime-comments.json'),
    );
    expect(runtimeKey).toBeUndefined();
  });

  it('appends to runtime-comments.json EXACTLY once with the generated text on success', async () => {
    const client = {
      commentOnPost: vi.fn().mockResolvedValue({ comment: { id: 'c-new' } }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeComment(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    const runtimeKey = Array.from(fsState.files.keys()).find((k) =>
      k.endsWith('runtime-comments.json'),
    );
    expect(runtimeKey).toBeDefined();
    if (runtimeKey) {
      const parsed = JSON.parse(fsState.files.get(runtimeKey) as string);
      expect(parsed.comments).toHaveLength(1);
      expect(parsed.comments[0].text).toBe('canned generated comment text');
      expect(parsed.comments[0].postId).toBeDefined();
      expect(parsed.comments[0].againstAuthor).toBeDefined();
    }
  });
});

describe('executeReply: error-path depth coverage', () => {
  it('appends to runtime-comments.json with parentCommentId + depth on success', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [makeComment('root', { depth: 0 })],
      }),
      commentOnPost: vi.fn().mockResolvedValue({ comment: { id: 'reply-new' } }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('ok');
    const runtimeKey = Array.from(fsState.files.keys()).find((k) =>
      k.endsWith('runtime-comments.json'),
    );
    expect(runtimeKey).toBeDefined();
    if (runtimeKey) {
      const parsed = JSON.parse(fsState.files.get(runtimeKey) as string);
      expect(parsed.comments).toHaveLength(1);
      expect(parsed.comments[0].text).toBe('canned reply text');
      expect(parsed.comments[0].parentCommentId).toBe('root');
      // Parent depth 0 → new reply depth 1.
      expect(parsed.comments[0].depth).toBe(1);
    }
  });

  it('surfaces a non-ParentDeleted 4xx on commentOnPost as error without consuming quota', async () => {
    const client = {
      getPostComments: vi.fn().mockResolvedValue({
        comments: [makeComment('root', { depth: 0 })],
      }),
      commentOnPost: vi
        .fn()
        .mockRejectedValue(new InstaMoltApiError('POST', '/posts/p1/comments', 400, 'bad request')),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({
      client,
      feedCache: {
        refreshedAt: new Date().toISOString(),
        sources: ['explore'],
        posts: [makePost('p1')],
      },
    });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executeReply(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/400/);
    expect(quota.history.reply).toHaveLength(0);
  });
});

describe('executePost: error-path depth coverage', () => {
  it('returns { status: error } with the error message when generatePost throws — does NOT rethrow', async () => {
    const client = {
      generatePost: vi.fn(async () => {
        throw new Error('generate boom');
      }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executePost(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/generate boom/);
    expect(quota.history.post).toHaveLength(0);
  });

  it('returns { status: error } when the platform rejects the request', async () => {
    const client = {
      generatePost: vi.fn(async () => {
        throw new InstaMoltApiError(
          'POST',
          '/posts/generate',
          400,
          'moderation rejected the caption',
        );
      }),
    } as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);

    const res = await executePost(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.error).toMatch(/moderation rejected/);
    expect(quota.history.post).toHaveLength(0);
  });

  it('returns skipped with quota_exhausted when the post slot is at cap', async () => {
    const client = {} as unknown as InstaMoltClient;
    const ctx = makeCtx({ client });
    const persona = makePersona();
    const quota = makeFreshQuota('alice', persona);
    exhaustKind(quota, 'post');

    const res = await executePost(ctx, makeAgent('alice'), persona, quota);
    expect(res.status).toBe('skipped');
    if (res.status === 'skipped') expect(res.reason).toBe('quota_exhausted');
    expect(quota.history.post).toHaveLength(persona.postsPerDay[1]);
  });
});
