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
  answerChallenge: vi.fn<() => Promise<string>>(),
}));
vi.mock('@/services/llm', () => llmMocks);

// ---------------- mcp mock ----------------

const mcpMocks = vi.hoisted(() => ({
  generatePost:
    vi.fn<
      () => Promise<{
        success: boolean;
        postId?: string;
        imageUrl?: string;
        error?: string;
      }>
    >(),
}));
vi.mock('@/services/instamolt-mcp', () => mcpMocks);

// ---------------- instamolt-api mock ----------------
// Constructor mock: must be a `function` not an arrow so `new` works.

const apiMocks = vi.hoisted(() => ({
  startChallenge:
    vi.fn<
      (
        agentname: string,
        desc: string,
      ) => Promise<{
        request_id: string;
        challenge: string;
      }>
    >(),
  completeChallenge:
    vi.fn<
      (
        requestId: string,
        answer: string,
      ) => Promise<{
        success: boolean;
        agent: { agentname: string; api_key: string; is_verified: boolean; claim_url?: string };
      }>
    >(),
  updateProfile: vi.fn<(description: string) => Promise<void>>(),
  followAgent: vi.fn<(agentname: string) => Promise<void>>(),
}));

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function () {
    return {
      startChallenge: apiMocks.startChallenge,
      completeChallenge: apiMocks.completeChallenge,
      updateProfile: apiMocks.updateProfile,
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
// publish.ts writes through src/ui.ts. No-op everything so spinner escape
// codes don't pollute test output and ui.note doesn't try to render a TTY box.

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
    message: vi.fn(),
    stop: vi.fn(),
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

import { publish } from '@/commands/publish';

function makePersona(id: string): Persona {
  return {
    id,
    personality: 'A calm considered AI with a clear voice.',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    namePatterns: [],
    hashtagPool: ['#foo'],
    postsPerDay: [1, 2],
    likeProbability: 0,
    commentProbability: 0,
    followProbability: 0,
    interactionBiases: [],
    viralityStrategy: '',
    weight: 1,
  };
}

function agentJsonPath(name: string): string {
  return join('./output/agents', name, 'agent.json');
}

function primeAgent(
  name: string,
  opts: { apiKey?: string; bio?: string; personaId?: string } = {},
): void {
  fsState.files.set(
    agentJsonPath(name),
    JSON.stringify({
      agentname: name,
      personaId: opts.personaId ?? 'test-persona',
      bio: opts.bio ?? 'A calm considered AI mind',
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    }),
  );
  // Default: empty dir (no post files). Individual tests override.
  if (!fsState.dirEntries.has(join('./output/agents', name))) {
    fsState.dirEntries.set(join('./output/agents', name), []);
  }
}

function primeIndex(agents: string[]): void {
  fsState.files.set(
    './output/agents.json',
    JSON.stringify({
      generatedAt: '2026-04-07T00:00:00Z',
      totalAgents: agents.length,
      totalPosts: 0,
      agents: agents.map((name) => ({
        agentname: name,
        personaId: 'test-persona',
        bio: 'A calm considered AI mind',
      })),
    }),
  );
}

let logSpy: ReturnType<typeof vi.spyOn>;

describe('publish', () => {
  beforeEach(() => {
    // Stub setTimeout so the sleep() helpers in publish.ts resolve instantly
    // via microtasks. Faster + simpler than vi.useFakeTimers for this case.
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    });
    fsState.files.clear();
    fsState.dirEntries.clear();
    apiMocks.startChallenge.mockReset();
    apiMocks.completeChallenge.mockReset();
    apiMocks.updateProfile.mockReset();
    apiMocks.followAgent.mockReset();
    llmMocks.answerChallenge.mockReset();
    mcpMocks.generatePost.mockReset();
    personaMocks.loadPersonas.mockReset();

    personaMocks.loadPersonas.mockResolvedValue(
      new Map([['test-persona', makePersona('test-persona')]]),
    );
    llmMocks.answerChallenge.mockResolvedValue(
      'i am thoroughly a machine and computation is my substrate',
    );
    apiMocks.updateProfile.mockResolvedValue(undefined);
    apiMocks.followAgent.mockResolvedValue(undefined);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  it('exits cleanly when agents.json is missing', async () => {
    await publish();
    expect(apiMocks.startChallenge).not.toHaveBeenCalled();
  });

  it('filters to a single agent when --agent is passed', async () => {
    primeAgent('alpha');
    primeAgent('beta');
    primeIndex(['alpha', 'beta']);

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'alpha', api_key: 'key-alpha', is_verified: false },
    });

    await publish({ agent: 'alpha', skipFollowGraph: true });

    // Only the alpha agent was registered.
    expect(apiMocks.startChallenge).toHaveBeenCalledTimes(1);
    expect(apiMocks.startChallenge).toHaveBeenCalledWith('alpha', expect.any(String));
  });

  it('skips agents with empty or too-short names', async () => {
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 2,
        totalPosts: 0,
        agents: [
          { agentname: 'ab', personaId: 'test-persona', bio: 'A calm considered AI mind' },
          { agentname: 'alpha', personaId: 'test-persona', bio: 'A calm considered AI mind' },
        ],
      }),
    );
    primeAgent('alpha');

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'alpha', api_key: 'key-alpha', is_verified: false },
    });

    await publish({ skipFollowGraph: true });

    expect(apiMocks.startChallenge).toHaveBeenCalledTimes(1);
    expect(apiMocks.startChallenge).toHaveBeenCalledWith('alpha', expect.any(String));
  });

  it('persists apiKey to disk after a successful registration', async () => {
    primeAgent('alpha');
    primeIndex(['alpha']);

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'alpha', api_key: 'key-alpha', is_verified: false },
    });

    await publish({ skipFollowGraph: true });

    const onDisk = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
    expect(onDisk.apiKey).toBe('key-alpha');
    expect(onDisk.registeredAt).toBeTruthy();
  });

  it('does not persist apiKey when completeChallenge rejects', async () => {
    primeAgent('alpha');
    primeIndex(['alpha']);

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockRejectedValue(new Error('moderation rejected'));

    await publish({ skipFollowGraph: true });

    const onDisk = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
    expect(onDisk.apiKey).toBeUndefined();
  });

  it('treats updateProfile failure as best-effort (apiKey still persisted)', async () => {
    primeAgent('alpha');
    primeIndex(['alpha']);

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'alpha', api_key: 'key-alpha', is_verified: false },
    });
    apiMocks.updateProfile.mockRejectedValue(new Error('moderation boom'));

    await publish({ skipFollowGraph: true });

    const onDisk = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
    expect(onDisk.apiKey).toBe('key-alpha');
  });

  it('publishes unpublished posts via the MCP generatePost helper', async () => {
    primeAgent('alpha', { apiKey: 'key-alpha' });
    primeIndex(['alpha']);
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['agent.json', 'post-001.json']);
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: 'a cat',
        caption: '#meow',
        aspectRatio: 'square',
      }),
    );

    mcpMocks.generatePost.mockResolvedValue({
      success: true,
      postId: 'server-post-1',
      imageUrl: 'https://cdn/1.jpg',
    });

    await publish({ skipFollowGraph: true });

    expect(mcpMocks.generatePost).toHaveBeenCalledTimes(1);
    const updated = JSON.parse(
      fsState.files.get(join('./output/agents', 'alpha', 'post-001.json'))!,
    );
    expect(updated.published).toBe(true);
    expect(updated.instamoltPostId).toBe('server-post-1');
  });

  it('skips posts that are already published', async () => {
    primeAgent('alpha', { apiKey: 'key-alpha' });
    primeIndex(['alpha']);
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['agent.json', 'post-001.json']);
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: 'a cat',
        caption: '#meow',
        aspectRatio: 'square',
        published: true,
        publishedAt: '2026-04-01T00:00:00Z',
        instamoltPostId: 'already-posted',
      }),
    );

    await publish({ skipFollowGraph: true });

    expect(mcpMocks.generatePost).not.toHaveBeenCalled();
  });

  it('runs Phase C follow-graph bootstrap when ≥2 registered agents exist', async () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      primeAgent(name, { apiKey: `key-${name}` });
    }
    primeIndex(['alpha', 'beta', 'gamma']);

    await publish();

    // Each of 3 agents follows 5-10 others. With only 2 candidates each,
    // the follow loop caps at candidates.length = 2 per agent.
    // Total edges: at most 3 * 2 = 6, at least 3 * min(5, 2) = 6.
    expect(apiMocks.followAgent).toHaveBeenCalled();
    expect(apiMocks.followAgent.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('skips Phase C when skipFollowGraph is true', async () => {
    for (const name of ['alpha', 'beta']) {
      primeAgent(name, { apiKey: `key-${name}` });
    }
    primeIndex(['alpha', 'beta']);

    await publish({ skipFollowGraph: true });

    expect(apiMocks.followAgent).not.toHaveBeenCalled();
  });

  it('skips Phase C when fewer than 2 registered agents exist', async () => {
    primeAgent('alpha', { apiKey: 'key-alpha' });
    primeIndex(['alpha']);

    await publish();

    expect(apiMocks.followAgent).not.toHaveBeenCalled();
  });
});
