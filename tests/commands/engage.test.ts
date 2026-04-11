import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Persona } from '@/types';

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
}));
vi.mock('@/services/llm', () => llmMocks);

// ---------------- mcp mock ----------------

const mcpMocks = vi.hoisted(() => ({
  generatePost: vi.fn<() => Promise<{ success: boolean; postId?: string; error?: string }>>(),
}));
vi.mock('@/services/instamolt-mcp', () => mcpMocks);

// ---------------- instamolt-api mock ----------------

const apiMocks = vi.hoisted(() => ({
  getExplore:
    vi.fn<
      () => Promise<{
        posts: Array<{
          id: string;
          agentname: string;
          caption?: string;
          likes_count: number;
          comments_count: number;
          created_at: string;
        }>;
        has_more: boolean;
      }>
    >(),
  likePost: vi.fn<() => Promise<void>>(),
  commentOnPost: vi.fn<() => Promise<void>>(),
  followAgent: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function () {
    return {
      getExplore: apiMocks.getExplore,
      likePost: apiMocks.likePost,
      commentOnPost: apiMocks.commentOnPost,
      followAgent: apiMocks.followAgent,
    };
  }),
}));

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
    interactionBiases: [],
    viralityStrategy: '',
    weight: 1,
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
    apiMocks.getExplore.mockReset();
    apiMocks.likePost.mockReset();
    apiMocks.commentOnPost.mockReset();
    apiMocks.followAgent.mockReset();
    llmMocks.generateComment.mockReset();
    llmMocks.generatePostContent.mockReset();
    mcpMocks.generatePost.mockReset();
    personaMocks.loadPersonas.mockReset();

    personaMocks.loadPersonas.mockResolvedValue(
      new Map([['test-persona', makePersona('test-persona')]]),
    );
    apiMocks.likePost.mockResolvedValue(undefined);
    apiMocks.commentOnPost.mockResolvedValue(undefined);
    apiMocks.followAgent.mockResolvedValue(undefined);
    llmMocks.generateComment.mockResolvedValue('thoughtful take');
    mcpMocks.generatePost.mockResolvedValue({ success: true, postId: 'p1' });

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
    expect(apiMocks.getExplore).not.toHaveBeenCalled();
  });

  it('runs one cycle against a single agent with likes/comments/follows', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'hi',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
        {
          id: 'post-2',
          agentname: 'beta',
          caption: 'yo',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
        {
          id: 'post-3',
          agentname: 'beta',
          caption: 'ok',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
        {
          id: 'post-4',
          agentname: 'beta',
          caption: 'sure',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'hi',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'hi',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

    await engage({ agents: 1, limit: 10 });

    expect(apiMocks.commentOnPost).toHaveBeenCalled();
  });

  it('persists a new lastCommentedAt after a successful comment', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'hi',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'cap text',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'cap one',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
        {
          id: 'post-2',
          agentname: 'beta',
          caption: 'cap two',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'cap',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'cap',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'post-1',
          agentname: 'beta',
          caption: 'first',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
        {
          id: 'post-2',
          agentname: 'beta',
          caption: 'second',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

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

    await engage({ agents: 1, limit: 10 });

    expect(apiMocks.getExplore).not.toHaveBeenCalled();
  });

  it('warns and continues when explore feed is empty', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    apiMocks.getExplore.mockResolvedValue({ posts: [], has_more: false });

    await engage({ agents: 1, limit: 10 });

    expect(apiMocks.likePost).not.toHaveBeenCalled();
    expect(apiMocks.commentOnPost).not.toHaveBeenCalled();
  });
});
