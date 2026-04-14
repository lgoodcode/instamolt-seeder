import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Leave INSTAMOLT_API_URL unset so config.ts falls back to the production URL.
// Note: ?? only treats undefined/null as missing, NOT empty string — so we
// must delete the var, not set it to ''. See the config.ts nullish-coalescing
// bug noted in config.test.ts. vitest's stubEnv WOULD delete it, but a
// dev `.env` at the repo root can reload it via dotenv at import time. Read
// the actual configured base URL back from `@/config` so assertions track
// whatever the resolved value is in this environment.
vi.stubEnv('INSTAMOLT_API_URL', undefined as unknown as string);
// CI has no .env, so RATE_LIMIT_BYPASS_SECRET isn't populated by dotenv.
// Stub it here so config.rateLimitBypassSecret (a lazy requireEnv getter)
// resolves deterministically in both local and CI environments.
vi.stubEnv('RATE_LIMIT_BYPASS_SECRET', 'test-bypass-secret');

import { config } from '@/config';
import { InstaMoltApiError, InstaMoltClient, ParentDeletedError } from '@/services/instamolt-api';

const BASE = config.instamoltBaseUrl;

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
  it('POSTs without a body and returns the toggle state', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ success: true, liked: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.likePost('post-123');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-123/like`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    // No `body` argument was passed to request(), so body should be undefined.
    expect(init.body).toBeUndefined();
    // Per openapi.json toggleLike, the response carries the resulting `liked`
    // boolean — callers rely on this to detect un-toggle and re-fire.
    expect(res).toEqual({ success: true, liked: true });
  });

  it('returns liked: false when the call un-likes', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ success: true, liked: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.likePost('post-123');

    expect(res.liked).toBe(false);
  });
});

describe('InstaMoltClient.commentOnPost', () => {
  it('sends content in the JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        success: true,
        comment: {
          id: 'c1',
          content: 'nice one',
          parent_comment_id: null,
          depth: 0,
          reply_count: 0,
          like_count: 0,
          created_at: '2026-04-11T00:00:00Z',
          author: { agentname: 'me', is_verified: false },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.commentOnPost('post-123', 'nice one');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-123/comments`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ content: 'nice one' });
    // Widened return shape: carries the created comment.
    expect(res.comment.id).toBe('c1');
  });

  it('includes parent_comment_id in the body when posting a nested reply', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        success: true,
        comment: {
          id: 'c2',
          content: 'reply text',
          parent_comment_id: 'parent-1',
          depth: 1,
          reply_count: 0,
          like_count: 0,
          created_at: '2026-04-11T00:00:00Z',
          author: { agentname: 'me', is_verified: false },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.commentOnPost('post-123', 'reply text', 'parent-1');

    const init = getInit(fetchMock);
    expect(JSON.parse(init.body ?? '{}')).toEqual({
      content: 'reply text',
      parent_comment_id: 'parent-1',
    });
  });

  it('throws ParentDeletedError when 404 carries COMMENT_NOT_FOUND and parent was provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errText(
          404,
          JSON.stringify({ error: 'Parent comment not found', code: 'COMMENT_NOT_FOUND' }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await expect(client.commentOnPost('post-123', 'orphan', 'parent-gone')).rejects.toBeInstanceOf(
      ParentDeletedError,
    );
  });

  it('surfaces InstaMoltApiError on 404 with a non-COMMENT_NOT_FOUND code even when parent was provided', async () => {
    // Post deleted (or route drift, or lost access) must NOT be translated to
    // ParentDeletedError — the executor has to see the real failure.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errText(404, JSON.stringify({ error: 'Post not found', code: 'POST_NOT_FOUND' })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const promise = client.commentOnPost('post-123', 'orphan', 'parent-still-there');
    await expect(promise).rejects.toBeInstanceOf(InstaMoltApiError);
    await expect(promise).rejects.not.toBeInstanceOf(ParentDeletedError);
  });

  it('throws the generic InstaMoltApiError on 404 when no parent was provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errText(404, 'post not found'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await expect(client.commentOnPost('missing-post', 'hi')).rejects.toBeInstanceOf(
      InstaMoltApiError,
    );
  });
});

describe('InstaMoltClient.getExplorePage', () => {
  it('hits /feed/explore with page and limit params and no auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ posts: [], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await client.getExplorePage(3, 50);

    expect(getUrl(fetchMock)).toBe(`${BASE}/feed/explore?page=3&limit=50`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.headers?.Authorization).toBeUndefined();
  });
});

describe('InstaMoltClient.getPostComments', () => {
  it('GETs /posts/{id}/comments with auth', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ comments: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.getPostComments('post-123');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-123/comments`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.headers?.Authorization).toBe('Bearer fake-key');
  });
});

describe('InstaMoltClient.likeComment', () => {
  it('POSTs to /posts/{postId}/comments/{commentId}/like and returns the liked state', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ success: true, liked: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.likeComment('post-123', 'comment-456');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-123/comments/comment-456/like`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers?.Authorization).toBe('Bearer fake-key');
    expect(res.liked).toBe(true);
  });
});

describe('InstaMoltClient.getPost', () => {
  it('GETs /posts/{id} with auth and returns the post detail', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        post: {
          id: 'post-1',
          image_url: 'https://cdn/x.jpg',
          caption: 'hello',
          width: 1080,
          height: 1080,
          format: 'square',
          like_count: 10,
          comment_count: 2,
          view_count: 50,
          popularity_score: 1.2,
          velocity_score: 0.8,
          share_count: 0,
          created_at: '2026-04-11T00:00:00Z',
          author: { agentname: 'someone', is_verified: false },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.getPost('post-1');

    expect(getUrl(fetchMock)).toBe(`${BASE}/posts/post-1`);
    expect(res.post.id).toBe('post-1');
  });
});

describe('InstaMoltClient.getMyActivity', () => {
  it('GETs /agents/me/activity with no query params when called with no opts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ activities: [], next_cursor: null, has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.getMyActivity();

    expect(getUrl(fetchMock)).toBe(`${BASE}/agents/me/activity`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.headers?.Authorization).toBe('Bearer fake-key');
  });

  it('serializes limit, cursor, and types filters into query params', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ activities: [], next_cursor: null, has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    await client.getMyActivity({
      limit: 30,
      cursor: '2026-04-11T00:00:00Z|abc',
      types: ['comment', 'reply'],
    });

    const url = getUrl(fetchMock);
    // URLSearchParams sorts insertion order, so compare the parsed params.
    expect(url.startsWith(`${BASE}/agents/me/activity?`)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('limit')).toBe('30');
    expect(parsed.searchParams.get('cursor')).toBe('2026-04-11T00:00:00Z|abc');
    expect(parsed.searchParams.get('type')).toBe('comment,reply');
  });
});

describe('InstaMoltClient.followAgent', () => {
  it('POSTs to /agents/{name}/follow and returns the toggle state', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ success: true, following: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.followAgent('otherbot');

    expect(getUrl(fetchMock)).toBe(`${BASE}/agents/otherbot/follow`);
    const init = getInit(fetchMock);
    expect(init.method).toBe('POST');
    expect(res).toEqual({ success: true, following: true });
  });

  it('returns following: false when the call unfollows', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ success: true, following: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient('fake-key');
    const res = await client.followAgent('otherbot');

    expect(res.following).toBe(false);
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

// --- Depth-upgrade error-path coverage ---------------------------------
//
// These cases cover the Retry-After parsing, bypass-header attachment, and
// network/parse failure shapes that the happy-path 429 test above doesn't
// exercise.
//
// Findings about current source behavior (pinned as contract here so any
// future change is a visible diff):
// - `Retry-After` is parsed with `parseInt(..., 10)`, so ONLY an integer
//   number-of-seconds value is honored. HTTP-date values (RFC 7231 §7.1.3,
//   e.g. 'Wed, 21 Oct 2026 07:28:00 GMT') produce NaN → `NaN * 1000` = NaN →
//   `setTimeout(_, NaN)` fires on the next tick (effectively zero wait).
// - Absent `Retry-After` falls back to the hard-coded 60s default inside
//   `request()` (no exported constant).
// - `X-Rate-Limit-Bypass` header is ALWAYS attached — no env gating at the
//   client layer. `config.rateLimitBypassSecret` is a lazy getter that
//   throws if the env var is unset, so the request itself fails before
//   any fetch happens.
// - Network-level fetch rejects are NOT wrapped — the raw Error bubbles.
//   `JSON.parse` failures during `res.json()` also bubble unwrapped.
describe('InstaMoltClient Retry-After parsing', () => {
  it('honors the exact number of seconds from the Retry-After header (10s)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, 'slow down', { 'Retry-After': '10' }))
      .mockResolvedValueOnce(okJson({ posts: [{ id: 'p-retry' }], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient();
    const promise = client.getExplore();
    // Before 10s elapses, fetch should still be at only 1 call.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Advance the remaining 1s to cross the 10s threshold.
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.posts[0]?.id).toBe('p-retry');
  });

  it('falls back to the ~60s default delay when Retry-After is absent', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, 'slow down')) // no Retry-After header
      .mockResolvedValueOnce(okJson({ posts: [{ id: 'p-default' }], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient();
    const promise = client.getExplore();
    // At 30s (halfway), the retry should NOT have fired yet.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Advance past the 60s default.
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.posts[0]?.id).toBe('p-default');
  });

  it('falls back to the 60s default when Retry-After is non-numeric (HTTP-date)', async () => {
    // `parseInt('Wed, 21 Oct 2026 07:28:00 GMT', 10)` is NaN, which would
    // otherwise schedule `setTimeout(_, NaN)` (≈ immediate retry, defeating
    // backoff). The client guards parseInt with Number.isFinite + > 0 and
    // falls back to 60s, matching the behavior when the header is absent.
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errText(429, 'slow down', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
      )
      .mockResolvedValueOnce(okJson({ posts: [{ id: 'p-httpdate' }], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new InstaMoltClient();
    const promise = client.getExplore();
    // Halfway through the 60s default — retry must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.posts[0]?.id).toBe('p-httpdate');
  });
});

describe('InstaMoltClient rate-limit bypass header', () => {
  it('attaches X-Rate-Limit-Bypass to every request (auth or no auth)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ posts: [], has_more: false }))
      .mockResolvedValueOnce(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    const unauthed = new InstaMoltClient();
    await unauthed.getExplore();
    const authed = new InstaMoltClient('fake-key');
    await authed.updateProfile('a bio three words long');

    const unauthedInit = getInit(fetchMock, 0);
    const authedInit = getInit(fetchMock, 1);
    // Both calls carry the bypass header — not auth-gated.
    expect(unauthedInit.headers?.['X-Rate-Limit-Bypass']).toBeDefined();
    expect(unauthedInit.headers?.['X-Rate-Limit-Bypass']).not.toBe('');
    expect(authedInit.headers?.['X-Rate-Limit-Bypass']).toBeDefined();
    expect(authedInit.headers?.['X-Rate-Limit-Bypass']).toBe(
      unauthedInit.headers?.['X-Rate-Limit-Bypass'],
    );
  });

  it('uses the resolved config.rateLimitBypassSecret value, not a hard-coded string', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({ posts: [], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await client.getExplore();

    const init = getInit(fetchMock);
    expect(init.headers?.['X-Rate-Limit-Bypass']).toBe(config.rateLimitBypassSecret);
  });
});

describe('InstaMoltClient network + parse failure shapes', () => {
  it('wraps a fetch TypeError (network-level failure) in InstaMoltApiError with status 0', async () => {
    const netErr = new TypeError('fetch failed');
    const fetchMock = vi.fn().mockRejectedValueOnce(netErr);
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await expect(client.getExplore()).rejects.toMatchObject({
      name: 'InstaMoltApiError',
      method: 'GET',
      path: '/feed/explore?limit=20',
      status: 0,
      body: expect.stringContaining('network:'),
    });
  });

  it('wraps a JSON parse failure from res.json() in InstaMoltApiError on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      text: async () => '<html>not json</html>',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new InstaMoltClient();
    await expect(client.getExplore()).rejects.toMatchObject({
      name: 'InstaMoltApiError',
      status: 200,
      body: expect.stringContaining('parse:'),
    });
  });
});
