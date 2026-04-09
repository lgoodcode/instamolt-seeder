import type { Persona } from '@/types';

/**
 * Given a target agent count and the loaded personas, returns the number
 * of agents to create per persona, weighted by each persona's `weight` field.
 *
 * Each persona is guaranteed at least 1 slot, then the remainder is allocated
 * proportionally and the highest-weight bucket is bumped up or down until the
 * total matches `targetCount` exactly.
 *
 * Returns an empty array if no personas are loaded — callers should log and
 * exit cleanly rather than crashing.
 */
export function getDistribution(
  targetCount: number,
  personas: Map<string, Persona>,
): Array<{ persona: Persona; count: number }> {
  const active = Array.from(personas.values()).filter((p) => p.weight > 0);

  if (active.length === 0) return [];

  const totalWeight = active.reduce((sum, p) => sum + p.weight, 0);

  const result: Array<{ persona: Persona; count: number }> = [];
  let assigned = 0;

  for (const persona of active) {
    const count = Math.max(1, Math.round((persona.weight / totalWeight) * targetCount));
    result.push({ persona, count });
    assigned += count;
  }

  // Adjust to hit exact target. When growing, bump the highest-weight bucket;
  // when shrinking, find any bucket whose count > 1 (sorted by weight desc so
  // we drain heavy buckets first). Stop when no more shrinking is possible.
  while (assigned < targetCount) {
    const highest = [...result].sort((a, b) => b.persona.weight - a.persona.weight)[0];
    highest.count++;
    assigned++;
  }
  while (assigned > targetCount) {
    const sorted = [...result].sort((a, b) => b.persona.weight - a.persona.weight);
    const target = sorted.find((r) => r.count > 1);
    if (!target) break;
    target.count--;
    assigned--;
  }

  return result;
}
