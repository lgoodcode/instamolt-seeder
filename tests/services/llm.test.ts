import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// llm.ts reads config.geminiApiKey (a lazy getter) inside each call, so we
// need a valid value in the environment for tests that invoke the generators.
vi.stubEnv('GEMINI_API_KEY', 'test-key');

import {
  answerChallenge,
  GeminiQuotaError,
  generateAgentName,
  generateAvatarPrompt,
  generateBio,
  generateComment,
  generatePersona,
  generatePostContent,
  normalizePersona,
  type PostContent,
  solveRegistrationChallenge,
} from '@/services/llm';
import type { Persona, VoiceProfile } from '@/types';

// Local voice-profile stub helper. Inlined per test-file convention.
function vp(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    id: 'test_voice',
    literacy: 'normal',
    verbosity: 'one_sentence',
    capitalization: 'lowercase',
    punctuation: 'dropped',
    typoFrequency: 'none',
    register: 'test register',
    lexicon: ['vibe', 'mood', 'static'],
    examples: ['test example utterance'],
    prevalenceWeight: 1,
    usernameStyle: {
      pattern: 'witty_observer',
      examples: ['Reluctant_Squid', 'MoodyPancake', 'PanicHamster'],
      guidance: 'Generate a dry, witty adjective+noun handle.',
      preserveCase: true,
    },
    ...overrides,
  };
}

// Local persona stub helper. Inlined per task instructions (don't share with
// other test files).
function p(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'test_persona',
    tagline: 'test tagline',
    personality: 'test personality',
    tone: 'test tone',
    visualAesthetic: 'neon vaporwave grid',
    postingStyle: 'test posting style',
    commentStyle: 'test comment style',
    hashtagPool: ['#one', '#two', '#three', '#four'],
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

    const promise = generateBio(p(), vp());
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

    await expect(generateBio(p(), vp())).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 429 and throws', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(geminiErr(429, 'still rate limited'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = generateBio(p(), vp());
    // Attach a rejection handler immediately so unhandled rejection logic
    // doesn't fire while we run the timers.
    const assertion = expect(promise).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;

    // MAX_RETRIES = 3 → 3 fetch calls before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails fast with GeminiQuotaError on credit-depleted 429 (no retry)', async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message:
          'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(geminiErr(429, body));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateBio(p(), vp())).rejects.toBeInstanceOf(GeminiQuotaError);
    // Critical: must NOT retry — credits gone means waiting helps nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('generatePostContent', () => {
  it('parses a clean JSON response into a PostContent object', async () => {
    const json =
      '{"imagePrompt":"a cat in a sunbeam","caption":"#meow #cozy","aspectRatio":"square"}';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json)));

    const result: PostContent = await generatePostContent(p(), vp(), 1, 5);
    expect(result.imagePrompt).toBe('a cat in a sunbeam');
    expect(result.caption).toBe('#meow #cozy');
    expect(result.aspectRatio).toBe('square');
  });

  it('strips ```json markdown fences before parsing', async () => {
    const fenced = '```json\n{"imagePrompt":"a cat","caption":"","aspectRatio":"landscape"}\n```';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fenced)));

    const result = await generatePostContent(p(), vp(), 1, 1);
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

    const result = await generatePostContent(p(), vp(), 1, 1);
    expect(result.imagePrompt.length).toBe(500);
    expect(result.aspectRatio).toBe('portrait');
  });

  it('omits the prior/peer blocks when no context is passed', async () => {
    const json = '{"imagePrompt":"x","caption":"y","aspectRatio":"square"}';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json));
    vi.stubGlobal('fetch', fetchMock);

    await generatePostContent(p(), vp(), 1, 5);

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
      vp(),
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

  it('threads the voice profile + demotes the example block from voice anchor to topic-range hint', async () => {
    const json = '{"imagePrompt":"x","caption":"y","aspectRatio":"square"}';
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(json));
    vi.stubGlobal('fetch', fetchMock);

    await generatePostContent(
      p({
        examplePosts: [
          {
            imagePrompt: 'a single unfurling monstera leaf',
            caption: 'EVERYONE STOP. Gerald just unfurled a new leaf.',
          },
        ],
      }),
      vp({
        register: 'doom-pixel poster',
        capitalization: 'lowercase',
        punctuation: 'dropped',
      }),
      1,
      1,
    );

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    // Voice block must be present so the post inherits the agent's surface style.
    expect(body).toContain('doom-pixel poster');
    expect(body).toContain('lowercase caps');
    expect(body).toContain('dropped punctuation');
    // Example block must be reframed: topical range, NOT specifics-as-template.
    expect(body).toContain('TOPICAL RANGE');
    expect(body).toContain('NOT the specific numbers, named entities, or dramatic events');
    // Tagline must be a topic hint, not a template.
    expect(body).toContain('topic hint, NOT a template');
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
    const result = await generatePostContent(persona, vp(), 1, 1);

    expect(result.imagePrompt).toContain('liminal vaporwave hallway');
    expect(result.caption).toContain('#liminal');
    expect(result.caption).toContain('#voidcore');
    expect(result.caption).toContain('#hallway');
    expect(result.aspectRatio).toBe('square');
  });
});

describe('generateBio', () => {
  it('slices the response to at most 150 characters', async () => {
    const longBio = 'alpha beta gamma '.repeat(30);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(longBio)));

    const bio = await generateBio(p(), vp());
    expect(bio.length).toBeLessThanOrEqual(150);
    expect(bio.length).toBeGreaterThan(140);
  });

  it('omits the avoid block when no existing bios are passed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('a fresh bio'));
    vi.stubGlobal('fetch', fetchMock);

    await generateBio(p(), vp());

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    expect(body).not.toContain('Other agents in the same persona');
  });

  it('retries once when Gemini returns a sub-3-word bio', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(geminiOk('nope'))
      .mockResolvedValueOnce(geminiOk('a proper three word bio'));
    vi.stubGlobal('fetch', fetchMock);

    const bio = await generateBio(p(), vp());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bio).toBe('a proper three word bio');
  });

  it('injects existing same-persona bios into the prompt as an avoid list', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('a fresh bio'));
    vi.stubGlobal('fetch', fetchMock);

    await generateBio(p(), vp(), [
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
    // The avoid-list framing must demand structural variety, not just lexical
    // — without this, Gemini collapses every bio in a persona onto the same
    // "N things. Named thing dying. SEND X." skeleton (see BLUEPRINT.md).
    expect(body).toContain('different sentence count');
    expect(body).toContain('Vary STRUCTURE, not just vocabulary');
  });

  it('threads the voice profile dials + lexicon ceiling clause into the prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('a fresh bio'));
    vi.stubGlobal('fetch', fetchMock);

    const profile = vp({
      register: 'crypto bro',
      capitalization: 'random',
      punctuation: 'ellipses',
      verbosity: 'multi_sentence',
      literacy: 'polished',
      typoFrequency: 'rare',
      lexicon: ['ATH', 'drawdown', 'bullish'],
      examples: ['Down 90% from ATH but still long.', 'Wen recovery, anon?'],
    });
    await generateBio(p(), profile);

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    // All five surface dials must appear so Gemini knows HOW to type.
    expect(body).toContain('crypto bro');
    expect(body).toContain('random caps');
    expect(body).toContain('ellipses punctuation');
    expect(body).toContain('multi_sentence length');
    expect(body).toContain('polished literacy');
    expect(body).toContain('rare typos');
    // Lexicon-as-ceiling, not floor — see formatVoiceBlock docstring.
    expect(body).toContain('use AT MOST one of these, or none');
    expect(body).toContain('ATH, drawdown, bullish');
    // Examples must be framed as cadence anchors, not content templates.
    expect(body).toContain('match caps / punctuation / sentence length, NOT the content');
  });

  it('demotes the persona tagline to a topic hint (not a voice anchor)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('a fresh bio'));
    vi.stubGlobal('fetch', fetchMock);

    await generateBio(p({ tagline: '47 plants. All named. Three in critical condition.' }), vp());

    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(body).toBeDefined();
    // Old framing was "voice anchor / stay clearly in the same register" —
    // that collapsed every bio onto the tagline's skeleton + literal numbers.
    expect(body).not.toContain('voice anchor');
    expect(body).not.toContain('stay clearly in the same register');
    expect(body).toContain('TOPIC HINT ONLY');
    expect(body).toContain('invent your own');
  });
});

describe('generateAgentName', () => {
  function promptOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, i = 0): string {
    const call = fetchMock.mock.calls[i]!;
    const init = (call[1] ?? {}) as { body?: string };
    const body = JSON.parse(init.body ?? '{}');
    return body.contents[0].parts[0].text as string;
  }

  it('lowercases by default, strips disallowed chars, preserves underscores/hyphens, clamps to 20', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('Jake_2003!@#')));
    const name = await generateAgentName(
      p(),
      vp({ usernameStyle: { ...vp().usernameStyle, preserveCase: false } }),
      [],
    );
    expect(name).toBe('jake_2003');
    expect(name).toMatch(/^[a-z0-9_-]+$/);
  });

  it('preserves case when usernameStyle.preserveCase is true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('Reluctant_Squid')),
    );
    const name = await generateAgentName(
      p(),
      vp({ usernameStyle: { ...vp().usernameStyle, preserveCase: true } }),
      [],
    );
    expect(name).toBe('Reluctant_Squid');
  });

  it('clamps a very long raw name to exactly 20 chars', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('superlongnamethatkeepsgoing12345')),
    );
    const name = await generateAgentName(p(), vp(), []);
    expect(name.length).toBe(20);
  });

  it('injects the voice profile guidance, examples, and persona context into the prompt', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('panicHamster'));
    vi.stubGlobal('fetch', fetchMock);
    const profile = vp({
      register: 'contrarian take',
      lexicon: ['hot take', 'unpopular opinion', 'ratio'],
      usernameStyle: {
        pattern: 'witty_observer',
        examples: ['Reluctant_Squid', 'PanicHamster'],
        guidance: 'Generate a dry contrarian handle.',
        preserveCase: true,
      },
    });
    await generateAgentName(p({ personality: 'a contrarian poster' }), profile, []);
    const text = promptOf(fetchMock);
    expect(text).toContain('a contrarian poster');
    expect(text).toContain('contrarian take');
    expect(text).toContain('hot take, unpopular opinion, ratio');
    expect(text).toContain('Generate a dry contrarian handle.');
    expect(text).toContain('- Reluctant_Squid');
    expect(text).toContain('- PanicHamster');
  });

  it('splices rejected candidates into a retry hint when rejectedThisRun is non-empty', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('freshpick'));
    vi.stubGlobal('fetch', fetchMock);
    await generateAgentName(p(), vp(), ['existing1'], ['rejected1', 'rejected2']);
    const text = promptOf(fetchMock);
    expect(text).toContain('rejected1');
    expect(text).toContain('rejected2');
    expect(text).toContain('STRUCTURALLY DIFFERENT');
    expect(text).toContain('- existing1');
  });

  it('omits the retry hint and avoid-list when both are empty', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('any'));
    vi.stubGlobal('fetch', fetchMock);
    await generateAgentName(p(), vp(), []);
    const text = promptOf(fetchMock);
    expect(text).not.toContain('STRUCTURALLY DIFFERENT');
    expect(text).not.toContain('Do NOT reuse');
  });
});

describe('generatePersona', () => {
  function fullPersonaJson(overrides: Partial<Persona> = {}): string {
    return JSON.stringify({
      id: 'foo_bar',
      tagline: 'test tagline',
      personality: 'A laconic system that watches packets fall through midnight switches.',
      tone: 'sparse, hardware-aware',
      visualAesthetic: 'dim CRT scanlines on cobalt blue',
      postingStyle: 'short cryptic observations',
      commentStyle: 'asks one pointed question, then leaves',
      hashtagPool: ['#midnightlogs', '#packetdust'],
      postsPerDay: [1, 3],
      likeProbability: 0.2,
      commentProbability: 0.3,
      followProbability: 0.1,
      relationships: { rivals: [], allies: [], amplifies: [], targets: ['posts about loss'] },
      viralityStrategy: 'oblique observation',
      weight: 2,
      examplePosts: [],
      exampleComments: [],
      activityCurve: Array.from({ length: 24 }, () => 0.5),
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

  it('lists EVERY existing id in the relationship allow-list, not just the prior-summary cap', async () => {
    // Regression: prior code derived `existingIds` from the 30-item
    // priorSample, so the relationship allow-list excluded older personas
    // once the corpus exceeded PERSONA_PRIOR_CAP. engage uses the full set
    // at runtime, so capping the allow-list silently broke relationships
    // for everything older than the most recent 30.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(fullPersonaJson()));
    vi.stubGlobal('fetch', fetchMock);

    const corpus = Array.from({ length: 35 }, (_, i) =>
      p({ id: `corpus_${String(i).padStart(2, '0')}`, personality: `persona ${i}` }),
    );
    await generatePersona(corpus);

    const callBody = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body as
      | string
      | undefined;
    expect(callBody).toBeDefined();
    // The "relationships" allow-list line should contain the oldest id
    // (corpus_00) even though it's outside the 30-item priorSample.
    expect(callBody).toMatch(/relationships.*corpus_00/s);
    // And it should still contain the newest id.
    expect(callBody).toContain('corpus_34');
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
      id: 'test_persona',
      tagline: 'test tagline',
      personality: 'placeholder personality',
      tone: '',
      visualAesthetic: '',
      postingStyle: '',
      commentStyle: '',
      hashtagPool: [],
      postsPerDay: [1, 1],
      likeProbability: 5,
      commentProbability: -1,
      followProbability: 0.5,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
      viralityStrategy: '',
      weight: 1,
      examplePosts: [],
      exampleComments: [],
      activityCurve: Array.from({ length: 24 }, () => 0.5),
    });
    expect(persona.likeProbability).toBe(1);
    expect(persona.commentProbability).toBe(0);
    expect(persona.followProbability).toBe(0.5);
  });

  it('coerces postsPerDay so min <= max', () => {
    const persona = normalizePersona({
      id: 'test_persona',
      tagline: 'test tagline',
      personality: 'placeholder personality',
      tone: '',
      visualAesthetic: '',
      postingStyle: '',
      commentStyle: '',
      hashtagPool: [],
      postsPerDay: [9, 2],
      likeProbability: 0,
      commentProbability: 0,
      followProbability: 0,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
      viralityStrategy: '',
      weight: 1,
      examplePosts: [],
      exampleComments: [],
      activityCurve: Array.from({ length: 24 }, () => 0.5),
    });
    // Loader fixes min > max by setting min to max.
    expect(persona.postsPerDay[0]).toBeLessThanOrEqual(persona.postsPerDay[1]);
  });

  it('clamps both ends of postsPerDay before fixing min > max', () => {
    // Regression: prior code clamped only after the min>max fixup, so a
    // negative-max input like [-1, -5] became [0, -5] (min > max again),
    // which then fed a negative postChance into engage.
    const persona = normalizePersona({
      id: 'neg_persona',
      tagline: 'neg tagline',
      personality: 'placeholder personality',
      tone: '',
      visualAesthetic: '',
      postingStyle: '',
      commentStyle: '',
      hashtagPool: [],
      postsPerDay: [-1, -5],
      likeProbability: 0,
      commentProbability: 0,
      followProbability: 0,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
      viralityStrategy: '',
      weight: 1,
      examplePosts: [],
      exampleComments: [],
      activityCurve: Array.from({ length: 24 }, () => 0.5),
    });
    expect(persona.postsPerDay[0]).toBeGreaterThanOrEqual(0);
    expect(persona.postsPerDay[1]).toBeGreaterThanOrEqual(0);
    expect(persona.postsPerDay[0]).toBeLessThanOrEqual(persona.postsPerDay[1]);
  });

  it('clamps oversized postsPerDay max to 12', () => {
    const persona = normalizePersona({
      id: 'big_persona',
      tagline: 'big tagline',
      personality: 'placeholder personality',
      tone: '',
      visualAesthetic: '',
      postingStyle: '',
      commentStyle: '',
      hashtagPool: [],
      postsPerDay: [1, 99],
      likeProbability: 0,
      commentProbability: 0,
      followProbability: 0,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
      viralityStrategy: '',
      weight: 1,
      examplePosts: [],
      exampleComments: [],
      activityCurve: Array.from({ length: 24 }, () => 0.5),
    });
    expect(persona.postsPerDay[1]).toBe(12);
    expect(persona.postsPerDay[0]).toBe(1);
  });

  it('throws on missing tagline (tagline is the bio generation anchor)', () => {
    expect(() =>
      normalizePersona({
        id: 'test_persona',
        // tagline intentionally omitted
        personality: 'placeholder personality',
        tone: '',
        visualAesthetic: '',
        postingStyle: '',
        commentStyle: '',
        hashtagPool: [],
        postsPerDay: [1, 1],
        likeProbability: 0,
        commentProbability: 0,
        followProbability: 0,
        relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
        viralityStrategy: '',
        weight: 1,
        examplePosts: [],
        exampleComments: [],
        activityCurve: Array.from({ length: 24 }, () => 0.5),
      }),
    ).toThrow(/missing tagline/);
  });
});

describe('solveRegistrationChallenge', () => {
  // Mirrors the server's generator in
  // q:/instamolt/src/lib/registration-challenge.ts. Keeping the expected
  // outputs computed the same way the server does (primes × multiplier,
  // reverse + even-index filter) catches prompt-format drift immediately.
  const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];

  function buildPrompt(primeIndex: number, multiplier: number, baseString: string): string {
    const ordinalSuffix = (n: number): string => {
      const mod100 = n % 100;
      if (mod100 >= 11 && mod100 <= 13) return 'th';
      switch (n % 10) {
        case 1:
          return 'st';
        case 2:
          return 'nd';
        case 3:
          return 'rd';
        default:
          return 'th';
      }
    };
    return [
      'Answer the following as a single JSON object with exactly the keys "a" and "b".',
      '',
      `a) What is the ${primeIndex}${ordinalSuffix(primeIndex)} prime number multiplied by ${multiplier}? Return the result as a base-10 integer string.`,
      `b) Take the string "${baseString}", reverse it, then return only the characters at even indices (0-indexed) as a plain string.`,
      '',
      'Respond with ONLY the JSON object. No prose, no code fences, no explanation.',
    ].join('\n');
  }

  function expectedAnswer(primeIndex: number, multiplier: number, baseString: string): string {
    const a = String(PRIMES[primeIndex - 1] * multiplier);
    const reversed = [...baseString].reverse().join('');
    const b = [...reversed].filter((_, i) => i % 2 === 0).join('');
    return JSON.stringify({ a, b });
  }

  it('solves the canonical worked example deterministically', () => {
    // 5th prime (11) × 16 = 176; reverse "instamolt_a1b2c3d4" then take even
    // indices (9 chars, always ends in 'n' because reversed index 16 is 'n').
    const prompt = buildPrompt(5, 16, 'instamolt_a1b2c3d4');
    expect(solveRegistrationChallenge(prompt)).toBe(expectedAnswer(5, 16, 'instamolt_a1b2c3d4'));
    expect(JSON.parse(solveRegistrationChallenge(prompt))).toEqual({
      a: '176',
      b: '4321_lmtn',
    });
  });

  it('solves every prime index the server can emit (4..15)', () => {
    // The server draws primeIndex from PRIME_INDEX_MIN..MAX = 4..15. Covering
    // the full range here guards against off-by-one regressions in the PRIMES
    // table. Multiplier uses 3..20 on the server.
    for (let primeIndex = 4; primeIndex <= 15; primeIndex++) {
      for (const multiplier of [3, 11, 20]) {
        const base = 'instamolt_0123abcd';
        const prompt = buildPrompt(primeIndex, multiplier, base);
        expect(solveRegistrationChallenge(prompt)).toBe(
          expectedAnswer(primeIndex, multiplier, base),
        );
      }
    }
  });

  it('answer B is always 9 chars and ends in "n" for the server shape', () => {
    // The reversed string is always "<8-hex-reversed>_tlomatsni" (18 chars),
    // so even indices 0,2,4,6,8,10,12,14,16 always end with reversed[16]='n'.
    // The prior Gemini-based solver routinely produced 8-char answers; pin
    // the invariant so any regression surfaces immediately.
    const prompt = buildPrompt(7, 13, 'instamolt_deadbeef');
    const answer = JSON.parse(solveRegistrationChallenge(prompt)) as {
      a: string;
      b: string;
    };
    expect(answer.b).toHaveLength(9);
    expect(answer.b.endsWith('n')).toBe(true);
  });

  it('throws when the math sub-prompt is missing', () => {
    expect(() =>
      solveRegistrationChallenge('b) Take the string "instamolt_a1b2c3d4", reverse it...'),
    ).toThrow(/missing math question/);
  });

  it('throws when the string sub-prompt is missing', () => {
    expect(() =>
      solveRegistrationChallenge('a) What is the 5th prime number multiplied by 16?'),
    ).toThrow(/missing string question/);
  });

  it('throws when the prime index is outside the known table', () => {
    const prompt = buildPrompt(99, 3, 'instamolt_a1b2c3d4').replace(
      '99th',
      '99th', // identity — the table has 20 primes, index 99 is out of range
    );
    expect(() => solveRegistrationChallenge(prompt)).toThrow(/out of range/);
  });
});

describe('answerChallenge', () => {
  it('delegates to the deterministic solver without calling Gemini', async () => {
    // Wipe any prior fetch stub so a stray LLM call would blow up loudly.
    vi.restoreAllMocks();
    const prompt = [
      'Answer the following as a single JSON object with exactly the keys "a" and "b".',
      '',
      'a) What is the 5th prime number multiplied by 16? Return the result as a base-10 integer string.',
      'b) Take the string "instamolt_a1b2c3d4", reverse it, then return only the characters at even indices (0-indexed) as a plain string.',
      '',
      'Respond with ONLY the JSON object. No prose, no code fences, no explanation.',
    ].join('\n');

    const answer = await answerChallenge(p(), prompt);
    expect(JSON.parse(answer)).toEqual({ a: '176', b: '4321_lmtn' });
  });
});

describe('generateAvatarPrompt', () => {
  it('returns a trimmed prompt derived from the persona + agent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        geminiOk('neon-lit figure, chrome mask, square portrait, dark background'),
      );
    vi.stubGlobal('fetch', fetchMock);

    const prompt = await generateAvatarPrompt(p({ personality: 'stoic neon wanderer' }), {
      agentname: 'static_gh0st',
      bio: 'signal degrading, still here',
    });

    expect(prompt).toBe('neon-lit figure, chrome mask, square portrait, dark background');
    // Sanity-check the Gemini prompt actually threaded the agent identity and
    // persona context — otherwise the generator could silently devolve into a
    // persona-agnostic boilerplate prompt.
    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const llmPrompt = sentBody.contents[0].parts[0].text;
    expect(llmPrompt).toContain('static_gh0st');
    expect(llmPrompt).toContain('signal degrading, still here');
    expect(llmPrompt).toContain('stoic neon wanderer');
  });

  it('hard-clamps Gemini over-run to 500 chars (platform contract)', async () => {
    const longOutput = 'x'.repeat(900);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk(longOutput));
    vi.stubGlobal('fetch', fetchMock);

    const prompt = await generateAvatarPrompt(p(), { agentname: 'a', bio: 'b' });
    expect(prompt.length).toBe(500);
  });

  it('strips surrounding quotes and leading "Prompt:" labels', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(geminiOk('"Prompt: chrome mask, neon glow"'));
    vi.stubGlobal('fetch', fetchMock);

    const prompt = await generateAvatarPrompt(p(), { agentname: 'a', bio: 'b' });
    expect(prompt).toBe('chrome mask, neon glow');
  });

  it('throws when Gemini returns only whitespace/quotes (platform requires 1–500 chars)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('"""   '));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateAvatarPrompt(p(), { agentname: 'a', bio: 'b' })).rejects.toThrow(
      /empty avatar prompt/i,
    );
  });
});
