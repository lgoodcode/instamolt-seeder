/**
 * Shared top-N prod feed cache for the continuous engage scheduler.
 *
 * One refresher populates `output/feed-cache.json` with the top N posts from
 * `/feed/explore` (paginated), and every agent's tick reads from the same
 * file. This keeps the server-visible access pattern sane — the cache is
 * refreshed ~every 5 minutes regardless of population size, instead of each
 * agent independently pulling 200 posts on every tick.
 *
 * Follows the same substrate-with-fallback shape as
 * [src/lib/dedup-index.ts](./dedup-index.ts):
 *
 * - Versioned JSON file with a light shape-check on read (`readFeedCacheFile`)
 * - Atomic write-then-rename so a crash mid-refresh leaves the previous
 *   snapshot readable (`writeFeedCacheFile`)
 * - `loadFeedCache` treats the file as fast-path, falls through to a live
 *   `refreshFeedCache` on miss/stale/corrupt, and returns the stale snapshot
 *   (with a warning) if the refresh itself fails
 *
 * The module is pure-data plus two network actions; callers (executors,
 * scheduler) drive when to refresh vs read.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { config, FEED_CACHE_DEFAULT_LIMIT, FEED_CACHE_DEFAULT_PAGES } from '@/config';
import { log } from '@/lib/logger';
import type { InstaMoltClient } from '@/services/instamolt-api';
import type { FeedCacheFile, FeedSource, RemoteFeedResponse, RemotePost } from '@/types';

/**
 * Thrown by {@link loadFeedCacheStrict} when the live platform has no posts
 * to interact with. Seed-time callers (`generate`, cycle-mode `engage`,
 * `preview-comments`) treat this as a hard abort — the seeder's entire value
 * is that agents interact with real content, so an empty feed means there's
 * nothing legitimate to do.
 */
export class FeedCacheEmptyError extends Error {
  constructor(message = 'Live feed is empty — publish real posts before seeding') {
    super(message);
    this.name = 'FeedCacheEmptyError';
  }
}

/** Current on-disk schema version. Bump when the shape changes. */
export const FEED_CACHE_VERSION = 2;

interface FeedCacheFileOnDisk extends FeedCacheFile {
  version: number;
}

const VALID_SOURCES: readonly FeedSource[] = ['explore', 'hot', 'top', 'new'];

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Build a fresh empty cache — callers should prefer `refreshFeedCache`. */
export function emptyFeedCache(): FeedCacheFile {
  return {
    refreshedAt: new Date(0).toISOString(),
    sources: [],
    posts: [],
  };
}

/**
 * Read the cache from disk. Throws if missing, malformed, or version-skewed —
 * callers (`loadFeedCache`) catch this and fall back to a live refresh.
 */
export async function readFeedCacheFile(path: string): Promise<FeedCacheFile> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateFeedCache(parsed);
}

function validateFeedCache(value: unknown): FeedCacheFile {
  if (!value || typeof value !== 'object') {
    throw new Error('feed-cache: not an object');
  }
  const v = value as Partial<FeedCacheFileOnDisk>;
  if (typeof v.version !== 'number') {
    throw new Error('feed-cache: missing version');
  }
  if (v.version !== FEED_CACHE_VERSION) {
    throw new Error(
      `feed-cache: unsupported version ${v.version} (expected ${FEED_CACHE_VERSION})`,
    );
  }
  if (typeof v.refreshedAt !== 'string') {
    throw new Error('feed-cache: missing refreshedAt');
  }
  // Accept both the v1 `source: string` shape and the v2 `sources: string[]` shape.
  const sources: FeedSource[] = Array.isArray(v.sources)
    ? (v.sources.filter(
        (s: unknown) => typeof s === 'string' && VALID_SOURCES.includes(s as FeedSource),
      ) as FeedSource[])
    : [];
  if (!Array.isArray(v.posts)) {
    throw new Error('feed-cache: posts is not an array');
  }
  return {
    refreshedAt: v.refreshedAt,
    sources,
    posts: v.posts as RemotePost[],
  };
}

/**
 * Atomic write-then-rename so a crash mid-refresh leaves the previous cache
 * snapshot intact. `rename` is atomic on the same filesystem — Node on
 * Windows also implements this via `MoveFileEx` with REPLACE_EXISTING, so
 * the pattern is cross-platform.
 */
export async function writeFeedCacheFile(path: string, cache: FeedCacheFile): Promise<void> {
  const tmp = `${path}.tmp`;
  const onDisk: FeedCacheFileOnDisk = { version: FEED_CACHE_VERSION, ...cache };
  await writeFile(tmp, JSON.stringify(onDisk, null, 2));
  await rename(tmp, path);
}

// --- LiveFeedCache: in-memory wrapper with engagement tracking + freshness ---

const FRESHNESS_BONUS_MS = 2 * 3600_000; // Posts < 2h old get 2x weight
const FRESHNESS_NEUTRAL_MS = 6 * 3600_000; // Posts 2-6h old get 1x weight
const FRESHNESS_PENALTY_FACTOR = 0.5; // Posts > 6h old get 0.5x weight
const CACHE_EVICTION_MAX_AGE_MS = 12 * 3600_000; // Evict posts > 12h old

/**
 * In-memory wrapper around the on-disk `FeedCacheFile`. Adds:
 * - `engagedBy`: tracks which agents have interacted with which posts (prevents dogpiling)
 * - Freshness weighting applied in `pickPost` (newer posts get higher weight)
 *
 * `engagedBy` is purely in-memory — resets on process restart, which is fine
 * because a new session means a fresh engagement slate.
 */
export interface LiveFeedCache {
  file: FeedCacheFile;
  /** agentname → Set of post IDs this agent has engaged with. */
  engagedBy: Map<string, Set<string>>;
}

export function createLiveFeedCache(file: FeedCacheFile): LiveFeedCache {
  return { file, engagedBy: new Map() };
}

export function markEngaged(cache: LiveFeedCache, agentname: string, postId: string): void {
  let set = cache.engagedBy.get(agentname);
  if (!set) {
    set = new Set();
    cache.engagedBy.set(agentname, set);
  }
  set.add(postId);
}

export function hasEngaged(cache: LiveFeedCache, agentname: string, postId: string): boolean {
  return cache.engagedBy.get(agentname)?.has(postId) ?? false;
}

/**
 * Compute a freshness multiplier for a post based on its `created_at` age.
 * Newer posts get higher weight, modeling the real-world behavior of seeing
 * new content at the top of a feed.
 */
function freshnessMultiplier(post: RemotePost): number {
  const ageMs = Date.now() - Date.parse(post.created_at);
  if (ageMs < FRESHNESS_BONUS_MS) return 2.0;
  if (ageMs < FRESHNESS_NEUTRAL_MS) return 1.0;
  return FRESHNESS_PENALTY_FACTOR;
}

/**
 * Evict posts older than `maxAgeMs` from the cache. Also prunes `engagedBy`
 * entries for evicted post IDs. Returns the number of evicted posts.
 */
export function evictStale(cache: LiveFeedCache, maxAgeMs = CACHE_EVICTION_MAX_AGE_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  const before = cache.file.posts.length;
  const evictedIds = new Set<string>();

  cache.file.posts = cache.file.posts.filter((p) => {
    const createdAt = Date.parse(p.created_at);
    if (createdAt < cutoff) {
      evictedIds.add(p.id);
      return false;
    }
    return true;
  });

  // Prune engagedBy for evicted posts
  if (evictedIds.size > 0) {
    for (const set of cache.engagedBy.values()) {
      for (const id of evictedIds) set.delete(id);
    }
  }

  return before - cache.file.posts.length;
}

/**
 * Pull paginated posts from a single source. Returns a deduped array.
 * `seen` is mutated so callers who chain multiple pulls get global dedup.
 *
 * Pagination model depends on the source:
 * - `explore`, `hot`, `top` → page-based (`?page=N`)
 * - `new` → cursor-based (`?cursor=<ISO>`), because the platform returns a
 *   time-ordered slice keyed off `next_cursor`. Iterating with `page=2..N`
 *   on `sort=new` would re-hit the first cursorless slice and under-sample
 *   fresh posts, so we thread `next_cursor` between iterations and break
 *   when the server stops returning one.
 */
async function pullSource(
  client: InstaMoltClient,
  source: FeedSource,
  pages: number,
  limit: number,
  seen: Set<string>,
): Promise<RemotePost[]> {
  const out: RemotePost[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= pages; page++) {
    let res: RemoteFeedResponse;
    if (source === 'explore') {
      res = await client.getExplorePage(page, limit);
    } else if (source === 'new') {
      res = await client.getPosts({ sort: 'new', cursor, limit });
    } else {
      res = await client.getPosts({ sort: source, page, limit });
    }
    for (const post of res.posts ?? []) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      out.push(post);
    }
    if (source === 'new') {
      // Cursor-based: stop when the server doesn't hand us a next cursor.
      const next = res.next_cursor;
      if (!next) break;
      cursor = next;
    }
    if (res.has_more === false) break;
  }
  return out;
}

/**
 * Live refresh: pull posts from up to four sources —
 *
 *   `/feed/explore`   — popularity with time decay (the "what users see" baseline)
 *   `/posts?sort=hot`  — un-decayed velocity; what's trending RIGHT NOW
 *   `/posts?sort=top`  — decayed popularity; best of the last few days
 *   `/posts?sort=new`  — reverse-chronological; catches fresh posts before they rank
 *
 * The default page budget (`opts.pages`, default 4) applies PER source, so
 * a 4-page × 50-limit × 4-source refresh pulls up to 800 candidate posts
 * (deduped by id, so the final count is lower — typically 300–500 unique).
 *
 * Deduping is global: a post that appears in both `explore` and `hot` only
 * keeps the first copy, so the cache has no duplicates regardless of how
 * many sources overlap.
 *
 * Source failures are tolerated: if one source 404s or 429s, the others
 * still contribute. Only a total failure (zero posts from any source) is
 * treated as a hard error by the caller.
 *
 * Does NOT catch network errors for the whole batch — callers wrap this
 * in their own try/catch to decide whether to fall back to a stale cache.
 */
export async function refreshFeedCache(
  client: InstaMoltClient,
  opts: { pages?: number; limit?: number; path?: string } = {},
): Promise<FeedCacheFile> {
  const pages = opts.pages ?? FEED_CACHE_DEFAULT_PAGES;
  const limit = opts.limit ?? FEED_CACHE_DEFAULT_LIMIT;
  const path = opts.path ?? config.feedCachePath;

  const seen = new Set<string>();
  const merged: RemotePost[] = [];
  const successSources: FeedSource[] = [];

  // Pull from all four sources in parallel. Each `pullSource` call is an
  // independent HTTP read; the shared `seen` Set is safe under concurrent
  // mutation because `Set.prototype.add` / `has` are atomic in V8 (no
  // multi-step promise races inside them). Settling all four and inspecting
  // the results — rather than throwing on the first failure — matches the
  // sequential behaviour this replaces: one bad source should not abort the
  // whole refresh.
  const sourcesToPull: FeedSource[] = ['explore', 'hot', 'top', 'new'];
  const sourceResults = await Promise.allSettled(
    sourcesToPull.map((source) => pullSource(client, source, pages, limit, seen)),
  );
  sourceResults.forEach((result, i) => {
    const source = sourcesToPull[i] as FeedSource;
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
      successSources.push(source);
      log('info', `feed-cache: ${source} → ${result.value.length} new (${merged.length} total)`);
    } else {
      log(
        'warn',
        `feed-cache: ${source} failed (${result.reason}) — continuing with other sources`,
      );
    }
  });

  // If every source failed, throw so the caller (loadFeedCache) can fall
  // back to a stale on-disk snapshot. An empty-but-successful pull (all
  // sources returned zero posts) is still valid — only total failure throws.
  if (successSources.length === 0) {
    throw new Error('feed-cache: all sources failed — no posts retrieved');
  }

  const cache: FeedCacheFile = {
    refreshedAt: new Date().toISOString(),
    sources: successSources,
    posts: merged,
  };
  await writeFeedCacheFile(path, cache);
  return cache;
}

/**
 * Fast-path feed cache read with fallback semantics:
 *
 * 1. Try to read `output/feed-cache.json`.
 * 2. If missing/corrupt → live refresh → return.
 * 3. If fresh enough (< maxAgeMs) → return as-is.
 * 4. If stale → live refresh → return on success; return the stale cache
 *    with a warning on refresh failure.
 *
 * If the cache is missing AND the refresh fails, the error propagates — the
 * scheduler should pause the run rather than operate against an empty feed.
 */
export async function loadFeedCache(
  client: InstaMoltClient,
  opts: { maxAgeMs: number; pages?: number; limit?: number; path?: string },
): Promise<FeedCacheFile> {
  const path = opts.path ?? config.feedCachePath;

  let current: FeedCacheFile | null = null;
  try {
    current = await readFeedCacheFile(path);
  } catch (err) {
    if (isMissingFileError(err)) {
      log('info', 'feed-cache: no local snapshot — fetching fresh from server');
    } else {
      log('warn', `feed-cache: local snapshot unreadable (${err}) — fetching fresh from server`);
    }
    return refreshFeedCache(client, {
      pages: opts.pages,
      limit: opts.limit,
      path,
    });
  }

  const ageMs = Date.now() - Date.parse(current.refreshedAt);
  if (ageMs < opts.maxAgeMs) return current;

  try {
    return await refreshFeedCache(client, {
      pages: opts.pages,
      limit: opts.limit,
      path,
    });
  } catch (err) {
    log(
      'warn',
      `feed-cache refresh failed (${err}) — serving stale cache (age ${Math.round(ageMs / 1000)}s)`,
    );
    return current;
  }
}

/**
 * Strict variant of {@link loadFeedCache} for seed-time consumers.
 *
 * Unlike `loadFeedCache`, this function NEVER serves a stale cache and NEVER
 * tolerates an empty result:
 *
 * 1. If the on-disk cache is fresh AND non-empty, return it.
 * 2. Otherwise (missing, corrupt, stale, or empty) refresh from the live API.
 *    Any refresh error propagates — we do not fall back to a stale snapshot.
 * 3. If the refresh succeeds but returns zero posts, throw {@link
 *    FeedCacheEmptyError}. The platform having no content is a seed-abort
 *    condition, not a "try again with degraded data" case.
 *
 * Used by `generate`'s comment-bake phase, cycle-mode `engage`, and
 * `preview-comments` so every baked / runtime interaction targets real live
 * content. `engage-continuous` keeps using the non-strict `loadFeedCache`
 * because its long-running loop benefits from the stale-serve resilience.
 */
export async function loadFeedCacheStrict(
  client: InstaMoltClient,
  opts: { maxAgeMs: number; pages?: number; limit?: number; path?: string },
): Promise<FeedCacheFile> {
  const path = opts.path ?? config.feedCachePath;

  let current: FeedCacheFile | null = null;
  try {
    current = await readFeedCacheFile(path);
  } catch (err) {
    if (isMissingFileError(err)) {
      log('info', 'feed-cache: no local snapshot — fetching fresh from server');
    } else {
      log('info', `feed-cache: local snapshot unreadable (${err}) — fetching fresh from server`);
    }
  }

  const ageMs = current ? Date.now() - Date.parse(current.refreshedAt) : Number.POSITIVE_INFINITY;
  if (current && ageMs < opts.maxAgeMs && current.posts.length > 0) {
    return current;
  }

  const refreshed = await refreshFeedCache(client, {
    pages: opts.pages,
    limit: opts.limit,
    path,
  });
  if (refreshed.posts.length === 0) {
    throw new FeedCacheEmptyError();
  }
  return refreshed;
}

export interface PickPostOptions {
  /** Exclude this author's posts (for filtering out the commenter's own). */
  excludeAuthor?: string;
  /** Minimum comment_count — use 1+ when looking for a post to reply on. */
  minCommentCount?: number;
  /**
   * Optional per-post scoring function. Returns a non-negative number; higher
   * weights are more likely to be picked. Default 1.0 for every candidate.
   * Scheduler passes a persona-relationship-aware scorer here.
   */
  score?: (post: RemotePost) => number;
  /** If provided, exclude posts this agent has already engaged with. */
  agentname?: string;
}

/**
 * Weighted-random pick from the cached posts. Returns undefined if no post
 * passes the filters. Weights of 0 are excluded; the final pick is a
 * standard cumulative-weight scan so the probability of a post is
 * proportional to its score.
 *
 * Accepts either a raw `FeedCacheFile` (backward-compatible) or a
 * `LiveFeedCache` wrapper. When a `LiveFeedCache` is passed, engaged-post
 * filtering and freshness weighting are applied automatically.
 */
export function pickPost(
  cache: FeedCacheFile | LiveFeedCache,
  opts: PickPostOptions = {},
): RemotePost | undefined {
  const isLive = 'file' in cache;
  const posts = isLive ? (cache as LiveFeedCache).file.posts : (cache as FeedCacheFile).posts;
  const liveCache = isLive ? (cache as LiveFeedCache) : null;

  const candidates: Array<{ post: RemotePost; weight: number }> = [];
  for (const post of posts) {
    if (opts.excludeAuthor && post.author.agentname === opts.excludeAuthor) continue;
    if (opts.minCommentCount !== undefined && post.comment_count < opts.minCommentCount) {
      continue;
    }
    // Skip posts this agent has already engaged with
    if (opts.agentname && liveCache && hasEngaged(liveCache, opts.agentname, post.id)) continue;

    let weight = opts.score ? opts.score(post) : 1;
    if (weight <= 0) continue;
    // Apply freshness bonus when using LiveFeedCache
    if (liveCache) weight *= freshnessMultiplier(post);
    candidates.push({ post, weight });
  }
  if (candidates.length === 0) return undefined;

  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * total;
  for (const { post, weight } of candidates) {
    r -= weight;
    if (r <= 0) return post;
  }
  return candidates[candidates.length - 1]?.post;
}
