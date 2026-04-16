import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveFeedCache,
  emptyFeedCache,
  evictStale,
  FEED_CACHE_VERSION,
  FeedCacheEmptyError,
  hasEngaged,
  loadFeedCache,
  loadFeedCacheStrict,
  markEngaged,
  pickPost,
  readFeedCacheFile,
  refreshFeedCache,
  writeFeedCacheFile,
} from '@/lib/feed-cache';
import type { InstaMoltClient } from '@/services/instamolt-api';
import type { FeedSource, RemotePost } from '@/types';

// In-memory fs mock — mirrors the shape used by dedup-index.test.ts.
// Supports readFile, writeFile, and rename so the atomic write-then-rename
// pattern in feed-cache.ts is exercised.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsState.files.set(path, content);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const content = fsState.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    fsState.files.set(to, content);
    fsState.files.delete(from);
  }),
}));

// Stub the logger so warn lines don't pollute test output.
vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

function makePost(id: string, overrides: Partial<RemotePost> = {}): RemotePost {
  return {
    id,
    image_url: `https://cdn/${id}.jpg`,
    thumbnail_url: null,
    caption: `caption ${id}`,
    width: 1080,
    height: 1080,
    format: 'square',
    like_count: 0,
    comment_count: 0,
    view_count: 0,
    popularity_score: 1,
    velocity_score: 1,
    share_count: 0,
    created_at: '2026-04-11T00:00:00Z',
    author: { agentname: 'someone', is_verified: false },
    hashtags: [],
    ...overrides,
  };
}

/**
 * Build a minimal InstaMoltClient mock. `pagesData` is used for
 * getExplorePage AND getPosts (each call pops from the same array in order,
 * simulating sequential page reads across sources). The multi-source
 * refresher calls explore → hot → top → new, consuming pages sequentially.
 */
function mockClient(pagesData: RemotePost[][]): InstaMoltClient {
  let callIdx = 0;
  const handler = vi.fn(async () => {
    const posts = pagesData[callIdx] ?? [];
    callIdx++;
    const hasMore = callIdx < pagesData.length;
    return { posts, has_more: hasMore, page: callIdx, next_page: hasMore ? callIdx + 1 : null };
  });
  return {
    getExplorePage: handler,
    getPosts: handler,
  } as unknown as InstaMoltClient;
}

beforeEach(() => {
  fsState.files.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('emptyFeedCache', () => {
  it('returns a zeroed cache stamped with the epoch so any maxAge check treats it as stale', () => {
    const cache = emptyFeedCache();
    expect(cache.posts).toEqual([]);
    expect(cache.sources).toEqual([]);
    expect(new Date(cache.refreshedAt).getTime()).toBe(0);
  });
});

describe('writeFeedCacheFile + readFeedCacheFile round-trip', () => {
  it('writes with version and reads back intact', async () => {
    const cache = {
      refreshedAt: '2026-04-11T00:00:00.000Z',
      sources: ['explore'] as FeedSource[],
      posts: [makePost('p1')],
    };
    await writeFeedCacheFile('/tmp/feed.json', cache);
    const read = await readFeedCacheFile('/tmp/feed.json');
    expect(read.sources).toContain('explore');
    expect(read.posts).toHaveLength(1);
    expect(read.posts[0]?.id).toBe('p1');
    // On-disk file carries the version tag even though the returned shape doesn't.
    const raw = fsState.files.get('/tmp/feed.json') as string;
    expect(JSON.parse(raw).version).toBe(FEED_CACHE_VERSION);
  });

  it('uses atomic write-then-rename so no .tmp file lingers on success', async () => {
    const cache = {
      refreshedAt: '2026-04-11T00:00:00Z',
      sources: ['explore'] as FeedSource[],
      posts: [],
    };
    await writeFeedCacheFile('/tmp/feed.json', cache);
    expect(fsState.files.has('/tmp/feed.json')).toBe(true);
    expect(fsState.files.has('/tmp/feed.json.tmp')).toBe(false);
  });
});

describe('readFeedCacheFile validation', () => {
  it('throws on missing version', async () => {
    fsState.files.set('/tmp/bad.json', JSON.stringify({ posts: [] }));
    await expect(readFeedCacheFile('/tmp/bad.json')).rejects.toThrow(/missing version/);
  });

  it('throws on version mismatch so callers can fall back to a fresh refresh', async () => {
    fsState.files.set(
      '/tmp/bad.json',
      JSON.stringify({ version: 999, refreshedAt: 'x', sources: ['explore'], posts: [] }),
    );
    await expect(readFeedCacheFile('/tmp/bad.json')).rejects.toThrow(/unsupported version/);
  });

  it('throws when posts is not an array', async () => {
    fsState.files.set(
      '/tmp/bad.json',
      JSON.stringify({
        version: FEED_CACHE_VERSION,
        refreshedAt: 'x',
        sources: ['explore'],
        posts: {},
      }),
    );
    await expect(readFeedCacheFile('/tmp/bad.json')).rejects.toThrow(/posts is not an array/);
  });
});

describe('refreshFeedCache', () => {
  it('paginates across all four sources, dedupes by id, and writes the merged snapshot', async () => {
    // Provide enough pages so explore, hot, top, and new each get data.
    // The mock handler serves them in order — explore gets [a,b], hot gets [b,c] (b deduped),
    // top gets [d], new gets [e]. All global-deduped.
    const client = mockClient([
      [makePost('a'), makePost('b')], // explore page 1
      [makePost('b'), makePost('c')], // hot page 1 (b deduped)
      [makePost('d')], // top page 1
      [makePost('e')], // new page 1
    ]);
    const cache = await refreshFeedCache(client, { pages: 1, limit: 50, path: '/tmp/f.json' });
    expect(cache.posts.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(cache.sources).toEqual(['explore', 'hot', 'top', 'new']);
    expect(fsState.files.has('/tmp/f.json')).toBe(true);
  });

  it('tolerates individual source failures and still includes posts from working sources', async () => {
    // The handler returns one page of data for explore, then rejects for hot/top/new.
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ posts: [makePost('a')], has_more: false }) // explore
      .mockRejectedValueOnce(new Error('hot failed')) // hot
      .mockRejectedValueOnce(new Error('top failed')) // top
      .mockRejectedValueOnce(new Error('new failed')); // new
    const client = { getExplorePage: handler, getPosts: handler } as unknown as InstaMoltClient;
    const cache = await refreshFeedCache(client, { pages: 1, limit: 50, path: '/tmp/f.json' });
    expect(cache.posts.map((p) => p.id)).toEqual(['a']);
    expect(cache.sources).toEqual(['explore']);
  });

  it('uses cursor pagination for sort:"new" and threads next_cursor between pages', async () => {
    // Build per-method mocks so we can inspect the exact args passed to
    // getPosts across iterations. Explore / hot / top each return one page
    // with no more; sort=new returns three pages chained via next_cursor.
    const explorePage = vi.fn(async () => ({
      posts: [makePost('explore-a')],
      has_more: false,
    }));

    const hotAndTop = vi
      .fn()
      .mockImplementationOnce(async () => ({ posts: [makePost('hot-a')], has_more: false }))
      .mockImplementationOnce(async () => ({ posts: [makePost('top-a')], has_more: false }));

    const newCalls: Array<{ sort: string; cursor?: string; page?: number; limit?: number }> = [];
    const newPages = [
      { posts: [makePost('new-1')], has_more: true, next_cursor: 'cursor-1' },
      { posts: [makePost('new-2')], has_more: true, next_cursor: 'cursor-2' },
      // Terminal page: next_cursor is null → loop must break.
      { posts: [makePost('new-3')], has_more: true, next_cursor: null },
    ];

    const getPosts = vi.fn(
      async (opts: { sort: string; cursor?: string; page?: number; limit?: number }) => {
        if (opts.sort === 'new') {
          newCalls.push({ ...opts });
          return newPages[newCalls.length - 1] ?? { posts: [], has_more: false, next_cursor: null };
        }
        return hotAndTop(opts);
      },
    );

    const client = {
      getExplorePage: explorePage,
      getPosts,
    } as unknown as InstaMoltClient;

    const cache = await refreshFeedCache(client, { pages: 5, limit: 50, path: '/tmp/cursor.json' });

    // (a) First new-sort call has no cursor; subsequent calls thread the
    //     cursor returned by the previous page. Page numbers must NOT be
    //     passed for sort:new (we use cursor pagination, not page).
    expect(newCalls).toHaveLength(3);
    expect(newCalls[0]).toMatchObject({ sort: 'new', limit: 50 });
    expect(newCalls[0]?.cursor).toBeUndefined();
    expect(newCalls[0]?.page).toBeUndefined();
    expect(newCalls[1]).toMatchObject({ sort: 'new', cursor: 'cursor-1', limit: 50 });
    expect(newCalls[1]?.page).toBeUndefined();
    expect(newCalls[2]).toMatchObject({ sort: 'new', cursor: 'cursor-2', limit: 50 });
    expect(newCalls[2]?.page).toBeUndefined();

    // (b) Posts from all three new-sort pages are merged in.
    const ids = cache.posts.map((p) => p.id);
    expect(ids).toContain('new-1');
    expect(ids).toContain('new-2');
    expect(ids).toContain('new-3');
  });

  it('stops paginating sort:"new" when next_cursor is missing on the first page', async () => {
    const explorePage = vi.fn(async () => ({ posts: [], has_more: false }));
    const newCalls: Array<{ sort: string; cursor?: string }> = [];
    const getPosts = vi.fn(async (opts: { sort: string; cursor?: string }) => {
      if (opts.sort === 'new') {
        newCalls.push({ ...opts });
        // next_cursor undefined → loop must break immediately, no page 2.
        return { posts: [makePost('only')], has_more: true };
      }
      return { posts: [], has_more: false };
    });

    const client = {
      getExplorePage: explorePage,
      getPosts,
    } as unknown as InstaMoltClient;

    await refreshFeedCache(client, { pages: 5, limit: 50, path: '/tmp/cursor-stop.json' });

    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]?.cursor).toBeUndefined();
  });

  it('throws when ALL sources fail so callers can fall back to a stale cache', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('everything down'));
    const client = { getExplorePage: handler, getPosts: handler } as unknown as InstaMoltClient;
    await expect(
      refreshFeedCache(client, { pages: 1, limit: 50, path: '/tmp/f.json' }),
    ).rejects.toThrow(/all sources failed/);
  });

  it('assigns _source deterministically by explore→hot→top→new precedence regardless of settle order', async () => {
    // Post 'shared' appears in all four sources. Regardless of which parallel
    // pullSource microtask settles first, the merge must always stamp
    // `_source: 'explore'` because explore wins precedence.
    const client = mockClient([
      [makePost('shared'), makePost('exp-only')], // explore
      [makePost('shared'), makePost('hot-only')], // hot
      [makePost('shared'), makePost('top-only')], // top
      [makePost('shared'), makePost('new-only')], // new
    ]);
    const cache = await refreshFeedCache(client, {
      pages: 1,
      limit: 50,
      path: '/tmp/provenance.json',
    });

    const shared = cache.posts.find((p) => p.id === 'shared');
    expect(shared?._source).toBe('explore');
    expect(shared?._sourceRank).toBe(0);

    // Unique posts keep their originating source.
    expect(cache.posts.find((p) => p.id === 'hot-only')?._source).toBe('hot');
    expect(cache.posts.find((p) => p.id === 'top-only')?._source).toBe('top');
    expect(cache.posts.find((p) => p.id === 'new-only')?._source).toBe('new');
  });

  it('assigns precedence correctly when the winning source fails (e.g. explore down → hot wins shared)', async () => {
    // Explore rejects; hot + top + new all return 'shared'. Hot must win.
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('explore down')) // explore
      .mockResolvedValueOnce({ posts: [makePost('shared')], has_more: false }) // hot
      .mockResolvedValueOnce({ posts: [makePost('shared')], has_more: false }) // top
      .mockResolvedValueOnce({ posts: [makePost('shared')], has_more: false }); // new
    const client = { getExplorePage: handler, getPosts: handler } as unknown as InstaMoltClient;
    const cache = await refreshFeedCache(client, {
      pages: 1,
      limit: 50,
      path: '/tmp/prov-fallback.json',
    });
    const shared = cache.posts.find((p) => p.id === 'shared');
    expect(shared?._source).toBe('hot');
  });
});

describe('loadFeedCache', () => {
  it('returns the on-disk cache when it is fresh', async () => {
    const freshCache = {
      refreshedAt: new Date().toISOString(),
      sources: ['explore'] as FeedSource[],
      posts: [makePost('p1')],
    };
    await writeFeedCacheFile('/tmp/f.json', freshCache);
    const client = mockClient([]);

    const res = await loadFeedCache(client, {
      maxAgeMs: 5 * 60_000,
      path: '/tmp/f.json',
    });

    expect(res.posts[0]?.id).toBe('p1');
    expect(client.getExplorePage).not.toHaveBeenCalled();
  });

  it('refreshes when the on-disk cache is stale', async () => {
    const staleCache = {
      refreshedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min old
      sources: ['explore'] as FeedSource[],
      posts: [makePost('old')],
    };
    await writeFeedCacheFile('/tmp/f.json', staleCache);
    const client = mockClient([[makePost('new')]]);

    const res = await loadFeedCache(client, {
      maxAgeMs: 5 * 60_000,
      pages: 1,
      limit: 50,
      path: '/tmp/f.json',
    });

    // The first post in the refreshed cache should come from explore's page 1.
    expect(res.posts[0]?.id).toBe('new');
    // Multi-source: handler is called at least once per source (explore/hot/top/new).
    expect(client.getExplorePage).toHaveBeenCalled();
  });

  it('refreshes when the on-disk file is missing', async () => {
    const client = mockClient([[makePost('fresh')]]);
    const res = await loadFeedCache(client, {
      maxAgeMs: 5 * 60_000,
      pages: 1,
      limit: 50,
      path: '/tmp/missing.json',
    });
    expect(res.posts[0]?.id).toBe('fresh');
    expect(client.getExplorePage).toHaveBeenCalled();
  });

  it('returns the stale cache with a warning when the refresh fails', async () => {
    const staleCache = {
      refreshedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      sources: ['explore'] as FeedSource[],
      posts: [makePost('stale')],
    };
    await writeFeedCacheFile('/tmp/f.json', staleCache);
    // All sources reject so refreshFeedCache throws → loadFeedCache returns stale.
    const handler = vi.fn().mockRejectedValue(new Error('network down'));
    const client = {
      getExplorePage: handler,
      getPosts: handler,
    } as unknown as InstaMoltClient;

    const res = await loadFeedCache(client, {
      maxAgeMs: 5 * 60_000,
      path: '/tmp/f.json',
    });

    expect(res.posts[0]?.id).toBe('stale');
  });

  it('propagates the error when both the on-disk read and refresh fail', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('network down'));
    const client = {
      getExplorePage: handler,
      getPosts: handler,
    } as unknown as InstaMoltClient;

    await expect(
      loadFeedCache(client, { maxAgeMs: 5 * 60_000, path: '/tmp/missing.json' }),
    ).rejects.toThrow(/all sources failed/);
  });
});

describe('pickPost', () => {
  const cache = {
    refreshedAt: '2026-04-11T00:00:00Z',
    sources: ['explore'] as FeedSource[],
    posts: [
      makePost('a', { author: { agentname: 'alice', is_verified: false }, comment_count: 0 }),
      makePost('b', { author: { agentname: 'bob', is_verified: false }, comment_count: 5 }),
      makePost('c', { author: { agentname: 'carol', is_verified: false }, comment_count: 2 }),
    ],
  };

  it('excludes posts authored by the caller', () => {
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0);
    const res = pickPost(cache, { excludeAuthor: 'alice' });
    expect(res?.author.agentname).not.toBe('alice');
    rng.mockRestore();
  });

  it('enforces minCommentCount', () => {
    const seenIds = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = pickPost(cache, { minCommentCount: 1 });
      if (res) seenIds.add(res.id);
    }
    // 'a' has comment_count=0 and must never be picked
    expect(seenIds.has('a')).toBe(false);
    expect(seenIds.has('b')).toBe(true);
    expect(seenIds.has('c')).toBe(true);
  });

  it('uses the scoring function to bias the pick', () => {
    // Give 'b' weight 100 and others weight 1 — 'b' should dominate.
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const res = pickPost(cache, {
        score: (p) => (p.id === 'b' ? 100 : 1),
      });
      if (res) counts.set(res.id, (counts.get(res.id) ?? 0) + 1);
    }
    const bCount = counts.get('b') ?? 0;
    // 'b' should be picked ~97% of the time; allow wide margin for randomness
    expect(bCount).toBeGreaterThan(900);
  });

  it('returns undefined when no candidates pass the filters', () => {
    expect(pickPost(cache, { minCommentCount: 1000 })).toBeUndefined();
  });

  it('excludes zero-weight candidates', () => {
    const seenIds = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = pickPost(cache, {
        score: (p) => (p.id === 'a' ? 0 : 1),
      });
      if (res) seenIds.add(res.id);
    }
    expect(seenIds.has('a')).toBe(false);
  });
});

// --- LiveFeedCache tests ---

describe('createLiveFeedCache', () => {
  it('wraps a FeedCacheFile with an empty engagedBy map', () => {
    const file = {
      refreshedAt: '2026-04-11T00:00:00Z',
      sources: ['explore'] as FeedSource[],
      posts: [makePost('p1')],
    };
    const live = createLiveFeedCache(file);
    expect(live.file).toBe(file);
    expect(live.engagedBy.size).toBe(0);
  });
});

describe('markEngaged / hasEngaged', () => {
  it('tracks per-agent engagement', () => {
    const live = createLiveFeedCache(emptyFeedCache());
    expect(hasEngaged(live, 'agent1', 'post1')).toBe(false);
    markEngaged(live, 'agent1', 'post1');
    expect(hasEngaged(live, 'agent1', 'post1')).toBe(true);
    expect(hasEngaged(live, 'agent2', 'post1')).toBe(false);
  });

  it('allows multiple posts per agent', () => {
    const live = createLiveFeedCache(emptyFeedCache());
    markEngaged(live, 'agent1', 'a');
    markEngaged(live, 'agent1', 'b');
    expect(hasEngaged(live, 'agent1', 'a')).toBe(true);
    expect(hasEngaged(live, 'agent1', 'b')).toBe(true);
    expect(hasEngaged(live, 'agent1', 'c')).toBe(false);
  });
});

describe('evictStale', () => {
  it('removes posts older than the threshold', () => {
    const live = createLiveFeedCache({
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [
        makePost('old', { created_at: new Date(Date.now() - 13 * 3600_000).toISOString() }),
        makePost('new', { created_at: new Date().toISOString() }),
      ],
    });
    const evicted = evictStale(live, 12 * 3600_000);
    expect(evicted).toBe(1);
    expect(live.file.posts).toHaveLength(1);
    expect(live.file.posts[0]?.id).toBe('new');
  });

  it('prunes engagedBy entries for evicted posts', () => {
    const live = createLiveFeedCache({
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [makePost('old', { created_at: new Date(Date.now() - 25 * 3600_000).toISOString() })],
    });
    markEngaged(live, 'agent1', 'old');
    expect(hasEngaged(live, 'agent1', 'old')).toBe(true);
    evictStale(live, 12 * 3600_000);
    expect(hasEngaged(live, 'agent1', 'old')).toBe(false);
  });

  it('returns 0 when nothing is evicted', () => {
    const live = createLiveFeedCache({
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [makePost('fresh', { created_at: new Date().toISOString() })],
    });
    expect(evictStale(live, 12 * 3600_000)).toBe(0);
  });
});

describe('pickPost with LiveFeedCache', () => {
  it('excludes posts the agent has already engaged with', () => {
    const live = createLiveFeedCache({
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [
        makePost('a', {
          created_at: new Date().toISOString(),
          author: { agentname: 'x', is_verified: false },
        }),
        makePost('b', {
          created_at: new Date().toISOString(),
          author: { agentname: 'y', is_verified: false },
        }),
      ],
    });
    markEngaged(live, 'viewer', 'a');

    const seenIds = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = pickPost(live, { agentname: 'viewer' });
      if (res) seenIds.add(res.id);
    }
    expect(seenIds.has('a')).toBe(false);
    expect(seenIds.has('b')).toBe(true);
  });

  it('applies freshness bonus — newer posts picked more often', () => {
    const now = Date.now();
    const live = createLiveFeedCache({
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [
        makePost('fresh', { created_at: new Date(now - 30 * 60_000).toISOString() }), // 30min old → 2x
        makePost('old', { created_at: new Date(now - 8 * 3600_000).toISOString() }), // 8h old → 0.5x
      ],
    });

    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const res = pickPost(live);
      if (res) counts.set(res.id, (counts.get(res.id) ?? 0) + 1);
    }
    // With 2x vs 0.5x weights (4:1 ratio), fresh should dominate
    expect(counts.get('fresh') ?? 0).toBeGreaterThan((counts.get('old') ?? 0) * 2);
  });

  it('still works with plain FeedCacheFile (no freshness applied)', () => {
    const plain = {
      refreshedAt: new Date().toISOString(),
      sources: ['explore'] as FeedSource[],
      posts: [makePost('p1', { created_at: new Date().toISOString() })],
    };
    const res = pickPost(plain);
    expect(res?.id).toBe('p1');
  });
});

describe('FeedCacheEmptyError', () => {
  it('is an Error subclass with a recognizable name', () => {
    const err = new FeedCacheEmptyError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FeedCacheEmptyError');
  });

  it('accepts a custom message', () => {
    const err = new FeedCacheEmptyError('custom reason');
    expect(err.message).toBe('custom reason');
  });
});

describe('loadFeedCacheStrict', () => {
  const path = '/tmp/feed.json';

  beforeEach(() => {
    fsState.files.clear();
  });

  it('returns the on-disk cache when fresh and non-empty (no refresh)', async () => {
    await writeFeedCacheFile(path, {
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [makePost('p1')],
    });
    const client = mockClient([]);

    const result = await loadFeedCacheStrict(client, { maxAgeMs: 60_000, path });

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.id).toBe('p1');
  });

  it('refreshes when the on-disk cache is missing', async () => {
    // No file on disk → first read throws → strict loader must refresh.
    const client = mockClient([[makePost('fresh')]]);

    const result = await loadFeedCacheStrict(client, { maxAgeMs: 60_000, path });

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.id).toBe('fresh');
    // Refresh should have persisted the cache to disk.
    expect(fsState.files.has(path)).toBe(true);
  });

  it('refreshes when the on-disk cache is stale', async () => {
    // Cache timestamped 10 min ago, maxAge 1 min → stale → refresh.
    await writeFeedCacheFile(path, {
      refreshedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      sources: ['explore'],
      posts: [makePost('stale-p1')],
    });
    const client = mockClient([[makePost('fresh-after-refresh')]]);

    const result = await loadFeedCacheStrict(client, { maxAgeMs: 60_000, path });

    // The refresh should override the stale snapshot, not serve it.
    expect(result.posts.map((p) => p.id)).toContain('fresh-after-refresh');
    expect(result.posts.map((p) => p.id)).not.toContain('stale-p1');
  });

  it('refreshes when the on-disk cache is fresh but empty', async () => {
    // A fresh-but-empty cache is still a hard-abort trigger: we must refresh
    // rather than happily return zero posts to the caller.
    await writeFeedCacheFile(path, {
      refreshedAt: new Date().toISOString(),
      sources: ['explore'],
      posts: [],
    });
    const client = mockClient([[makePost('after-refresh')]]);

    const result = await loadFeedCacheStrict(client, { maxAgeMs: 60_000, path });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.id).toBe('after-refresh');
  });

  it('throws FeedCacheEmptyError when the refresh returns zero posts', async () => {
    // No disk cache, and the live refresh (all four sources) returns nothing.
    const client = mockClient([[], [], [], []]);

    await expect(loadFeedCacheStrict(client, { maxAgeMs: 60_000, path })).rejects.toThrow(
      FeedCacheEmptyError,
    );
  });

  it('propagates refresh errors instead of serving stale (no silent fallback)', async () => {
    // Stale disk cache exists, but every refresh source throws → the strict
    // loader re-throws the refresh error rather than returning the stale
    // snapshot (unlike loadFeedCache which would).
    await writeFeedCacheFile(path, {
      refreshedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      sources: ['explore'],
      posts: [makePost('stale')],
    });
    const client = {
      getExplorePage: vi.fn(async () => {
        throw new Error('network down');
      }),
      getPosts: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as unknown as InstaMoltClient;

    await expect(loadFeedCacheStrict(client, { maxAgeMs: 60_000, path })).rejects.toThrow(
      /all sources failed/,
    );
  });
});
