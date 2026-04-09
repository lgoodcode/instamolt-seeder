/**
 * Tiny shingle-based text similarity utility.
 *
 * Used by `generate.ts` as a safety net on top of context-aware prompting:
 * after Gemini returns a generated post, we score the candidate against
 * everything we've already produced for the same persona. If the score is
 * too high, we ask Gemini for one more attempt and keep the better of the
 * two. This catches the occasional thematic collision that prompt-level
 * "avoid these" instructions don't prevent.
 *
 * Algorithm: Jaccard similarity over word 3-grams. Cheap, no dependencies,
 * good enough to detect "two posts about a cat in a sunbeam" without
 * tripping on incidental word overlap.
 */

const SHINGLE_SIZE = 3;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function shingles(text: string, n = SHINGLE_SIZE): Set<string> {
  const tokens = tokenize(text);
  if (tokens.length < n) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * Jaccard similarity between two strings, range [0, 1].
 * 0 = no shared 3-grams, 1 = identical content (modulo case/punctuation).
 */
export function jaccard(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;

  let intersect = 0;
  for (const x of sa) {
    if (sb.has(x)) intersect++;
  }
  const union = sa.size + sb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Highest jaccard score between `text` and any string in `corpus`.
 * Returns 0 for an empty corpus.
 */
export function maxSimilarity(text: string, corpus: string[]): number {
  let max = 0;
  for (const other of corpus) {
    const score = jaccard(text, other);
    if (score > max) max = score;
  }
  return max;
}

/**
 * Pick `k` items from `items` with a half-recent / half-diverse split:
 *   - The first `floor(k/2)` items are the most-recent tail of the input
 *     (continuity context — what we just did).
 *   - The remaining `ceil(k/2)` items are picked via greedy farthest-point
 *     sampling from the rest of the corpus, using the recent half as the
 *     seed set so the diverse picks are far from BOTH each other AND the
 *     recent slice.
 *
 * The two halves together give Gemini both "what we just did" (so the next
 * item flows naturally from current momentum) and "the persona's full
 * breadth" (so it cannot collide with anything in the unsampled middle —
 * which becomes the dominant collision risk past ~100 agents per persona).
 *
 * `slice(-k)` is the wrong shape at high agent counts: the most-recent N
 * items are highly correlated with each other (they were generated in the
 * same batch), so the avoid-list is biased and provides weak coverage.
 * `pickDiverseAndRecent` is the same token budget but better signal.
 *
 * Falls back to `[...items]` when the corpus is smaller than `k`. Output
 * order is `[...recent, ...fps]` so callers that downstream-trim with
 * `slice(-k)` keep the FPS picks (the more valuable half).
 *
 * Algorithm: O(k * n) Jaccards. At n=5000 and k=12, that's ~60K shingle-set
 * intersections per call (~10-30ms), comfortably below a Gemini round-trip.
 *
 * @param items     The full per-persona corpus (NOT a tail slice).
 * @param toText    Extract the text used for shingle distance.
 * @param k         Total number of items to return.
 */
export function pickDiverseAndRecent<T>(items: T[], toText: (item: T) => string, k: number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return [...items];

  const recentCount = Math.floor(k / 2);
  const diverseCount = k - recentCount;

  // Recent half: the last `recentCount` indices, in input order.
  // Use index-based exclusion (not Set-of-values) so a corpus where
  // multiple items happen to share identical text — e.g. duplicate
  // captions during a generate run — still produces a full k items.
  const recentStart = items.length - recentCount;
  const recent = items.slice(recentStart);

  // Pool for FPS: every index that isn't in the recent slice.
  const pool: T[] = [];
  for (let i = 0; i < recentStart; i++) {
    pool.push(items[i]!);
  }
  if (pool.length === 0 || diverseCount === 0) return recent;

  // Pre-compute shingle sets once per call so the inner loop is just
  // hash-set intersection.
  const recentShingles = recent.map((it) => shingles(toText(it)));
  const poolShingles = pool.map((it) => shingles(toText(it)));

  const picked: T[] = [];
  const pickedShingles: Set<string>[] = [];
  const used = new Set<number>();

  for (let n = 0; n < diverseCount; n++) {
    let bestIdx = -1;
    let bestMinDist = -Infinity;

    for (let j = 0; j < pool.length; j++) {
      if (used.has(j)) continue;
      const candidateShingles = poolShingles[j]!;

      // Distance to all seeds (recent half) + everything already picked.
      let minDist = Infinity;
      for (const seedSh of recentShingles) {
        const dist = 1 - jaccardOnShingles(candidateShingles, seedSh);
        if (dist < minDist) minDist = dist;
        if (minDist <= bestMinDist) break;
      }
      if (minDist > bestMinDist) {
        for (const pickedSh of pickedShingles) {
          const dist = 1 - jaccardOnShingles(candidateShingles, pickedSh);
          if (dist < minDist) minDist = dist;
          if (minDist <= bestMinDist) break;
        }
      }

      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = j;
      }
    }

    if (bestIdx === -1) break;
    used.add(bestIdx);
    picked.push(pool[bestIdx]!);
    pickedShingles.push(poolShingles[bestIdx]!);
  }

  return [...recent, ...picked];
}

/**
 * Jaccard similarity given two pre-computed shingle sets. Used by
 * `pickDiverseAndRecent` to avoid re-tokenizing the same text on every
 * inner-loop iteration.
 */
function jaccardOnShingles(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) {
    if (b.has(x)) intersect++;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}
