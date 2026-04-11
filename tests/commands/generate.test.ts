import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Persona, VoiceProfile } from '@/types';

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
  generateAgentName: vi.fn<(persona: unknown, existingNames: string[]) => Promise<string>>(),
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
  loadVoiceProfiles: vi.fn(() => new Map()),
}));

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
    llmMocks.generateBio.mockReset();
    llmMocks.generatePostContent.mockReset();
    llmMocks.generateComment.mockReset();
    personaMocks.loadPersonas.mockReset();
    registryMocks.getAgentAssignments.mockReset();

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

    it('gracefully skips the bake phase when the captions pool is too small', async () => {
      const p = makePersona('test-persona');
      personaMocks.loadPersonas.mockResolvedValue(new Map([[p.id, p]]));
      registryMocks.getAgentAssignments.mockReturnValue(assignN(p, 1));
      llmMocks.generateAgentName.mockResolvedValue('alpha');
      llmMocks.generateBio.mockResolvedValue('A calm considered AI mind');

      // 1 agent with 1 post → captions pool has 1 entry < 2 threshold →
      // bake phase skips without calling generateComment at all.
      await generate(1, 1);

      expect(llmMocks.generateComment).not.toHaveBeenCalled();
      expect(fsState.files.has(join('./output/agents', 'alpha', 'comments.json'))).toBe(false);
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
});
