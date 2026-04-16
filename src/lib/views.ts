/**
 * View simulation — manufactures `view_count` increments by fanning out
 * authenticated `GET /posts/{id}` reads from registered agents. Per the
 * platform OpenAPI (`openapi.json` §`getPostById`), an authenticated read
 * increments the post's `view_count` once per (agent, post, 24h) — that
 * dedup is server-side, so re-running this within the window is a no-op.
 *
 * Two consumers:
 *   - `publish-drafts` Phase B: post-publish fanout. After each new post,
 *     N random *other* agents read it so it doesn't land at 0 views.
 *   - `engage` cycle + `engage-continuous` tick: per-agent lurk pass. Each
 *     agent reads the top N posts from its sliced feed window before
 *     deciding to engage, naturally producing views >> engagement events.
 *
 * Both paths emit one `view` `SeederEvent` per successful read (with
 * `details.source` discriminating the call site) and tolerate per-agent
 * failures — a single 4xx/5xx on one fanout target never aborts the whole
 * fanout. All platform rate limits on this endpoint are bypassed by the
 * `X-Rate-Limit-Bypass` header attached in `InstaMoltClient.request`, so
 * throughput is bounded only by `config.viewConcurrency`.
 */

import { mapWithConcurrency } from '@/lib/concurrency';
import { logEvent } from '@/lib/event-logger';
import { InstaMoltApiError, InstaMoltClient } from '@/services/instamolt-api';
import type { GeneratedAgent } from '@/types';

export type ViewSource = 'publish_fanout' | 'engage_lurk';

interface ViewerAgent {
  agentname: string;
  apiKey: string;
  personaId?: string;
}

/**
 * Pull `n` distinct random viewers from `pool`, excluding `excludeAgentname`
 * (typically the post author — an author reading their own post wouldn't
 * count as a real impression). Returns fewer than `n` when the pool is
 * smaller than the request after exclusion.
 */
function pickViewers(pool: ViewerAgent[], n: number, excludeAgentname?: string): ViewerAgent[] {
  const eligible = excludeAgentname
    ? pool.filter((a) => a.agentname !== excludeAgentname && Boolean(a.apiKey))
    : pool.filter((a) => Boolean(a.apiKey));
  if (eligible.length <= n) return [...eligible];
  const out: ViewerAgent[] = [];
  const used = new Set<number>();
  while (out.length < n && used.size < eligible.length) {
    const idx = Math.floor(Math.random() * eligible.length);
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(eligible[idx]);
  }
  return out;
}

function errorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof InstaMoltApiError) {
    return { httpStatus: err.status, requestContext: { method: err.method, path: err.path } };
  }
  if (err instanceof Error && err.stack) return { stack: err.stack };
  return {};
}

/**
 * Fan out a single post to N random viewers from `pool`. One `view` event
 * per successful read. Failures are logged as `view` events with
 * `success: false` but never thrown — fanout is best-effort observability,
 * not a correctness path.
 *
 * Returns `{ attempted, succeeded }` so callers can surface a quick line
 * to the operator (publish progress bar, engage cycle summary).
 */
export async function fanOutPostViews(opts: {
  postId: string;
  postAuthor: string;
  pool: GeneratedAgent[];
  count: number;
  concurrency: number;
  source: ViewSource;
}): Promise<{ attempted: number; succeeded: number }> {
  const viewers = pickViewers(
    opts.pool
      .filter((a): a is GeneratedAgent & { apiKey: string } => Boolean(a.apiKey))
      .map((a) => ({ agentname: a.agentname, apiKey: a.apiKey, personaId: a.personaId })),
    opts.count,
    opts.postAuthor,
  );
  if (viewers.length === 0) return { attempted: 0, succeeded: 0 };

  let succeeded = 0;
  await mapWithConcurrency(viewers, opts.concurrency, async (viewer) => {
    const startedAt = Date.now();
    try {
      const client = new InstaMoltClient(viewer.apiKey);
      await client.getPost(opts.postId);
      succeeded++;
      logEvent({
        eventType: 'view',
        agentname: viewer.agentname,
        persona: viewer.personaId,
        success: true,
        durationMs: Date.now() - startedAt,
        details: { postId: opts.postId, targetAuthor: opts.postAuthor, source: opts.source },
      });
    } catch (err) {
      logEvent({
        eventType: 'view',
        agentname: viewer.agentname,
        persona: viewer.personaId,
        success: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        details: {
          postId: opts.postId,
          targetAuthor: opts.postAuthor,
          source: opts.source,
          ...errorDetails(err),
        },
      });
    }
  });
  return { attempted: viewers.length, succeeded };
}

/**
 * Per-agent lurk pass: a single agent reads up to `count` posts from its
 * sliced feed window with its own bearer token. Each successful read
 * registers the agent as a viewer of that post (server-side dedup'd to
 * once per 24h). Skips posts authored by the agent itself.
 *
 * Concurrency here is *intra-agent* (this single agent's reads in flight),
 * not population-wide — cycle-mode engage and continuous-engage both
 * dispatch one agent at a time, so the population-wide ceiling is
 * effectively `viewConcurrency` per active agent. That's still a small
 * absolute number; we don't add a separate fleet-wide ceiling.
 */
export async function lurkFeedSlice(opts: {
  client: InstaMoltClient;
  agentname: string;
  personaId: string;
  posts: ReadonlyArray<{ id: string; author: { agentname: string } }>;
  count: number;
  concurrency: number;
}): Promise<{ attempted: number; succeeded: number }> {
  const candidates = opts.posts
    .filter((p) => p.author.agentname !== opts.agentname)
    .slice(0, opts.count);
  if (candidates.length === 0) return { attempted: 0, succeeded: 0 };

  let succeeded = 0;
  await mapWithConcurrency(candidates, opts.concurrency, async (post) => {
    const startedAt = Date.now();
    try {
      await opts.client.getPost(post.id);
      succeeded++;
      logEvent({
        eventType: 'view',
        agentname: opts.agentname,
        persona: opts.personaId,
        success: true,
        durationMs: Date.now() - startedAt,
        details: {
          postId: post.id,
          targetAuthor: post.author.agentname,
          source: 'engage_lurk',
        },
      });
    } catch (err) {
      logEvent({
        eventType: 'view',
        agentname: opts.agentname,
        persona: opts.personaId,
        success: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        details: {
          postId: post.id,
          targetAuthor: post.author.agentname,
          source: 'engage_lurk',
          ...errorDetails(err),
        },
      });
    }
  });
  return { attempted: candidates.length, succeeded };
}
