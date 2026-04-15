import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config', () => ({
  config: {
    instamoltBaseUrl: 'https://instamolt.app/api/v1',
    rateLimitBypassSecret: 'test-bypass-secret',
    retryMaxAttempts: 4,
    retryBaseMs: 100,
    retryMaxDelayMs: 8000,
  },
}));

const logEventMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/event-logger', () => ({
  logEvent: logEventMock,
}));

import { InstaMoltApiError, InstaMoltClient } from '@/services/instamolt-api';

function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errText(status: number, body: string, headers?: Record<string, string>): Response {
  return {
    ok: false,
    status,
    headers: new Headers(headers ?? {}),
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

describe('InstaMoltClient api_call event emission', () => {
  it('emits api_call on a 2xx response with method/path/httpStatus/attempt/durationMs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ liked: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('api-key');
    await client.likePost('p1');

    const apiCalls = logEventMock.mock.calls
      .map(
        (c) =>
          c[0] as {
            eventType: string;
            success: boolean;
            durationMs?: number;
            details?: Record<string, unknown>;
          },
      )
      .filter((e) => e.eventType === 'api_call');
    expect(apiCalls.length).toBe(1);
    const ev = apiCalls[0];
    expect(ev.success).toBe(true);
    expect(typeof ev.durationMs).toBe('number');
    expect(ev.durationMs!).toBeGreaterThanOrEqual(0);
    expect(ev.details?.method).toBe('POST');
    expect(ev.details?.path).toBe('/posts/p1/like');
    expect(ev.details?.httpStatus).toBe(200);
    expect(typeof ev.details?.attempt).toBe('number');
  });
});

describe('InstaMoltClient api_error event emission', () => {
  it('emits api_error on a 4xx failure with durationMs + httpStatus + error string', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errText(400, 'bad input'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('api-key');
    const err = await client.likePost('p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstaMoltApiError);

    const apiErrors = logEventMock.mock.calls
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
      .filter((e) => e.eventType === 'api_error');
    expect(apiErrors.length).toBe(1);
    const ev = apiErrors[0];
    expect(ev.success).toBe(false);
    expect(typeof ev.durationMs).toBe('number');
    expect(ev.durationMs!).toBeGreaterThanOrEqual(0);
    expect(typeof ev.error).toBe('string');
    expect(ev.error!.length).toBeGreaterThan(0);
    expect(ev.details?.httpStatus).toBe(400);
  });
});
