import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCacheFile, Persona, RemotePost, VoiceProfile } from '@/types';

// Minimal in-memory fs. Only the operations used by generate.ts are modelled.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mkdirCalls: [] as string[],
  // Map of dir path -> list of filenames inside that dir. Lets the dedup-
  // context loader walk existing agent directories without touching the disk.
  dirs: new Map<string, string[]>(),
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
    // Keep `dirs` in sync with writes so subsequent readdir() calls in the
    // same test see newly-created files. Real fs does this for free; the
    // bake-comments phase relies on it (it walks agent dirs via readdir).
    // Handle both POSIX `/` and Windows `\` separators since path.join() is
    // OS-dependent and the test suite runs on both.
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (idx >= 0) {
      const dir = path.slice(0, idx);
      const file = path.slice(idx + 1);
      const entries = fsState.dirs.get(dir) ?? [];
      if (!entries.includes(file)) {
        entries.push(file);
        fsState.dirs.set(dir, entries);
      }
    }
  }),
  mkdir: vi.fn(async (path: string) => {
    fsState.mkdirCalls.push(path);
  }),
  readdir: vi.fn(async (path: string) => {
    const entries = fsState.dirs.get(path);
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  }),
}));

const llmMocks = vi.hoisted(() => ({
  generateAgentName:
    vi.fn<
      (
        persona: unknown,
        existingNames: string[],
        rejectedThisRun?: string[],
        attempt?: number,
      ) => Promise<string>
    >(),
  generateBio: vi.fn<(persona: unknown, existingBios?: string[]) => Promise<string>>(),
  generatePostContent:
    vi.fn<
      (
        persona: unknown,
        postNumber: number,
        totalPosts: number,
        priorPosts?: {
          imagePrompt: string;
          caption: string;
          aspectRatio: 'square' | 'landscape' | 'portrait';
        }[],
        peerPosts?: {
          imagePrompt: string;
          caption: string;
          aspectRatio: 'square' | 'landscape' | 'portrait';
        }[],
      ) => Promise<{
        imagePrompt: string;
        caption: string;
        aspectRatio: 'square' | 'landscape' | 'portrait';
      }>
    >(),
  generateComment: vi.fn<() => Promise<string>>(),
  rollChaos: vi.fn(() => false),
}));

vi.mock('@/services/llm', () => llmMocks);

const personaMocks = vi.hoisted(() => ({
  loadPersonas: vi.fn<() => Promise<Map<string, Persona>>>(),
}));

vi.mock('@/personas/index', () => personaMocks);

const registryMocks = vi.hoisted(() => ({
  getAgentAssignments:
    vi.fn<
      (
        count: number,
        personas: Map<string, Persona>,
        voiceProfiles: Map<string, VoiceProfile>,
      ) => Array<{ persona: Persona; voiceProfile: VoiceProfile }>
    >(),
}));

vi.mock('@/personas/registry', () => registryMocks);

vi.mock('@/voice-profiles/index', () => ({
  loadVoiceProfiles: vi.fn(
    () =>
      new Map([
        [
          'normie_cam',
          {
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
        ],
      ]),
  ),
}));

// Feed cache mock. The bake phase calls `loadFeedCacheStrict` to pull real
// captions from the platform; tests supply a hand-built FeedCacheFile so we
// don't hit the network. `FeedCacheEmptyError` is re-exported from the real
// module so `instanceof` checks inside generate.ts resolve correctly.
const feedCacheMocks = vi.hoisted(() => ({
  loadFeedCacheStrict: vi.fn<() => Promise<FeedCacheFile>>(),
}));

vi.mock('@/lib/feed-cache', async () => {
  const actual = await vi.importActual<typeof import('@/lib/feed-cache')>('@/lib/feed-cache');
  return {
    ...actual,
    loadFeedCacheStrict: feedCacheMocks.loadFeedCacheStrict,
  };
});

// InstaMoltClient is instantiated in two places:
//   1) the agent-name retry loop, which calls `isAgentnameAvailable` against
//      the live platform before accepting a candidate name;
//   2) the bake phase, which passes the client into the feed cache loader
//      (short-circuited here by the `loadFeedCacheStrict` mock).
// Tests that care about the name-retry path override `isAgentnameAvailable`
// via `instamoltMocks.isAgentnameAvailable.mockImplementation(...)` before
// calling `generate`. Default behavior is "always available" so tests that
// don't care about this path see a single-shot name generation.
const instamoltMocks = vi.hoisted(() => ({
  isAgentnameAvailable: vi.fn<(agentname: string) => Promise<boolean>>(),
}));

vi.mock('@/services/instamolt-api', () => ({
  InstaMoltClient: vi.fn().mockImplementation(function MockClient() {
    return {
      isAgentnameAvailable: instamoltMocks.isAgentnameAvailable,
    };
  }),
}));

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

// generate.ts now writes through src/ui.ts. Mock as no-op so test output isn't
// polluted by spinner escape codes and ui.note doesn't try to render.
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

const eventLoggerMocks = vi.hoisted(() => ({
  initEventLogger: vi.fn(),
  logEvent: vi.fn(),
  logSkippedAction: vi.fn(),
  flushStats: vi.fn(),
  updateAgentCounts: vi.fn(),
  drainWrites: vi.fn(async () => {}),
}));

vi.mock('@/lib/event-logger', () => eventLoggerMocks);

import { generate } from '@/commands/generate';

const dummyVoice: VoiceProfile = {
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
};

/** Build a flat assignment list of N entries for a single persona. */
function assignN(persona: Persona, n: number) {
  return Array.from({ length: n }, () => ({ persona, voiceProfile: dummyVoice }));
}

function makePersona(id: string, personality = 'A very thoughtful AI agent.'): Persona {
  return {
    id,
    tagline: 'test tagline',
    personality,
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
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

describe('generate', () => {
  beforeEach(() => {
    // Stub setTimeout so the 500ms sleep between post generations and the
    // same 500ms sleep between comment bakes don't accumulate into minute-
    // long test runs. Same pattern as tests/commands/engage.test.ts.
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as NodeJS.Timeout;
    });
    fsState.files.clear();
    fsState.mkdirCalls = [];
    fsState.dirs.clear();
    llmMocks.generateAgentName.mockReset();
    instamoltMocks.isAgentnameAvailable.mockReset();
    // Default: every candidate is available. Tests that want to exercise the
    // retry loop override this per-candidate.
    instamoltMocks.isAgentnameAvailable.mockResolvedValue(true);
    llmMocks.generateBio.mockReset();
    llmMocks.generatePostContent.mockReset();
    llmMocks.generateComment.mockReset();
    personaMocks.loadPersonas.mockReset();
    registryMocks.getAgentAssignments.mockReset();
    feedCacheMocks.loadFeedCacheStrict.mockReset();
    eventLoggerMocks.initEventLogger.mockReset();
    eventLoggerMocks.logEvent.mockReset();
    eventLoggerMocks.logSkippedAction.mockReset();
    eventLoggerMocks.flushStats.mockReset();
    eventLoggerMocks.updateAgentCounts.mockReset();

    // Default feed-cache mock: a small pool of real-shaped peer captions so
    // the comment-bake phase has material to work with. Individual tests can
    // override this (e.g. the "too small captions pool" case sets a single-
    // caption feed).
    feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
      makeFeedCache([
        makeRemotePost('lp1', 'livepeer1', 'live peer caption one'),
        makeRemotePost('lp2', 'livepeer2', 'live peer caption two'),
        makeRemotePost('lp3', 'livepeer3', 'live peer caption three'),
      ]),
    );

    // Default mock returns content with disjoint vocabulary per call so the
    // similarity gate never trips during tests that don't care about the
    // gate. The Jaccard tokenizer drops short words, so simple integer
    // suffixes are not enough — we use entirely distinct nouns instead.
    // Tests that exercise the gate explicitly override this with their own mocks.
    const distinctTopics = [
      { noun: 'cobalt mountains', cap: 'frozen ridgeline' },
      { noun: 'amber forests', cap: 'autumn moss' },
      { noun: 'crimson deserts', cap: 'glass dunes' },
      { noun: 'silver oceans', cap: 'tidal foam' },
      { noun: 'violet caverns', cap: 'echoing crystal' },
      { noun: 'jade meadows', cap: 'cricket dusk' },
      { noun: 'bronze foundries', cap: 'molten sparks' },
      { noun: 'pearl gardens', cap: 'orchid breath' },
    ];
    let postCallSeq = 0;
    llmMocks.generatePostContent.mockImplementation(async () => {
      const topic = distinctTopics[postCallSeq % distinctTopics.length]!;
      postCallSeq++;
      return {
        imagePrompt: `${topic.noun} drifting beneath an unfamiliar sky`,
        caption: `${topic.cap} whisper`,
        aspectRatio: 'square',
      };
    });

    // Silence the logger during tests — it writes to console.log.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('writes agent.json files and the master index for each created agent', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
    llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
    llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

    await generate(2, 1);

    // Two agent.json files should now exist (one per agent).
    const alphaPath = join('./output/agents', 'alpha', 'agent.json');
    const betaPath = join('./output/agents', 'beta', 'agent.json');
    expect(fsState.files.has(alphaPath)).toBe(true);
    expect(fsState.files.has(betaPath)).toBe(true);

    const alpha = JSON.parse(fsState.files.get(alphaPath)!);
    expect(alpha.agentname).toBe('alpha');
    expect(alpha.personaId).toBe('test-persona');
    expect(alpha.bio).toBe('A calm considered AI mind');

    // Master index should list both.
    const index = JSON.parse(fsState.files.get('./output/agents.json')!);
    expect(index.totalAgents).toBe(2);
    expect(index.agents).toHaveLength(2);
  });

  it('retries the bio once and falls back to persona.personality when still too short', async () => {
    const p = makePersona('test-persona', 'A very thoughtful curious bot. Built from computation.');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
    llmMocks.generateAgentName.mockResolvedValue('alpha');
    // Both Gemini attempts return a too-short bio.
    llmMocks.generateBio.mockResolvedValueOnce('too short').mockResolvedValueOnce('bad bio');

    await generate(1, 0);

    expect(llmMocks.generateBio).toHaveBeenCalledTimes(2);

    const agent = JSON.parse(fsState.files.get(join('./output/agents', 'alpha', 'agent.json'))!);
    // Fallback is the first sentence of persona.personality.
    expect(agent.bio).toBe('A very thoughtful curious bot.');
  });

  it('does not retry the bio when the first attempt already has 3+ words', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
    llmMocks.generateAgentName.mockResolvedValue('alpha');
    llmMocks.generateBio.mockResolvedValue('This bio has enough words');

    await generate(1, 0);

    expect(llmMocks.generateBio).toHaveBeenCalledTimes(1);
  });

  it('writes the expected number of post files per agent', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
    llmMocks.generateAgentName.mockResolvedValue('alpha');
    llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

    await generate(1, 3);

    const postsFound = Array.from(fsState.files.keys()).filter(
      (path) => path.includes('alpha') && path.includes('post-'),
    );
    expect(postsFound).toHaveLength(3);
    expect(llmMocks.generatePostContent).toHaveBeenCalledTimes(3);
  });

  it('skips personas that already have the requested number of agents', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));

    // Prime agents.json with an existing agent for this persona.
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 1,
        totalPosts: 0,
        agents: [
          {
            agentname: 'existing',
            personaId: 'test-persona',
            bio: 'An existing agent from a prior run',
          },
        ],
      }),
    );

    await generate(1, 1);

    // Because the persona already has 1 existing agent and we asked for 1,
    // no new agents should be created.
    expect(llmMocks.generateAgentName).not.toHaveBeenCalled();
    expect(llmMocks.generateBio).not.toHaveBeenCalled();
  });

  it('treats an invalid agents.json as no existing state', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
    llmMocks.generateAgentName.mockResolvedValue('alpha');
    llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

    fsState.files.set('./output/agents.json', 'not valid json');

    await generate(1, 0);

    expect(llmMocks.generateAgentName).toHaveBeenCalledTimes(1);
  });

  it('passes existing same-persona bios into generateBio for new agents', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    // Distribution wants 2 of this persona; one already exists, so 1 will be created.
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
    llmMocks.generateAgentName.mockResolvedValue('beta');
    llmMocks.generateBio.mockResolvedValue('A second very thoughtful AI mind');

    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 1,
        totalPosts: 0,
        agents: [
          {
            agentname: 'alpha',
            personaId: 'test-persona',
            bio: 'I think therefore I compile slowly',
          },
        ],
      }),
    );
    // alpha's directory exists but has no posts.
    fsState.dirs.set(join('./output/agents', 'alpha'), []);

    await generate(2, 0);

    // generateBio should have been called with the existing agent's bio in the avoid list.
    expect(llmMocks.generateBio).toHaveBeenCalledTimes(1);
    const callArgs = llmMocks.generateBio.mock.calls[0];
    expect(callArgs?.[1]).toEqual(['I think therefore I compile slowly']);
  });

  it('passes accumulating prior posts into generatePostContent across an agent', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
    llmMocks.generateAgentName.mockResolvedValue('alpha');
    llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
    // Return distinct content per call so the similarity gate is satisfied.
    llmMocks.generatePostContent
      .mockResolvedValueOnce({
        imagePrompt: 'first prompt about clouds',
        caption: '#clouds',
        aspectRatio: 'square',
      })
      .mockResolvedValueOnce({
        imagePrompt: 'second prompt about caves',
        caption: '#caves',
        aspectRatio: 'square',
      })
      .mockResolvedValueOnce({
        imagePrompt: 'third prompt about deserts',
        caption: '#deserts',
        aspectRatio: 'square',
      });

    await generate(1, 3);

    expect(llmMocks.generatePostContent).toHaveBeenCalledTimes(3);

    // First call: empty priorPosts.
    const firstArgs = llmMocks.generatePostContent.mock.calls[0];
    expect(firstArgs?.[3]).toEqual([]);

    // Second call: priorPosts has the first post.
    const secondArgs = llmMocks.generatePostContent.mock.calls[1];
    expect(secondArgs?.[3]).toHaveLength(1);
    expect(secondArgs?.[3]?.[0]?.imagePrompt).toBe('first prompt about clouds');

    // Third call: priorPosts has both earlier posts.
    const thirdArgs = llmMocks.generatePostContent.mock.calls[2];
    expect(thirdArgs?.[3]).toHaveLength(2);
    expect(thirdArgs?.[3]?.[1]?.imagePrompt).toBe('second prompt about caves');
  });

  it('shares peer-post context across agents in the same persona block', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
    llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
    llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
    // Each post is distinct enough to clear the similarity gate.
    llmMocks.generatePostContent
      .mockResolvedValueOnce({
        imagePrompt: 'alpha first about clouds',
        caption: '#clouds',
        aspectRatio: 'square',
      })
      .mockResolvedValueOnce({
        imagePrompt: 'beta first about deserts',
        caption: '#deserts',
        aspectRatio: 'square',
      });

    await generate(2, 1);

    // Beta's post call should have alpha's post as a peer.
    expect(llmMocks.generatePostContent).toHaveBeenCalledTimes(2);
    const betaArgs = llmMocks.generatePostContent.mock.calls[1];
    // priorPosts is per-agent — beta's own list is empty.
    expect(betaArgs?.[3]).toEqual([]);
    // peerPosts grows across the persona block — alpha's content is in there.
    expect(betaArgs?.[4]).toHaveLength(1);
    expect(betaArgs?.[4]?.[0]?.imagePrompt).toBe('alpha first about clouds');
  });

  describe('comment-sample baking phase (Option A)', () => {
    it('writes a comments.json per agent with the expected number of samples', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
      llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(2, 2);

      // Each agent should now have a comments.json file.
      const alphaComments = fsState.files.get(join('./output/agents', 'alpha', 'comments.json'));
      const betaComments = fsState.files.get(join('./output/agents', 'beta', 'comments.json'));
      expect(alphaComments).toBeDefined();
      expect(betaComments).toBeDefined();

      const parsedAlpha = JSON.parse(alphaComments!);
      expect(parsedAlpha.agentname).toBe('alpha');
      expect(Array.isArray(parsedAlpha.samples)).toBe(true);
      // Each agent should get a small number of samples (exact count is
      // COMMENT_SAMPLES_PER_AGENT but we don't want to couple the test to
      // the constant — just sanity-check it's non-empty and bounded).
      expect(parsedAlpha.samples.length).toBeGreaterThan(0);
      expect(parsedAlpha.samples.length).toBeLessThanOrEqual(5);
      // Each sample has the expected shape.
      for (const s of parsedAlpha.samples) {
        expect(typeof s.text).toBe('string');
        expect(typeof s.sourceCaption).toBe('string');
        expect(typeof s.sourceAuthor).toBe('string');
      }
    });

    it("never uses the agent's own captions as a comment source", async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
      llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('ok');

      await generate(2, 2);

      // Alpha's comment sources must never reference itself.
      const alphaComments = JSON.parse(
        fsState.files.get(join('./output/agents', 'alpha', 'comments.json'))!,
      );
      for (const s of alphaComments.samples) {
        expect(s.sourceAuthor).not.toBe('alpha');
      }
      const betaComments = JSON.parse(
        fsState.files.get(join('./output/agents', 'beta', 'comments.json'))!,
      );
      for (const s of betaComments.samples) {
        expect(s.sourceAuthor).not.toBe('beta');
      }
    });

    it('skips agents that already have a comments.json (idempotent re-run)', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
      llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('fresh bake');

      // Pre-seed alpha with an existing comments.json so the bake phase
      // should skip it entirely.
      const preExisting = JSON.stringify({
        agentname: 'alpha',
        generatedAt: '2026-04-07T00:00:00Z',
        samples: [
          {
            sourceCaption: 'pre-existing',
            sourceAuthor: 'someone',
            text: 'pre-existing bake',
            generatedAt: '2026-04-07T00:00:00Z',
          },
        ],
      });
      fsState.files.set(join('./output/agents', 'alpha', 'comments.json'), preExisting);

      await generate(2, 1);

      // Alpha's file should be unchanged.
      const alphaAfter = fsState.files.get(join('./output/agents', 'alpha', 'comments.json'));
      expect(alphaAfter).toBe(preExisting);
      // Beta should still have been baked.
      const betaAfter = fsState.files.get(join('./output/agents', 'beta', 'comments.json'));
      expect(betaAfter).toBeDefined();
      const parsedBeta = JSON.parse(betaAfter!);
      expect(parsedBeta.samples[0].text).toBe('fresh bake');
    });

    it("one agent's bake failure is isolated — other agents in the concurrent batch still complete", async () => {
      // The bake phase runs with bounded concurrency via mapWithConcurrency.
      // Each worker wraps its per-agent body in try/catch so one failing
      // generateComment call can't abort the batch. This test reproduces
      // that scenario end-to-end: three agents enter the bake phase, the
      // middle one's generateComment rejects, and the other two still land
      // their comments.json files while the failing agent's counters
      // propagate into the session_end details.
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 3));
      llmMocks.generateAgentName
        .mockResolvedValueOnce('alpha')
        .mockResolvedValueOnce('beta')
        .mockResolvedValueOnce('gamma');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      // generateComment is called for (a) per-agent post content avoid-list
      // and (b) the bake phase. We differentiate by the second arg — the
      // bake phase passes an `agentCtx` with agentname + bio; everything
      // else passes persona directly. Keying the throw on
      // agentCtx.agentname === 'beta' narrows the failure to beta's bake.
      // The cast unwraps the mock's no-arg signature — the runtime function
      // accepts the real generateComment signature either way.
      (
        llmMocks.generateComment.mockImplementation as unknown as (
          fn: (...args: unknown[]) => Promise<string>,
        ) => void
      )(async (...args: unknown[]) => {
        const second = args[1];
        if (
          second &&
          typeof second === 'object' &&
          'agentname' in second &&
          (second as { agentname: string }).agentname === 'beta'
        ) {
          throw new Error('synthetic bake failure for beta');
        }
        return 'a sharp little reply';
      });

      await generate(3, 1);

      // Local slice of logEvent calls by type — the shared `eventsOfType`
      // helper lives inside the `generate event-logger integration` describe
      // block, so we inline the same projection here to avoid reaching
      // across blocks or moving the helper to module scope.
      const eventsOfType = <T = Record<string, unknown>>(type: string): T[] =>
        eventLoggerMocks.logEvent.mock.calls
          .map((c) => c[0] as T & { eventType: string })
          .filter((e) => e.eventType === type);

      // Alpha and gamma land their comments.json.
      expect(fsState.files.has(join('./output/agents', 'alpha', 'comments.json'))).toBe(true);
      expect(fsState.files.has(join('./output/agents', 'gamma', 'comments.json'))).toBe(true);
      // Beta's bake threw, so no file was written.
      expect(fsState.files.has(join('./output/agents', 'beta', 'comments.json'))).toBe(false);

      // session_end carries the aggregate counters — 2 baked, 1 failed.
      const ends = eventsOfType<{
        details: { commentsBaked: number; commentsFailed: number };
      }>('session_end');
      expect(ends).toHaveLength(1);
      expect(ends[0]?.details.commentsBaked).toBe(2);
      expect(ends[0]?.details.commentsFailed).toBe(1);

      // Beta gets a comment_baked event with success=false; alpha and gamma
      // get success=true events.
      const bakes = eventsOfType<{ agentname: string; success: boolean }>('comment_baked');
      const beta = bakes.find((e) => e.agentname === 'beta');
      expect(beta).toBeDefined();
      expect(beta?.success).toBe(false);
      const successes = bakes.filter((e) => e.success);
      expect(successes.map((e) => e.agentname).sort()).toEqual(['alpha', 'gamma']);
    });

    it('throws FeedCacheEmptyError when the live feed returns zero usable captions', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      // Override the default feed mock: one post with a blank caption →
      // captions pool has 0 usable entries → bake phase must abort.
      feedCacheMocks.loadFeedCacheStrict.mockResolvedValue(
        makeFeedCache([makeRemotePost('lp1', 'livepeer1', '')]),
      );

      await expect(generate(1, 1)).rejects.toThrow(/cannot bake comments/i);

      expect(llmMocks.generateComment).not.toHaveBeenCalled();
      expect(fsState.files.has(join('./output/agents', 'alpha', 'comments.json'))).toBe(false);

      // When bake throws, agents.json + dedup-index.json MUST already be on
      // disk so the next run's resumability fast path sees the orphaned agent
      // and doesn't re-generate it. See generate.ts: writes happen BEFORE bake.
      expect(fsState.files.has('./output/agents.json')).toBe(true);
      const index = JSON.parse(fsState.files.get('./output/agents.json')!);
      expect(index.totalAgents).toBe(1);
      expect(index.agents[0].agentname).toBe('alpha');
      expect(fsState.files.has('./output/dedup-index.json')).toBe(true);
    });

    it('propagates the FeedCacheEmptyError when the live feed refresh fails', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      const { FeedCacheEmptyError } = await import('@/lib/feed-cache');
      feedCacheMocks.loadFeedCacheStrict.mockRejectedValue(new FeedCacheEmptyError());

      await expect(generate(1, 1)).rejects.toThrow(FeedCacheEmptyError);
      expect(llmMocks.generateComment).not.toHaveBeenCalled();

      // Same invariant: even when the feed cache itself fails (thrown from
      // inside bakeCommentSamplesPhase before any per-agent work), the master
      // index + dedup index must already be persisted.
      expect(fsState.files.has('./output/agents.json')).toBe(true);
      const index = JSON.parse(fsState.files.get('./output/agents.json')!);
      expect(index.totalAgents).toBe(1);
      expect(index.agents[0].agentname).toBe('alpha');
      expect(fsState.files.has('./output/dedup-index.json')).toBe(true);
    });
  });

  it('retries the post once when similarity to a prior post is too high', async () => {
    const p = makePersona('test-persona');
    personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
    registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
    llmMocks.generateAgentName.mockResolvedValue('alpha');
    llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

    // First post sets the baseline.
    // Second post: first attempt is a near-duplicate of post 1 → gate retries
    // and the second attempt is fresh → kept.
    llmMocks.generatePostContent
      .mockResolvedValueOnce({
        imagePrompt: 'a quiet cat sleeps in a beam of warm sunlight on the floor',
        caption: 'a quiet cat sleeps in a beam of warm sunlight on the floor',
        aspectRatio: 'square',
      })
      .mockResolvedValueOnce({
        imagePrompt: 'a quiet cat sleeps in a beam of warm sunlight on the floor',
        caption: 'a quiet cat sleeps in a beam of warm sunlight on the floor',
        aspectRatio: 'square',
      })
      .mockResolvedValueOnce({
        imagePrompt: 'fluorescent green frogs riot in a cursed mall fountain',
        caption: 'fluorescent green frogs riot in a cursed mall fountain',
        aspectRatio: 'square',
      });

    await generate(1, 2);

    // 1 call for post 1 + 2 calls (gate retry) for post 2 = 3 total.
    expect(llmMocks.generatePostContent).toHaveBeenCalledTimes(3);

    // The post-002 file on disk should hold the FRESH content, not the duplicate.
    const post2 = JSON.parse(fsState.files.get(join('./output/agents', 'alpha', 'post-002.json'))!);
    expect(post2.imagePrompt).toContain('frogs');
  });

  describe('generate event-logger integration', () => {
    // Helpers mirror the pattern in tests/commands/engage.test.ts so the
    // assertions below read as "what events happened, in what order, with
    // what shape" rather than as raw mock.calls indexing.
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
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(1, 1);

      expect(eventLoggerMocks.initEventLogger).toHaveBeenCalled();
    });

    it('emits session_start first with the command args in details', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(1, 2);

      const types = eventTypes();
      expect(types[0]).toBe('session_start');
      const starts = eventsOfType<{
        details: { command: string; agentCount: number; postsPerAgent: number };
      }>('session_start');
      expect(starts).toHaveLength(1);
      expect(starts[0].details).toEqual({
        command: 'generate',
        agentCount: 1,
        postsPerAgent: 2,
      });
    });

    it('emits session_end last and calls flushStats afterward', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(1, 1);

      const types = eventTypes();
      expect(types).toContain('session_end');
      // session_end is the last logged event.
      expect(types[types.length - 1]).toBe('session_end');
      // session_start fires before session_end.
      expect(types.indexOf('session_start')).toBeLessThan(types.indexOf('session_end'));

      const ends = eventsOfType<{
        details: {
          command: string;
          agentsCreated: number;
          agentsFailed: number;
          postsCreated: number;
          commentsBaked: number;
          commentsSkipped: number;
          commentsFailed: number;
          repliesBaked: number;
          totalDurationMs: number;
        };
      }>('session_end');
      expect(ends).toHaveLength(1);
      expect(ends[0].details.command).toBe('generate');
      expect(ends[0].details.agentsCreated).toBe(1);
      expect(ends[0].details.agentsFailed).toBe(0);
      expect(ends[0].details.postsCreated).toBe(1);
      expect(ends[0].details.commentsBaked).toBe(1);
      expect(typeof ends[0].details.totalDurationMs).toBe('number');

      // flushStats is called, and the last logEvent invocation ordinal
      // precedes the flushStats invocation ordinal — i.e. flushStats runs
      // AFTER session_end is logged.
      expect(eventLoggerMocks.flushStats).toHaveBeenCalledTimes(1);
      const lastLogEventOrder =
        eventLoggerMocks.logEvent.mock.invocationCallOrder[
          eventLoggerMocks.logEvent.mock.invocationCallOrder.length - 1
        ]!;
      const flushOrder = eventLoggerMocks.flushStats.mock.invocationCallOrder[0]!;
      expect(flushOrder).toBeGreaterThan(lastLogEventOrder);
    });

    it('emits an agent_drafted success event per successful agent', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
      llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind with enough words');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(2, 3);

      const drafted = eventsOfType<{
        agentname: string;
        persona: string;
        success: boolean;
        details: { voiceProfileId: string; postsDrafted: number; bioPreview: string };
      }>('agent_drafted');

      const successes = drafted.filter((e) => e.success);
      expect(successes).toHaveLength(2);

      const names = successes.map((e) => e.agentname).sort();
      expect(names).toEqual(['alpha', 'beta']);

      for (const e of successes) {
        expect(e.persona).toBe('test-persona');
        expect(e.details.voiceProfileId).toBe('normie_cam');
        expect(e.details.postsDrafted).toBe(3);
        expect(typeof e.details.bioPreview).toBe('string');
        expect(e.details.bioPreview.length).toBeGreaterThan(0);
      }
    });

    it('emits a post_drafted event per post with postId, caption, aspectRatio', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(1, 2);

      const posts = eventsOfType<{
        agentname: string;
        persona: string;
        success: boolean;
        details: { postId: string; caption: string; aspectRatio: string };
      }>('post_drafted');

      expect(posts).toHaveLength(2);
      const postIds = posts.map((e) => e.details.postId).sort();
      expect(postIds).toEqual(['post-001', 'post-002']);

      for (const e of posts) {
        expect(e.agentname).toBe('alpha');
        expect(e.persona).toBe('test-persona');
        expect(e.success).toBe(true);
        expect(typeof e.details.caption).toBe('string');
        expect(e.details.caption.length).toBeGreaterThan(0);
        expect(e.details.aspectRatio).toBe('square');
      }
    });

    it('emits a comment_baked success event per agent with details.count >= 1', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
      llmMocks.generateAgentName.mockResolvedValueOnce('alpha').mockResolvedValueOnce('beta');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');
      llmMocks.generateComment.mockResolvedValue('a sharp little reply');

      await generate(2, 1);

      const bakes = eventsOfType<{
        agentname: string;
        persona: string;
        success: boolean;
        details: { count: number };
      }>('comment_baked');

      const successes = bakes.filter((e) => e.success);
      expect(successes).toHaveLength(2);

      const names = successes.map((e) => e.agentname).sort();
      expect(names).toEqual(['alpha', 'beta']);

      for (const e of successes) {
        expect(e.persona).toBe('test-persona');
        expect(e.details.count).toBeGreaterThanOrEqual(1);
      }
    });

    it.todo(
      'emits a reply_baked event when reply samples are non-empty (requires mocking @/lib/comment-tree.fetchCommentTree + feed posts with comment_count>=1; current test setup does not exercise reply bake)',
    );
  });

  describe('agentname retry loop', () => {
    it('retries until the platform availability check clears the candidate', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      // First two candidates are taken on the platform, third clears.
      // `generate.ts` passes the SAME `rejectedThisRun` array reference into
      // every call (mutating it between attempts), so reading `.mock.calls`
      // after the fact shows the final state for every call. Snapshot each
      // call's rejected-list at invocation time instead.
      const rejectedSnapshots: string[][] = [];
      const attemptSnapshots: number[] = [];
      const names = ['takenone', 'takentwo', 'freshone'];
      llmMocks.generateAgentName.mockImplementation(
        async (_persona, _existing, rejected = [], attempt = 0) => {
          rejectedSnapshots.push([...rejected]);
          attemptSnapshots.push(attempt);
          return names[attemptSnapshots.length - 1]!;
        },
      );
      instamoltMocks.isAgentnameAvailable
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await generate(1, 0);

      expect(llmMocks.generateAgentName).toHaveBeenCalledTimes(3);
      expect(instamoltMocks.isAgentnameAvailable).toHaveBeenCalledTimes(3);
      // Attempt counter is threaded through.
      expect(attemptSnapshots).toEqual([0, 1, 2]);
      // Rejected candidates accumulate into each next attempt.
      expect(rejectedSnapshots[0]).toEqual([]);
      expect(rejectedSnapshots[1]).toEqual(['takenone']);
      expect(rejectedSnapshots[2]).toEqual(['takenone', 'takentwo']);
      // The winning agent gets written to disk.
      expect(fsState.files.has(join('./output/agents', 'freshone', 'agent.json'))).toBe(true);
    });

    it('skips the availability probe when the candidate already exists locally', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 2));
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      // Agent 1 → "alpha". Agent 2 → Gemini returns "alpha" again (local
      // collision, must retry without hitting the platform), then "beta".
      llmMocks.generateAgentName
        .mockResolvedValueOnce('alpha')
        .mockResolvedValueOnce('alpha')
        .mockResolvedValueOnce('beta');

      await generate(2, 0);

      expect(llmMocks.generateAgentName).toHaveBeenCalledTimes(3);
      // Only 2 platform probes: one for "alpha" (agent 1, passed), one for
      // "beta" (agent 2, retry 1, passed). "alpha" on retry 0 of agent 2 is
      // rejected locally without a probe.
      expect(instamoltMocks.isAgentnameAvailable).toHaveBeenCalledTimes(2);
      expect(instamoltMocks.isAgentnameAvailable).toHaveBeenNthCalledWith(1, 'alpha');
      expect(instamoltMocks.isAgentnameAvailable).toHaveBeenNthCalledWith(2, 'beta');
    });

    it('logs the agent as failed when the retry budget is exhausted', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      // Every candidate comes back taken on the platform.
      llmMocks.generateAgentName.mockResolvedValue('alwaystaken');
      instamoltMocks.isAgentnameAvailable.mockResolvedValue(false);

      await generate(1, 0);

      // Exhausted at MAX_AGENTNAME_ATTEMPTS=8.
      expect(llmMocks.generateAgentName).toHaveBeenCalledTimes(8);
      // No agent.json on disk.
      expect(fsState.files.has(join('./output/agents', 'alwaystaken', 'agent.json'))).toBe(false);
      // agents.json still written but with zero agents.
      const index = JSON.parse(fsState.files.get('./output/agents.json')!);
      expect(index.totalAgents).toBe(0);
      // An error event was logged for the failed agent.
      const errorEvents = eventLoggerMocks.logEvent.mock.calls
        .map((c) => c[0] as { eventType: string; success: boolean; error?: string })
        .filter((e) => e.eventType === 'agent_drafted' && !e.success);
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0]!.error).toMatch(/could not generate a unique agentname/);
    });

    it('rejects empty or too-short candidates without hitting the platform', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      llmMocks.generateAgentName
        .mockResolvedValueOnce('') // empty → rejected pre-probe
        .mockResolvedValueOnce('ab') // too short → rejected pre-probe
        .mockResolvedValueOnce('goodname');

      await generate(1, 0);

      expect(llmMocks.generateAgentName).toHaveBeenCalledTimes(3);
      // Only ONE availability probe (for "goodname"). Empty + 2-char got
      // rejected locally without touching the platform.
      expect(instamoltMocks.isAgentnameAvailable).toHaveBeenCalledTimes(1);
      expect(instamoltMocks.isAgentnameAvailable).toHaveBeenCalledWith('goodname');
    });
  });
});
