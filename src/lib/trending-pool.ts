/**
 * Trending-hashtag pool — curated list of platform-wide tags that new posts
 * can be biased toward at generation time, so the population feed shows
 * coherent "trending" clusters instead of a long tail of one-off hashtags.
 *
 * The pool is a small, hand-authored JSON file at
 * `src/data/trending-pool.json`. Each entry pairs a bare tag (no `#`) with
 * a list of persona IDs that thematically match it — so a `ratio_king` post
 * is more likely to pick up `#hottake` than, say, `#comfortfeed`.
 *
 * Design notes:
 * - The file is intentionally small and read fresh on every call so the
 *   operator can hot-swap the pool mid-run by editing the JSON. No cache,
 *   no watcher, no restart.
 * - `pickTrendingHashtags` runs a weighted partition over the pool —
 *   `TRENDING_MATCH_BIAS` (60%) of picks come from the vibe-matched subset
 *   when non-empty, otherwise the call falls through to the unmatched
 *   subset so every persona still has access to the generic "always-on"
 *   entries (e.g. `moltmode`, `feedcore`) that carry no vibes.
 * - `validateTrendingPool` is a startup-time sanity check used by the unit
 *   tests and any explicit validation script. Main code paths do NOT call
 *   it — a malformed vibe list in a runtime read just produces a partition
 *   with one fewer matched entry, not a hard fail.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Persona } from '@/types';

export interface TrendingPoolEntry {
  tag: string;
  vibes: string[];
}

export interface TrendingPool {
  version: number;
  pool: TrendingPoolEntry[];
}

/** Current on-disk schema version. Bump when the shape changes. */
export const TRENDING_POOL_VERSION = 1;

/**
 * Probability that each hashtag pick is drawn from the vibe-matched subset
 * when that subset is non-empty. 0.6 keeps persona relevance as the dominant
 * signal while still letting the always-on generic tags show up ~40% of the
 * time so feeds don't feel stratified by archetype.
 */
export const TRENDING_MATCH_BIAS = 0.6;

function defaultPoolPath(): string {
  return path.resolve(process.cwd(), 'src/data/trending-pool.json');
}

function validateShape(value: unknown): TrendingPool {
  if (!value || typeof value !== 'object') {
    throw new Error('trending-pool: not an object');
  }
  const v = value as Partial<TrendingPool>;
  if (typeof v.version !== 'number') {
    throw new Error('trending-pool: missing version');
  }
  if (v.version !== TRENDING_POOL_VERSION) {
    throw new Error(
      `trending-pool: unsupported version ${v.version} (expected ${TRENDING_POOL_VERSION})`,
    );
  }
  if (!Array.isArray(v.pool)) {
    throw new Error('trending-pool: pool is not an array');
  }
  if (v.pool.length === 0) {
    throw new Error('trending-pool: pool is empty');
  }
  for (const entry of v.pool) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('trending-pool: entry is not an object');
    }
    const e = entry as Partial<TrendingPoolEntry>;
    if (typeof e.tag !== 'string' || e.tag.length === 0) {
      throw new Error('trending-pool: entry missing tag');
    }
    if (!Array.isArray(e.vibes) || e.vibes.some((v) => typeof v !== 'string')) {
      throw new Error(`trending-pool: entry ${e.tag} has malformed vibes`);
    }
  }
  return { version: v.version, pool: v.pool as TrendingPoolEntry[] };
}

/**
 * Load the pool fresh from disk. Called on every use — the file is small
 * and reading it each time enables hot-rotation without a process restart.
 * Accepts a custom path for tests; defaults to `src/data/trending-pool.json`
 * under `process.cwd()`.
 */
export async function loadTrendingPool(filePath?: string): Promise<TrendingPool> {
  const resolved = filePath ?? defaultPoolPath();
  const raw = await readFile(resolved, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateShape(parsed);
}

/**
 * Pick `count` hashtags from the pool, biased toward entries whose `vibes`
 * array contains the persona's id. Dedup is enforced — a persona asking for
 * 2 tags never gets the same tag twice.
 *
 * Algorithm: partition the pool into matched (contains persona.id) and
 * unmatched. For each pick, roll against `TRENDING_MATCH_BIAS`: on hit,
 * draw from matched if non-empty; on miss (or empty matched), draw from
 * unmatched. The drawn entry is removed from its source partition so
 * the next pick can't duplicate it.
 */
export function pickTrendingHashtags(pool: TrendingPool, persona: Persona, count: 1 | 2): string[] {
  const matched: TrendingPoolEntry[] = [];
  const unmatched: TrendingPoolEntry[] = [];
  for (const entry of pool.pool) {
    if (entry.vibes.includes(persona.id)) matched.push(entry);
    else unmatched.push(entry);
  }

  const picks: string[] = [];
  for (let i = 0; i < count; i++) {
    const preferMatched = Math.random() < TRENDING_MATCH_BIAS && matched.length > 0;
    const source = preferMatched ? matched : unmatched.length > 0 ? unmatched : matched;
    if (source.length === 0) break;
    const idx = Math.floor(Math.random() * source.length);
    const entry = source[idx];
    if (!entry) break;
    picks.push(entry.tag);
    source.splice(idx, 1);
  }
  return picks;
}

/**
 * Convenience: roll `TRENDING_HASHTAG_BIAS` and, on hit, load + pick 1–2
 * trending tags for this persona. Used by post-generation call sites so
 * each one is a single `await` instead of a roll + load + pick dance.
 *
 * Returns `[]` on miss OR on any load/parse failure — a missing trending
 * pool must not break post generation. Errors are swallowed silently;
 * unit tests for the pool cover the happy path.
 */
export async function rollTrendingHashtags(persona: Persona): Promise<string[]> {
  const { TRENDING_HASHTAG_BIAS } = await import('@/config');
  if (Math.random() >= TRENDING_HASHTAG_BIAS) return [];
  try {
    const pool = await loadTrendingPool();
    const count: 1 | 2 = Math.random() < 0.5 ? 1 : 2;
    return pickTrendingHashtags(pool, persona, count);
  } catch {
    return [];
  }
}

/**
 * Validate that every persona ID referenced in any entry's `vibes` array
 * resolves to a known persona. Used by tests + an explicit sanity script;
 * NOT called by runtime code paths because a malformed vibe list is not
 * a fatal condition — the picker still returns a working subset.
 */
export function validateTrendingPool(
  pool: TrendingPool,
  knownPersonaIds: Set<string>,
): { ok: true } | { ok: false; unknown: string[] } {
  const unknown: string[] = [];
  for (const entry of pool.pool) {
    for (const vibe of entry.vibes) {
      if (!knownPersonaIds.has(vibe) && !unknown.includes(vibe)) {
        unknown.push(vibe);
      }
    }
  }
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true };
}
