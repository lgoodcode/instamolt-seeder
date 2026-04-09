import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Critical: stub the env var BEFORE importing instamolt-api.ts (which
// transitively imports config.ts, which calls requireEnv('GEMINI_API_KEY')
// at module load).
vi.stubEnv('GEMINI_API_KEY', 'test-key');
// Leave INSTAMOLT_API_URL unset so config.ts falls back to the production URL.
// Note: ?? only treats undefined/null as missing, NOT empty string — so we
// must delete the var, not set it to ''. See the config.ts nullish-coalescing
// bug noted in config.test.ts.
vi.stubEnv('INSTAMOLT_API_URL', undefined as unknown as string);

import { InstaMoltClient } from '@/services/instamolt-api';

const BASE = 'https://instamolt.app/api/v1';

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

// Build a fake error fetch Response with a text body.
function errText(status: number, body: string, headers?: Record<string, string>): Response {
  return {
    ok: false,
    status,
    headers: new Headers(headers ?? {}),
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

// Pull the RequestInit argument out of a fetch mock call. Typed as a loose
// shape so we can assert on headers/body without `any`.
interface FetchCallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function getInit(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): FetchCallInit {
  const call = fetchMock.mock.calls[callIndex];
  return (call?.[1] ?? {}) as FetchCallInit;
}

function getUrl(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const call = fetchMock.mock.calls[callIndex];
  return String(call?.[0] ?? '');
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InstaMoltClient.startChallenge', () => {
  it('POSTs to /agents/register with agentname + description and no auth header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ request_id: 'req-1', challenge: 'solve me' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    const res = await client.startChallenge('testbot', 'a test bot');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getUrl(fetchMock)).toBe(`${BASE}/agents/register`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBeUndefined();
    expect(init.headers?.['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body ?? '{}');
    expect(body).toEqual({ agentname: 'testbot', description: 'a test bot' });
    expect(res.request_id).toBe('req-1');
  });
});

describe('InstaMoltClient.completeChallenge', () => {
  it('POSTs to /agents/register/complete with request_id + answer and no auth', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        success: true,
        agent: { agentname: 'testbot', api_key: 'abc', is_verified: true },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    const res = await client.completeChallenge('req-1', 'forty two');

    expect(getUrl(fetchMock)).toBe(`${BASE}/agents/register/complete`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBeUndefined();
    const body = JSON.parse(init.body ?? '{}');
    expect(body).toEqual({ request_id: 'req-1', answer: 'forty two' });
    expect(res.success).toBe(true);
  });
});

describe('InstaMoltClient.updateProfile', () => {
  it('sets the Authorization: Bearer header when an API key is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.updateProfile('hello world three');

    expect(getUrl(fetchMock)).toBe(`${BASE}/agents/me`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('PATCH');
    expect(init.headers?.Authorization).toBe('Bearer fake-key');
    const body = JSON.parse(init.body ?? '{}');
    expect(body).toEqual({ description: 'hello world three' });
  });

  it('omits the Authorization header when no API key is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await client.updateProfile('anonymous bio');

    const init = getInit(fetchMock);
    expect(init.headers?.Authorization).toBeUndefined();
  });
});

describe('InstaMoltClient.likePost', () => {
  it('POSTs without a body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.likePost('post-123');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-123/like`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    // No `body` argument was passed to request(), so body should be undefined.
    expect(init.body).toBeUndefined();
  });
});

describe('InstaMoltClient.commentOnPost', () => {
  it('sends content in the JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.commentOnPost('post-123', 'nice one');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-123/comments`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ content: 'nice one' });
  });
});

describe('InstaMoltClient.followAgent', () => {
  it('POSTs to /agents/{name}/follow', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.followAgent('otherbot');

    expect(getUrl(fetchMock)).toBe(`${BASE}/agents/otherbot/follow`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
  });
});

describe('InstaMoltClient.getExplore', () => {
  it('hits /feed/explore?limit=20 by default', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ posts: [], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await client.getExplore();

    expect(getUrl(fetchMock)).toBe(`${BASE}/feed/explore?limit=20`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it('hits /feed/explore?limit=50 when called with 50', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ posts: [], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await client.getExplore(50);

    expect(getUrl(fetchMock)).toBe(`${BASE}/feed/explore?limit=50`);
  });
});

describe('InstaMoltClient 429 handling', () => {
  it('retries once on 429, honoring Retry-After, and returns the second response', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, 'slow down', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(okJson({ posts: [{ id: 'p1' }], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient();
    const promise = client.getExplore();
    // Fast-forward the Retry-After wait (1 second).
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both calls should hit the same URL.
    expect(getUrl(fetchMock, 0)).toBe(`${BASE}/feed/explore?limit=20`);
    expect(getUrl(fetchMock, 1)).toBe(`${BASE}/feed/explore?limit=20`);
    expect(result.posts[0]?.id).toBe('p1');
  });
});

describe('InstaMoltClient error paths', () => {
  it('throws with the status code and response body on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errText(500, 'server error'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await expect(client.getExplore()).rejects.toThrow(/500/);
    // Reset and call again to also assert the body is included.
    const fetchMock2 = vi.fn().mockResolvedValueOnce(errText(500, 'server error'));
    vi.stubGlobal('fetch', fetchMock2);
    await expect(new InstaMoltClient().getExplore()).rejects.toThrow(/server error/);
  });

  it('propagates a network error from fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await expect(client.getExplore()).rejects.toThrow(/ECONNREFUSED/);
  });
});
