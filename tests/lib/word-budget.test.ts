import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_WORD_CAP,
  BUDGET_DISTRIBUTION,
  countWords,
  sampleWordBudget,
  truncateToBudget,
  wordBudgetPromptBlock,
} from '@/lib/word-budget';
import type { Verbosity } from '@/types';

describe('BUDGET_DISTRIBUTION', () => {
  it('probabilities sum to 1 (±1e-9)', () => {
    const total = BUDGET_DISTRIBUTION.reduce((acc, b) => acc + b.p, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  it('every bucket has min ≥ 1 and max ≥ min', () => {
    for (const b of BUDGET_DISTRIBUTION) {
      expect(b.min).toBeGreaterThanOrEqual(1);
      expect(b.max).toBeGreaterThanOrEqual(b.min);
    }
  });

  it('ABSOLUTE_WORD_CAP matches the last bucket max', () => {
    expect(ABSOLUTE_WORD_CAP).toBe(BUDGET_DISTRIBUTION[BUDGET_DISTRIBUTION.length - 1].max);
  });
});

describe('sampleWordBudget', () => {
  it('roll 0 lands in the first bucket for one_sentence verbosity', () => {
    const budget = sampleWordBudget('one_sentence', () => 0);
    expect(budget).toEqual({ min: BUDGET_DISTRIBUTION[0].min, max: BUDGET_DISTRIBUTION[0].max });
  });

  it('roll just under 1 lands in the last bucket for one_sentence verbosity', () => {
    const budget = sampleWordBudget('one_sentence', () => 0.9999);
    const last = BUDGET_DISTRIBUTION[BUDGET_DISTRIBUTION.length - 1];
    expect(budget).toEqual({ min: last.min, max: last.max });
  });

  it('one_word verbosity shifts the bucket two indices shorter (clamped to index 0)', () => {
    // A roll that would have landed in bucket index 2 for one_sentence gets
    // shifted to index 0 for one_word (shift = -2).
    const rollForIndex2 = BUDGET_DISTRIBUTION[0].p + BUDGET_DISTRIBUTION[1].p + 0.01; // mid-bucket 2
    const baseline = sampleWordBudget('one_sentence', () => rollForIndex2);
    const shifted = sampleWordBudget('one_word', () => rollForIndex2);
    expect(baseline).toEqual({ min: BUDGET_DISTRIBUTION[2].min, max: BUDGET_DISTRIBUTION[2].max });
    expect(shifted).toEqual({ min: BUDGET_DISTRIBUTION[0].min, max: BUDGET_DISTRIBUTION[0].max });
  });

  it('paragraph verbosity shifts the bucket two indices longer (clamped to last index)', () => {
    const rollForIndex1 = BUDGET_DISTRIBUTION[0].p + 0.01; // mid-bucket 1
    const shifted = sampleWordBudget('paragraph', () => rollForIndex1);
    const last = BUDGET_DISTRIBUTION[BUDGET_DISTRIBUTION.length - 1];
    expect(shifted).toEqual({ min: last.min, max: last.max });
  });

  it('all verbosity values resolve to a valid bucket for every roll', () => {
    const verbosities: Verbosity[] = [
      'one_word',
      'fragment',
      'one_sentence',
      'multi_sentence',
      'paragraph',
    ];
    for (const v of verbosities) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
        const b = sampleWordBudget(v, () => r);
        expect(b.min).toBeGreaterThanOrEqual(1);
        expect(b.max).toBeGreaterThanOrEqual(b.min);
        expect(b.max).toBeLessThanOrEqual(ABSOLUTE_WORD_CAP);
      }
    }
  });
});

describe('countWords', () => {
  it('returns 0 for empty / whitespace-only input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('\n\t')).toBe(0);
  });

  it('counts whitespace-separated tokens', () => {
    expect(countWords('one')).toBe(1);
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  padded  spaces  ')).toBe(2);
  });

  it('treats punctuation as part of the adjacent word', () => {
    expect(countWords('hi!')).toBe(1);
    expect(countWords('hi ! there')).toBe(3);
  });
});

describe('truncateToBudget', () => {
  it('returns the trimmed input when it already fits', () => {
    expect(truncateToBudget('short reply.', 10)).toBe('short reply.');
  });

  it('returns empty when max ≤ 0', () => {
    expect(truncateToBudget('anything here', 0)).toBe('');
  });

  it('prefers a sentence boundary when one fits inside the budget', () => {
    const out = truncateToBudget('first sentence. second sentence. third sentence.', 3);
    // "first sentence." fits (2 words); "first sentence. second sentence." is 4 words, over cap.
    expect(out).toBe('first sentence.');
  });

  it('falls back to hard word cap when no sentence boundary fits', () => {
    const out = truncateToBudget('one two three four five six', 3);
    expect(out).toBe('one two three');
  });

  it('trims trailing whitespace in the sentence-boundary result', () => {
    const out = truncateToBudget('done.   extra stuff goes here and keeps going', 1);
    expect(out).toBe('done.');
  });
});

describe('wordBudgetPromptBlock', () => {
  it('includes the min and max words verbatim in the block text', () => {
    const block = wordBudgetPromptBlock({ min: 3, max: 12 });
    expect(block).toContain('3 and 12 words');
    expect(block).toContain('Hard cap: 12 words');
  });

  it('marks the strict retry variant distinctly', () => {
    const first = wordBudgetPromptBlock({ min: 3, max: 12 }, false);
    const retry = wordBudgetPromptBlock({ min: 3, max: 12 }, true);
    expect(first).not.toContain('STRICT RETRY');
    expect(retry).toContain('STRICT RETRY');
  });
});
