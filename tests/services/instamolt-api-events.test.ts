import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @/config BEFORE importing the client — bypasses the pre-existing
// dotenv-loading race in tests/services/instamolt-api.test.ts. We want a
// known fixed base URL so the retry URL assertions are deterministic.
vi.mock('@/config', () => ({
  config: {
    instamoltBaseUrl: 'https://instamolt.app/api/v1',
    rateLimitBypassSecret: 'test-bypass-secret',
  },
}));

// Hoisted mock for the event logger so we can assert on logEvent calls
// without caring about the rest of the module's internal state.
const logEventMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/event-logger', () => ({
  logEvent: logEventMock,
}));

import { InstaMoltApiError, InstaMoltClient } from '@/services/instamolt-api';

// Build a fake successful fetch Response with a JSON body.
function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Build a fake error fetch Response with a text body and optional headers.
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

describe('InstaMoltClient 429 event emission', () => {
  it('emits api_429 once on 429 -> retry -> 200 with Retry-After * 1000 as retryAfterMs', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, 'slow down', { 'Retry-After': '2' }))
      .mockResolvedValueOnce(okJson({ liked: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient('api-key');
    const promise = client.likePost('p1');
    // Fast-forward the Retry-After wait (2 seconds).
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    // Confirm retry actually happened (bypasses URL assertions which the
    // sibling test file's dotenv race breaks).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // logEvent called twice: api_429 (before the retry sleep) and api_call
    // (after the retry succeeds, carrying durationMs).
    expect(logEventMock).toHaveBeenCalledTimes(2);
    expect(logEventMock).toHaveBeenNthCalledWith(1, {
      eventType: 'api_429',
      success: false,
      error: 'rate-limited on POST /posts/p1/like',
      details: {
        httpStatus: 429,
        retryAfterMs: 2_000,
        requestContext: { method: 'POST', path: '/posts/p1/like' },
      },
    });
    const successCall = logEventMock.mock.calls[1][0] as {
      eventType: string;
      success: boolean;
      durationMs: number;
      details: { method: string; path: string; httpStatus: number };
    };
    expect(successCall.eventType).toBe('api_call');
    expect(successCall.success).toBe(true);
    expect(successCall.durationMs).toBeGreaterThanOrEqual(0);
    expect(successCall.details.method).toBe('POST');
    expect(successCall.details.path).toBe('/posts/p1/like');
    expect(successCall.details.httpStatus).toBe(200);
  });

  it('falls back to 60s (60000ms) retryAfterMs when Retry-After header is absent', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, 'slow down'))
      .mockResolvedValueOnce(okJson({ liked: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient('api-key');
    const promise = client.likePost('p1');
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    // api_429 + api_call (retry succeeded).
    expect(logEventMock).toHaveBeenCalledTimes(2);
    const call = logEventMock.mock.calls[0][0] as {
      details: { retryAfterMs: number };
    };
    expect(call.details.retryAfterMs).toBe(60_000);
    expect(logEventMock.mock.calls[1][0].eventType).toBe('api_call');
  });

  it('throws InstaMoltApiError with retryAfterMs from the SECOND response on 429 -> retry -> 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, 'slow down', { 'Retry-After': '2' }))
      .mockResolvedValueOnce(errText(429, 'still slow', { 'Retry-After': '7' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient('api-key');
    const promise = client.likePost('p1');
    // Catch now so unhandled rejection doesn't fire before we advance timers.
    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(InstaMoltApiError);
    const apiErr = err as InstaMoltApiError;
    expect(apiErr.status).toBe(429);
    // retryAfterMs on the thrown error = SECOND response's Retry-After * 1000,
    // not the first (2s).
    expect(apiErr.retryAfterMs).toBe(7_000);

    // The initial 429 still emitted once (the second 429 is thrown, not
    // logged via api_429). A final api_error is now also emitted before the
    // throw, carrying durationMs + the final 429 status.
    expect(logEventMock).toHaveBeenCalledTimes(2);
    const firstCall = logEventMock.mock.calls[0][0] as {
      eventType: string;
      details: { retryAfterMs: number };
    };
    expect(firstCall.eventType).toBe('api_429');
    expect(firstCall.details.retryAfterMs).toBe(2_000);
    const errCall = logEventMock.mock.calls[1][0] as {
      eventType: string;
      success: boolean;
      durationMs: number;
      details: { httpStatus: number; requestContext: { method: string; path: string } };
    };
    expect(errCall.eventType).toBe('api_error');
    expect(errCall.success).toBe(false);
    expect(errCall.details.httpStatus).toBe(429);
    expect(errCall.details.requestContext).toEqual({ method: 'POST', path: '/posts/p1/like' });
  });
});
