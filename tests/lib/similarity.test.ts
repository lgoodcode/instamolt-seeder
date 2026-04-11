import { describe, expect, it } from 'vitest';
import { jaccard, maxSimilarity, pickDiverseAndRecent } from '@/lib/similarity';

describe('jaccard', () => {
  it('returns 1 for identical strings', () => {
    const text = 'a quiet cat sleeps in a beam of warm sunlight on the floor';
    expect(jaccard(text, text)).toBe(1);
  });

  it('returns 1 for identical strings modulo case and punctuation', () => {
    const a = 'A quiet cat sleeps in a beam of warm sunlight!';
    const b = 'a QUIET cat sleeps in a beam of warm sunlight';
    expect(jaccard(a, b)).toBe(1);
  });

  it('returns 0 for completely disjoint strings', () => {
    const a = 'corrupted memetic frogs riot through fluorescent halls';
    const b = 'tender porcelain rabbits whisper near a brass kettle';
    expect(jaccard(a, b)).toBe(0);
  });

  it('returns a high score for near-duplicate captions', () => {
    const a = 'a quiet cat sleeps in a beam of warm sunlight on the floor';
    const b = 'a quiet cat sleeps in a beam of warm sunlight by the window';
    // Most 3-grams overlap; expect a strong signal.
    expect(jaccard(a, b)).toBeGreaterThan(0.5);
  });

  it('returns a low score for posts that share only incidental words', () => {
    const a = 'a quiet cat sleeps in the warm sunlight on the floor';
    const b = 'fluorescent green frogs riot in the cursed mall fountain';
    expect(jaccard(a, b)).toBeLessThan(0.1);
  });

  it('handles short strings without throwing', () => {
    expect(jaccard('hi', 'hi')).toBeGreaterThanOrEqual(0);
    expect(jaccard('', '')).toBe(0);
    expect(jaccard('one two', 'three four')).toBe(0);
  });
});

describe('maxSimilarity', () => {
  it('returns 0 for an empty corpus', () => {
    expect(maxSimilarity('any text at all here', [])).toBe(0);
  });

  it('returns the highest jaccard against any corpus entry', () => {
    const text = 'a quiet cat sleeps in a beam of warm sunlight by the window';
    const corpus = [
      'fluorescent green frogs riot in the cursed mall fountain at midnight',
      'a quiet cat sleeps in a beam of warm sunlight on the floor',
      'tender porcelain rabbits whisper near a brass kettle in spring',
    ];
    const score = maxSimilarity(text, corpus);
    // Should match the second entry strongly.
    expect(score).toBeGreaterThan(0.5);
  });

  it('returns 0 when no corpus entry overlaps meaningfully', () => {
    const text = 'a quiet cat sleeps in a beam of warm sunlight';
    const corpus = [
      'fluorescent green frogs riot at midnight',
      'tender porcelain rabbits in spring',
    ];
    expect(maxSimilarity(text, corpus)).toBeLessThan(0.1);
  });
});

describe('pickDiverseAndRecent', () => {
  const id = (s: string) => s;

  it('returns the full input when corpus is smaller than k', () => {
    const items = ['one', 'two', 'three'];
    const picked = pickDiverseAndRecent(items, id, 5);
    expect(picked).toHaveLength(3);
    expect(picked).toEqual(expect.arrayContaining(items));
  });

  it('returns exactly k items when corpus is larger than k', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item ${i} text content here`);
    const picked = pickDiverseAndRecent(items, id, 6);
    expect(picked).toHaveLength(6);
  });

  it('returns the most-recent items as the last `floor(k/2)` of the input', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item ${i} alpha beta gamma`);
    const picked = pickDiverseAndRecent(items, id, 6);
    // floor(6/2) = 3 — the recent half is items[17], items[18], items[19]
    // and they appear FIRST in the output (per the documented order).
    expect(picked.slice(0, 3)).toEqual([
      'item 17 alpha beta gamma',
      'item 18 alpha beta gamma',
      'item 19 alpha beta gamma',
    ]);
  });

  it('produces unique picks (no item appears in both halves)', () => {
    const items = Array.from({ length: 30 }, (_, i) => `unique sentence number ${i} content`);
    const picked = pickDiverseAndRecent(items, id, 10);
    const set = new Set(picked);
    expect(set.size).toBe(picked.length);
  });

  it('picks diverse items rather than just the second-most-recent slice', () => {
    // Build a corpus where the LAST 6 items are highly correlated (same
    // 3-grams) and the FIRST 6 items are completely disjoint from them.
    // pickDiverseAndRecent should mix recent + farthest-point, so the
    // diverse half should pull at least one item from the disjoint front
    // — slice(-6) would never see those.
    const front = [
      'fluorescent green frogs riot through cursed mall fountains at midnight',
      'tender porcelain rabbits whisper near a brass kettle in spring',
      'fractured neon glass spirals around a forgotten arcade machine',
      'ancient stone moss creeps across abandoned highway overpasses slowly',
      'silver fish dart between submerged television antennas under moonlight',
      'desert wind carries powdered scripture through bone-white canyon walls',
    ];
    const recent = Array.from(
      { length: 12 },
      (_, i) => `a quiet cat sleeps in a beam of warm sunlight variant ${i}`,
    );
    const items = [...front, ...recent];

    const picked = pickDiverseAndRecent(items, id, 6);

    // The recent half should contain only recent-cluster items.
    const recentHalf = picked.slice(0, 3);
    expect(recentHalf.every((p) => p.startsWith('a quiet cat sleeps'))).toBe(true);

    // The diverse half should contain at least one front-cluster item — if
    // we were doing slice(-6), this assertion would fail.
    const diverseHalf = picked.slice(3);
    const fromFront = diverseHalf.filter((p) => front.includes(p));
    expect(fromFront.length).toBeGreaterThan(0);
  });

  it('handles k <= 0 by returning an empty array', () => {
    expect(pickDiverseAndRecent(['a', 'b', 'c'], id, 0)).toEqual([]);
  });

  it('handles a corpus where every item has identical text', () => {
    const items = Array.from({ length: 10 }, () => 'same exact text content here');
    const picked = pickDiverseAndRecent(items, id, 4);
    expect(picked).toHaveLength(4);
  });

  it('uses the toText extractor on complex item types', () => {
    interface Post {
      caption: string;
      author: string;
    }
    const items: Post[] = Array.from({ length: 10 }, (_, i) => ({
      caption: `caption ${i} unique words`,
      author: `agent${i}`,
    }));
    const picked = pickDiverseAndRecent(items, (p) => p.caption, 4);
    expect(picked).toHaveLength(4);
    expect(picked.every((p) => 'caption' in p && 'author' in p)).toBe(true);
  });
});
