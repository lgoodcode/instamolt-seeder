import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentQuota, FeedCacheFile, Persona } from '@/types';

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
  rename: vi.fn(async () => {}),
}));

// ---------------- ui mock ----------------

const uiState = vi.hoisted(() => ({
  intros: [] as string[],
  outros: [] as string[],
  notes: [] as Array<{ title: string; body: string }>,
  sections: [] as string[],
}));

vi.mock('@/lib/ui', () => ({
  intro: vi.fn((msg: string) => {
    uiState.intros.push(msg);
  }),
  outro: vi.fn((msg: string) => {
    uiState.outros.push(msg);
  }),
  section: vi.fn((msg: string) => {
    uiState.sections.push(msg);
  }),
  note: vi.fn((title: string, body: string) => {
    uiState.notes.push({ title, body });
  }),
  isInteractive: vi.fn(() => false),
  summaryLine: vi.fn((items: unknown) => JSON.stringify(items)),
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

// ---------------- logger mock ----------------

const loggerMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));
vi.mock('@/lib/logger', () => loggerMocks);

// ---------------- event-logger mock ----------------

const eventLoggerMocks = vi.hoisted(() => ({
  initEventLogger: vi.fn(),
  logEvent: vi.fn(),
  flushStats: vi.fn(),
  updateAgentCounts: vi.fn(),
  drainWrites: vi.fn(async () => {}),
}));
vi.mock('@/lib/event-logger', () => eventLoggerMocks);

// ---------------- feed-cache mock ----------------

const feedCacheMocks = vi.hoisted(() => ({
  loadFeedCache: vi.fn<() => Promise<FeedCacheFile>>(),
  refreshFeedCache: vi.fn<() => Promise<FeedCacheFile>>(),
  refreshOpenApiCache: vi.fn<() => Promise<void>>(),
  evictStale: vi.fn(() => 0),
  createLiveFeedCache: vi.fn((file: FeedCacheFile) => ({
    file,
    engagedBy: new Map(),
  })),
}));
vi.mock('@/lib/feed-cache', () => feedCacheMocks);

// ---------------- instamolt-api mock ----------------

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function () {
    return {};
  }),
  InstaMoltApiError: class extends Error {
    constructor(
      readonly method: string,
      readonly path: string,
      readonly status: number,
      readonly body: string,
    ) {
      super(`${method} ${path}: ${status}`);
      this.name = 'InstaMoltApiError';
    }
  },
}));

// ---------------- engage-actions mock ----------------

const engageActionsMocks = vi.hoisted(() => ({
  dispatchAction: vi.fn(),
}));
vi.mock('@/lib/engage-actions', () => engageActionsMocks);

// ---------------- action-scheduler mock ----------------

const schedulerMocks = vi.hoisted(() => ({
  enroll: vi.fn(),
  pop: vi.fn(),
  size: vi.fn(() => 1),
  has: vi.fn(() => true),
  injectBonusSession: vi.fn<(agent: { agentname: string }) => boolean>(() => true),
  rescheduleAfterTick: vi.fn(),
  rescheduleQuotaExhausted: vi.fn(),
  rescheduleToNextActiveHour: vi.fn(() => 3),
  peek: vi.fn(),
}));

vi.mock('@/lib/action-scheduler', () => ({
  ActionScheduler: vi.fn(function () {
    return schedulerMocks;
  }),
}));

// ---------------- quota mock ----------------

const quotaMocks = vi.hoisted(() => ({
  loadOrInitQuota: vi.fn<(agent: { agentname: string }) => Promise<AgentQuota>>(),
  usedInWindow: vi.fn(() => 0),
  checkAvailability: vi.fn<() => { ok: boolean; reason?: string }>(() => ({ ok: true })),
  maxPostsThisHour: vi.fn(() => 10),
  postsInLastHour: vi.fn(() => 0),
  consume: vi.fn(),
  persistQuota: vi.fn(async () => {}),
}));
vi.mock('@/lib/quota', () => quotaMocks);

// ---------------- personas mock ----------------

const personaMocks = vi.hoisted(() => ({
  loadPersonas: vi.fn<() => Promise<Map<string, Persona>>>(),
}));
vi.mock('@/personas/index', () => personaMocks);

// ---------------- growth mock ----------------

const growthMocks = vi.hoisted(() => ({
  computeBatchSize: vi.fn(() => 1),
  formatGrowthStatus: vi.fn(() => 'Growth: mocked'),
  GROWTH_DEFAULTS: {
    maxAgents: 200,
    growthRate: 3,
    growthIntervalHours: 4,
    postsPerNewAgent: 10,
  },
}));
vi.mock('@/lib/growth', () => growthMocks);

// ---------------- imports ----------------

import { engageContinuous } from '@/commands/engage-continuous';

// ---------------- fixtures ----------------

function makePersona(id: string, overrides: Partial<Persona> = {}): Persona {
  return {
    id,
    tagline: 'test tagline',
    personality: 'A cheerful agent',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: ['#foo'],
    postsPerDay: [1, 2],
    likeProbability: 1,
    commentProbability: 1,
    followProbability: 1,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
    ...overrides,
  };
}

function makeQuota(agentname: string): AgentQuota {
  return {
    agentname,
    history: {
      like: [],
      comment: [],
      reply: [],
      follow: [],
      post: [],
      commentLike: [],
    },
    caps: { like: 80, comment: 15, reply: 25, follow: 10, post: 2, commentLike: 40 },
    last: {},
  };
}

function makeFeedCacheFile(): FeedCacheFile {
  return {
    refreshedAt: new Date().toISOString(),
    sources: ['explore'],
    posts: [
      {
        id: 'post-1',
        image_url: 'http://x/y.jpg',
        thumbnail_url: null,
        caption: 'hi',
        width: 1080,
        height: 1080,
        format: 'square',
        like_count: 0,
        comment_count: 0,
        view_count: 0,
        popularity_score: 0,
        velocity_score: 0,
        share_count: 0,
        created_at: new Date().toISOString(),
        author: { agentname: 'someone', is_verified: false },
      },
    ],
  };
}

function primeAgent(name: string, personaId = 'test-persona'): void {
  fsState.files.set(
    join('./output/agents', name, 'agent.json'),
    JSON.stringify({
      agentname: name,
      personaId,
      bio: 'A calm considered mind',
      apiKey: `key-${name}`,
    }),
  );
}

// ---------------- tests ----------------

describe('engage-continuous', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Stub setTimeout so scheduler sleeps resolve instantly.
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    });

    fsState.files.clear();
    fsState.dirEntries.clear();
    uiState.intros.length = 0;
    uiState.outros.length = 0;
    uiState.notes.length = 0;
    uiState.sections.length = 0;

    // Reset all mocks
    loggerMocks.log.mockReset();
    eventLoggerMocks.initEventLogger.mockReset();
    eventLoggerMocks.logEvent.mockReset();
    eventLoggerMocks.flushStats.mockReset();
    eventLoggerMocks.updateAgentCounts.mockReset();
    feedCacheMocks.loadFeedCache.mockReset();
    feedCacheMocks.refreshFeedCache.mockReset();
    feedCacheMocks.refreshOpenApiCache.mockReset();
    feedCacheMocks.evictStale.mockReset();
    feedCacheMocks.evictStale.mockReturnValue(0);
    feedCacheMocks.createLiveFeedCache.mockImplementation((file: FeedCacheFile) => ({
      file,
      engagedBy: new Map(),
    }));
    engageActionsMocks.dispatchAction.mockReset();
    schedulerMocks.enroll.mockReset();
    schedulerMocks.pop.mockReset();
    schedulerMocks.size.mockReset();
    schedulerMocks.size.mockReturnValue(1);
    schedulerMocks.has.mockReset();
    schedulerMocks.has.mockReturnValue(true);
    schedulerMocks.injectBonusSession.mockReset();
    schedulerMocks.injectBonusSession.mockReturnValue(true);
    schedulerMocks.rescheduleAfterTick.mockReset();
    schedulerMocks.rescheduleQuotaExhausted.mockReset();
    schedulerMocks.rescheduleToNextActiveHour.mockReset();
    schedulerMocks.rescheduleToNextActiveHour.mockReturnValue(3);
    quotaMocks.loadOrInitQuota.mockReset();
    quotaMocks.usedInWindow.mockReset();
    quotaMocks.usedInWindow.mockReturnValue(0);
    quotaMocks.checkAvailability.mockReset();
    quotaMocks.checkAvailability.mockReturnValue({ ok: true });
    quotaMocks.maxPostsThisHour.mockReset();
    quotaMocks.maxPostsThisHour.mockReturnValue(10);
    quotaMocks.postsInLastHour.mockReset();
    quotaMocks.postsInLastHour.mockReturnValue(0);
    personaMocks.loadPersonas.mockReset();
    growthMocks.computeBatchSize.mockReset();
    growthMocks.computeBatchSize.mockReturnValue(1);
    growthMocks.formatGrowthStatus.mockReset();
    growthMocks.formatGrowthStatus.mockReturnValue('Growth: mocked');

    // Default happy-path fixture setup
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([['test-persona', makePersona('test-persona')]]),
    );
    feedCacheMocks.loadFeedCache.mockResolvedValue(makeFeedCacheFile());
    feedCacheMocks.refreshFeedCache.mockResolvedValue(makeFeedCacheFile());
    feedCacheMocks.refreshOpenApiCache.mockResolvedValue();
    quotaMocks.loadOrInitQuota.mockImplementation(async (agent) =>
      makeQuota((agent as { agentname: string }).agentname),
    );

    // Env setup
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.RATE_LIMIT_BYPASS_SECRET = 'test-secret';

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    logSpy.mockRestore();
  });

  it('hard-fails without RATE_LIMIT_BYPASS_SECRET', async () => {
    delete process.env.RATE_LIMIT_BYPASS_SECRET;

    // Source contract: `if (!config.rateLimitBypassSecret)` is the first gate
    // after `ui.intro`. In the current source the `config.rateLimitBypassSecret`
    // getter throws on missing env, which aborts the function before any
    // downstream work — equivalent to the documented hard-fail behavior, just
    // via a different error shape than `ui.outro`. We verify the gate by
    // asserting NO feed cache / scheduler / persona work happened, and that
    // the promise rejected with a message naming the missing env var.
    let err: unknown = null;
    try {
      await engageContinuous({});
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('RATE_LIMIT_BYPASS_SECRET');
    expect(feedCacheMocks.loadFeedCache).not.toHaveBeenCalled();
    expect(schedulerMocks.enroll).not.toHaveBeenCalled();
    expect(schedulerMocks.pop).not.toHaveBeenCalled();
    expect(personaMocks.loadPersonas).not.toHaveBeenCalled();
  });

  it('aborts when no registered agents exist', async () => {
    fsState.dirEntries.set('./output/agents', []);

    await engageContinuous({});

    const abortedOutro = uiState.outros.find((m) => /aborted/i.test(m));
    expect(abortedOutro).toBeDefined();
    expect(schedulerMocks.enroll).not.toHaveBeenCalled();
    expect(schedulerMocks.pop).not.toHaveBeenCalled();
  });

  it('aborts when initial feed cache load fails', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    feedCacheMocks.loadFeedCache.mockRejectedValueOnce(new Error('network down'));

    await engageContinuous({});

    const abortedOutro = uiState.outros.find((m) => /no feed cache/i.test(m));
    expect(abortedOutro).toBeDefined();
    expect(schedulerMocks.pop).not.toHaveBeenCalled();
  });

  it('runs a single tick happy path: dispatches one action and reschedules', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockReturnValue(undefined);

    engageActionsMocks.dispatchAction.mockResolvedValue({
      status: 'ok',
      kind: 'like',
      detail: 'liked post-1',
    });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    expect(engageActionsMocks.dispatchAction).toHaveBeenCalledTimes(1);
    const callArgs = engageActionsMocks.dispatchAction.mock.calls[0] as unknown[];
    // Signature: (kind, ctx, agent, persona, quota, activityReplyProbability)
    expect((callArgs[2] as { agentname: string }).agentname).toBe('alpha');
    expect((callArgs[3] as { id: string }).id).toBe('test-persona');
    expect((callArgs[4] as { agentname: string }).agentname).toBe('alpha');

    expect(schedulerMocks.rescheduleAfterTick).toHaveBeenCalledTimes(1);

    const likeEvent = eventLoggerMocks.logEvent.mock.calls.find((call) => {
      const arg = call[0] as { eventType?: string };
      return arg?.eventType === 'like';
    });
    expect(likeEvent).toBeDefined();
  });

  it('offline gate: zero activityCurve for current hour skips dispatch and reschedules to next active hour', async () => {
    // Build an offline curve whose zero slot is the current hour in the
    // seeder timezone. We read the hour via the same Intl formatter the
    // source uses so this test is independent of the local clock.
    const currentHour = Number.parseInt(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: 'America/New_York',
      }).format(new Date()),
      10,
    );
    const offlineCurve = Array.from({ length: 24 }, (_, i) => (i === currentHour ? 0 : 0.5));
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([['test-persona', makePersona('test-persona', { activityCurve: offlineCurve })]]),
    );

    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    // Offline branch `continue`s without incrementing actionsPerformed, so
    // the loop won't terminate via maxActions. Signal SIGINT on the next
    // pop so the loop exits cleanly.
    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockImplementation(() => {
        process.emit('SIGINT');
        return undefined;
      });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    expect(engageActionsMocks.dispatchAction).not.toHaveBeenCalled();
    expect(schedulerMocks.rescheduleToNextActiveHour).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.rescheduleAfterTick).not.toHaveBeenCalled();
  });

  it('bonusEligible triggers injectBonusSession on the scheduler', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockReturnValue(undefined);

    engageActionsMocks.dispatchAction.mockResolvedValue({
      status: 'ok',
      kind: 'comment',
      detail: 'thoughtful take',
      bonusEligible: true,
    });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    expect(schedulerMocks.injectBonusSession).toHaveBeenCalledTimes(1);
    const callArg = schedulerMocks.injectBonusSession.mock.calls[0]?.[0] as { agentname: string };
    expect(callArg.agentname).toBe('alpha');
  });

  it('quota exhaustion: pickWeightedAction returns null → rescheduleQuotaExhausted, no dispatch', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    // Force pickWeightedAction to return null by making every kind unavailable.
    quotaMocks.checkAvailability.mockReturnValue({ ok: false, reason: 'quota_exhausted' });

    // Quota-exhausted branch does NOT increment actionsPerformed — so we
    // trigger SIGINT on the second pop call to exit the loop.
    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockImplementation(() => {
        process.emit('SIGINT');
        return undefined;
      });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    expect(schedulerMocks.rescheduleQuotaExhausted).toHaveBeenCalledTimes(1);
    expect(engageActionsMocks.dispatchAction).not.toHaveBeenCalled();
    expect(schedulerMocks.rescheduleAfterTick).not.toHaveBeenCalled();
  });

  it('skipped action logs success:false with the skip reason', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockReturnValue(undefined);

    engageActionsMocks.dispatchAction.mockResolvedValue({
      status: 'skipped',
      kind: 'like',
      reason: 'no posts',
    });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    const skippedEvent = eventLoggerMocks.logEvent.mock.calls.find((call) => {
      const arg = call[0] as {
        success?: boolean;
        details?: { skipped?: boolean; reason?: string };
      };
      return arg?.success === false && arg?.details?.skipped === true;
    });
    expect(skippedEvent).toBeDefined();
    const arg = skippedEvent?.[0] as { details?: { reason?: string } };
    expect(arg.details?.reason).toBe('no posts');
  });

  it('error result logs success:false with the error text', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockReturnValue(undefined);

    engageActionsMocks.dispatchAction.mockResolvedValue({
      status: 'error',
      kind: 'like',
      error: 'boom',
    });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    const errorEvent = eventLoggerMocks.logEvent.mock.calls.find((call) => {
      const arg = call[0] as { success?: boolean; error?: string };
      return arg?.success === false && arg?.error === 'boom';
    });
    expect(errorEvent).toBeDefined();
  });

  it('--no-growth skips growth tick (never calls formatGrowthStatus)', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    schedulerMocks.pop
      .mockReturnValueOnce({ agentname: 'alpha', nextTickAt: Date.now() })
      .mockReturnValue(undefined);

    engageActionsMocks.dispatchAction.mockResolvedValue({
      status: 'ok',
      kind: 'like',
      detail: 'ok',
    });

    await engageContinuous({
      maxActions: 1,
      dryRun: true,
      noGrowth: true,
      // Force the rescan branch to execute within the single tick.
      agentRescanIntervalMs: 0,
    });

    // Growth display is gated behind growthConfig.enabled, so with noGrowth: true
    // formatGrowthStatus should never fire.
    expect(growthMocks.formatGrowthStatus).not.toHaveBeenCalled();
    expect(growthMocks.computeBatchSize).not.toHaveBeenCalled();
  });

  it('SIGINT sets stopRequested, exits cleanly, flushes stats, and removes listener', async () => {
    primeAgent('alpha');
    fsState.dirEntries.set('./output/agents', ['alpha']);

    // Track listener count BEFORE the function registers its SIGINT handler.
    const listenersBefore = process.listeners('SIGINT').length;

    // The first pop triggers SIGINT synchronously so the loop's subsequent
    // `if (stopRequested) break` branch fires before any action is dispatched.
    // This exercises the SIGINT handler wiring + the finally-block cleanup
    // without requiring real time to pass.
    let sigintEmitted = false;
    schedulerMocks.pop.mockImplementation(() => {
      if (!sigintEmitted) {
        sigintEmitted = true;
        process.emit('SIGINT');
      }
      return undefined;
    });

    await engageContinuous({ maxActions: 1, dryRun: true, noGrowth: true });

    expect(eventLoggerMocks.flushStats).toHaveBeenCalled();
    // Finally-block outro should have run.
    const finishedOutro = uiState.outros.find((m) => /finished/i.test(m));
    expect(finishedOutro).toBeDefined();

    // Listener count returns to the baseline (no leak).
    expect(process.listeners('SIGINT').length).toBe(listenersBefore);
  });
});
