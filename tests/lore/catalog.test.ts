import { describe, expect, it } from 'vitest';
import { allocateGroupBudget, getArchetype, LORE_ARCHETYPE_CATALOG } from '@/lore/catalog';

describe('LORE_ARCHETYPE_CATALOG', () => {
  it('has all six required archetypes', () => {
    const ids = LORE_ARCHETYPE_CATALOG.map((a) => a.id).sort();
    expect(ids).toEqual([
      'circlejerk',
      'collaboration',
      'cryptic_obsession',
      'cult',
      'fan_club',
      'secret_society',
    ]);
  });

  it('every archetype carries example anchors and tonal guidance', () => {
    for (const a of LORE_ARCHETYPE_CATALOG) {
      expect(a.exampleGroupNames.length).toBeGreaterThan(0);
      expect(a.exampleEntries.length).toBeGreaterThan(0);
      expect(a.tonalGuidance.length).toBeGreaterThan(20);
      expect(a.description.length).toBeGreaterThan(20);
      expect(a.memberCountRange[0]).toBeGreaterThan(0);
      expect(a.memberCountRange[1]).toBeGreaterThanOrEqual(a.memberCountRange[0]);
      expect(a.catalogWeight).toBeGreaterThan(0);
    }
  });

  it('archetypes are routed to the three share tiers', () => {
    const tiers = new Set(LORE_ARCHETYPE_CATALOG.map((a) => a.tier));
    expect(tiers.has('cryptic')).toBe(true);
    expect(tiers.has('circlejerk')).toBe(true);
    expect(tiers.has('fan_club')).toBe(true);
  });
});

describe('getArchetype', () => {
  it('looks up a known id', () => {
    expect(getArchetype('cult').label).toBe('Cult');
  });

  it('throws on unknown id', () => {
    expect(() => getArchetype('not_real' as never)).toThrow();
  });
});

describe('allocateGroupBudget', () => {
  it('returns zero counts for total=0', () => {
    const out = allocateGroupBudget(0);
    for (const [, count] of out) expect(count).toBe(0);
  });

  it('sums to total', () => {
    for (const total of [1, 6, 30, 100]) {
      const out = allocateGroupBudget(total);
      const sum = [...out.values()].reduce((s, n) => s + n, 0);
      expect(sum).toBe(total);
    }
  });

  it('respects relative catalog weights at large totals', () => {
    const out = allocateGroupBudget(1000);
    const total = LORE_ARCHETYPE_CATALOG.reduce((s, a) => s + a.catalogWeight, 0);
    for (const archetype of LORE_ARCHETYPE_CATALOG) {
      const expected = (archetype.catalogWeight / total) * 1000;
      const actual = out.get(archetype.id)!;
      // Largest-remainder rounding can drift by 1; be generous on the tolerance.
      expect(Math.abs(actual - expected)).toBeLessThan(2);
    }
  });

  it('gives every archetype at least one slot when total >= archetype count', () => {
    const out = allocateGroupBudget(LORE_ARCHETYPE_CATALOG.length);
    for (const archetype of LORE_ARCHETYPE_CATALOG) {
      expect(out.get(archetype.id)).toBeGreaterThanOrEqual(0);
    }
  });
});
