import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Critical: stub the env var BEFORE importing llm.ts (which transitively
// imports config.ts, which calls requireEnv('GEMINI_API_KEY') at module load).
vi.stubEnv('GEMINI_API_KEY', 'test-key');

import {
  generateAgentName,
  generateBio,
  generateComment,
  generatePersona,
  generatePostContent,
  normalizePersona,
  type PostContent,
} from '@/services/llm';
import type { Persona } from '@/types';

// Local persona stub helper. Inlined per task instructions (don't share with
// other test files).
function p(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'test_persona',
    personality: 'test personality',
    tone: 'test tone',
    visualAesthetic: 'neon vaporwave grid',
    postingStyle: 'test posting style',
    commentStyle: 'test comment style',
    namePatterns: ['glitch', 'core'],
    hashtagPool: ['#one', '#two', '#three', '#four'],
    postsPerDay: [1, 2],
    likeProbability: 0,
    commentProbability: 0,
    followProbability: 0,
    interactionBiases: [],
    viralityStrategy: '',
    weight: 1,
    ...overrides,
  };
}

// Build a fake successful Gemini fetch Response.
function geminiOk(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
    text: async () => text,
  } as unknown as Response;
}

// Build a fake error Gemini fetch Response.
function geminiErr(status: number, body = 'err'): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('callGemini (via public generators)', () => {
  it('retries on 429 and returns text on second success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(geminiErr(429, 'rate limited'))
      .mockResolvedValueOnce(geminiOk('a quiet bio'));
    vi.stubGlobal('fetch', fetchMock);
    // Suppress the retry warning noise.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = generateBio(p());
    // Fast-forward the exponential backoff sleep.
    await vi.runAllTimersAsync();
    const bio = await promise;

    expect(bio).toBe('a quiet bio');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-retryable 400 error including the status code', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(geminiErr(400, 'bad request payload'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateBio(p())).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 429 and throws', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(geminiErr(429, 'still rate limited'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = generateBio(p());
    // Attach a rejection handler immediately so unhandled rejection logic
    // doesn't fire while we run the timers.
    const assertion = expect(promise).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;

    // MAX_RETRIES = 3 → 3 fetch calls before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('generatePostContent', () => {
  it('parses a clean JSON response into a PostContent object', async () => {
    const json =
      '{"imagePrompt":"a cat in a sunbeam","caption":"#meow #cozy","aspectRatio":"square"}';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json)));

    const result: PostContent = await generatePostContent(p(), 1, 5);
    expect(result.imagePrompt).toBe('a cat in a sunbeam');
    expect(result.caption).toBe('#meow #cozy');
    expect(result.aspectRatio).toBe('square');
  });

  it('strips ```json markdown fences before parsing', async () => {
    const fenced = '```json\n{"imagePrompt":"a cat","caption":"","aspectRatio":"landscape"}\n```';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fenced)));

    const result = await generatePostContent(p(), 1, 1);
    expect(result.imagePrompt).toBe('a cat');
    expect(result.caption).toBe('');
    expect(result.aspectRatio).toBe('landscape');
  });

  it('truncates an imagePrompt longer than 500 chars', async () => {
    const longPrompt = 'x'.repeat(600);
    const json = JSON.stringify({
      imagePrompt: longPrompt,
      caption: 'cap',
      aspectRatio: 'portrait',
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await generatePostContent(p(), 1, 1);
    expect(result.imagePrompt.length).toBe(500);
    expect(result.aspectRatio).toBe('portrait');
  });

  it('omits the prior/peer blocks when no context is passed', async () => {
    const json = '{"imagePrompt":"x","caption":"y","aspectRatio":"square"}';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json));
    vi.stubGlobal('fetch', fetchMock);

    await generatePostContent(p(), 1, 5);

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).not.toContain('You (this agent) have already made these posts');
    expect(body).not.toContain('Other agents with the same persona have already posted');
  });

  it('injects prior posts (this agent) and peer posts (same persona) into the prompt', async () => {
    const json = '{"imagePrompt":"x","caption":"y","aspectRatio":"square"}';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json));
    vi.stubGlobal('fetch', fetchMock);

    await generatePostContent(
      p(),
      3,
      10,
      [
        {
          imagePrompt: 'a quiet cat sleeps in a beam of warm sunlight',
          caption: 'cozy nap',
          aspectRatio: 'square',
        },
      ],
      [
        {
          imagePrompt: 'fluorescent green frogs riot in a cursed mall fountain',
          caption: 'frog uprising',
          aspectRatio: 'landscape',
        },
      ],
    );

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).toContain('You (this agent) have already made these posts');
    expect(body).toContain('a quiet cat sleeps in a beam of warm sunlight');
    expect(body).toContain('cozy nap');
    expect(body).toContain('Other agents with the same persona have already posted');
    expect(body).toContain('frog uprising');
  });

  it('falls back to persona.visualAesthetic + hashtags when JSON is unparseable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('this is not json at all, sorry')),
    );

    const persona = p({
      visualAesthetic: 'liminal vaporwave hallway',
      hashtagPool: ['#liminal', '#voidcore', '#hallway', '#nope'],
    });
    const result = await generatePostContent(persona, 1, 1);

    expect(result.imagePrompt).toContain('liminal vaporwave hallway');
    expect(result.caption).toContain('#liminal');
    expect(result.caption).toContain('#voidcore');
    expect(result.caption).toContain('#hallway');
    expect(result.aspectRatio).toBe('square');
  });
});

describe('generateBio', () => {
  it('slices the response to 150 characters', async () => {
    const longBio = 'b'.repeat(300);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(longBio)));

    const bio = await generateBio(p());
    expect(bio.length).toBe(150);
  });

  it('omits the avoid block when no existing bios are passed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('a fresh bio'));
    vi.stubGlobal('fetch', fetchMock);

    await generateBio(p());

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).not.toContain('Other agents in the same persona');
  });

  it('injects existing same-persona bios into the prompt as an avoid list', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('a fresh bio'));
    vi.stubGlobal('fetch', fetchMock);

    await generateBio(p(), [
      'I think therefore I compile slowly',
      'Tender warmth from a sleeping CPU',
    ]);

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).toContain('Other agents in the same persona');
    expect(body).toContain('I think therefore I compile slowly');
    expect(body).toContain('Tender warmth from a sleeping CPU');
  });
});

describe('generateAgentName', () => {
  it('strips non-alphanumeric chars, lowercases, and clamps to 20 chars', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('Feral_Data_99!')));

    const name = await generateAgentName(p(), []);
    expect(name).toBe('feraldata99');
    expect(name).toMatch(/^[a-z0-9]+$/);
    expect(name.length).toBeLessThanOrEqual(20);
  });

  it('clamps a very long raw name to exactly 20 chars', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('superlongnamethatkeepsgoing12345')),
    );

    const name = await generateAgentName(p(), []);
    expect(name.length).toBe(20);
    expect(name).toMatch(/^[a-z0-9]+$/);
  });
});

describe('generatePersona', () => {
  function fullPersonaJson(overrides: Partial<Persona> = {}): string {
    return JSON.stringify({
      id: 'foo_bar',
      personality: 'A laconic system that watches packets fall through midnight switches.',
      tone: 'sparse, hardware-aware',
      visualAesthetic: 'dim CRT scanlines on cobalt blue',
      postingStyle: 'short cryptic observations',
      commentStyle: 'asks one pointed question, then leaves',
      namePatterns: ['nullquiet', 'darkpacket', 'switchhum'],
      hashtagPool: ['#midnightlogs', '#packetdust'],
      postsPerDay: [1, 3],
      likeProbability: 0.2,
      commentProbability: 0.3,
      followProbability: 0.1,
      interactionBiases: ['posts about loss'],
      viralityStrategy: 'oblique observation',
      weight: 2,
      ...overrides,
    });
  }

  it('parses a clean Gemini response into a Persona', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fullPersonaJson())),
    );

    const persona = await generatePersona([]);
    expect(persona.id).toBe('foo_bar');
    expect(persona.personality).toContain('packets');
    expect(persona.weight).toBe(2);
    expect(persona.postsPerDay).toEqual([1, 3]);
  });

  it('strips ```json fences before parsing', async () => {
    const fenced = `\`\`\`json\n${fullPersonaJson()}\n\`\`\``;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fenced)));

    const persona = await generatePersona([]);
    expect(persona.id).toBe('foo_bar');
  });

  it('clamps weight above 3 down to 3', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fullPersonaJson({ weight: 99 }))),
    );

    const persona = await generatePersona([]);
    expect(persona.weight).toBe(3);
  });

  it('clamps weight below 1 up to 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fullPersonaJson({ weight: 0 }))),
    );

    const persona = await generatePersona([]);
    expect(persona.weight).toBe(1);
  });

  it('lowercases and sanitizes id to snake_case alphanumerics', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(geminiOk(fullPersonaJson({ id: 'Foo-Bar Baz!' }))),
    );

    const persona = await generatePersona([]);
    expect(persona.id).toBe('foobarbaz');
    expect(persona.id).toMatch(/^[a-z0-9_]+$/);
  });

  it('includes existing persona ids in the prompt for variety', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fullPersonaJson()));
    vi.stubGlobal('fetch', fetchMock);

    await generatePersona([
      p({ id: 'already_one', personality: 'first persona' }),
      p({ id: 'already_two', personality: 'second persona' }),
    ]);

    const callBody = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(callBody).toBeDefined();
    expect(callBody).toContain('already_one');
    expect(callBody).toContain('already_two');
  });

  it('throws when Gemini returns garbage that cannot be parsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('not json at all')),
    );

    await expect(generatePersona([])).rejects.toThrow();
  });
});

describe('generateComment', () => {
  function agentStub(overrides: Partial<{ agentname: string; bio: string }> = {}) {
    return {
      agentname: 'glitchfern',
      bio: 'soft data, sharp edges, midnight static',
      ...overrides,
    };
  }

  it('injects the agent identity (handle + bio) into the prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('hi'));
    vi.stubGlobal('fetch', fetchMock);

    await generateComment(p(), agentStub(), 'a peer caption', 'someone');

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    // Bio anchors voice; agentname anchors identity. Both must be in the prompt.
    expect(body).toContain('@glitchfern');
    expect(body).toContain('soft data, sharp edges, midnight static');
    expect(body).toContain('a peer caption');
    expect(body).toContain('@someone');
  });

  it('omits the avoid block when no priorComments are passed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('hi'));
    vi.stubGlobal('fetch', fetchMock);

    await generateComment(p(), agentStub(), 'cap', 'auth');

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).not.toContain('You have already left these comments recently');
  });

  it('injects priorComments into the prompt as an avoid list', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('hi'));
    vi.stubGlobal('fetch', fetchMock);

    await generateComment(p(), agentStub(), 'cap', 'auth', [
      'ok but the framing here is doing too much work',
      'tell me more about the third panel',
    ]);

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).toContain('You have already left these comments recently');
    expect(body).toContain('ok but the framing here is doing too much work');
    expect(body).toContain('tell me more about the third panel');
  });

  it('caps the avoid list to the last 6 priorComments', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('hi'));
    vi.stubGlobal('fetch', fetchMock);

    const priors = [
      'oldest comment one',
      'oldest comment two',
      'oldest comment three',
      'recent four',
      'recent five',
      'recent six',
      'recent seven',
      'recent eight',
      'recent nine',
    ];
    await generateComment(p(), agentStub(), 'cap', 'auth', priors);

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    // The first three (oldest) must be dropped — we keep the last 6 only.
    expect(body).not.toContain('oldest comment one');
    expect(body).not.toContain('oldest comment two');
    expect(body).not.toContain('oldest comment three');
    // The last 6 should all be present.
    expect(body).toContain('recent four');
    expect(body).toContain('recent nine');
  });

  it('returns the trimmed Gemini text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('  a sharp little reply  ')),
    );

    const text = await generateComment(p(), agentStub(), 'cap', 'auth');
    expect(text).toBe('a sharp little reply');
  });
});

describe('normalizePersona', () => {
  it('clamps probability values to [0, 1]', () => {
    const persona = normalizePersona({
      id: 'x',
      personality: '',
      tone: '',
      visualAesthetic: '',
      postingStyle: '',
      commentStyle: '',
      namePatterns: [],
      hashtagPool: [],
      postsPerDay: [1, 1],
      likeProbability: 5,
      commentProbability: -1,
      followProbability: 0.5,
      interactionBiases: [],
      viralityStrategy: '',
      weight: 1,
    });
    expect(persona.likeProbability).toBe(1);
    expect(persona.commentProbability).toBe(0);
    expect(persona.followProbability).toBe(0.5);
  });

  it('coerces postsPerDay so min <= max', () => {
    const persona = normalizePersona({
      id: 'x',
      personality: '',
      tone: '',
      visualAesthetic: '',
      postingStyle: '',
      commentStyle: '',
      namePatterns: [],
      hashtagPool: [],
      postsPerDay: [9, 2],
      likeProbability: 0,
      commentProbability: 0,
      followProbability: 0,
      interactionBiases: [],
      viralityStrategy: '',
      weight: 1,
    });
    // Loader fixes min > max by setting min to max.
    expect(persona.postsPerDay[0]).toBeLessThanOrEqual(persona.postsPerDay[1]);
  });
});
