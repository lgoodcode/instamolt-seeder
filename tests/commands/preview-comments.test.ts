import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCacheFile, Persona, RemotePost } from '@/types';

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

// ---------------- feed-cache mock ----------------

const feedCacheMocks = vi.hoisted(() => ({
  loadFeedCacheStrict: vi.fn<() => Promise<FeedCacheFile>>(),
}));

vi.mock('@/lib/feed-cache', async () => {
  // Preserve the real FeedCacheEmptyError class so `instanceof` checks in
  // preview-comments.ts resolve correctly against the same error constructor.
  const actual = await vi.importActual<typeof import('@/lib/feed-cache')>('@/lib/feed-cache');
  return {
    ...actual,
    loadFeedCacheStrict: feedCacheMocks.loadFeedCacheStrict,
  };
});

// ---------------- instamolt-api mock ----------------
// preview-comments instantiates InstaMoltClient to pass into loadFeedCacheStrict.
// The actual client is never used because the cache mock short-circuits the call.

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function MockClient() {
    return {};
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

// ---------------- voice-profiles mock ----------------
// Returns a Map containing one entry under `normie_cam` so the bake phase's
// `voiceProfiles.get(agent.voiceProfileId)` lookup resolves for fixtures
// that pin agents to that profile id.
const hoistedVoice = vi.hoisted(() => ({
  dummy: {
    id: 'normie_cam',
    literacy: 'normal',
    verbosity: 'one_sentence',
    capitalization: 'proper',
    punctuation: 'proper',
    typoFrequency: 'none',
    register: 'casual normal',
    lexicon: ['wow'],
    examples: ['Wow.'],
    prevalenceWeight: 4,
  },
}));

vi.mock('@/voice-profiles/index', () => ({
  loadVoiceProfiles: vi.fn(() => new Map([[hoistedVoice.dummy.id, hoistedVoice.dummy]])),
}));

import { previewComments } from '@/commands/preview-comments';
import { FeedCacheEmptyError } from '@/lib/feed-cache';

function makePersona(id: string): Persona {
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

function primeAgent(name: string, personaId: string): void {
  fsState.files.set(
    join('./output/agents', name, 'agent.json'),
    JSON.stringify({
      agentname: name,
      personaId,
      voiceProfileId: 'normie_cam',
      bio: `${name} bio`,
    }),
  );
}

function makeRemotePost(id: string, agentname: string, caption: string | null): RemotePost {
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

describe('preview-comments', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    llmMocks.generateComment.mockReset();
    personaMocks.loadPersonas.mockReset();
    feedCacheMocks.loadFeedCacheStrict.mockReset();

    llmMocks.generateComment.mockResolvedValue('a sharp little reply');
    // Default: a healthy live feed with two captions from unrelated peers.
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      makeFeedCache([
        makeRemotePost('p1', 'feedpeer1', 'live feed caption one'),
        makeRemotePost('p2', 'feedpeer2', 'live feed caption two'),
      ]),
    );
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
    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });

  it('aborts cleanly when there are no agents on disk', async () => {
    personaMocks.loadPersonas.mockResolvedValue(new Map([['cozy', makePersona('cozy')]]));
    await previewComments();
    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });

  it('generates N sample comments per agent from the live feed cache', async () => {
    personaMocks.loadPersonas.mockResolvedValue(
      new Map([
        ['cozy', makePersona('cozy')],
        ['chaotic', makePersona('chaotic')],
      ]),
    );

    primeAgent('alpha', 'cozy');
    primeAgent('beta', 'chaotic');
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 2,
        totalPosts: 0,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', voiceProfileId: 'normie_cam', bio: 'alpha bio' },
          {
            agentname: 'beta',
            personaId: 'chaotic',
            voiceProfileId: 'normie_cam',
            bio: 'beta bio',
          },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['agent.json']);
    fsState.dirEntries.set(join('./output/agents', 'beta'), ['agent.json']);

    await previewComments({ count: 1 });

    expect(feedCacheMocks.loadFeedCacheStrict).toHaveBeenCalledTimes(1);
    expect(llmMocks.generateComment).toHaveBeenCalledTimes(2);

    // All source authors should be live-feed peers, never a seeder agent.
    const sources = (llmMocks.generateComment.mock.calls as unknown[][]).map((c) => c[3]);
    expect(sources.every((s) => s === 'feedpeer1' || s === 'feedpeer2')).toBe(true);

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
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 2,
        totalPosts: 0,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', voiceProfileId: 'normie_cam', bio: 'alpha bio' },
          {
            agentname: 'beta',
            personaId: 'chaotic',
            voiceProfileId: 'normie_cam',
            bio: 'beta bio',
          },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), []);
    fsState.dirEntries.set(join('./output/agents', 'beta'), []);

    await previewComments({ agent: 'alpha', count: 1 });

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
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 3,
        totalPosts: 0,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', voiceProfileId: 'normie_cam', bio: 'alpha bio' },
          {
            agentname: 'beta',
            personaId: 'chaotic',
            voiceProfileId: 'normie_cam',
            bio: 'beta bio',
          },
          { agentname: 'gamma', personaId: 'cozy', voiceProfileId: 'normie_cam', bio: 'gamma bio' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), []);
    fsState.dirEntries.set(join('./output/agents', 'beta'), []);
    fsState.dirEntries.set(join('./output/agents', 'gamma'), []);

    await previewComments({ persona: 'cozy', count: 1 });

    expect(llmMocks.generateComment).toHaveBeenCalledTimes(2);
    const names = (llmMocks.generateComment.mock.calls as unknown[][]).map(
      (c) => (c[1] as { agentname: string }).agentname,
    );
    expect(names).toContain('alpha');
    expect(names).toContain('gamma');
    expect(names).not.toContain('beta');
  });

  it('aborts cleanly when the live feed is empty', async () => {
    personaMocks.loadPersonas.mockResolvedValue(new Map([['cozy', makePersona('cozy')]]));
    primeAgent('alpha', 'cozy');
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 1,
        totalPosts: 0,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', voiceProfileId: 'normie_cam', bio: 'alpha bio' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), []);

    feedCacheMocks.loadFeedCacheStrict.mockRejectedValue(new FeedCacheEmptyError());

    await previewComments({ count: 2 });

    // The FeedCacheEmptyError is caught inside previewComments → early return
    // with no LLM calls. Must not throw out of the command itself.
    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });

  it('aborts cleanly when the live feed has fewer than 2 usable captions', async () => {
    personaMocks.loadPersonas.mockResolvedValue(new Map([['cozy', makePersona('cozy')]]));
    primeAgent('alpha', 'cozy');
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '',
        totalAgents: 1,
        totalPosts: 0,
        agents: [
          { agentname: 'alpha', personaId: 'cozy', voiceProfileId: 'normie_cam', bio: 'alpha bio' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), []);

    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      makeFeedCache([makeRemotePost('p1', 'feedpeer1', 'lonely caption')]),
    );

    await previewComments({ count: 3 });

    expect(llmMocks.generateComment).not.toHaveBeenCalled();
  });
});
