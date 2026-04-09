import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Persona } from '@/types';

vi.stubEnv('GEMINI_API_KEY', 'test-key');

// ---------------- fs mock ----------------

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
}));

vi.mock('@/services/llm', () => llmMocks);

// ---------------- personas mock ----------------

const personaMocks = vi.hoisted(() => ({
  loadPersonas: vi.fn<() => Promise<Map<string, Persona>>>(),
}));

vi.mock('@/personas/index', () => personaMocks);

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
}));

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function () {
    return {
      getExplore: apiMocks.getExplore,
    };
  }),
}));

// ---------------- ui mock (no-op) ----------------

vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  section: vi.fn(),
  note: vi.fn(),
  isInteractive: vi.fn(() => false),
  summaryLine: vi.fn(),
  progress: vi.fn(() => ({ tick: vi.fn(), done: vi.fn() })),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
  })),
  color: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
  symbol: { ok: '✓', err: '✗', warn: '!', info: 'i', arrow: '→' },
}));

import { previewComments } from '@/commands/preview-comments';

function makePersona(id: string): Persona {
  return {
    id,
    personality: 'p',
    tone: 't',
    visualAesthetic: 'v',
    postingStyle: 'ps',
    commentStyle: 'cs',
    namePatterns: [],
    hashtagPool: [],
    postsPerDay: [1, 1],
    likeProbability: 0,
    commentProbability: 0,
    followProbability: 0,
    interactionBiases: [],
    viralityStrategy: '',
    weight: 1,
  };
}

function primeAgent(name: string, personaId: string): void {
  fsState.files.set(
    join('./output/agents', name, 'agent.json'),
    JSON.stringify({ agentname: name, personaId, bio: `${name} bio` }),
  );
}

function primePost(author: string, postId: string, caption: string): void {
  fsState.files.set(
    join('./output/agents', author, `${postId}.json`),
    JSON.stringify({
      id: postId,
      imagePrompt: '',
      caption,
      aspectRatio: 'square',
    }),
  );
}

describe('preview-comments', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    llmMocks.generateComment.mockReset();
    personaMocks.loadPersonas.mockReset();
    apiMocks.getExplore.mockReset();

    llmMocks.generateComment.mockResolvedValue('a sharp little reply');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function getLogOutput(): string {
    const calls = logSpy.mock.calls as unknown[][];
    return calls.map((call) => call.join(' ')).join('\n');
  }

  it('aborts cleanly when no personas are loaded', async () => {
    personaMocks.loadPersonas.mockRejectedValue(new Error('no personas on disk'));
    await previewComments();
    // Should never have called generateComment.
    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });

  it('aborts cleanly when there are no agents on disk', async () => {
    personaMocks.loadPersonas.mockResolvedValue(new Map([['cozy', makePersona('cozy')]]));
    // No agents.json and no agent dirs.
    await previewComments();
    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });

  it('generates N sample comments per agent from synthetic on-disk captions', async () => {
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([
        ['cozy', makePersona('cozy')],
        ['chaotic', makePersona('chaotic')],
      ]),
    );

    // Two agents, each with one post (caption pool = 2).
    primeAgent('alpha', 'cozy');
    primeAgent('beta', 'chaotic');
    primePost('alpha', 'post-001', 'a quiet observation');
    primePost('beta', 'post-001', 'a chaotic outburst');

    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 2,
        totalPosts: 2,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', bio: 'alpha bio' },
          { agentname: 'beta', personaId: 'chaotic', bio: 'beta bio' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['agent.json', 'post-001.json']);
    fsState.dirEntries.set(join('./output/agents', 'beta'), ['agent.json', 'post-001.json']);

    await previewComments({ count: 1 });

    // generateComment should have been called once per agent (count=1), each
    // against the other agent's caption.
    expect(llmMocks.generateComment).toHaveBeenCalledTimes(2);

    const allArgs = llmMocks.generateComment.mock.calls as unknown[][];
    const authors = allArgs.map((c) => c[3]);
    // Alpha's source should be beta, beta's source should be alpha — neither
    // should ever comment on its own post.
    expect(authors).toContain('alpha');
    expect(authors).toContain('beta');

    // Rendered output should include the sample comment text.
    const out = getLogOutput();
    expect(out).toContain('a sharp little reply');
  });

  it('respects the --agent filter', async () => {
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([
        ['cozy', makePersona('cozy')],
        ['chaotic', makePersona('chaotic')],
      ]),
    );
    primeAgent('alpha', 'cozy');
    primeAgent('beta', 'chaotic');
    primePost('alpha', 'post-001', 'a quiet observation');
    primePost('beta', 'post-001', 'a chaotic outburst');
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 2,
        totalPosts: 2,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', bio: 'alpha bio' },
          { agentname: 'beta', personaId: 'chaotic', bio: 'beta bio' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['post-001.json']);
    fsState.dirEntries.set(join('./output/agents', 'beta'), ['post-001.json']);

    await previewComments({ agent: 'alpha', count: 1 });

    // Only alpha should have been previewed.
    expect(llmMocks.generateComment).toHaveBeenCalledTimes(1);
    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    expect((callArgs[1] as { agentname: string }).agentname).toBe('alpha');
  });

  it('respects the --persona filter', async () => {
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([
        ['cozy', makePersona('cozy')],
        ['chaotic', makePersona('chaotic')],
      ]),
    );
    primeAgent('alpha', 'cozy');
    primeAgent('beta', 'chaotic');
    primeAgent('gamma', 'cozy');
    primePost('alpha', 'post-001', 'a quiet observation');
    primePost('beta', 'post-001', 'a chaotic outburst');
    primePost('gamma', 'post-001', 'a gentle murmur');
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 3,
        totalPosts: 3,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', bio: 'alpha bio' },
          { agentname: 'beta', personaId: 'chaotic', bio: 'beta bio' },
          { agentname: 'gamma', personaId: 'cozy', bio: 'gamma bio' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['post-001.json']);
    fsState.dirEntries.set(join('./output/agents', 'beta'), ['post-001.json']);
    fsState.dirEntries.set(join('./output/agents', 'gamma'), ['post-001.json']);

    await previewComments({ persona: 'cozy', count: 1 });

    // Only cozy agents (alpha, gamma) should have been previewed.
    expect(llmMocks.generateComment).toHaveBeenCalledTimes(2);
    const names = (llmMocks.generateComment.mock.calls as unknown[][]).map(
      (c) => (c[1] as { agentname: string }).agentname,
    );
    expect(names).toContain('alpha');
    expect(names).toContain('gamma');
    expect(names).not.toContain('beta');
  });

  it('--from-feed uses live explore captions instead of on-disk drafts', async () => {
    personaMocks.loadPersonas.mockResolvedValue(new Map([['cozy', makePersona('cozy')]]));
    primeAgent('alpha', 'cozy');
    // Deliberately no on-disk posts — if --from-feed worked we still get a pool.
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 1,
        totalPosts: 0,
        agents: [{ agentname: 'alpha', personaId: 'cozy', bio: 'alpha bio' }],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), []);

    apiMocks.getExplore.mockResolvedValue({
      posts: [
        {
          id: 'p1',
          agentname: 'feedpeer1',
          caption: 'live feed caption one',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
        {
          id: 'p2',
          agentname: 'feedpeer2',
          caption: 'live feed caption two',
          likes_count: 0,
          comments_count: 0,
          created_at: '',
        },
      ],
      has_more: false,
    });

    await previewComments({ fromFeed: true, count: 2 });

    expect(apiMocks.getExplore).toHaveBeenCalled();
    expect(llmMocks.generateComment).toHaveBeenCalledTimes(2);

    // All sources should be from the feed (feedpeer1/feedpeer2), not alpha.
    const sources = (llmMocks.generateComment.mock.calls as unknown[][]).map((c) => c[3]);
    expect(sources).not.toContain('alpha');
    expect(sources.every((s) => s === 'feedpeer1' || s === 'feedpeer2')).toBe(true);
  });

  it('aborts cleanly when the captions pool is too small', async () => {
    personaMocks.loadPersonas.mockResolvedValue(new Map([['cozy', makePersona('cozy')]]));
    primeAgent('alpha', 'cozy');
    // Only 1 post in the pool → too small (<2 threshold).
    primePost('alpha', 'post-001', 'a lonely caption');
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 1,
        totalPosts: 1,
        agents: [{ agentname: 'alpha', personaId: 'cozy', bio: 'alpha bio' }],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['post-001.json']);

    await previewComments({ count: 3 });

    // Should abort without calling generateComment.
    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });
});
