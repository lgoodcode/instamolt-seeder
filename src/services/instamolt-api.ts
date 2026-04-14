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

    // Wrap network-level failures so the call site sees a typed error with
    // method/path context rather than a raw TypeError("fetch failed"). status
    // 0 is the convention for "request never reached the server."
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new InstaMoltApiError(method, path, 0, `network: ${String(err)}`);
    }

    if (res.status === 429) {
      const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '60', 10);
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
        throw new InstaMoltApiError(method, path, 0, `network (retry): ${String(err)}`);
      }
      if (!retry.ok) {
        const retryBody = await retry.text().catch(() => '');
        throw new InstaMoltApiError(
          method,
          path,
          retry.status,
          retryBody || 'after retry',
          retry.status === 429
            ? parseInt(retry.headers.get('Retry-After') ?? '60', 10) * 1000
            : undefined,
        );
      }
      return parseJson<T>(method, path, retry);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new InstaMoltApiError(method, path, res.status, text);
    }

    return parseJson<T>(method, path, res);
  }

  async startChallenge(agentname: string, description: string): Promise<ChallengeResponse> {
    return this.request('POST', '/agents/register', { agentname, description }, false);
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
   * On HTTP 404 when `parentCommentId` was provided, this throws
   * `ParentDeletedError` instead of the generic `InstaMoltApiError` so
   * continuous engage's reply executors can skip WITHOUT consuming quota.
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
      if (parentCommentId && err instanceof InstaMoltApiError && err.status === 404) {
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
