import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCacheFile, Persona, RemotePost } from '@/types';

// ---------------- fs mocks ----------------

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
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
  readdir: vi.fn(async (path: string) => {
    const entries = fsState.dirEntries.get(path);
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  }),
}));

// ---------------- llm mock ----------------

const llmMocks = vi.hoisted(() => ({
  generateComment: vi.fn<() => Promise<string>>(),
  generatePostContent:
    vi.fn<
      () => Promise<{
        imagePrompt: string;
        caption: string;
        aspectRatio: 'square' | 'landscape' | 'portrait';
      }>
    >(),
  rollChaos: vi.fn(() => false),
}));
vi.mock('@/services/llm', () => llmMocks);

// ---------------- instamolt-api mock ----------------

const apiMocks = vi.hoisted(() => ({
  likePost: vi.fn<() => Promise<{ success: boolean; liked: boolean }>>(),
  commentOnPost: vi.fn<() => Promise<void>>(),
  followAgent: vi.fn<() => Promise<{ success: boolean; following: boolean }>>(),
  generatePost: vi.fn<() => Promise<{ post: { id: string; image_url: string } }>>(),
}));

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function () {
    return {
      likePost: apiMocks.likePost,
      commentOnPost: apiMocks.commentOnPost,
      followAgent: apiMocks.followAgent,
      generatePost: apiMocks.generatePost,
    };
  }),
  InstaMoltApiError: class extends Error {
    constructor(
      readonly method: string,
      readonly path: string,
      readonly status: number,
      readonly body: string,
      readonly retryAfterMs?: number,
    ) {
      super(`${method} ${path}: ${status}`);
      this.name = 'InstaMoltApiError';
    }
  },
}));

// ---------------- event-logger mock ----------------
// Event-logger writes JSONL files via node:fs (sync). Mock it as a no-op so
// tests never touch the real filesystem and so we can assert on calls if
// we want to later.

const eventLoggerMocks = vi.hoisted(() => ({
  initEventLogger: vi.fn(),
  logEvent: vi.fn(),
  logSkippedAction: vi.fn(),
  flushStats: vi.fn(),
  updateAgentCounts: vi.fn(),
  drainWrites: vi.fn(async () => {}),
}));
vi.mock('@/lib/event-logger', () => eventLoggerMocks);

// ---------------- feed-cache mock ----------------
// engage.ts loads the shared feed cache once per cycle via loadFeedCacheStrict
// and every agent reads posts from the same snapshot.

const feedCacheMocks = vi.hoisted(() => ({
  loadFeedCacheStrict: vi.fn<() => Promise<FeedCacheFile>>(),
}));

vi.mock('@/lib/feed-cache', async () => {
  // Preserve the real FeedCacheEmptyError class so `instanceof` inside
  // engage.ts resolves against the same constructor.
  const actual = await vi.importActual<typeof import('@/lib/feed-cache')>('@/lib/feed-cache');
  return {
    ...actual,
    loadFeedCacheStrict: feedCacheMocks.loadFeedCacheStrict,
  };
});

function makeRemotePost(id: string, agentname: string, caption: string): RemotePost {
  return {
    id,
    image_url: 'http://x/y.jpg',
    thumbnail_url: null,
    caption,
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
    author: { agentname, is_verified: false },
  };
}

function makeFeedCache(posts: RemotePost[]): FeedCacheFile {
  return {
    refreshedAt: '2026-04-13T00:00:00.000Z',
    sources: ['explore'],
    posts,
  };
}

/**
 * Convenience helper so tests can describe feed content in the legacy
 * `{id, agentname, caption}` shape (same ergonomics as the pre-feed-cache
 * engage tests) while the mock still returns a properly-shaped `FeedCacheFile`.
 */
function feedCacheFromLegacy(
  legacy: Array<{ id: string; agentname: string; caption?: string }>,
): FeedCacheFile {
  return makeFeedCache(legacy.map((p) => makeRemotePost(p.id, p.agentname, p.caption ?? '')));
}

// ---------------- personas mock ----------------

const personaMocks = vi.hoisted(() => ({
  loadPersonas: vi.fn<() => Promise<Map<string, Persona>>>(),
}));
vi.mock('@/personas/index', () => personaMocks);

// ---------------- ui mock ----------------
// engage.ts now writes through src/ui.ts (intro/outro/spinner/section). Mock
// it as a no-op so test output isn't polluted by spinner escape codes, and so
// we can assert on spinner messages in tests where the wording matters.

const uiMocks = vi.hoisted(() => {
  const spinnerMessages: string[] = [];
  return { spinnerMessages };
});

vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  section: vi.fn(),
  note: vi.fn(),
  isInteractive: vi.fn(() => false),
  summaryLine: vi.fn(),
  progress: vi.fn(() => ({
    tick: vi.fn(),
    done: vi.fn(),
  })),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    message: vi.fn((msg: string) => {
      uiMocks.spinnerMessages.push(msg);
    }),
    stop: vi.fn((msg?: string) => {
      if (msg) uiMocks.spinnerMessages.push(msg);
    }),
  })),
  color: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
  symbol: { ok: '✓', err: '✗', warn: '!', info: 'i' },
}));

// ---------------- imports ----------------

import { engage } from '@/commands/engage';

function makePersona(id: string): Persona {
  return {
    id,
    tagline: 'test tagline',
    personality: 'A cheerful AI agent that engages lots.',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    namePatterns: [],
    hashtagPool: ['#foo'],
    postsPerDay: [0, 0], // Force the fresh-post branch OFF for determinism.
    likeProbability: 1, // Always like
    commentProbability: 1,
    followProbability: 1, // Always follow
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
  };
}

function primeAgent(name: string, extras: Record<string, unknown> = {}): void {
  fsState.files.set(
    join(process.cwd().replace(/\\/g, '/'), 'output/agents', name, 'agent.json'),
    JSON.stringify({
      agentname: name,
      personaId: 'test-persona',
      bio: 'A calm considered AI mind',
      apiKey: `key-${name}`,
      ...extras,
    }),
  );
  // Also set the relative path that engage.ts's join('./output/agents', name, ...) produces.
  fsState.files.set(
    join('./output/agents', name, 'agent.json'),
    JSON.stringify({
      agentname: name,
      personaId: 'test-persona',
      bio: 'A calm considered AI mind',
      apiKey: `key-${name}`,
      ...extras,
    }),
  );
}

let logSpy: ReturnType<typeof vi.spyOn>;

describe('engage', () => {
  beforeEach(() => {
    // Stub setTimeout so the 30-60s inter-agent stagger and 3-30s action
    // delays don't block tests.
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    });
    fsState.files.clear();
    fsState.dirEntries.clear();
    uiMocks.spinnerMessages.length = 0;
    feedCacheMocks.loadFeedCacheStrict.mockReset();
    apiMocks.likePost.mockReset();
    apiMocks.commentOnPost.mockReset();
    apiMocks.followAgent.mockReset();
    llmMocks.generateComment.mockReset();
    llmMocks.generatePostContent.mockReset();
    apiMocks.generatePost.mockReset();
    personaMocks.loadPersonas.mockReset();
    eventLoggerMocks.initEventLogger.mockReset();
    eventLoggerMocks.logEvent.mockReset();
    eventLoggerMocks.logSkippedAction.mockReset();
    eventLoggerMocks.flushStats.mockReset();
    eventLoggerMocks.updateAgentCounts.mockReset();

    personaMocks.loadPersonas.mockResolvedValue(
      new Map([['test-persona', makePersona('test-persona')]]),
    );
    apiMocks.likePost.mockResolvedValue({ success: true, liked: true });
    apiMocks.commentOnPost.mockResolvedValue(undefined);
    apiMocks.followAgent.mockResolvedValue({ success: true, following: true });
    llmMocks.generateComment.mockResolvedValue('thoughtful take');
    apiMocks.generatePost.mockResolvedValue({
      post: { id: 'p1', image_url: 'https://cdn/p1.jpg' },
    });

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  function getLogOutput(): string {
    const calls = logSpy.mock.calls as unknown[][];
    return calls.map((call) => call.join(' ')).join('\n');
  }

  it('exits early and logs an error when no registered agents exist', async () => {
    fsState.dirEntries.set('./output/agents', []);
    await engage();
    const out = getLogOutput();
    expect(out).toMatch(/No registered agents/i);
    expect(feedCacheMocks.loadFeedCacheStrict).not.toHaveBeenCalled();
  });

  it('runs one cycle against a single agent with likes/comments/follows', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([
        { id: 'post-1', agentname: 'beta', caption: 'hi' },
        { id: 'post-2', agentname: 'beta', caption: 'yo' },
        { id: 'post-3', agentname: 'beta', caption: 'ok' },
        { id: 'post-4', agentname: 'beta', caption: 'sure' },
      ]),
    );

    await engage({ agents: 1, limit: 10 });

    // Like probability is 1, so at least the likesTarget (2-4) likes should fire.
    expect(apiMocks.likePost).toHaveBeenCalled();
    // Comment path should also fire at least once.
    expect(apiMocks.commentOnPost).toHaveBeenCalled();
    // Follow path should also fire.
    expect(apiMocks.followAgent).toHaveBeenCalled();
  });

  it('skips the comment loop when lastCommentedAt is within the cooldown window', async () => {
    primeAgent('alpha', { lastCommentedAt: new Date().toISOString() });
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'hi' }]),
    );

    await engage({ agents: 1, limit: 10 });

    expect(apiMocks.commentOnPost).not.toHaveBeenCalled();
    // The "comment cooldown active, skipping" wording goes through the
    // ui spinner now, not the plain logger.
    const cooldownMsg = uiMocks.spinnerMessages.find((m) => /cooldown/i.test(m));
    expect(cooldownMsg).toBeDefined();
  });

  it('does not skip comments when lastCommentedAt is older than 65 seconds', async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    primeAgent('alpha', { lastCommentedAt: twoMinutesAgo });
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'hi' }]),
    );

    await engage({ agents: 1, limit: 10 });

    expect(apiMocks.commentOnPost).toHaveBeenCalled();
  });

  it('persists a new lastCommentedAt after a successful comment', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'hi' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const updated = JSON.parse(fsState.files.get(join('./output/agents', 'alpha', 'agent.json'))!);
    expect(updated.lastCommentedAt).toBeTruthy();
    // Should be roughly now — not ancient.
    const delta = Date.now() - Date.parse(updated.lastCommentedAt);
    expect(delta).toBeLessThan(10_000);
  });

  it('passes the agent context (bio + agentname) into generateComment', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap text' }]),
    );

    await engage({ agents: 1, limit: 10 });

    expect(llmMocks.generateComment).toHaveBeenCalled();
    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    // Signature: (persona, agent, postCaption, postAuthor, priorComments)
    expect(callArgs[1]).toEqual({
      agentname: 'alpha',
      bio: 'A calm considered AI mind',
    });
    expect(callArgs[2]).toBe('cap text');
    expect(callArgs[3]).toBe('beta');
    // priorComments arrives as an empty array (alpha has no comments.json).
    expect(callArgs[4]).toEqual([]);
  });

  it('persists each posted comment to runtime-comments.json (capped tail)', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([
        { id: 'post-1', agentname: 'beta', caption: 'cap one' },
        { id: 'post-2', agentname: 'beta', caption: 'cap two' },
      ]),
    );

    llmMocks.generateComment
      .mockResolvedValueOnce('runtime first reply')
      .mockResolvedValueOnce('runtime second reply');

    await engage({ agents: 1, limit: 10 });

    const written = fsState.files.get(join('./output/agents', 'alpha', 'runtime-comments.json'));
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      agentname: string;
      comments: Array<{
        text: string;
        generatedAt: string;
        againstPostId?: string;
        againstAuthor?: string;
      }>;
    };
    expect(parsed.agentname).toBe('alpha');
    // commentsTarget is randInt(1, 2), so at least one comment is persisted.
    // Posts are shuffled by engage so we can't assert which post was hit
    // first — just verify the metadata is wired through.
    expect(parsed.comments.length).toBeGreaterThanOrEqual(1);
    expect(parsed.comments[0]?.text).toBe('runtime first reply');
    expect(['post-1', 'post-2']).toContain(parsed.comments[0]?.againstPostId);
    expect(parsed.comments[0]?.againstAuthor).toBe('beta');
    expect(typeof parsed.comments[0]?.generatedAt).toBe('string');
  });

  it('loads runtime-comments.json on cycle start as part of the priorComments avoid list', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    // No baked samples, but a runtime tail from a prior cycle.
    fsState.files.set(
      join('./output/agents', 'alpha', 'runtime-comments.json'),
      JSON.stringify({
        agentname: 'alpha',
        comments: [
          { text: 'runtime tail one', generatedAt: '2026-04-08T00:00:00Z' },
          { text: 'runtime tail two', generatedAt: '2026-04-08T00:00:01Z' },
        ],
      }),
    );

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    expect(callArgs[4]).toEqual(['runtime tail one', 'runtime tail two']);
  });

  it('combines baked samples and runtime tail in the priorComments avoid list (baked first)', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    fsState.files.set(
      join('./output/agents', 'alpha', 'comments.json'),
      JSON.stringify({
        agentname: 'alpha',
        generatedAt: '2026-04-08T00:00:00Z',
        samples: [{ sourceCaption: 's', sourceAuthor: 'x', text: 'baked', generatedAt: '' }],
      }),
    );
    fsState.files.set(
      join('./output/agents', 'alpha', 'runtime-comments.json'),
      JSON.stringify({
        agentname: 'alpha',
        comments: [{ text: 'runtime', generatedAt: '2026-04-08T00:00:00Z' }],
      }),
    );

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    // Baked first, then runtime — order matters because generateComment
    // slices to the last 6, so the freshest runtime entries always make
    // the cut.
    expect(callArgs[4]).toEqual(['baked', 'runtime']);
  });

  it('loads baked comment samples from comments.json as the priorComments avoid list', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    // Drop a baked comments.json so loadPriorComments() finds three avoid texts.
    fsState.files.set(
      join('./output/agents', 'alpha', 'comments.json'),
      JSON.stringify({
        agentname: 'alpha',
        generatedAt: '2026-04-08T00:00:00Z',
        samples: [
          { sourceCaption: 'a', sourceAuthor: 'x', text: 'baked one', generatedAt: '' },
          { sourceCaption: 'b', sourceAuthor: 'y', text: 'baked two', generatedAt: '' },
          { sourceCaption: 'c', sourceAuthor: 'z', text: 'baked three', generatedAt: '' },
        ],
      }),
    );

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([
        { id: 'post-1', agentname: 'beta', caption: 'first' },
        { id: 'post-2', agentname: 'beta', caption: 'second' },
      ]),
    );

    // Have generateComment return predictable text so we can verify it gets
    // appended to the in-memory avoid list across calls within the same cycle.
    llmMocks.generateComment.mockResolvedValueOnce('runtime first');
    llmMocks.generateComment.mockResolvedValueOnce('runtime second');

    await engage({ agents: 1, limit: 10 });

    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    expect(callArgs[4]).toEqual(['baked one', 'baked two', 'baked three']);
  });

  it('skips an agent whose persona is missing from the map', async () => {
    primeAgent('alpha');
    // Override file to have an unknown persona.
    fsState.files.set(
      join('./output/agents', 'alpha', 'agent.json'),
      JSON.stringify({
        agentname: 'alpha',
        personaId: 'missing-persona',
        bio: 'A calm considered AI mind',
        apiKey: 'key-alpha',
      }),
    );
    fsState.dirEntries.set('./output/agents', ['alpha']);
    // Feed cache is loaded once per cycle BEFORE we iterate agents, so even
    // when every agent is unskippable the cache load still fires. We assert
    // the per-agent action paths stay untouched instead.
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'ignored' }]),
    );

    await engage({ agents: 1, limit: 10 });

    expect(apiMocks.likePost).not.toHaveBeenCalled();
    expect(apiMocks.commentOnPost).not.toHaveBeenCalled();
    expect(apiMocks.followAgent).not.toHaveBeenCalled();
  });

  it('aborts the cycle when the live feed is empty (FeedCacheEmptyError)', async () => {
    const { FeedCacheEmptyError } = await import('@/lib/feed-cache');
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCacheStrict.mockRejectedValue(new FeedCacheEmptyError());

    await expect(engage({ agents: 1, limit: 10 })).rejects.toThrow(FeedCacheEmptyError);

    // Per-agent actions must not fire when the feed is empty — no synthetic
    // fallback, no silent skip.
    expect(apiMocks.likePost).not.toHaveBeenCalled();
    expect(apiMocks.commentOnPost).not.toHaveBeenCalled();
    expect(apiMocks.followAgent).not.toHaveBeenCalled();
  });

  // --- Event-logger integration -----------------------------------------
  // Assertions on the structured activity stream wired through engage.ts.
  // Each action path (like / comment / follow / post / cooldown-skip /
  // feed-refresh success+fail) must surface the right event so overnight
  // operators can reconstruct a cycle from `output/logs/events.jsonl`.

  function eventTypes(): string[] {
    return eventLoggerMocks.logEvent.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
  }

  function eventsOfType<T = Record<string, unknown>>(type: string): T[] {
    return eventLoggerMocks.logEvent.mock.calls
      .map((c) => c[0] as T & { eventType: string })
      .filter((e) => e.eventType === type);
  }

  it('initializes the event logger on command start', async () => {
    fsState.dirEntries.set('./output/agents', []);
    await engage();
    expect(eventLoggerMocks.initEventLogger).toHaveBeenCalled();
  });

  it('emits session_start, session_end, and flushes on a full cycle', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'hi' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const types = eventTypes();
    expect(types).toContain('session_start');
    expect(types).toContain('session_end');
    // session_start fires before session_end.
    expect(types.indexOf('session_start')).toBeLessThan(types.indexOf('session_end'));
    // Cycle number is tracked on both bookend events.
    const starts = eventsOfType<{ details: { cycleNumber: number } }>('session_start');
    const ends = eventsOfType<{ details: { cycleNumber: number } }>('session_end');
    expect(starts[0].details.cycleNumber).toBe(1);
    expect(ends[0].details.cycleNumber).toBe(1);
    // updateAgentCounts is called with (registered, active) — 1 agent primed,
    // 1 selected for this cycle.
    expect(eventLoggerMocks.updateAgentCounts).toHaveBeenCalledWith(1, 1);
    // flushStats fires at cycle end + once more in the finally block.
    expect(eventLoggerMocks.flushStats).toHaveBeenCalled();
  });

  it('emits a feed_refresh success event with the post count', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([
        { id: 'post-1', agentname: 'beta', caption: 'one' },
        { id: 'post-2', agentname: 'beta', caption: 'two' },
        { id: 'post-3', agentname: 'beta', caption: 'three' },
      ]),
    );

    await engage({ agents: 1, limit: 10 });

    const refreshes = eventsOfType<{
      success: boolean;
      details: { postCount: number };
    }>('feed_refresh');
    expect(refreshes.length).toBe(1);
    expect(refreshes[0].success).toBe(true);
    expect(refreshes[0].details.postCount).toBe(3);
  });

  it('emits a feed_refresh failure event when the feed load throws', async () => {
    const { FeedCacheEmptyError } = await import('@/lib/feed-cache');
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockRejectedValue(new FeedCacheEmptyError('empty'));

    await expect(engage({ agents: 1, limit: 10 })).rejects.toThrow(FeedCacheEmptyError);

    const refreshes = eventsOfType<{ success: boolean; error?: string }>('feed_refresh');
    expect(refreshes.length).toBe(1);
    expect(refreshes[0].success).toBe(false);
    expect(refreshes[0].error).toMatch(/empty/i);
  });

  it('emits a like event for each successful like with agent + post context', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([
        { id: 'post-1', agentname: 'beta', caption: 'one' },
        { id: 'post-2', agentname: 'beta', caption: 'two' },
        { id: 'post-3', agentname: 'beta', caption: 'three' },
        { id: 'post-4', agentname: 'beta', caption: 'four' },
      ]),
    );

    await engage({ agents: 1, limit: 10 });

    const likes = eventsOfType<{
      agentname: string;
      persona: string;
      success: boolean;
      details: { postId: string; targetAuthor: string };
    }>('like');
    expect(likes.length).toBeGreaterThanOrEqual(1);
    expect(likes.length).toBe(apiMocks.likePost.mock.calls.length);
    for (const e of likes) {
      expect(e.agentname).toBe('alpha');
      expect(e.persona).toBe('test-persona');
      expect(e.success).toBe(true);
      expect(e.details.targetAuthor).toBe('beta');
      expect(e.details.postId).toMatch(/^post-\d$/);
    }
  });

  it('emits a like failure event with httpStatus + requestContext when the API throws InstaMoltApiError', async () => {
    const { InstaMoltApiError } = await import('@/services/instamolt-api');
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'one' }]),
    );
    // Fail every like attempt with a typed API error so errorDetails() pulls
    // out status + requestContext.
    apiMocks.likePost.mockRejectedValue(
      new InstaMoltApiError('POST', '/posts/post-1/like', 500, 'boom'),
    );

    await engage({ agents: 1, limit: 10 });

    const likeFailures = eventsOfType<{
      success: boolean;
      error?: string;
      details: {
        postId: string;
        targetAuthor: string;
        httpStatus?: number;
        requestContext?: { method?: string; path?: string };
      };
    }>('like').filter((e) => !e.success);
    expect(likeFailures.length).toBeGreaterThanOrEqual(1);
    expect(likeFailures[0].details.httpStatus).toBe(500);
    expect(likeFailures[0].details.requestContext?.method).toBe('POST');
    expect(likeFailures[0].details.requestContext?.path).toBe('/posts/post-1/like');
    expect(likeFailures[0].error).toMatch(/500/);
  });

  it('emits a comment event on each successful comment and a cooldown skip via logSkippedAction', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    // At least one comment success event for the single posted comment.
    const comments = eventsOfType<{
      agentname: string;
      persona: string;
      success: boolean;
      details: { postId: string; targetAuthor: string; preview: string };
    }>('comment');
    const successes = comments.filter((c) => c.success);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(successes[0].details.targetAuthor).toBe('beta');
    expect(successes[0].details.preview).toMatch(/thoughtful take/);
    // No cooldown skip on a fresh agent.
    expect(eventLoggerMocks.logSkippedAction).not.toHaveBeenCalled();
  });

  it('calls logSkippedAction("comment", …, reason: cooldown) when the agent is on cooldown', async () => {
    primeAgent('alpha', { lastCommentedAt: new Date().toISOString() });
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    expect(eventLoggerMocks.logSkippedAction).toHaveBeenCalledWith(
      'comment',
      'alpha',
      'test-persona',
      expect.stringMatching(/^cooldown:/),
    );
    // The comment success path must NOT fire a comment event on cooldown.
    const commentSuccesses = eventsOfType<{ success: boolean }>('comment').filter((c) => c.success);
    expect(commentSuccesses.length).toBe(0);
  });

  it('emits a follow event on each successful follow', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const follows = eventsOfType<{
      agentname: string;
      persona: string;
      success: boolean;
      details: { targetAuthor: string };
    }>('follow');
    const successes = follows.filter((f) => f.success);
    expect(successes.length).toBe(apiMocks.followAgent.mock.calls.length);
    expect(successes[0].details.targetAuthor).toBe('beta');
    expect(successes[0].agentname).toBe('alpha');
  });

  it('emits a post_published success event when the fresh-post branch fires', async () => {
    // Force the fresh-post roll to always land by giving the persona a
    // guaranteed postsPerDay window. makePersona has [0,0] for determinism,
    // so override here.
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([
        [
          'test-persona',
          { ...makePersona('test-persona'), postsPerDay: [100, 100] as [number, number] },
        ],
      ]),
    );
    llmMocks.generatePostContent.mockResolvedValue({
      imagePrompt: 'a sunset',
      caption: 'warm light',
      aspectRatio: 'square',
    });
    apiMocks.generatePost.mockResolvedValue({
      post: { id: 'post-new-1', image_url: 'https://cdn/post-new-1.jpg' },
    });

    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const publishes = eventsOfType<{
      success: boolean;
      details: { postId?: string; caption?: string };
    }>('post_published');
    const successes = publishes.filter((p) => p.success);
    expect(successes.length).toBe(1);
    expect(successes[0].details.postId).toBe('post-new-1');
    expect(successes[0].details.caption).toBe('warm light');
  });

  it('emits a post_published failure when generatePost throws', async () => {
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([
        [
          'test-persona',
          { ...makePersona('test-persona'), postsPerDay: [100, 100] as [number, number] },
        ],
      ]),
    );
    llmMocks.generatePostContent.mockResolvedValue({
      imagePrompt: 'x',
      caption: 'y',
      aspectRatio: 'square',
    });
    apiMocks.generatePost.mockRejectedValue(new Error('moderation blocked'));

    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      feedCacheFromLegacy([{ id: 'post-1', agentname: 'beta', caption: 'cap' }]),
    );

    await engage({ agents: 1, limit: 10 });

    const publishes = eventsOfType<{ success: boolean; error?: string }>('post_published');
    const failures = publishes.filter((p) => !p.success);
    expect(failures.length).toBe(1);
    expect(failures[0].error).toBe('moderation blocked');
  });
});
