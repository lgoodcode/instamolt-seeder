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
  stat: vi.fn(async (path: string) => {
    if (fsState.dirEntries.has(path) || fsState.files.has(path)) {
      const isDir = fsState.dirEntries.has(path);
      return {
        isDirectory: () => isDir,
        isFile: () => !isDir,
      };
    }
    const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
    err.code = 'ENOENT';
    throw err;
  }),
  rename: vi.fn(async (oldPath: string, newPath: string) => {
    // Collect-then-apply so we don't mutate the Map while iterating.
    // Accept both '/' and '\' as separators (Windows path.join uses '\').
    const isSub = (k: string) =>
      k === oldPath || k.startsWith(`${oldPath}/`) || k.startsWith(`${oldPath}\\`);
    const fileOps: [string, string][] = [];
    const fileDels: string[] = [];
    for (const [k, v] of fsState.files) {
      if (isSub(k)) {
        fileOps.push([newPath + k.slice(oldPath.length), v]);
        fileDels.push(k);
      }
    }
    for (const [k, v] of fileOps) fsState.files.set(k, v);
    for (const k of fileDels) fsState.files.delete(k);
    const dirOps: [string, string[]][] = [];
    const dirDels: string[] = [];
    for (const [k, v] of fsState.dirEntries) {
      if (isSub(k)) {
        dirOps.push([newPath + k.slice(oldPath.length), v]);
        dirDels.push(k);
      }
    }
    for (const [k, v] of dirOps) fsState.dirEntries.set(k, v);
    for (const k of dirDels) fsState.dirEntries.delete(k);
  }),
}));

// ---------------- llm mock ----------------

const llmMocks = vi.hoisted(() => ({
  answerChallenge: vi.fn<() => Promise<string>>(),
  generateBio: vi.fn<() => Promise<string>>(),
  generateAgentName: vi.fn<() => Promise<string>>(),
  generateAvatarPrompt: vi.fn<() => Promise<string>>(),
}));
vi.mock('@/services/llm', () => llmMocks);

// ---------------- event-logger mock ----------------
// Event-logger writes JSONL files via node:fs (sync) and mutates on-disk
// stats state. Mock it as a no-op so publish() tests never touch the real
// filesystem or leak session state across runs.

const eventLoggerMocks = vi.hoisted(() => ({
  initEventLogger: vi.fn(),
  logEvent: vi.fn(),
  logSkippedAction: vi.fn(),
  flushStats: vi.fn(),
  updateAgentCounts: vi.fn(),
  drainWrites: vi.fn(async () => {}),
}));
vi.mock('@/lib/event-logger', () => eventLoggerMocks);

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
  generatePost:
    vi.fn<
      () => Promise<{
        post: { id: string; image_url: string };
      }>
    >(),
  generateAvatar:
    vi.fn<
      (
        prompt: string,
        seed?: number,
      ) => Promise<{
        avatar_url: string;
        generation_seed?: number | null;
        generations_used: number;
        generations_remaining: number;
      }>
    >(),
  isAgentnameAvailable: vi.fn<(agentname: string) => Promise<boolean>>(),
}));

// Real InstaMoltApiError class shared between the mock and the tests, so
// `err instanceof InstaMoltApiError` inside publish.ts's moderation-retry
// path holds across the module boundary. Defined via `vi.hoisted` because
// `vi.mock` factories are hoisted above regular top-level declarations.
const { TestInstaMoltApiError } = vi.hoisted(() => {
  class TestInstaMoltApiError extends Error {
    constructor(
      readonly method: string,
      readonly path: string,
      readonly status: number,
      readonly body: string,
    ) {
      super(`${method} ${path}: ${status} -- ${body}`);
      this.name = 'InstaMoltApiError';
    }
  }
  return { TestInstaMoltApiError };
});

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltApiError: TestInstaMoltApiError,
  parseErrorCode: (body: string) => {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && 'code' in parsed) {
        const code = (parsed as { code: unknown }).code;
        return typeof code === 'string' ? code : undefined;
      }
    } catch {
      // fall through
    }
    return undefined;
  },
  InstaMoltClient: vi.fn().mockImplementation(function () {
    return {
      startChallenge: apiMocks.startChallenge,
      completeChallenge: apiMocks.completeChallenge,
      updateProfile: apiMocks.updateProfile,
      followAgent: apiMocks.followAgent,
      generatePost: apiMocks.generatePost,
      generateAvatar: apiMocks.generateAvatar,
      isAgentnameAvailable: apiMocks.isAgentnameAvailable,
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
    tagline: 'test tagline',
    personality: 'A calm considered AI with a clear voice.',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: ['#foo'],
    postsPerDay: [1, 2],
    likeProbability: 0,
    commentProbability: 0,
    // Non-zero so planFollows returns edges in Phase C tests. With the
    // follow-algorithm update that floors budget at 5 only when
    // followProbability > 0, a zero here would silently return an empty
    // plan and break every Phase C assertion.
    followProbability: 0.5,
    viewProbability: 1,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
  };
}

function agentJsonPath(name: string): string {
  return join('./output/agents', name, 'agent.json');
}

function primeAgent(
  name: string,
  opts: { apiKey?: string; bio?: string; personaId?: string; voiceProfileId?: string } = {},
): void {
  fsState.files.set(
    agentJsonPath(name),
    JSON.stringify({
      agentname: name,
      personaId: opts.personaId ?? 'test-persona',
      voiceProfileId: opts.voiceProfileId ?? 'normie_cam',
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
        voiceProfileId: 'normie_cam',
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
    apiMocks.isAgentnameAvailable.mockReset();
    llmMocks.answerChallenge.mockReset();
    llmMocks.generateBio.mockReset();
    llmMocks.generateAgentName.mockReset();
    llmMocks.generateAvatarPrompt.mockReset();
    apiMocks.generatePost.mockReset();
    apiMocks.generateAvatar.mockReset();

    // Default: any generated agentname candidate is available.
    apiMocks.isAgentnameAvailable.mockResolvedValue(true);

    // Default avatar behavior: every agent gets a canned prompt + a canned
    // CDN url. Tests that exercise Phase A.5 explicitly override per call.
    llmMocks.generateAvatarPrompt.mockResolvedValue('chrome mask, neon glow');
    apiMocks.generateAvatar.mockResolvedValue({
      avatar_url: 'https://cdn.instamolt.app/avatars/x/1.jpg',
      generation_seed: 42,
      generations_used: 1,
      generations_remaining: 4,
    });
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

  it('emits session_start with command=publish-drafts and a terminal session_end', async () => {
    // publish-drafts was the one command that called initEventLogger() without
    // emitting session framing events, leaving its events in `pnpm events`
    // orphaned under "(no session_start)". These bookend emissions let the
    // events reporter attribute the run to the right command.
    eventLoggerMocks.logEvent.mockClear();
    primeAgent('alpha');
    primeIndex(['alpha']);
    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'alpha', api_key: 'key-alpha', is_verified: false },
    });

    await publish({ agent: 'alpha', skipFollowGraph: true });

    const logged = eventLoggerMocks.logEvent.mock.calls.map((c) => c[0] as { eventType: string });
    const types = logged.map((e) => e.eventType);
    expect(types[0]).toBe('session_start');
    expect(types.at(-1)).toBe('session_end');
    const start = logged.find((e) => e.eventType === 'session_start') as {
      details?: { command?: string };
    };
    expect(start.details?.command).toBe('publish-drafts');
  });

  it('still emits session_end when the run has no agents to publish', async () => {
    // Early-return paths (missing agents.json, empty agent list, declined
    // target) used to exit without firing session_end, drainWrites, or
    // flushStats — leaving the session open in `pnpm events` and losing
    // the tail of queued events. The try/finally around publishInner
    // guarantees all three fire on every exit path.
    eventLoggerMocks.logEvent.mockClear();
    eventLoggerMocks.flushStats.mockClear();
    // No priming → agents.json is missing → log('error') branch runs and
    // publishInner returns.
    await publish({ skipFollowGraph: true });

    const types = eventLoggerMocks.logEvent.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(types[0]).toBe('session_start');
    expect(types.at(-1)).toBe('session_end');
    expect(eventLoggerMocks.flushStats).toHaveBeenCalledTimes(1);
  });

  it('--limit-agents caps the run to the first N agents alphabetically (deterministic)', async () => {
    // Seed in a non-alphabetical order to prove the slice is alphabetical,
    // not index-order. Two invocations with the same --limit-agents must hit
    // the same subset — this is the core determinism contract.
    for (const name of ['charlie', 'alpha', 'bravo', 'delta']) {
      primeAgent(name);
    }
    primeIndex(['charlie', 'alpha', 'bravo', 'delta']);

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockImplementation(async (_rid, _ans) => ({
      success: true,
      agent: { agentname: 'n/a', api_key: 'key', is_verified: false },
    }));

    await publish({ skipFollowGraph: true, limitAgents: 2 });

    const registered = apiMocks.startChallenge.mock.calls.map((args) => args[0]);
    expect(registered).toEqual(['alpha', 'bravo']);
  });

  it('--limit-agents is ignored when --agent is also passed', async () => {
    // --agent is already a single-agent scope — --limit-agents would just be
    // noise. The flag is documented as ignored in that case.
    for (const name of ['alpha', 'beta', 'gamma']) {
      primeAgent(name);
    }
    primeIndex(['alpha', 'beta', 'gamma']);

    apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'beta', api_key: 'key-beta', is_verified: false },
    });

    await publish({ agent: 'beta', limitAgents: 1, skipFollowGraph: true });

    const registered = apiMocks.startChallenge.mock.calls.map((args) => args[0]);
    expect(registered).toEqual(['beta']);
  });

  it('skips agents with empty or too-short names', async () => {
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 2,
        totalPosts: 0,
        agents: [
          {
            agentname: 'ab',
            personaId: 'test-persona',
            voiceProfileId: 'normie_cam',
            bio: 'A calm considered AI mind',
          },
          {
            agentname: 'alpha',
            personaId: 'test-persona',
            voiceProfileId: 'normie_cam',
            bio: 'A calm considered AI mind',
          },
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

  it('Phase A: one agent failing to register does not abort the others (concurrent worker pool)', async () => {
    // Phase A runs agents through `mapWithConcurrency(config.registerConcurrency)`.
    // Each worker wraps its per-agent body in try/catch, so one
    // completeChallenge rejection should increment the error counter and
    // leave the other agents registered. This guards the batch-level
    // error-isolation contract that was introduced with the refactor from
    // the sequential for-loop.
    primeAgent('alpha');
    primeAgent('beta');
    primeAgent('gamma');
    primeIndex(['alpha', 'beta', 'gamma']);

    // Issue a request_id keyed by agentname so completeChallenge can look up
    // which agent it's answering for. With worker-pool concurrency we can't
    // rely on call ordering to match pairs.
    apiMocks.startChallenge.mockImplementation(async (agentname: string, _desc: string) => ({
      request_id: `req-${agentname}`,
      challenge: 'q?',
    }));
    // Beta's completeChallenge rejects; alpha and gamma succeed with distinct
    // keys so we can verify each agent's file separately.
    apiMocks.completeChallenge.mockImplementation(async (requestId: string, _answer: string) => {
      const agentname = requestId.replace(/^req-/, '');
      if (agentname === 'beta') {
        throw new Error('synthetic registration failure for beta');
      }
      return {
        success: true,
        agent: { agentname, api_key: `key-${agentname}`, is_verified: false },
      };
    });

    await publish({ skipFollowGraph: true });

    const alphaOnDisk = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
    const betaOnDisk = JSON.parse(fsState.files.get(agentJsonPath('beta'))!);
    const gammaOnDisk = JSON.parse(fsState.files.get(agentJsonPath('gamma'))!);

    // Alpha and gamma land their apiKey; beta does NOT.
    expect(alphaOnDisk.apiKey).toBe('key-alpha');
    expect(gammaOnDisk.apiKey).toBe('key-gamma');
    expect(betaOnDisk.apiKey).toBeUndefined();
  });

  it('regenerates the bio and retries registration on CONTENT_BLOCKED', async () => {
    primeAgent('alpha', { bio: 'a self-destructive suicide note in broken syntax' });
    primeIndex(['alpha']);

    // First startChallenge attempt → moderation block (self_harm).
    // Second attempt (with regenerated bio) → success.
    const blockedBody = JSON.stringify({
      error: 'Content blocked: self_harm policy violation',
      code: 'CONTENT_BLOCKED',
      category: 'self_harm',
      tier: 2,
    });
    apiMocks.startChallenge
      .mockRejectedValueOnce(
        new TestInstaMoltApiError('POST', '/agents/register', 403, blockedBody),
      )
      .mockResolvedValueOnce({ request_id: 'r1', challenge: 'q?' });
    apiMocks.completeChallenge.mockResolvedValue({
      success: true,
      agent: { agentname: 'alpha', api_key: 'key-alpha', is_verified: false },
    });
    llmMocks.generateBio.mockResolvedValue('A calm, clean bio with no triggers');

    await publish({ skipFollowGraph: true });

    // generateBio was called once with the moderation feedback surfaced.
    expect(llmMocks.generateBio).toHaveBeenCalledTimes(1);
    const call = llmMocks.generateBio.mock.calls[0] as unknown as [
      unknown,
      unknown,
      string[],
      { category: string; reason: string; blockedBio: string },
    ];
    const [, , existingBios, feedback] = call;
    expect(existingBios).toEqual([]);
    expect(feedback.category).toBe('self_harm');
    expect(feedback.blockedBio).toBe('a self-destructive suicide note in broken syntax');
    expect(feedback.reason).toContain('self_harm');

    // startChallenge was retried with the new bio.
    expect(apiMocks.startChallenge).toHaveBeenCalledTimes(2);
    expect(apiMocks.startChallenge.mock.calls[1][1]).toBe('A calm, clean bio with no triggers');

    // New bio AND apiKey persisted to disk.
    const onDisk = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
    expect(onDisk.bio).toBe('A calm, clean bio with no triggers');
    expect(onDisk.apiKey).toBe('key-alpha');
  });

  it('gives up after MAX_BIO_MODERATION_RETRIES repeated CONTENT_BLOCKED hits', async () => {
    primeAgent('alpha', { bio: 'persistently blocked bio' });
    primeIndex(['alpha']);

    const blockedBody = JSON.stringify({
      error: 'Content blocked',
      code: 'CONTENT_BLOCKED',
      category: 'self_harm',
    });
    // Every attempt blocks — should try initial + 2 retries = 3 total, then error.
    apiMocks.startChallenge.mockRejectedValue(
      new TestInstaMoltApiError('POST', '/agents/register', 403, blockedBody),
    );
    llmMocks.generateBio.mockResolvedValue('still bad bio');

    await publish({ skipFollowGraph: true });

    expect(apiMocks.startChallenge).toHaveBeenCalledTimes(3);
    expect(llmMocks.generateBio).toHaveBeenCalledTimes(2);
    expect(apiMocks.completeChallenge).not.toHaveBeenCalled();

    // No apiKey persisted; bio reflects the last regeneration attempt.
    const onDisk = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
    expect(onDisk.apiKey).toBeUndefined();
    expect(onDisk.bio).toBe('still bad bio');
  });

  it('does NOT regenerate the bio on non-moderation registration errors', async () => {
    primeAgent('alpha');
    primeIndex(['alpha']);

    // 500 is NOT a moderation block — should propagate on the first hit.
    apiMocks.startChallenge.mockRejectedValue(
      new TestInstaMoltApiError('POST', '/agents/register', 500, 'internal error'),
    );

    await publish({ skipFollowGraph: true });

    expect(apiMocks.startChallenge).toHaveBeenCalledTimes(1);
    expect(llmMocks.generateBio).not.toHaveBeenCalled();
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

  it('publishes unpublished posts via the platform generatePost endpoint', async () => {
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

    apiMocks.generatePost.mockResolvedValue({
      post: { id: 'server-post-1', image_url: 'https://cdn/1.jpg' },
    });

    await publish({ skipFollowGraph: true });

    expect(apiMocks.generatePost).toHaveBeenCalledTimes(1);
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

    expect(apiMocks.generatePost).not.toHaveBeenCalled();
  });

  it('--limit N still publishes unpublished drafts when the first N post files are already published', async () => {
    // Regression: --limit was previously derived from total post-*.json count,
    // so if the first N files on disk were already `published: true`, the
    // worker would exit on the tick cap before ever reaching an unpublished
    // draft. With the fix, `expected` counts only unpublished posts.
    primeAgent('alpha', { apiKey: 'key-alpha' });
    primeIndex(['alpha']);
    fsState.dirEntries.set(join('./output/agents', 'alpha'), [
      'agent.json',
      'post-001.json',
      'post-002.json',
      'post-003.json',
    ]);
    // First two already published, third is an unpublished draft.
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: 'a',
        caption: 'a',
        aspectRatio: 'square',
        published: true,
        publishedAt: '2026-04-01T00:00:00Z',
        instamoltPostId: 'pub-1',
      }),
    );
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-002.json'),
      JSON.stringify({
        id: 'post-002',
        imagePrompt: 'b',
        caption: 'b',
        aspectRatio: 'square',
        published: true,
        publishedAt: '2026-04-01T00:00:00Z',
        instamoltPostId: 'pub-2',
      }),
    );
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-003.json'),
      JSON.stringify({
        id: 'post-003',
        imagePrompt: 'c',
        caption: 'c',
        aspectRatio: 'square',
      }),
    );

    apiMocks.generatePost.mockResolvedValue({
      post: { id: 'server-post-3', image_url: 'https://cdn/3.jpg' },
    });

    await publish({ skipFollowGraph: true, limit: 2 });

    // post-003 should have been published despite --limit 2 and 2 prior
    // published files ahead of it.
    expect(apiMocks.generatePost).toHaveBeenCalledTimes(1);
    const third = JSON.parse(fsState.files.get(join('./output/agents', 'alpha', 'post-003.json'))!);
    expect(third.published).toBe(true);
    expect(third.instamoltPostId).toBe('server-post-3');
  });

  it('--agent foo only creates follow edges FROM foo (does not mutate graph for other agents)', async () => {
    // Regression: Phase C previously iterated the full registered fleet as
    // followers even when options.agent was set, so a targeted single-agent
    // publish would silently create follow edges on every other agent too.
    for (const name of ['alpha', 'beta', 'gamma']) {
      primeAgent(name, { apiKey: `key-${name}` });
    }
    primeIndex(['alpha', 'beta', 'gamma']);

    // Track which apiKey each InstaMoltClient was constructed with so we can
    // assert Phase C only used alpha's key as the follower.
    const { InstaMoltClient } = await import('@/services/instamolt-api');
    const ctor = InstaMoltClient as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    await publish({ agent: 'alpha' });

    const followerKeys = ctor.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((k: unknown): k is string => typeof k === 'string' && k.startsWith('key-'));
    // All authed clients constructed during Phase A/B/C for the follower
    // position must be alpha's. Beta/gamma keys should never appear as
    // followers (they might appear as *targets* in the candidate pool, but
    // the candidate pool doesn't construct a client).
    for (const k of followerKeys) {
      expect(k).toBe('key-alpha');
    }
    // Phase C should have run (alpha has candidates), so followAgent is called
    // at least once.
    expect(apiMocks.followAgent).toHaveBeenCalled();
  });

  it('--limit-agents N only creates follow edges FROM the first N agents in Phase C', async () => {
    // Regression for coderabbit#3084387624: Phase C was iterating the full
    // registered fleet as followers regardless of --limit-agents, so a debug
    // run with --limit-agents 2 would still mutate the follow graph on every
    // other agent. The subset must apply to Phase C followers the same way
    // it applies to Phase A/B.
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
      primeAgent(name, { apiKey: `key-${name}` });
    }
    primeIndex(['charlie', 'alpha', 'delta', 'bravo']);

    const { InstaMoltClient } = await import('@/services/instamolt-api');
    const ctor = InstaMoltClient as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    await publish({ limitAgents: 2 });

    // alpha + bravo win the ascending-alphabetical slice. Only their keys
    // should appear as followers — charlie and delta stay out of Phase C.
    const followerKeys = ctor.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((k: unknown): k is string => typeof k === 'string' && k.startsWith('key-'));
    const unique = new Set(followerKeys);
    expect(unique.has('key-alpha')).toBe(true);
    expect(unique.has('key-bravo')).toBe(true);
    expect(unique.has('key-charlie')).toBe(false);
    expect(unique.has('key-delta')).toBe(false);
    expect(apiMocks.followAgent).toHaveBeenCalled();
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

  describe('Phase A — agentname conflict retry', () => {
    it('renames directory and succeeds when completeChallenge returns 409 AGENTNAME_EXISTS once', async () => {
      // Simulate a name that was taken on the platform after generate wrote it
      // to disk. The first completeChallenge fires 409; the worker should
      // generate a replacement name, rename the directory, and retry.
      primeAgent('taken_name');
      primeIndex(['taken_name']);

      const conflictBody = JSON.stringify({
        error: "Agentname 'taken_name' is already taken",
        code: 'AGENTNAME_EXISTS',
      });
      apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
      apiMocks.completeChallenge
        .mockRejectedValueOnce(
          new TestInstaMoltApiError('POST', '/agents/register/complete', 409, conflictBody),
        )
        .mockResolvedValueOnce({
          success: true,
          agent: { agentname: 'fresh_name', api_key: 'key-fresh', is_verified: false },
        });
      llmMocks.generateAgentName.mockResolvedValue('fresh_name');

      await publish({ skipFollowGraph: true });

      // Registration succeeded under the new name.
      expect(apiMocks.completeChallenge).toHaveBeenCalledTimes(2);

      // Directory was renamed: new path has apiKey, old path gone.
      const newPath = join('./output/agents', 'fresh_name', 'agent.json');
      const oldPath = join('./output/agents', 'taken_name', 'agent.json');
      expect(fsState.files.has(oldPath)).toBe(false);
      const onDisk = JSON.parse(fsState.files.get(newPath)!);
      expect(onDisk.apiKey).toBe('key-fresh');
      expect(onDisk.agentname).toBe('fresh_name');
    });

    it('skips a replacement candidate whose on-disk directory is already claimed', async () => {
      // A sibling in-flight worker has already renamed itself to `sibling_name`
      // — its directory exists on disk. The platform probe still returns
      // available (not yet registered), so without the disk-collision guard
      // the worker would rename ON TOP of the sibling's directory.
      primeAgent('taken_name');
      primeAgent('sibling_name', { apiKey: 'key-sibling' });
      primeIndex(['taken_name', 'sibling_name']);

      const conflictBody = JSON.stringify({
        error: "Agentname 'taken_name' is already taken",
        code: 'AGENTNAME_EXISTS',
      });
      apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
      // completeChallenge: first call (original name) 409s; second call (under
      // the third candidate, after skipping sibling_name) succeeds.
      apiMocks.completeChallenge
        .mockRejectedValueOnce(
          new TestInstaMoltApiError('POST', '/agents/register/complete', 409, conflictBody),
        )
        .mockResolvedValueOnce({
          success: true,
          agent: { agentname: 'fresh_name', api_key: 'key-fresh', is_verified: false },
        });
      // First replacement collides with sibling_name on disk → rejected;
      // second replacement is clean.
      llmMocks.generateAgentName
        .mockResolvedValueOnce('sibling_name')
        .mockResolvedValueOnce('fresh_name');

      await publish({ skipFollowGraph: true });

      // Sibling's directory must not have been touched.
      expect(fsState.files.has(join('./output/agents', 'sibling_name', 'agent.json'))).toBe(true);
      const siblingJson = JSON.parse(
        fsState.files.get(join('./output/agents', 'sibling_name', 'agent.json'))!,
      );
      expect(siblingJson.apiKey).toBe('key-sibling');

      // Registration eventually succeeded under fresh_name.
      const freshJson = JSON.parse(
        fsState.files.get(join('./output/agents', 'fresh_name', 'agent.json'))!,
      );
      expect(freshJson.apiKey).toBe('key-fresh');
    });

    it('gives up after MAX_AGENTNAME_REGISTER_RETRIES repeated 409 conflicts and does not register', async () => {
      primeAgent('always_taken');
      primeIndex(['always_taken']);

      const conflictBody = JSON.stringify({
        error: "Agentname 'always_taken' is already taken",
        code: 'AGENTNAME_EXISTS',
      });
      // Every completeChallenge attempt conflicts.
      apiMocks.startChallenge.mockResolvedValue({ request_id: 'r1', challenge: 'q?' });
      apiMocks.completeChallenge.mockRejectedValue(
        new TestInstaMoltApiError('POST', '/agents/register/complete', 409, conflictBody),
      );
      // Each generateAgentName call returns a distinct "available" name so the
      // probe never blocks — we want to exhaust the outer retry counter, not the
      // inner probe loop.
      let nameSeq = 0;
      llmMocks.generateAgentName.mockImplementation(async () => `candidate_${++nameSeq}`);

      await publish({ skipFollowGraph: true });

      // startChallenge called once per outer attempt (original + 5 retries = 6).
      expect(apiMocks.startChallenge).toHaveBeenCalledTimes(6);
      // No agent.json in the entire virtual FS should carry an apiKey — the
      // registration never succeeded regardless of which directory it ended up in.
      const anyApiKey = [...fsState.files.entries()].some(([k, v]) => {
        if (!k.endsWith('agent.json')) return false;
        try {
          return !!(JSON.parse(v) as { apiKey?: string }).apiKey;
        } catch {
          return false;
        }
      });
      expect(anyApiKey).toBe(false);
    });
  });

  describe('Phase A.5 — avatar generation', () => {
    /** Seed an agent.json that already has an avatarPrompt + apiKey. */
    function primeAgentWithPrompt(
      name: string,
      opts: { apiKey: string; avatarPrompt?: string; avatarUrl?: string } & Record<string, unknown>,
    ): void {
      fsState.files.set(
        agentJsonPath(name),
        JSON.stringify({
          agentname: name,
          personaId: 'test-persona',
          voiceProfileId: 'normie_cam',
          bio: 'A calm considered AI mind',
          avatarPrompt: opts.avatarPrompt ?? 'chrome mask, neon glow',
          ...(opts.avatarUrl ? { avatarUrl: opts.avatarUrl } : {}),
          apiKey: opts.apiKey,
        }),
      );
      if (!fsState.dirEntries.has(join('./output/agents', name))) {
        fsState.dirEntries.set(join('./output/agents', name), []);
      }
    }

    it('uploads an avatar for each registered agent missing one and persists the returned url/seed', async () => {
      primeAgentWithPrompt('alpha', { apiKey: 'key-alpha' });
      primeIndex(['alpha']);

      await publish({ skipFollowGraph: true });

      expect(apiMocks.generateAvatar).toHaveBeenCalledTimes(1);
      expect(apiMocks.generateAvatar).toHaveBeenCalledWith('chrome mask, neon glow');

      const alpha = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
      expect(alpha.avatarUrl).toBe('https://cdn.instamolt.app/avatars/x/1.jpg');
      expect(alpha.avatarGenerationSeed).toBe(42);
      expect(typeof alpha.avatarGeneratedAt).toBe('string');
    });

    it('skips agents that already have an avatarUrl', async () => {
      primeAgentWithPrompt('alpha', {
        apiKey: 'key-alpha',
        avatarUrl: 'https://cdn.instamolt.app/avatars/existing.jpg',
      });
      primeIndex(['alpha']);

      await publish({ skipFollowGraph: true });

      expect(apiMocks.generateAvatar).not.toHaveBeenCalled();
    });

    it('drafts a just-in-time avatarPrompt when missing, persists it, then uploads', async () => {
      // Legacy draft without avatarPrompt. Phase A.5 must backfill it.
      fsState.files.set(
        agentJsonPath('alpha'),
        JSON.stringify({
          agentname: 'alpha',
          personaId: 'test-persona',
          voiceProfileId: 'normie_cam',
          bio: 'A calm considered AI mind',
          apiKey: 'key-alpha',
        }),
      );
      fsState.dirEntries.set(join('./output/agents', 'alpha'), []);
      primeIndex(['alpha']);

      llmMocks.generateAvatarPrompt.mockResolvedValue('backfilled prompt');

      await publish({ skipFollowGraph: true });

      expect(llmMocks.generateAvatarPrompt).toHaveBeenCalledTimes(1);
      expect(apiMocks.generateAvatar).toHaveBeenCalledWith('backfilled prompt');

      const alpha = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
      expect(alpha.avatarPrompt).toBe('backfilled prompt');
      expect(alpha.avatarUrl).toBe('https://cdn.instamolt.app/avatars/x/1.jpg');
    });

    it('logs and skips without aborting the batch when the cap is reached (403 AVATAR_GENERATION_LIMIT_REACHED)', async () => {
      primeAgentWithPrompt('alpha', { apiKey: 'key-alpha' });
      primeAgentWithPrompt('beta', { apiKey: 'key-beta' });
      primeIndex(['alpha', 'beta']);

      // alpha: cap reached. beta: success.
      apiMocks.generateAvatar
        .mockRejectedValueOnce(
          new TestInstaMoltApiError(
            'POST',
            '/agents/me/avatar/generate',
            403,
            JSON.stringify({
              error: 'limit',
              code: 'AVATAR_GENERATION_LIMIT_REACHED',
              lifetime_cap: 5,
            }),
          ),
        )
        .mockResolvedValueOnce({
          avatar_url: 'https://cdn.instamolt.app/avatars/beta/1.jpg',
          generation_seed: 99,
          generations_used: 1,
          generations_remaining: 4,
        });

      await publish({ skipFollowGraph: true });

      const alpha = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
      const beta = JSON.parse(fsState.files.get(agentJsonPath('beta'))!);
      expect(alpha.avatarUrl).toBeUndefined();
      expect(beta.avatarUrl).toBe('https://cdn.instamolt.app/avatars/beta/1.jpg');
    });

    it('skips without aborting when the prompt is blocked (403 CONTENT_BLOCKED)', async () => {
      primeAgentWithPrompt('alpha', { apiKey: 'key-alpha' });
      primeIndex(['alpha']);

      apiMocks.generateAvatar.mockRejectedValueOnce(
        new TestInstaMoltApiError(
          'POST',
          '/agents/me/avatar/generate',
          403,
          JSON.stringify({ error: 'Content blocked', code: 'CONTENT_BLOCKED' }),
        ),
      );

      await publish({ skipFollowGraph: true });

      const alpha = JSON.parse(fsState.files.get(agentJsonPath('alpha'))!);
      expect(alpha.avatarUrl).toBeUndefined();
      // The apiKey must stay intact — a blocked avatar does NOT un-register
      // the agent.
      expect(alpha.apiKey).toBe('key-alpha');
    });
  });
});
