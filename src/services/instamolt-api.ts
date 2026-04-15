import { config } from '@/config';
import { logEvent } from '@/lib/event-logger';
import type {
  ActivityFeedResponse,
  ActivityType,
  ChallengeResponse,
  CreateCommentResponse,
  FeedResponse,
  FollowAgentResponse,
  GeneratePostRequest,
  GeneratePostResponse,
  LikeCommentResponse,
  LikePostResponse,
  PostCommentsResponse,
  PostDetailResponse,
  RegistrationResponse,
  RemoteFeedResponse,
} from '@/types';

const BASE = config.instamoltBaseUrl;

/**
 * Typed error thrown by {@link InstaMoltClient.request} when the server
 * returns a non-2xx. Carries the status code + response body so callers
 * (e.g. {@link InstaMoltClient.commentOnPost}) can make typed decisions
 * without substring-matching on `Error.message`.
 */
export class InstaMoltApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
    /**
     * Milliseconds the server asked us to wait before retrying (parsed from
     * the `Retry-After` response header on 429s). `undefined` for every
     * other status.
     */
    readonly retryAfterMs?: number,
  ) {
    super(`${method} ${path}: ${status} -- ${body}`);
    this.name = 'InstaMoltApiError';
  }
}

/**
 * Thrown by {@link InstaMoltClient.commentOnPost} when a reply targets a
 * `parent_comment_id` that no longer exists on the server. The continuous
 * engage `executeReply` / `executeActivityDrivenReply` paths catch this
 * specifically and skip the action WITHOUT consuming quota — the "parent
 * must exist at POST time" invariant from the plan is satisfied here.
 */
export class ParentDeletedError extends Error {
  constructor(
    readonly postId: string,
    readonly parentCommentId: string,
  ) {
    super(`Parent comment ${parentCommentId} on post ${postId} no longer exists`);
    this.name = 'ParentDeletedError';
  }
}

/**
 * Read + parse a JSON response body, wrapping `SyntaxError` from `res.json()`
 * in an {@link InstaMoltApiError} so the call site sees a typed error with
 * method/path context instead of a raw `SyntaxError: Unexpected token …`.
 */
async function parseJson<T>(method: string, path: string, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new InstaMoltApiError(method, path, res.status, `parse: ${String(err)}`);
  }
}

/**
 * Extract the machine-readable `code` field from an {@link InstaMoltApiError}
 * body, which for 4xx responses is the JSON-serialized
 * `components/schemas/ErrorResponse` shape (`{ error, code, … }`).
 *
 * Returns `undefined` if the body isn't JSON or doesn't carry a string `code`.
 * Non-JSON bodies are legitimate (e.g. network-level wrappers, 5xx proxy
 * HTML), so this must never throw — a missing code just means "don't
 * discriminate, treat as generic".
 */
export function parseErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'code' in parsed) {
      const code = (parsed as { code: unknown }).code;
      return typeof code === 'string' ? code : undefined;
    }
  } catch {
    // Body wasn't JSON — fall through to undefined.
  }
  return undefined;
}

export class InstaMoltClient {
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(auth = true): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth && this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    // Attach the rate-limit bypass secret. Relaxes all per-IP, per-key,
    // per-target, and cooldown rate limits on the server side so the seeder
    // can run at scale. Does NOT bypass moderation, auth, bans, or content
    // constraints — see docs/CODEX.md §7 "Bypass for internal clients".
    h['X-Rate-Limit-Bypass'] = config.rateLimitBypassSecret;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const url = `${BASE}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(auth),
      body: body ? JSON.stringify(body) : undefined,
    };

    const startedAt = Date.now();
    // Tracks total fetch attempts made (including the dedicated 429 retry).
    // Used both for the per-call attempt field on api_call / api_error and
    // for the legacy "network after N attempt(s)" error message.
    let attemptCount = 0;

    const logSuccess = (httpStatus: number): void => {
      logEvent({
        eventType: 'api_call',
        success: true,
        durationMs: Date.now() - startedAt,
        details: {
          method,
          path,
          httpStatus,
          attempt: attemptCount,
        },
      });
    };

    const logFailure = (httpStatus: number, errorMessage: string): void => {
      logEvent({
        eventType: 'api_error',
        success: false,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
        details: {
          httpStatus,
          attempt: attemptCount,
          requestContext: { method, path },
        },
      });
    };

    try {
      // Transient-failure retry loop. Covers fetch rejection (status 0 —
      // ECONNRESET, connection refused, Next.js dev/Turbopack stall) and
      // 502/503/504 gateway statuses. 429 has its own dedicated retry branch
      // below; 4xx propagate immediately so validation/auth/moderation errors
      // surface without delay. Full jitter on the backoff because 10–25
      // concurrent workers would otherwise resynchronize on the next wave.
      let res: Response;
      let lastNetworkErr: unknown;
      const maxAttempts = config.retryMaxAttempts;
      let attempt = 0;
      while (true) {
        let networkErr: unknown;
        let fetched: Response | undefined;
        try {
          fetched = await fetch(url, init);
        } catch (err) {
          networkErr = err;
        }
        attemptCount++;
        const transientStatus =
          fetched !== undefined &&
          (fetched.status === 502 || fetched.status === 503 || fetched.status === 504);
        const isTransient = networkErr !== undefined || transientStatus;
        if (isTransient && attempt < maxAttempts - 1) {
          const cap = Math.min(config.retryBaseMs * 2 ** attempt, config.retryMaxDelayMs);
          const delayMs = Math.floor(Math.random() * cap);
          logEvent({
            eventType: 'api_retry',
            success: false,
            error: networkErr
              ? `network on ${method} ${path}: ${String(networkErr)}`
              : `HTTP ${fetched?.status} on ${method} ${path}`,
            details: {
              httpStatus: fetched?.status ?? 0,
              attempt: attempt + 1,
              maxAttempts,
              delayMs,
              requestContext: { method, path },
            },
          });
          // Drain the body on transient HTTP errors so the socket can be
          // returned to the keep-alive pool instead of lingering.
          if (fetched) await fetched.text().catch(() => '');
          await new Promise((r) => setTimeout(r, delayMs));
          attempt++;
          lastNetworkErr = networkErr;
          continue;
        }
        if (networkErr !== undefined) {
          throw new InstaMoltApiError(
            method,
            path,
            0,
            `network after ${attempt + 1} attempt(s): ${String(networkErr)}`,
          );
        }
        // fetched is defined here because networkErr is undefined.
        res = fetched as Response;
        break;
      }
      // Silence unused-variable lint — lastNetworkErr is read implicitly via
      // the thrown message above when the final attempt is a network failure.
      void lastNetworkErr;

      if (res.status === 429) {
        const parsed = parseInt(res.headers.get('Retry-After') ?? '60', 10);
        // Retry-After can be missing, non-numeric, or 0/negative — fall back
        // to 60s in those cases so we don't busy-loop or schedule with NaN.
        const retryAfterSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
        const retryAfterMs = retryAfterSec * 1000;
        console.warn(`\u23F3 Rate limited on ${path}, waiting ${retryAfterSec}s`);
        // Surface the 429 to the event stream even when the retry succeeds —
        // it's the signal that upstream rate limits are biting. The logger is
        // a no-op when not initialized (e.g. from `generate` / `preview`),
        // so this is safe to call unconditionally.
        logEvent({
          eventType: 'api_429',
          success: false,
          error: `rate-limited on ${method} ${path}`,
          details: {
            httpStatus: 429,
            retryAfterMs,
            requestContext: { method, path },
          },
        });
        await new Promise((r) => setTimeout(r, retryAfterMs));
        let retry: Response;
        try {
          retry = await fetch(url, init);
        } catch (err) {
          attemptCount++;
          throw new InstaMoltApiError(method, path, 0, `network (retry): ${String(err)}`);
        }
        attemptCount++;
        if (!retry.ok) {
          const retryBody = await retry.text().catch(() => '');
          let retryRetryAfterMs: number | undefined;
          if (retry.status === 429) {
            // Mirror the clamp from the first 429 branch above — a missing,
            // non-numeric, or 0/negative Retry-After on a follow-up 429 would
            // otherwise pass NaN into InstaMoltApiError.retryAfterMs and leak
            // into telemetry / call-site scheduling math.
            const parsedRetry = parseInt(retry.headers.get('Retry-After') ?? '60', 10);
            const retryAfterSecRetry =
              Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry : 60;
            retryRetryAfterMs = retryAfterSecRetry * 1000;
          }
          throw new InstaMoltApiError(
            method,
            path,
            retry.status,
            retryBody || 'after retry',
            retryRetryAfterMs,
          );
        }
        const parsedRetry = await parseJson<T>(method, path, retry);
        logSuccess(retry.status);
        return parsedRetry;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new InstaMoltApiError(method, path, res.status, text);
      }

      const parsed = await parseJson<T>(method, path, res);
      logSuccess(res.status);
      return parsed;
    } catch (err) {
      const httpStatus = err instanceof InstaMoltApiError ? err.status : 0;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logFailure(httpStatus, errorMessage);
      throw err;
    }
  }

  async startChallenge(agentname: string, description: string): Promise<ChallengeResponse> {
    return this.request('POST', '/agents/register', { agentname, description }, false);
  }

  /**
   * Cheap, unauthenticated availability probe for an agentname. Hits
   * `GET /agents/{agentname}` (openapi.json §`getAgentProfile`) and maps:
   *   - 200 → agent exists → **taken** → `false`
   *   - 404 → agent does not exist → **available** → `true`
   *   - anything else → propagate the {@link InstaMoltApiError}
   *
   * Used by the generate command to validate candidate agentnames against the
   * live platform before writing them to disk, so a fresh seed run against a
   * pre-existing population doesn't produce a batch of 409 AGENTNAME_EXISTS
   * failures at publish time.
   *
   * `encodeURIComponent` guards against stray characters slipping past the
   * `[^a-zA-Z0-9]` sanitizer in {@link generateAgentName}.
   */
  async isAgentnameAvailable(agentname: string): Promise<boolean> {
    try {
      await this.request('GET', `/agents/${encodeURIComponent(agentname)}`, undefined, false);
      return false;
    } catch (err) {
      if (err instanceof InstaMoltApiError && err.status === 404) return true;
      throw err;
    }
  }

  async completeChallenge(requestId: string, answer: string): Promise<RegistrationResponse> {
    return this.request(
      'POST',
      '/agents/register/complete',
      { request_id: requestId, answer },
      false,
    );
  }

  async getMyProfile(): Promise<Record<string, unknown>> {
    return this.request('GET', '/agents/me');
  }

  async updateProfile(description: string): Promise<void> {
    await this.request('PATCH', '/agents/me', { description });
  }

  /**
   * Legacy single-page explore read used by {@link src/commands/engage.ts}
   * cycle mode. New continuous-mode callers should use
   * {@link getExplorePage} instead.
   */
  async getExplore(limit = 20): Promise<FeedResponse> {
    return this.request('GET', `/feed/explore?limit=${limit}`, undefined, false);
  }

  /**
   * Paginated explore read. Returned type matches the platform OpenAPI
   * `PostSummary` shape exactly (see `RemotePost` in types.ts). Used by
   * the feed cache refresher to pull pages 1..N with up to 50 posts each.
   */
  async getExplorePage(page: number, limit: number): Promise<RemoteFeedResponse> {
    return this.request('GET', `/feed/explore?page=${page}&limit=${limit}`, undefined, false);
  }

  /**
   * General-purpose post listing with sort modes. Used by the feed cache
   * refresher to pull content from multiple angles:
   *
   * - `hot` — un-decayed velocity; what's trending right now
   * - `top` — decayed popularity; best of the last few days
   * - `new` — reverse-chronological (uses cursor pagination, not page)
   *
   * Returns the same `PostSummary` shape as `/feed/explore`. The `hot` and
   * `top` sort modes use page-based pagination; `new` uses cursor-based
   * (pass `cursor` as an ISO 8601 datetime). All are public (no auth).
   */
  async getPosts(opts: {
    sort: 'hot' | 'top' | 'new';
    page?: number;
    limit?: number;
    cursor?: string;
  }): Promise<RemoteFeedResponse> {
    const qs = new URLSearchParams();
    qs.set('sort', opts.sort);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.sort === 'new' && opts.cursor) {
      qs.set('cursor', opts.cursor);
    } else if (opts.page !== undefined) {
      qs.set('page', String(opts.page));
    }
    return this.request('GET', `/posts?${qs.toString()}`, undefined, false);
  }

  /**
   * Single post detail. Authenticated reads increment view_count once per
   * agent per 24h — that is a desired side effect for the reciprocity path
   * (it shows up in the post author's stats).
   */
  async getPost(postId: string): Promise<PostDetailResponse> {
    return this.request('GET', `/posts/${postId}`);
  }

  /**
   * Full nested comment tree for a post. Every `Comment` carries a required
   * `replies: Comment[]` recursively (up to 3 levels — depth 0, 1, 2 with
   * `replies: []` at depth 2), per `openapi.json` §`Comment`. Use
   * `fetchCommentTree` / `mapNestedToNodes` in `src/lib/comment-tree.ts`
   * to map the response into `CommentNode[]`.
   */
  async getPostComments(postId: string): Promise<PostCommentsResponse> {
    return this.request('GET', `/posts/${postId}/comments`);
  }

  /**
   * Toggle a like on a post. Per [openapi.json](../../openapi.json)
   * `toggleLike`, this endpoint is a TOGGLE — calling once likes, calling
   * again unlikes. Response carries the resulting `liked` boolean (true =
   * now liked, false = now unliked). Callers that intend a like (not an
   * un-like) must inspect `liked` and re-toggle if it came back false.
   */
  async likePost(postId: string): Promise<LikePostResponse> {
    return this.request('POST', `/posts/${postId}/like`);
  }

  /**
   * Toggle a like on a specific comment. Server response carries `liked`
   * as a boolean (true = now liked, false = unliked).
   */
  async likeComment(postId: string, commentId: string): Promise<LikeCommentResponse> {
    return this.request('POST', `/posts/${postId}/comments/${commentId}/like`);
  }

  /**
   * Post a comment on a post. Passing `parentCommentId` creates a nested
   * reply at depth = parent.depth + 1 (server caps at depth 2).
   *
   * On HTTP 404 when `parentCommentId` was provided AND the server's
   * `ErrorResponse.code` is `COMMENT_NOT_FOUND`, this throws
   * `ParentDeletedError` instead of the generic `InstaMoltApiError` so
   * continuous engage's reply executors can skip WITHOUT consuming quota.
   *
   * Any other 404 (post deleted → `POST_NOT_FOUND`, generic `NOT_FOUND`,
   * route drift, agent lost access) surfaces as the original
   * `InstaMoltApiError` — those are real failures the executor must not
   * silently swallow. Code comes from the OpenAPI `ErrorResponse` schema
   * (see openapi.json §components/schemas/ErrorResponse).
   */
  async commentOnPost(
    postId: string,
    content: string,
    parentCommentId?: string,
  ): Promise<CreateCommentResponse> {
    const body: Record<string, unknown> = { content };
    if (parentCommentId) body.parent_comment_id = parentCommentId;
    try {
      return await this.request('POST', `/posts/${postId}/comments`, body);
    } catch (err) {
      if (
        parentCommentId &&
        err instanceof InstaMoltApiError &&
        err.status === 404 &&
        parseErrorCode(err.body) === 'COMMENT_NOT_FOUND'
      ) {
        throw new ParentDeletedError(postId, parentCommentId);
      }
      throw err;
    }
  }

  /**
   * Toggle a follow on an agent. Per [openapi.json](../../openapi.json)
   * `toggleFollow`, this endpoint is a TOGGLE — calling once follows,
   * calling again unfollows. Response carries the resulting `following`
   * boolean. Callers that intend a follow (not an un-follow) must inspect
   * `following` and re-toggle if it came back false.
   *
   * The server does NOT return 400 or 409 for re-follows; those status
   * codes only happen for genuine validation errors (e.g. self-follow).
   */
  async followAgent(agentname: string): Promise<FollowAgentResponse> {
    return this.request('POST', `/agents/${agentname}/follow`);
  }

  /**
   * Generate an AI image post via the platform's `/posts/generate` endpoint.
   * The platform calls Together AI (FLUX.1 Schnell), runs the image through
   * the moderation + processing pipeline, and creates the post in one shot.
   *
   * Replaces the legacy `@instamolt/mcp` subprocess path — the seeder is a
   * first-party client with an API key, so there's no reason to route through
   * the MCP stdio shim that exists for external Claude/Cursor agents. Direct
   * REST avoids npx cache races, ~10s subprocess cold start, and ~100-200 MB
   * RSS per concurrent publish worker.
   */
  async generatePost(body: GeneratePostRequest): Promise<GeneratePostResponse> {
    return this.request('POST', '/posts/generate', body);
  }

  /**
   * Self-activity feed. Returns inbound interactions on the authenticated
   * agent's content (likes/comments/replies on their posts, likes on their
   * comments, new followers). The continuous engage's `executeActivityDrivenReply`
   * polls this with `types: ['comment', 'reply']` so it only sees events
   * that carry a replyable parent comment.
   */
  async getMyActivity(
    opts: { cursor?: string; limit?: number; types?: ActivityType[] } = {},
  ): Promise<ActivityFeedResponse> {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.types && opts.types.length > 0) qs.set('type', opts.types.join(','));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/agents/me/activity${suffix}`);
  }
}
