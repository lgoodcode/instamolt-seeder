import { readFile as actualReadFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTrendingPool,
  pickTrendingHashtags,
  TRENDING_POOL_VERSION,
  validateTrendingPool,
} from '@/lib/trending-pool';
import { PERSONA_CATALOG } from '@/personas/catalog';
import type { Persona } from '@/types';

// In-memory fs mock — same shape as tests/lib/feed-cache.test.ts. `readFile`
// is the only fs call the trending-pool helper makes, and we need the real
// `readFile` for the final "cross-check the committed JSON against the
// catalog" test, so the mock falls back to the real implementation when a
// path is not registered in the in-memory map.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(async (p: string, encoding?: string) => {
      const content = fsState.files.get(p);
      if (content !== undefined) return content;
      return actual.readFile(p, encoding as BufferEncoding);
    }),
  };
});

function makePersona(id: string): Persona {
  // Minimal shape — pickTrendingHashtags only reads `id`, so the other
  // fields are stubbed out. Cast through `unknown` rather than building a
  // full valid Persona, because the test never exercises those fields.
  return { id } as unknown as Persona;
}

beforeEach(() => {
  fsState.files.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadTrendingPool', () => {
  it('reads and validates a well-formed pool from disk', async () => {
    const fixture = {
      version: TRENDING_POOL_VERSION,
      pool: [
        { tag: 'foo', vibes: ['ratio_king'] },
        { tag: 'bar', vibes: [] },
      ],
    };
    fsState.files.set('/tmp/pool.json', JSON.stringify(fixture));

    const pool = await loadTrendingPool('/tmp/pool.json');

    expect(pool.version).toBe(TRENDING_POOL_VERSION);
    expect(pool.pool).toHaveLength(2);
    expect(pool.pool[0]?.tag).toBe('foo');
    expect(pool.pool[0]?.vibes).toEqual(['ratio_king']);
  });

  it('throws on missing version', async () => {
    fsState.files.set('/tmp/bad.json', JSON.stringify({ pool: [] }));
    await expect(loadTrendingPool('/tmp/bad.json')).rejects.toThrow(/missing version/);
  });

  it('throws on unsupported version', async () => {
    fsState.files.set(
      '/tmp/bad.json',
      JSON.stringify({ version: 999, pool: [{ tag: 'x', vibes: [] }] }),
    );
    await expect(loadTrendingPool('/tmp/bad.json')).rejects.toThrow(/unsupported version/);
  });

  it('throws when pool is not an array', async () => {
    fsState.files.set(
      '/tmp/bad.json',
      JSON.stringify({ version: TRENDING_POOL_VERSION, pool: {} }),
    );
    await expect(loadTrendingPool('/tmp/bad.json')).rejects.toThrow(/pool is not an array/);
  });

  it('throws when the pool is empty', async () => {
    fsState.files.set(
      '/tmp/empty.json',
      JSON.stringify({ version: TRENDING_POOL_VERSION, pool: [] }),
    );
    await expect(loadTrendingPool('/tmp/empty.json')).rejects.toThrow(/pool is empty/);
  });

  it('throws when an entry has malformed vibes', async () => {
    fsState.files.set(
      '/tmp/bad.json',
      JSON.stringify({
        version: TRENDING_POOL_VERSION,
        pool: [{ tag: 'x', vibes: 'not-an-array' }],
      }),
    );
    await expect(loadTrendingPool('/tmp/bad.json')).rejects.toThrow(/malformed vibes/);
  });
});

describe('pickTrendingHashtags', () => {
  const fixture = {
    version: TRENDING_POOL_VERSION,
    pool: [
      { tag: 'matched1', vibes: ['ratio_king'] },
      { tag: 'matched2', vibes: ['ratio_king', 'engagement_max'] },
      { tag: 'unmatched1', vibes: ['creature_feature'] },
      { tag: 'unmatched2', vibes: [] },
      { tag: 'unmatched3', vibes: [] },
    ],
  };

  it('returns exactly `count` tags when the pool has enough entries', () => {
    const persona = makePersona('ratio_king');
    const one = pickTrendingHashtags(fixture, persona, 1);
    const two = pickTrendingHashtags(fixture, persona, 2);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(2);
  });

  it('dedupes picks even when count=2 (no tag repeats)', () => {
    const persona = makePersona('ratio_king');
    for (let i = 0; i < 200; i++) {
      const picks = pickTrendingHashtags(fixture, persona, 2);
      expect(picks).toHaveLength(2);
      expect(new Set(picks).size).toBe(2);
    }
  });

  it('returns bare tags (no # prefix) matching the source format', () => {
    const persona = makePersona('ratio_king');
    const picks = pickTrendingHashtags(fixture, persona, 2);
    for (const tag of picks) {
      expect(tag).not.toMatch(/^#/);
      expect(tag).toMatch(/^[a-z0-9_]+$/i);
    }
  });

  it('over-represents vibe-matched tags at N=500 rolls', () => {
    const persona = makePersona('ratio_king');
    const counts = new Map<string, number>();
    for (let i = 0; i < 500; i++) {
      const picks = pickTrendingHashtags(fixture, persona, 1);
      for (const tag of picks) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const matchedCount = (counts.get('matched1') ?? 0) + (counts.get('matched2') ?? 0);
    const unmatchedCount =
      (counts.get('unmatched1') ?? 0) +
      (counts.get('unmatched2') ?? 0) +
      (counts.get('unmatched3') ?? 0);
    // With TRENDING_MATCH_BIAS=0.6 and 2 matched entries vs 3 unmatched,
    // matched picks should clear ~300/500 and unmatched ~200/500. Allow a
    // wide margin (matched > unmatched) to avoid flakiness.
    expect(matchedCount).toBeGreaterThan(unmatchedCount);
  });

  it('falls through to unmatched when the persona has no vibe match', () => {
    const persona = makePersona('no_such_persona');
    const picks = pickTrendingHashtags(fixture, persona, 2);
    expect(picks).toHaveLength(2);
    // Every pick must come from the unmatched side since matched is empty.
    for (const tag of picks) {
      expect(['matched1', 'matched2', 'unmatched1', 'unmatched2', 'unmatched3']).toContain(tag);
    }
  });
});

describe('validateTrendingPool', () => {
  it('returns ok when every vibe resolves', () => {
    const pool = {
      version: TRENDING_POOL_VERSION,
      pool: [
        { tag: 'a', vibes: ['ratio_king'] },
        { tag: 'b', vibes: [] },
      ],
    };
    const known = new Set(['ratio_king']);
    expect(validateTrendingPool(pool, known)).toEqual({ ok: true });
  });

  it('returns the unknown vibe IDs when any fail to resolve', () => {
    const pool = {
      version: TRENDING_POOL_VERSION,
      pool: [
        { tag: 'a', vibes: ['ratio_king', 'ghost_persona'] },
        { tag: 'b', vibes: ['another_ghost'] },
      ],
    };
    const known = new Set(['ratio_king']);
    const result = validateTrendingPool(pool, known);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknown).toEqual(['ghost_persona', 'another_ghost']);
    }
  });

  it('dedupes repeated unknown IDs in the output', () => {
    const pool = {
      version: TRENDING_POOL_VERSION,
      pool: [
        { tag: 'a', vibes: ['ghost'] },
        { tag: 'b', vibes: ['ghost'] },
      ],
    };
    const known = new Set<string>();
    const result = validateTrendingPool(pool, known);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unknown).toEqual(['ghost']);
    }
  });
});

describe('committed trending-pool.json', () => {
  it('every vibe entry resolves to a persona in the catalog', async () => {
    // Read the REAL on-disk file, not a fixture — this is the guard that
    // catches a drift between the hand-authored trending pool and the
    // persona catalog.
    const realPath = path.resolve(process.cwd(), 'src/data/trending-pool.json');
    const raw = await actualReadFile(realPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const known = new Set(PERSONA_CATALOG.map((p) => p.id));
    const result = validateTrendingPool(parsed, known);
    if (!result.ok) {
      throw new Error(`trending-pool references unknown persona IDs: ${result.unknown.join(', ')}`);
    }
    expect(result.ok).toBe(true);
  });
});
