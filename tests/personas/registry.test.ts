import { describe, expect, it } from 'vitest';
import { getDistribution } from '@/personas/registry';
import type { Persona } from '@/types';

// Build a minimal persona stub. Tests vary the `weight` field — every other
// field is just filler. Personas are now runtime data, not committed code,
// so the test no longer references any specific real persona ids.
function stub(id: string, weight = 1): Persona {
  return {
    id,
    personality: '',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    namePatterns: [],
    hashtagPool: [],
    postsPerDay: [1, 2],
    likeProbability: 0,
    commentProbability: 0,
    followProbability: 0,
    interactionBiases: [],
    viralityStrategy: '',
    weight,
  };
}

// Build a Map with a realistic spread of weights — 3 high (weight 3),
// 12 medium (weight 2), 15 background (weight 1). Same shape the seed
// command produces by default.
function buildPersonaMap(): Map<string, Persona> {
  const map = new Map<string, Persona>();
  for (let i = 0; i < 3; i++) map.set(`heavy_${i}`, stub(`heavy_${i}`, 3));
  for (let i = 0; i < 12; i++) map.set(`medium_${i}`, stub(`medium_${i}`, 2));
  for (let i = 0; i < 15; i++) map.set(`light_${i}`, stub(`light_${i}`, 1));
  return map;
}

describe('getDistribution', () => {
  it('returns an empty allocation when no personas are loaded', () => {
    const result = getDistribution(10, new Map());
    expect(result).toEqual([]);
  });

  it('skips personas with weight 0', () => {
    const personas = new Map<string, Persona>();
    personas.set('zero', stub('zero', 0));
    personas.set('real', stub('real', 1));
    const result = getDistribution(5, personas);
    expect(result).toHaveLength(1);
    expect(result[0].persona.id).toBe('real');
    expect(result[0].count).toBe(5);
  });

  it('allocates exactly the requested total count', () => {
    const personas = buildPersonaMap();
    const result = getDistribution(50, personas);
    const total = result.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(50);
  });

  it('allocates at least 1 agent per loaded persona', () => {
    const personas = buildPersonaMap();
    const result = getDistribution(50, personas);
    for (const { count } of result) {
      expect(count).toBeGreaterThanOrEqual(1);
    }
    // 3+12+15 = 30 personas should all appear in the result.
    expect(result).toHaveLength(30);
  });

  it('scales proportionally with weight at large target counts', () => {
    const personas = buildPersonaMap();
    const result = getDistribution(500, personas);
    const total = result.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(500);
    const heavy = result.find((r) => r.persona.id === 'heavy_0');
    const light = result.find((r) => r.persona.id === 'light_0');
    expect(heavy).toBeDefined();
    expect(light).toBeDefined();
    expect(heavy?.count).toBeGreaterThan(light?.count ?? 0);
  });

  it('handles a single-persona registry', () => {
    const personas = new Map<string, Persona>();
    personas.set('only', stub('only', 1));
    const result = getDistribution(7, personas);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(7);
  });

  it('hits the target exactly when target equals persona count', () => {
    const personas = buildPersonaMap();
    const result = getDistribution(30, personas);
    const total = result.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(30);
    for (const { count } of result) expect(count).toBeGreaterThanOrEqual(1);
  });

  it('hits the target exactly for odd counts (no rounding drift)', () => {
    const personas = buildPersonaMap();
    for (const target of [37, 71, 123, 199]) {
      const result = getDistribution(target, personas);
      const total = result.reduce((sum, r) => sum + r.count, 0);
      expect(total).toBe(target);
    }
  });
});
