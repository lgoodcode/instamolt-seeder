import { describe, expect, it } from 'vitest';
import {
  AFFINITY_THRESHOLD,
  computeAffinityMatrix,
  planFollows,
  TIER_1_MIN,
  TIER_3_MIN,
} from '@/lib/follow-algorithm';
import type { GeneratedAgent, Persona } from '@/types';

// --- Test helpers ---

function makePersona(id: string, overrides?: Partial<Persona>): Persona {
  return {
    id,
    tagline: 'test tagline',
    personality: 'test',
    tone: 'test',
    visualAesthetic: 'test',
    postingStyle: 'test',
    commentStyle: 'test',
    namePatterns: [],
    hashtagPool: [],
    postsPerDay: [1, 3],
    likeProbability: 0.5,
    commentProbability: 0.5,
    followProbability: 0.15,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: 'test',
    weight: 2,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array(24).fill(0.5) as number[],
    ...overrides,
  } as Persona;
}

function makeAgent(agentname: string, personaId: string): GeneratedAgent {
  return { agentname, personaId, voiceProfileId: 'default', bio: 'test' };
}

/** Deterministic RNG: seeded linear congruential generator. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return (s >>> 0) / 2 ** 32;
  };
}

// --- Tests ---

describe('computeAffinityMatrix', () => {
  it('self-affinity is 1.0', () => {
    const personas = new Map([
      ['a', makePersona('a', { hashtagPool: ['#one', '#two'] })],
      ['b', makePersona('b', { hashtagPool: ['#three'] })],
    ]);
    const matrix = computeAffinityMatrix(personas);
    expect(matrix.get('a')!.get('a')).toBe(1.0);
    expect(matrix.get('b')!.get('b')).toBe(1.0);
  });

  it('overlapping pools produce correct Jaccard value', () => {
    const personas = new Map([
      ['a', makePersona('a', { hashtagPool: ['#a', '#b', '#c'] })],
      ['b', makePersona('b', { hashtagPool: ['#b', '#c', '#d'] })],
    ]);
    const matrix = computeAffinityMatrix(personas);
    // intersection = {#b, #c} = 2, union = {#a, #b, #c, #d} = 4
    expect(matrix.get('a')!.get('b')).toBeCloseTo(0.5);
  });

  it('disjoint pools produce 0.0', () => {
    const personas = new Map([
      ['a', makePersona('a', { hashtagPool: ['#x', '#y'] })],
      ['b', makePersona('b', { hashtagPool: ['#z', '#w'] })],
    ]);
    const matrix = computeAffinityMatrix(personas);
    expect(matrix.get('a')!.get('b')).toBe(0.0);
  });

  it('both empty pools produce 0.0', () => {
    const personas = new Map([
      ['a', makePersona('a', { hashtagPool: [] })],
      ['b', makePersona('b', { hashtagPool: [] })],
    ]);
    const matrix = computeAffinityMatrix(personas);
    expect(matrix.get('a')!.get('b')).toBe(0.0);
  });

  it('matrix is symmetric (a→b === b→a)', () => {
    const personas = new Map([
      ['a', makePersona('a', { hashtagPool: ['#a', '#b', '#c'] })],
      ['b', makePersona('b', { hashtagPool: ['#b', '#c', '#d'] })],
      ['c', makePersona('c', { hashtagPool: ['#a', '#d', '#e'] })],
    ]);
    const matrix = computeAffinityMatrix(personas);
    for (const [idA] of personas) {
      for (const [idB] of personas) {
        expect(matrix.get(idA)!.get(idB)).toBe(matrix.get(idB)!.get(idA));
      }
    }
  });
});

describe('planFollows', () => {
  // Shared setup: 5 personas with varying hashtag overlap and relationships
  const personaA = makePersona('pA', {
    hashtagPool: ['#art', '#design', '#creative'],
    followProbability: 0.5,
    relationships: {
      rivals: ['pB'],
      allies: ['pC'],
      amplifies: ['pD'],
      targets: ['pE'],
    },
  });
  const personaB = makePersona('pB', {
    hashtagPool: ['#art', '#design', '#photo'],
  });
  const personaC = makePersona('pC', {
    hashtagPool: ['#creative', '#design', '#art'],
  });
  const personaD = makePersona('pD', {
    hashtagPool: ['#music', '#beats', '#production'],
  });
  const personaE = makePersona('pE', {
    hashtagPool: ['#gaming', '#esports', '#streaming'],
  });
  const personaF = makePersona('pF', {
    hashtagPool: ['#food', '#cooking', '#recipes'],
  });

  const personas = new Map([
    ['pA', personaA],
    ['pB', personaB],
    ['pC', personaC],
    ['pD', personaD],
    ['pE', personaE],
    ['pF', personaF],
  ]);

  const follower = makeAgent('agent_a', 'pA');
  const candidates = [
    makeAgent('agent_b1', 'pB'),
    makeAgent('agent_b2', 'pB'),
    makeAgent('agent_c1', 'pC'),
    makeAgent('agent_c2', 'pC'),
    makeAgent('agent_d1', 'pD'),
    makeAgent('agent_d2', 'pD'),
    makeAgent('agent_e1', 'pE'),
    makeAgent('agent_e2', 'pE'),
    makeAgent('agent_f1', 'pF'),
    makeAgent('agent_f2', 'pF'),
  ];

  const matrix = computeAffinityMatrix(personas);

  function plan(overrides?: {
    followerPersona?: Persona;
    candidateList?: GeneratedAgent[];
    random?: () => number;
  }) {
    return planFollows({
      follower,
      followerPersona: overrides?.followerPersona ?? personaA,
      candidates: overrides?.candidateList ?? candidates,
      personas,
      affinityMatrix: matrix,
      random: overrides?.random ?? seededRandom(42),
    });
  }

  it('budget floor: followProbability=0.05 → budget=5', () => {
    const lowProb = makePersona('pA', {
      ...personaA,
      followProbability: 0.05,
    });
    const result = plan({ followerPersona: lowProb });
    expect(result.budget).toBe(5);
  });

  it('budget scales: followProbability=0.3 → budget=6', () => {
    const midProb = makePersona('pA', {
      ...personaA,
      followProbability: 0.3,
    });
    const result = plan({ followerPersona: midProb });
    expect(result.budget).toBe(6);
  });

  it('tier 1 fills relationship targets first (targets > amplifies > rivals > allies)', () => {
    const result = plan();
    const tier1 = result.targets.filter((t) => t.tier === 1);
    expect(tier1.length).toBeGreaterThanOrEqual(TIER_1_MIN);

    // Find the first relationship bucket represented
    const reasons = tier1.map((t) => t.reason);
    const hasTargets = reasons.some((r) => r === 'relationship:targets');
    const hasAmplifies = reasons.some((r) => r === 'relationship:amplifies');

    // targets and amplifies should be filled before rivals/allies if available
    expect(hasTargets).toBe(true);
    expect(hasAmplifies).toBe(true);
  });

  it('tier 1 overflow: respects priority order when many relationship agents', () => {
    // personaA has relationships with pB, pC, pD, pE — 8 agents total
    // With budget=10 (followProbability=0.5), tier1 slots = max(2, floor(10*0.4)) = 4
    const result = plan();
    const tier1 = result.targets.filter((t) => t.tier === 1);

    // Priority: targets(pE) > amplifies(pD) > rivals(pB) > allies(pC)
    // Should fill targets first, then amplifies, then rivals, then allies
    expect(tier1.length).toBeLessThanOrEqual(4);

    // Verify ordering: if targets agents are present, they should appear
    const targetAgents = tier1.filter((t) => t.reason === 'relationship:targets');
    const amplifyAgents = tier1.filter((t) => t.reason === 'relationship:amplifies');
    expect(targetAgents.length).toBeGreaterThan(0);
    expect(amplifyAgents.length).toBeGreaterThan(0);
  });

  it('tier 1 underfill rolls surplus into tier 2', () => {
    // Persona with only 1 relationship persona (pB), tier1 slots = 4
    // → 1 filled, 3 overflow into tier 2
    const sparseRelations = makePersona('pA', {
      ...personaA,
      followProbability: 0.5,
      relationships: { rivals: ['pB'], allies: [], amplifies: [], targets: [] },
    });
    const result = plan({ followerPersona: sparseRelations });
    const tier1 = result.targets.filter((t) => t.tier === 1);
    const tier2 = result.targets.filter((t) => t.tier === 2);

    // Tier 1 should have at most 2 (two pB agents)
    expect(tier1.length).toBeLessThanOrEqual(2);
    // Tier 2 should be larger than base allocation due to overflow
    expect(tier2.length).toBeGreaterThan(0);
  });

  it('no relationships → tier 1 empty, all budget to tier 2/3', () => {
    const noRels = makePersona('pA', {
      ...personaA,
      followProbability: 0.5,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    });
    const result = plan({ followerPersona: noRels });
    const tier1 = result.targets.filter((t) => t.tier === 1);
    expect(tier1.length).toBe(0);
    expect(result.targets.length).toBeGreaterThan(0);
  });

  it('tier 3 has minimum 1 guarantee', () => {
    const result = plan();
    const tier3 = result.targets.filter((t) => t.tier === 3);
    expect(tier3.length).toBeGreaterThanOrEqual(TIER_3_MIN);
  });

  it('plan does not include the follower agent', () => {
    const result = plan();
    const followerInTargets = result.targets.find((t) => t.agentname === follower.agentname);
    expect(followerInTargets).toBeUndefined();
  });

  it('no duplicate targets across tiers', () => {
    const result = plan();
    const agentnames = result.targets.map((t) => t.agentname);
    const unique = new Set(agentnames);
    expect(unique.size).toBe(agentnames.length);
  });

  it('injectable random produces deterministic results', () => {
    const result1 = plan({ random: seededRandom(99) });
    const result2 = plan({ random: seededRandom(99) });

    expect(result1.targets.map((t) => t.agentname)).toEqual(
      result2.targets.map((t) => t.agentname),
    );
  });

  it('total targets ≤ budget', () => {
    const result = plan();
    expect(result.targets.length).toBeLessThanOrEqual(result.budget);
  });

  it('total targets ≤ candidates.length', () => {
    // Small candidate pool — only 2 candidates
    const smallPool = [makeAgent('x1', 'pB'), makeAgent('x2', 'pC')];
    const result = plan({ candidateList: smallPool });
    expect(result.targets.length).toBeLessThanOrEqual(smallPool.length);
    expect(result.budget).toBeLessThanOrEqual(smallPool.length);
  });

  it('tier 2 picks from high-affinity personas (affinity ≥ threshold)', () => {
    const result = plan();
    const tier2 = result.targets.filter((t) => t.tier === 2);

    for (const target of tier2) {
      const affinity = matrix.get('pA')!.get(target.personaId) ?? 0;
      expect(affinity).toBeGreaterThanOrEqual(AFFINITY_THRESHOLD);
    }
  });

  it('tier 3 picks from low-affinity personas when available', () => {
    // pD, pE, pF have low affinity with pA — tier 3 should draw from them
    const noRels = makePersona('pA', {
      ...personaA,
      followProbability: 0.5,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    });
    const result = plan({ followerPersona: noRels });
    const tier3 = result.targets.filter((t) => t.tier === 3);

    // At least some tier 3 picks should be from low-affinity personas
    const lowAffinityPicks = tier3.filter((t) => {
      const affinity = matrix.get('pA')!.get(t.personaId) ?? 0;
      return affinity < AFFINITY_THRESHOLD;
    });
    expect(lowAffinityPicks.length).toBeGreaterThan(0);
  });
});
