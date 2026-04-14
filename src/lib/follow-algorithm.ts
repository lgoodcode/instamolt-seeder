import type {
  AffinityMatrix,
  FollowPlan,
  FollowTarget,
  GeneratedAgent,
  Persona,
  PersonaRelationships,
} from '@/types';

// --- Constants (exported for testing) ---

export const TIER_1_RATIO = 0.4;
export const TIER_2_RATIO = 0.35;
export const TIER_3_RATIO = 0.25;
export const TIER_1_MIN = 2;
export const TIER_3_MIN = 1;
export const AFFINITY_THRESHOLD = 0.15;
export const RELATIONSHIP_PRIORITY: Array<keyof PersonaRelationships> = [
  'targets',
  'amplifies',
  'rivals',
  'allies',
];

// --- Helpers ---

/** Fisher-Yates shuffle returning a new array. */
function shuffleArray<T>(arr: readonly T[], random: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Weighted random selection without replacement using cumulative-weight scan. */
function weightedSample<T>(
  items: readonly T[],
  weights: readonly number[],
  count: number,
  random: () => number,
): T[] {
  const remaining = items.map((item, i) => ({ item, weight: weights[i] }));
  const selected: T[] = [];

  for (let picked = 0; picked < count && remaining.length > 0; picked++) {
    const totalWeight = remaining.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight <= 0) break;

    const threshold = random() * totalWeight;
    let cumulative = 0;
    let chosenIdx = remaining.length - 1; // fallback to last

    for (let i = 0; i < remaining.length; i++) {
      cumulative += remaining[i].weight;
      if (cumulative >= threshold) {
        chosenIdx = i;
        break;
      }
    }

    selected.push(remaining[chosenIdx].item);
    remaining.splice(chosenIdx, 1);
  }

  return selected;
}

// --- Core functions ---

/**
 * Compute Jaccard similarity between every persona pair based on `hashtagPool`.
 * Self-affinity is 1.0. Both empty pools yield 0.0.
 */
export function computeAffinityMatrix(personas: Map<string, Persona>): AffinityMatrix {
  const ids = [...personas.keys()];

  // Pre-compute lowercase hashtag sets
  const hashSets = new Map<string, Set<string>>();
  for (const [id, persona] of personas) {
    hashSets.set(id, new Set(persona.hashtagPool.map((h) => h.toLowerCase())));
  }

  const matrix: AffinityMatrix = new Map();

  for (const a of ids) {
    const row = new Map<string, number>();
    const setA = hashSets.get(a)!;

    for (const b of ids) {
      if (a === b) {
        row.set(b, 1.0);
        continue;
      }

      const setB = hashSets.get(b)!;

      // Both empty → 0
      if (setA.size === 0 && setB.size === 0) {
        row.set(b, 0.0);
        continue;
      }

      let intersection = 0;
      // Iterate over the smaller set for efficiency
      const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
      for (const tag of smaller) {
        if (larger.has(tag)) intersection++;
      }

      const union = setA.size + setB.size - intersection;
      row.set(b, union === 0 ? 0.0 : intersection / union);
    }

    matrix.set(a, row);
  }

  return matrix;
}

export interface PlanFollowsOptions {
  follower: GeneratedAgent;
  followerPersona: Persona;
  candidates: GeneratedAgent[];
  personas: Map<string, Persona>;
  affinityMatrix: AffinityMatrix;
  /** Injectable RNG for deterministic tests. Default: Math.random. */
  random?: () => number;
}

/**
 * Three-tier follow plan:
 *   Tier 1 (40%, min 2) — relationship graph
 *   Tier 2 (35% + overflow) — affinity-weighted
 *   Tier 3 (25%, min 1, + overflow) — random discovery
 */
export function planFollows(opts: PlanFollowsOptions): FollowPlan {
  const { follower, followerPersona, candidates, affinityMatrix, random = Math.random } = opts;

  // Budget: 5–20 based on followProbability
  const rawBudget = Math.max(5, Math.floor(followerPersona.followProbability * 20));
  const budget = Math.min(rawBudget, candidates.length);

  if (budget === 0) {
    return { follower: follower.agentname, budget: 0, targets: [] };
  }

  // Tier slot allocation
  const tier1Slots = Math.max(TIER_1_MIN, Math.floor(budget * TIER_1_RATIO));
  const tier3SlotsBase = Math.max(TIER_3_MIN, Math.floor(budget * TIER_3_RATIO));

  const selected = new Set<string>();
  const targets: FollowTarget[] = [];

  // --- Tier 1: Relationship follows ---
  const relationships = followerPersona.relationships;
  const relationshipPersonaIds = new Set<string>();
  for (const key of RELATIONSHIP_PRIORITY) {
    for (const pid of relationships[key]) {
      relationshipPersonaIds.add(pid);
    }
  }

  // Pre-filter once to the union of every relationship persona — tier-1 only
  // ever picks from this subset, so the per-relKey filter loop below scans a
  // much smaller list at large candidate counts.
  const tier1Candidates = candidates.filter((c) => relationshipPersonaIds.has(c.personaId));

  let tier1Filled = 0;
  for (const relKey of RELATIONSHIP_PRIORITY) {
    if (tier1Filled >= tier1Slots) break;

    const personaIds = new Set(relationships[relKey]);
    const bucket = tier1Candidates.filter(
      (c) => personaIds.has(c.personaId) && !selected.has(c.agentname),
    );
    const shuffled = shuffleArray(bucket, random);
    const take = Math.min(shuffled.length, tier1Slots - tier1Filled);

    for (let i = 0; i < take; i++) {
      const agent = shuffled[i];
      selected.add(agent.agentname);
      targets.push({
        agentname: agent.agentname,
        personaId: agent.personaId,
        tier: 1,
        reason: `relationship:${relKey}`,
      });
      tier1Filled++;
    }
  }

  // Overflow from tier 1 underfill rolls into tier 2
  const tier1Overflow = tier1Slots - tier1Filled;

  // --- Tier 2: Affinity-based ---
  const tier2Slots = Math.floor(budget * TIER_2_RATIO) + tier1Overflow;

  const followerRow = affinityMatrix.get(followerPersona.id);
  const tier2Pool = candidates.filter((c) => {
    if (selected.has(c.agentname)) return false;
    const affinity = followerRow?.get(c.personaId) ?? 0;
    return affinity >= AFFINITY_THRESHOLD;
  });

  const tier2Weights = tier2Pool.map((c) => followerRow?.get(c.personaId) ?? 0);
  const tier2Picks = weightedSample(tier2Pool, tier2Weights, tier2Slots, random);

  for (const agent of tier2Picks) {
    selected.add(agent.agentname);
    const affinity = followerRow?.get(agent.personaId) ?? 0;
    targets.push({
      agentname: agent.agentname,
      personaId: agent.personaId,
      tier: 2,
      reason: `affinity:${affinity.toFixed(2)}`,
    });
  }

  // Overflow from tier 2 underfill rolls into tier 3
  const tier2Overflow = tier2Slots - tier2Picks.length;

  // --- Tier 3: Random discovery ---
  const tier3Slots = tier3SlotsBase + tier2Overflow;
  const remaining = budget - targets.length;
  const tier3Take = Math.min(tier3Slots, remaining);

  // Prefer low-affinity candidates
  let tier3Pool = candidates.filter((c) => {
    if (selected.has(c.agentname)) return false;
    const affinity = followerRow?.get(c.personaId) ?? 0;
    return affinity < AFFINITY_THRESHOLD;
  });

  // If low-affinity pool is empty, fall back to any remaining
  if (tier3Pool.length === 0) {
    tier3Pool = candidates.filter((c) => !selected.has(c.agentname));
  }

  const shuffledTier3 = shuffleArray(tier3Pool, random);
  const tier3Final = shuffledTier3.slice(0, tier3Take);

  for (const agent of tier3Final) {
    selected.add(agent.agentname);
    targets.push({
      agentname: agent.agentname,
      personaId: agent.personaId,
      tier: 3,
      reason: 'discovery',
    });
  }

  return {
    follower: follower.agentname,
    budget,
    targets,
  };
}
