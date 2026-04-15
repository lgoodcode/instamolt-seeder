import { describe, expect, it } from 'vitest';
import { computeBatchSize, formatGrowthStatus, GROWTH_DEFAULTS } from '@/lib/growth';

describe('GROWTH_DEFAULTS', () => {
  it('exposes a post-count range (min/max), not a single fixed count', () => {
    expect(GROWTH_DEFAULTS).toHaveProperty('postsMin');
    expect(GROWTH_DEFAULTS).toHaveProperty('postsMax');
    expect(GROWTH_DEFAULTS.postsMin).toBeLessThanOrEqual(GROWTH_DEFAULTS.postsMax);
  });
});

describe('computeBatchSize', () => {
  it('returns 5 for initial catalog population (37/200)', () => {
    expect(computeBatchSize(37, 200, 3)).toBe(5);
  });

  it('returns 4 at 50/200', () => {
    expect(computeBatchSize(50, 200, 3)).toBe(4);
  });

  it('returns 2 at 100/200', () => {
    expect(computeBatchSize(100, 200, 3)).toBe(2);
  });

  it('returns 1 near the cap (150/200)', () => {
    expect(computeBatchSize(150, 200, 3)).toBe(1);
  });

  it('returns 0 at the cap (200/200)', () => {
    expect(computeBatchSize(200, 200, 3)).toBe(0);
  });

  it('returns 0 above the cap', () => {
    expect(computeBatchSize(250, 200, 3)).toBe(0);
  });

  it('handles zero current agents without dividing by zero', () => {
    const result = computeBatchSize(0, 200, 3);
    expect(result).toBeGreaterThan(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('scales with growth rate', () => {
    const slow = computeBatchSize(50, 200, 1);
    const fast = computeBatchSize(50, 200, 5);
    expect(fast).toBeGreaterThan(slow);
  });

  it('always returns at least 1 when below cap', () => {
    // Even at 199/200, should return at least 1
    expect(computeBatchSize(199, 200, 3)).toBeGreaterThanOrEqual(1);
  });

  it('produces a monotonically decreasing sequence as population grows', () => {
    const sizes: number[] = [];
    for (let pop = 10; pop <= 200; pop += 10) {
      sizes.push(computeBatchSize(pop, 200, 3));
    }
    // Each entry should be <= the previous (monotonically non-increasing)
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]!);
    }
  });
});

describe('formatGrowthStatus', () => {
  it('shows generating-now when nextTickIn is 0', () => {
    const s = formatGrowthStatus(50, 200, 4, 0);
    expect(s).toContain('generating now');
    expect(s).toContain('50/200');
    expect(s).toContain('~4');
  });

  it('shows hours and minutes when waiting', () => {
    const threeHours = 3 * 60 * 60 * 1000 + 12 * 60 * 1000;
    const s = formatGrowthStatus(52, 200, 4, threeHours);
    expect(s).toContain('52/200');
    expect(s).toContain('~4');
    expect(s).toContain('3h 12m');
  });

  it('shows minutes only when under 1 hour', () => {
    const fortyMin = 40 * 60 * 1000;
    const s = formatGrowthStatus(52, 200, 4, fortyMin);
    expect(s).toContain('40m');
    // Should NOT contain an hour component like "1h" or "0h"
    expect(s).not.toMatch(/\d+h/);
  });

  it('shows population cap message when at cap', () => {
    const s = formatGrowthStatus(200, 200, 0, 0);
    expect(s).toContain('at population cap');
    expect(s).toContain('200/200');
  });
});
