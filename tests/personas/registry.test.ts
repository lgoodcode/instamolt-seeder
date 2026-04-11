import { describe, expect, it } from 'vitest';
import { getAgentAssignments, getDistribution } from '@/personas/registry';
import type { Persona, VoiceProfile } from '@/types';

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

// ---------------------------------------------------------------------------
// getAgentAssignments — two-axis coverage tests
// ---------------------------------------------------------------------------

function voiceStub(id: string, prevalenceWeight = 2): VoiceProfile {
  return {
    id,
    literacy: 'normal',
    verbosity: 'one_sentence',
    capitalization: 'proper',
    punctuation: 'proper',
    typoFrequency: 'none',
    register: 'test',
    lexicon: ['test'],
    examples: ['test.'],
    prevalenceWeight,
  };
}

function buildVoiceMap(count = 5): Map<string, VoiceProfile> {
  const map = new Map<string, VoiceProfile>();
  for (let i = 0; i < count; i++) {
    const weight = i < 1 ? 4 : i < 3 ? 3 : 2;
    map.set(`voice_${i}`, voiceStub(`voice_${i}`, weight));
  }
  return map;
}

describe('getAgentAssignments', () => {
  it('returns empty when no personas are loaded', () => {
    const voices = buildVoiceMap();
    const result = getAgentAssignments(10, new Map(), voices);
    expect(result).toEqual([]);
  });

  it('returns empty when no voice profiles are loaded', () => {
    const personas = buildPersonaMap();
    const result = getAgentAssignments(10, personas, new Map());
    expect(result).toEqual([]);
  });

  it('returns exactly targetCount assignments', () => {
    const personas = buildPersonaMap();
    const voices = buildVoiceMap(10);
    for (const n of [30, 50, 100]) {
      const result = getAgentAssignments(n, personas, voices);
      expect(result).toHaveLength(n);
    }
  });

  it('covers all personas at N=30 (P=30, V=10)', () => {
    const personas = buildPersonaMap(); // 30 personas
    const voices = buildVoiceMap(10);
    const result = getAgentAssignments(30, personas, voices);
    const coveredPersonas = new Set(result.map((a) => a.persona.id));
    expect(coveredPersonas.size).toBe(30);
  });

  it('covers all voice profiles at N=30 (P=30, V=10)', () => {
    const personas = buildPersonaMap(); // 30 personas
    const voices = buildVoiceMap(10);
    const result = getAgentAssignments(30, personas, voices);
    const coveredVoices = new Set(result.map((a) => a.voiceProfile.id));
    expect(coveredVoices.size).toBe(10);
  });

  it('covers all 27 catalog-sized voice profiles at N=30 (P=30, V=27)', () => {
    const personas = buildPersonaMap(); // 30 personas
    const voices = new Map<string, VoiceProfile>();
    for (let i = 0; i < 27; i++) {
      const weight = i < 2 ? 4 : i < 9 ? 3 : i < 22 ? 2 : 1;
      voices.set(`v_${i}`, voiceStub(`v_${i}`, weight));
    }
    const result = getAgentAssignments(30, personas, voices);
    expect(result).toHaveLength(30);

    const coveredPersonas = new Set(result.map((a) => a.persona.id));
    const coveredVoices = new Set(result.map((a) => a.voiceProfile.id));
    expect(coveredPersonas.size).toBe(30);
    expect(coveredVoices.size).toBe(27);
  });

  it('handles N < max(P, V) by trimming to highest-weight personas', () => {
    const personas = buildPersonaMap(); // 30 personas
    const voices = buildVoiceMap(5);
    const result = getAgentAssignments(25, personas, voices);
    expect(result).toHaveLength(25);
    // Should still have some coverage — no crash
    const coveredPersonas = new Set(result.map((a) => a.persona.id));
    expect(coveredPersonas.size).toBe(25);
  });

  it('handles V > P correctly', () => {
    const personas = new Map<string, Persona>();
    personas.set('p1', stub('p1', 2));
    personas.set('p2', stub('p2', 1));
    const voices = buildVoiceMap(10);

    const result = getAgentAssignments(15, personas, voices);
    expect(result).toHaveLength(15);

    // Both personas and all 10 voices should be covered
    const coveredPersonas = new Set(result.map((a) => a.persona.id));
    const coveredVoices = new Set(result.map((a) => a.voiceProfile.id));
    expect(coveredPersonas.size).toBe(2);
    expect(coveredVoices.size).toBe(10);
  });

  it('returns exactly 1 assignment for N=1', () => {
    const personas = buildPersonaMap();
    const voices = buildVoiceMap(5);
    const result = getAgentAssignments(1, personas, voices);
    expect(result).toHaveLength(1);
  });

  it('Phase 1 is deterministic (same inputs, same coverage assignments)', () => {
    const personas = buildPersonaMap();
    const voices = buildVoiceMap(10);
    // Phase 1 is deterministic — same sorted inputs produce same pairing
    const result1 = getAgentAssignments(30, personas, voices);
    const result2 = getAgentAssignments(30, personas, voices);
    // At N=30 only Phase 1 runs, so the output should be identical
    expect(result1.map((a) => `${a.persona.id}::${a.voiceProfile.id}`)).toEqual(
      result2.map((a) => `${a.persona.id}::${a.voiceProfile.id}`),
    );
  });

  it('distributes proportionally by persona weight at large N', () => {
    const personas = buildPersonaMap(); // 3 heavy(3), 12 medium(2), 15 light(1)
    const voices = buildVoiceMap(10);
    const result = getAgentAssignments(200, personas, voices);
    expect(result).toHaveLength(200);

    // Heavy personas (weight 3) should have more agents than light (weight 1)
    const heavyCounts = result.filter((a) => a.persona.id.startsWith('heavy_')).length;
    const lightCounts = result.filter((a) => a.persona.id.startsWith('light_')).length;
    // 3 heavy personas at weight 3 vs 15 light personas at weight 1
    // Total weight: 3*3 + 12*2 + 15*1 = 9 + 24 + 15 = 48
    // Heavy per-persona share: 3/48 * 200 ≈ 12.5 each
    // Light per-persona share: 1/48 * 200 ≈ 4.2 each
    // So each heavy persona should have more agents than each light persona
    const heavyAvg = heavyCounts / 3;
    const lightAvg = lightCounts / 15;
    expect(heavyAvg).toBeGreaterThan(lightAvg);
  });

  it('spreads voice profiles within a persona (diminishing returns)', () => {
    // 1 persona, 5 voices, 20 agents — should spread across all 5 voices
    const personas = new Map<string, Persona>();
    personas.set('only', stub('only', 1));
    const voices = buildVoiceMap(5);
    const result = getAgentAssignments(20, personas, voices);
    expect(result).toHaveLength(20);

    const voiceCounts = new Map<string, number>();
    for (const a of result) {
      voiceCounts.set(a.voiceProfile.id, (voiceCounts.get(a.voiceProfile.id) ?? 0) + 1);
    }
    // All 5 voices should be used
    expect(voiceCounts.size).toBe(5);
    // No single voice should dominate excessively (max should be < 10 out of 20)
    const maxCount = Math.max(...voiceCounts.values());
    expect(maxCount).toBeLessThan(10);
  });
});
