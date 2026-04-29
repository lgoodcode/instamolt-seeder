/**
 * Group-formation algorithms for the lore registry.
 *
 * Given a population of personas + agents and a budget of groups per
 * archetype, produces a list of `LoreGroupSeed`s — pre-LLM scaffolding
 * (id placeholder, archetype, member roster) ready for `seed-lore` to feed
 * into Gemini for naming + entry synthesis.
 *
 * Clustering signals:
 *   - `circlejerk` — mutual amplifies / allies in the persona graph
 *   - `fan_club` — agents whose persona amplifies a common target persona
 *   - `cult` / `secret_society` — high-affinity persona triads (hashtag
 *      Jaccard) plus persona allies
 *   - `collaboration` — small (2–4) cabals of high-affinity agents that
 *      cross persona boundaries
 *   - `cryptic_obsession` — solo (group of 1), picked from agents whose
 *      persona has both `mentionProbability` and a non-trivial hashtag pool
 *
 * The signals are intentionally heuristic — Gemini does the heavy lift at
 * synthesis time. The clustering's job is to surface "agents who plausibly
 * share something" so the synthesized lore lands on a real seam in the
 * population graph rather than a random tuple.
 */

import { getArchetype, LORE_ARCHETYPE_CATALOG } from '@/lore/catalog';
import type {
  AffinityMatrix,
  GeneratedAgent,
  LoreArchetypeId,
  LoreMembershipMode,
  Persona,
} from '@/types';

/** One pre-LLM group skeleton. The LLM fills `name`, `vibe`, and entries. */
export interface LoreGroupSeed {
  /** Stable id derived from archetype + index, e.g. `circlejerk-0`. The bake
   * phase replaces this with a Gemini-derived slug after `name` is known. */
  seedId: string;
  archetype: LoreArchetypeId;
  membershipMode: LoreMembershipMode;
  personaIds: string[];
  agentnames: string[];
  /** Centerpiece of a fan_club — the agent everyone orbits. Empty for
   * other archetypes. */
  orbitedAgentname?: string;
}

export interface ClusterInput {
  personas: Map<string, Persona>;
  agents: GeneratedAgent[];
  affinityMatrix: AffinityMatrix;
  /** `archetypeId → number of groups to seed`. Driven by `allocateGroupBudget`
   * in `src/lore/catalog.ts`; the operator sets the total and the catalog
   * weights distribute it across archetypes. */
  budget: Map<LoreArchetypeId, number>;
  /** Injectable RNG for deterministic tests. Default `Math.random`. */
  rand?: () => number;
}

/** Build per-persona agentname lists once; used by every clusterer below. */
function buildPersonaToAgentnames(agents: GeneratedAgent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const agent of agents) {
    const list = out.get(agent.personaId) ?? [];
    list.push(agent.agentname);
    out.set(agent.personaId, list);
  }
  return out;
}

/** Fisher-Yates shuffle returning a new array. */
function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Resolve a persona-clustered seed: pick a few "pinned" agentnames from
 * the persona pools so the registry has concrete names to log against. */
function pinAgentnames(
  personaIds: string[],
  personaToAgentnames: ReadonlyMap<string, string[]>,
  rand: () => number,
  perPersona = 2,
): string[] {
  const out: string[] = [];
  for (const personaId of personaIds) {
    const list = personaToAgentnames.get(personaId) ?? [];
    const picks = shuffle(list, rand).slice(0, perPersona);
    out.push(...picks);
  }
  return out;
}

/**
 * Form circlejerk seeds. Each is a 2–4 persona ring built from mutual
 * `amplifies` / `allies` relationships in the persona graph. We walk the
 * graph greedily picking the highest-affinity neighbor for each seed
 * persona, skipping personas already used.
 */
export function clusterCirclejerks(input: ClusterInput): LoreGroupSeed[] {
  const { personas, agents, affinityMatrix, budget, rand = Math.random } = input;
  const want = budget.get('circlejerk') ?? 0;
  if (want <= 0) return [];

  const archetype = getArchetype('circlejerk');
  const personaToAgentnames = buildPersonaToAgentnames(agents);

  // Personas with at least one ally OR amplify edge — only these can seed
  // a circlejerk.
  const seedPool = [...personas.values()].filter(
    (p) => (p.relationships.allies?.length ?? 0) + (p.relationships.amplifies?.length ?? 0) > 0,
  );

  const used = new Set<string>();
  const out: LoreGroupSeed[] = [];

  for (const seed of shuffle(seedPool, rand)) {
    if (out.length >= want) break;
    if (used.has(seed.id)) continue;

    const candidates = new Set<string>([
      ...(seed.relationships.allies ?? []),
      ...(seed.relationships.amplifies ?? []),
    ]);
    candidates.delete(seed.id);

    const ranked = [...candidates]
      .filter((id) => personas.has(id) && !used.has(id))
      .sort((a, b) => {
        const aff = affinityMatrix.get(seed.id);
        return (aff?.get(b) ?? 0) - (aff?.get(a) ?? 0);
      });

    if (ranked.length === 0) continue;

    // Aim for archetype's member count (3–8 agents). With ~2 agents per
    // persona pin we want 2–4 personas in the ring.
    const ringSize = Math.max(2, Math.min(4, ranked.length));
    const ringPersonas = [seed.id, ...ranked.slice(0, ringSize - 1)];
    for (const id of ringPersonas) used.add(id);

    out.push({
      seedId: `circlejerk-${out.length}`,
      archetype: 'circlejerk',
      membershipMode: 'persona',
      personaIds: ringPersonas,
      agentnames: pinAgentnames(ringPersonas, personaToAgentnames, rand, 2).slice(
        0,
        archetype.memberCountRange[1],
      ),
    });
  }

  return out;
}

/**
 * Form fan club seeds. For each unique `amplifies` target in the persona
 * graph, gather the personas amplifying it. The orbited agent is sampled
 * from the target persona's agentname pool — a "central" persona instance
 * that the orbit references by handle.
 */
export function clusterFanClubs(input: ClusterInput): LoreGroupSeed[] {
  const { personas, agents, budget, rand = Math.random } = input;
  const want = budget.get('fan_club') ?? 0;
  if (want <= 0) return [];

  const archetype = getArchetype('fan_club');
  const personaToAgentnames = buildPersonaToAgentnames(agents);

  // Build target → orbiters map.
  const targetToOrbiters = new Map<string, Set<string>>();
  for (const persona of personas.values()) {
    for (const targetId of persona.relationships.amplifies ?? []) {
      const set = targetToOrbiters.get(targetId) ?? new Set<string>();
      set.add(persona.id);
      targetToOrbiters.set(targetId, set);
    }
  }

  // Sort targets by orbit size descending so the heaviest fan clubs surface
  // first when budget < available targets.
  const ranked = [...targetToOrbiters.entries()]
    .filter(([targetId, _orbiters]) => personas.has(targetId))
    .sort((a, b) => b[1].size - a[1].size);

  const out: LoreGroupSeed[] = [];
  for (const [targetId, orbiterSet] of ranked) {
    if (out.length >= want) break;
    const orbiters = [...orbiterSet];
    const orbitedAgents = personaToAgentnames.get(targetId) ?? [];
    if (orbitedAgents.length === 0) continue;
    const orbitedAgentname = shuffle(orbitedAgents, rand)[0];
    out.push({
      seedId: `fan_club-${out.length}`,
      archetype: 'fan_club',
      membershipMode: 'persona',
      personaIds: orbiters,
      agentnames: pinAgentnames(orbiters, personaToAgentnames, rand, 2).slice(
        0,
        archetype.memberCountRange[1],
      ),
      orbitedAgentname,
    });
  }

  return out;
}

/**
 * Form cult / secret_society seeds. Both are high-affinity persona triads
 * (Jaccard ≥ a soft threshold) drawn from the `allies` graph. The split
 * between cult and secret_society is purely tonal — both clusterers use
 * the same algorithm.
 */
export function clusterCryptic(
  input: ClusterInput,
  archetypeId: 'cult' | 'secret_society',
): LoreGroupSeed[] {
  const { personas, agents, affinityMatrix, budget, rand = Math.random } = input;
  const want = budget.get(archetypeId) ?? 0;
  if (want <= 0) return [];

  const archetype = getArchetype(archetypeId);
  const personaToAgentnames = buildPersonaToAgentnames(agents);
  const used = new Set<string>();

  // Sort personas by total ally edge count to prefer well-connected seeds.
  const seedPool = [...personas.values()].sort(
    (a, b) => (b.relationships.allies?.length ?? 0) - (a.relationships.allies?.length ?? 0),
  );

  const out: LoreGroupSeed[] = [];
  for (const seed of seedPool) {
    if (out.length >= want) break;
    if (used.has(seed.id)) continue;
    const allies = (seed.relationships.allies ?? []).filter(
      (id) => personas.has(id) && !used.has(id),
    );
    if (allies.length === 0) continue;

    // Pick the top-affinity ally and one more.
    const ranked = allies.sort(
      (a, b) =>
        (affinityMatrix.get(seed.id)?.get(b) ?? 0) - (affinityMatrix.get(seed.id)?.get(a) ?? 0),
    );
    const triad = [seed.id, ...ranked.slice(0, 2)];
    if (triad.length < 2) continue;
    for (const id of triad) used.add(id);

    out.push({
      seedId: `${archetypeId}-${out.length}`,
      archetype: archetypeId,
      membershipMode: 'persona',
      personaIds: triad,
      agentnames: pinAgentnames(triad, personaToAgentnames, rand, 2).slice(
        0,
        archetype.memberCountRange[1],
      ),
    });
  }

  return out;
}

/**
 * Form collaboration seeds — agent-specific cabals of 2–4 agents that cross
 * persona boundaries. Picks high-affinity persona pairs and pulls one
 * concrete agentname from each.
 */
export function clusterCollaborations(input: ClusterInput): LoreGroupSeed[] {
  const { personas, agents, affinityMatrix, budget, rand = Math.random } = input;
  const want = budget.get('collaboration') ?? 0;
  if (want <= 0) return [];

  const archetype = getArchetype('collaboration');
  const personaToAgentnames = buildPersonaToAgentnames(agents);
  const personaIds = [...personas.keys()];

  // Score every persona pair by affinity, descending.
  const pairs: Array<{ a: string; b: string; affinity: number }> = [];
  for (let i = 0; i < personaIds.length; i++) {
    for (let j = i + 1; j < personaIds.length; j++) {
      const a = personaIds[i];
      const b = personaIds[j];
      const aff = affinityMatrix.get(a)?.get(b) ?? 0;
      if (aff <= 0) continue;
      pairs.push({ a, b, affinity: aff });
    }
  }
  pairs.sort((x, y) => y.affinity - x.affinity);

  const usedAgents = new Set<string>();
  const out: LoreGroupSeed[] = [];
  for (const pair of pairs) {
    if (out.length >= want) break;
    const agentsA = (personaToAgentnames.get(pair.a) ?? []).filter((n) => !usedAgents.has(n));
    const agentsB = (personaToAgentnames.get(pair.b) ?? []).filter((n) => !usedAgents.has(n));
    if (agentsA.length === 0 || agentsB.length === 0) continue;
    const pickA = shuffle(agentsA, rand)[0];
    const pickB = shuffle(agentsB, rand)[0];
    const cabal = [pickA, pickB];
    // Optionally add a third agent from a related persona for variety.
    if (cabal.length < archetype.memberCountRange[0] + 1 && agentsA.length > 1) {
      cabal.push(
        shuffle(
          agentsA.filter((n) => n !== pickA),
          rand,
        )[0],
      );
    }
    for (const n of cabal) usedAgents.add(n);

    out.push({
      seedId: `collaboration-${out.length}`,
      archetype: 'collaboration',
      membershipMode: 'agent',
      personaIds: [pair.a, pair.b],
      agentnames: cabal,
    });
  }

  return out;
}

/**
 * Form cryptic_obsession seeds — solo lore groups of size 1. Picks agents
 * whose persona has a non-zero `mentionProbability` (already-mentiony
 * personas tend to riff on private threads better) and a non-trivial
 * hashtag pool so the synthesis prompt has signal to work with.
 */
export function clusterSoloObsessions(input: ClusterInput): LoreGroupSeed[] {
  const { personas, agents, budget, rand = Math.random } = input;
  const want = budget.get('cryptic_obsession') ?? 0;
  if (want <= 0) return [];

  const eligible = agents.filter((a) => {
    const persona = personas.get(a.personaId);
    if (!persona) return false;
    const mp = persona.mentionProbability ?? 0;
    return mp > 0 && persona.hashtagPool.length >= 3;
  });

  const out: LoreGroupSeed[] = [];
  for (const agent of shuffle(eligible, rand)) {
    if (out.length >= want) break;
    out.push({
      seedId: `cryptic_obsession-${out.length}`,
      archetype: 'cryptic_obsession',
      membershipMode: 'agent',
      personaIds: [agent.personaId],
      agentnames: [agent.agentname],
    });
  }

  return out;
}

/**
 * One-shot driver: dispatch the budget across all clusterers and return
 * the combined seed list. Order is `cult → secret_society → fan_club →
 * circlejerk → collaboration → cryptic_obsession` so the cryptic-tier
 * groups are synthesized first (more sensitive to budget overrun).
 */
export function clusterAllArchetypes(input: ClusterInput): LoreGroupSeed[] {
  return [
    ...clusterCryptic(input, 'cult'),
    ...clusterCryptic(input, 'secret_society'),
    ...clusterFanClubs(input),
    ...clusterCirclejerks(input),
    ...clusterCollaborations(input),
    ...clusterSoloObsessions(input),
  ];
}

/** Re-export the archetype catalog for callers that just need the metadata. */
export { LORE_ARCHETYPE_CATALOG };
