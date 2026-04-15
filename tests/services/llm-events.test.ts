import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @/config before importing llm.ts so config.geminiApiKey + config.geminiModel
// are deterministic and don't require a real .env.
vi.mock('@/config', () => ({
  config: {
    geminiApiKey: 'test-key',
    geminiModel: 'gemini-test',
  },
}));

// Hoisted spy on logEvent so we can assert on llm_call / llm_retry emissions
// from callGemini without touching the real in-memory logger state.
const logEventMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/event-logger', () => ({
  logEvent: logEventMock,
}));

import { generateAgentName } from '@/services/llm';
import type { Persona, VoiceProfile } from '@/types';

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
      guidance: 'Generate a dry witty handle.',
      preserveCase: true,
    },
    ...overrides,
  };
}

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

function geminiErr(status: number, body = 'err'): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  logEventMock.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('llm_call success emission', () => {
  it('emits llm_call success=true with durationMs and details.kind on a successful Gemini call', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(geminiOk('cool_handle'));
    vi.stubGlobal('fetch', fetchMock);

    // generateAgentName uses callGemini with kind='agentname'.
    await generateAgentName(p(), vp(), []);

    const successCalls = logEventMock.mock.calls
      .map(
        (c) =>
          c[0] as {
            eventType: string;
            success: boolean;
            durationMs?: number;
            details?: Record<string, unknown>;
          },
      )
      .filter((e) => e.eventType === 'llm_call');
    expect(successCalls.length).toBe(1);
    const ev = successCalls[0];
    expect(ev.success).toBe(true);
    expect(typeof ev.durationMs).toBe('number');
    expect(ev.durationMs!).toBeGreaterThanOrEqual(0);
    expect(ev.details?.kind).toBe('agentname');
  });
});

describe('llm_retry emission on transient 429', () => {
  it('emits llm_retry on 429 then llm_call success on recovery', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(geminiErr(429, 'rate limited per minute'))
      .mockResolvedValueOnce(geminiOk('another_handle'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = generateAgentName(p(), vp(), []);
    await vi.runAllTimersAsync();
    await promise;

    const retryCalls = logEventMock.mock.calls
      .map((c) => c[0] as { eventType: string; details?: Record<string, unknown> })
      .filter((e) => e.eventType === 'llm_retry');
    expect(retryCalls.length).toBe(1);
    expect(retryCalls[0].details?.kind).toBe('agentname');
    expect(typeof retryCalls[0].details?.attempt).toBe('number');

    const successCalls = logEventMock.mock.calls
      .map((c) => c[0] as { eventType: string; success: boolean })
      .filter((e) => e.eventType === 'llm_call');
    expect(successCalls.length).toBe(1);
    expect(successCalls[0].success).toBe(true);
  });
});

describe('llm_call failure emission on exhausted retries', () => {
  it('emits llm_call success=false with durationMs + error after retries exhausted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(geminiErr(500, 'server down'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = generateAgentName(p(), vp(), []).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);

    const llmCalls = logEventMock.mock.calls
      .map(
        (c) =>
          c[0] as {
            eventType: string;
            success: boolean;
            durationMs?: number;
            error?: string;
            details?: Record<string, unknown>;
          },
      )
      .filter((e) => e.eventType === 'llm_call');
    expect(llmCalls.length).toBe(1);
    const final = llmCalls[0];
    expect(final.success).toBe(false);
    expect(typeof final.durationMs).toBe('number');
    expect(final.durationMs!).toBeGreaterThanOrEqual(0);
    expect(typeof final.error).toBe('string');
    expect(final.error!.length).toBeGreaterThan(0);
    expect(final.details?.kind).toBe('agentname');
  });
});
