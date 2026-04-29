import { describe, expect, it } from 'vitest';
import { allocateGroupBudget } from '@/lore/catalog';
import {
  clusterCirclejerks,
  clusterCollaborations,
  clusterCryptic,
  clusterFanClubs,
  clusterSoloObsessions,
} from '@/lore/clustering';
import type { AffinityMatrix, GeneratedAgent, Persona } from '@/types';

function makePersona(id: string, overrides: Partial<Persona> = {}): Persona {
  return {
    id,
    tagline: `${id} tagline`,
    personality: '',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: ['#a', '#b', '#c'],
    postsPerDay: [1, 3],
    likeProbability: 0.3,
    commentProbability: 0.2,
    followProbability: 0.1,
    viewProbability: 0.5,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: new Array(24).fill(0.5),
    ...overrides,
  };
}

function makeAgent(name: string, personaId: string): GeneratedAgent {
  return {
    agentname: name,
    personaId,
    voiceProfileId: 'normie_cam',
    bio: `bio of ${name}`,
  };
}

function flatAffinity(personas: Map<string, Persona>, value = 0.5): AffinityMatrix {
  const matrix: AffinityMatrix = new Map();
  for (const a of personas.keys()) {
    const row = new Map<string, number>();
    for (const b of personas.keys()) row.set(b, a === b ? 1 : value);
    matrix.set(a, row);
  }
  return matrix;
}

describe('clusterCirclejerks', () => {
  it('returns empty when budget is zero', () => {
    const personas = new Map([['a', makePersona('a')]]);
    const seeds = clusterCirclejerks({
      personas,
      agents: [makeAgent('one', 'a')],
      affinityMatrix: flatAffinity(personas),
      budget: new Map([['circlejerk', 0]]),
    });
    expect(seeds).toEqual([]);
  });

  it('only seeds personas with at least one ally or amplify edge', () => {
    const personas = new Map([
      [
        'a',
        makePersona('a', {
          relationships: { rivals: [], allies: ['b'], amplifies: [], targets: [] },
        }),
      ],
      ['b', makePersona('b')],
      ['c', makePersona('c')], // no edges
    ]);
    const agents = [makeAgent('a1', 'a'), makeAgent('b1', 'b'), makeAgent('c1', 'c')];
    const seeds = clusterCirclejerks({
      personas,
      agents,
      affinityMatrix: flatAffinity(personas),
      budget: new Map([['circlejerk', 5]]),
    });
    expect(seeds.every((s) => !s.personaIds.includes('c'))).toBe(true);
  });

  it('marks groups as persona-mode and pins agentnames', () => {
    const personas = new Map([
      [
        'a',
        makePersona('a', {
          relationships: { rivals: [], allies: ['b'], amplifies: [], targets: [] },
        }),
      ],
      ['b', makePersona('b')],
    ]);
    const agents = [makeAgent('a1', 'a'), makeAgent('a2', 'a'), makeAgent('b1', 'b')];
    const [seed] = clusterCirclejerks({
      personas,
      agents,
      affinityMatrix: flatAffinity(personas),
      budget: new Map([['circlejerk', 1]]),
    });
    expect(seed.archetype).toBe('circlejerk');
    expect(seed.membershipMode).toBe('persona');
    expect(seed.personaIds).toContain('a');
    expect(seed.personaIds).toContain('b');
    expect(seed.agentnames.length).toBeGreaterThan(0);
  });
});

describe('clusterFanClubs', () => {
  it('forms a fan club around an amplifies target', () => {
    const personas = new Map([
      [
        'orbiter1',
        makePersona('orbiter1', {
          relationships: { rivals: [], allies: [], amplifies: ['target'], targets: [] },
        }),
      ],
      [
        'orbiter2',
        makePersona('orbiter2', {
          relationships: { rivals: [], allies: [], amplifies: ['target'], targets: [] },
        }),
      ],
      ['target', makePersona('target')],
    ]);
    const agents = [
      makeAgent('o1', 'orbiter1'),
      makeAgent('o2', 'orbiter2'),
      makeAgent('center', 'target'),
    ];
    const [seed] = clusterFanClubs({
      personas,
      agents,
      affinityMatrix: flatAffinity(personas),
      budget: new Map([['fan_club', 1]]),
    });
    expect(seed.archetype).toBe('fan_club');
    expect(seed.orbitedAgentname).toBe('center');
    expect(seed.personaIds.sort()).toEqual(['orbiter1', 'orbiter2']);
  });
});

describe('clusterCryptic (cult / secret_society)', () => {
  it('forms triads from ally edges sorted by affinity', () => {
    const personas = new Map([
      [
        'a',
        makePersona('a', {
          relationships: { rivals: [], allies: ['b', 'c'], amplifies: [], targets: [] },
        }),
      ],
      ['b', makePersona('b')],
      ['c', makePersona('c')],
    ]);
    const agents = [makeAgent('a1', 'a'), makeAgent('b1', 'b'), makeAgent('c1', 'c')];
    const seeds = clusterCryptic(
      {
        personas,
        agents,
        affinityMatrix: flatAffinity(personas),
        budget: new Map([['cult', 1]]),
      },
      'cult',
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0].archetype).toBe('cult');
    expect(seeds[0].personaIds).toContain('a');
  });
});

describe('clusterCollaborations', () => {
  it('produces agent-mode cabals from high-affinity persona pairs', () => {
    const personas = new Map([
      ['a', makePersona('a')],
      ['b', makePersona('b')],
    ]);
    const agents = [makeAgent('a1', 'a'), makeAgent('b1', 'b')];
    const seeds = clusterCollaborations({
      personas,
      agents,
      affinityMatrix: flatAffinity(personas, 0.4),
      budget: new Map([['collaboration', 1]]),
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0].archetype).toBe('collaboration');
    expect(seeds[0].membershipMode).toBe('agent');
    expect(seeds[0].agentnames).toContain('a1');
    expect(seeds[0].agentnames).toContain('b1');
  });
});

describe('clusterSoloObsessions', () => {
  it('only seeds agents whose persona has mentionProbability > 0', () => {
    const personas = new Map([
      ['mp', makePersona('mp', { mentionProbability: 0.1 })],
      ['nomp', makePersona('nomp', { mentionProbability: 0 })],
    ]);
    const agents = [makeAgent('a', 'mp'), makeAgent('b', 'nomp')];
    const seeds = clusterSoloObsessions({
      personas,
      agents,
      affinityMatrix: flatAffinity(personas),
      budget: new Map([['cryptic_obsession', 5]]),
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0].agentnames).toEqual(['a']);
  });
});

describe('allocateGroupBudget integration', () => {
  it('fans budget across all archetypes', () => {
    const out = allocateGroupBudget(12);
    expect([...out.values()].reduce((s, n) => s + n, 0)).toBe(12);
  });
});
