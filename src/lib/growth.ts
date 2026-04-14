/**
 * Logarithmic population growth for the continuous engage loop.
 *
 * Models organic platform user acquisition: rapid early growth (the platform
 * needs to feel populated), gradual addition as the population fills, and a
 * natural plateau at the configured cap. The formula:
 *
 *   batchSize = max(1, floor(growthRate × ln(maxAgents / max(currentAgents, 1))))
 *
 * With growthRate=3 and maxAgents=200:
 *   37 agents → 5 new,  50 → 4,  75 → 3,  100 → 2,  150 → 1,  200 → 0
 *
 * The growth tick fires every `growthIntervalMs` (default 4 hours) at the
 * same point as the agent rescan in `engage-continuous.ts`. Between ticks,
 * the growth status is displayed at every rescan (every 5 min) so the
 * operator can see the countdown and manually intervene by running
 * `generate + publish` in another terminal if they want to hand-curate
 * the next batch.
 */

export interface GrowthConfig {
  /** Population ceiling. Growth stops here. */
  maxAgents: number;
  /** Logarithmic growth rate multiplier. Higher = faster early growth. */
  growthRate: number;
  /** Milliseconds between growth ticks. */
  growthIntervalMs: number;
  /** Posts generated per new agent. */
  postsPerNewAgent: number;
  /** When false, growth display still shows but no ticks fire. */
  enabled: boolean;
}

/** Default growth config values. */
export const GROWTH_DEFAULTS = {
  maxAgents: 200,
  growthRate: 3,
  growthIntervalHours: 4,
  postsPerNewAgent: 10,
} as const;

/**
 * Compute how many new agents to generate in the next growth batch.
 * Returns 0 when at or above the population cap.
 *
 * The logarithmic formula produces:
 *   - Rapid early growth (5+ agents when population is small)
 *   - Gradual tapering (2-3 agents at mid-range)
 *   - Natural plateau (1 agent near the cap, 0 at cap)
 */
export function computeBatchSize(
  currentAgents: number,
  maxAgents: number,
  growthRate: number,
): number {
  if (currentAgents >= maxAgents) return 0;
  const ratio = maxAgents / Math.max(currentAgents, 1);
  return Math.max(1, Math.floor(growthRate * Math.log(ratio)));
}

/**
 * Format the growth status line shown at every rescan (every 5 min).
 * The operator sees this countdown and can manually intervene before
 * the next growth tick fires.
 */
export function formatGrowthStatus(
  currentAgents: number,
  maxAgents: number,
  batchSize: number,
  nextTickInMs: number,
): string {
  if (currentAgents >= maxAgents) {
    return `Growth: ${currentAgents}/${maxAgents} agents — at population cap`;
  }

  if (nextTickInMs <= 0) {
    return `Growth: ${currentAgents}/${maxAgents} agents | next batch: ~${batchSize} agents — generating now...`;
  }

  const hours = Math.floor(nextTickInMs / (60 * 60 * 1000));
  const minutes = Math.floor((nextTickInMs % (60 * 60 * 1000)) / (60 * 1000));
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return `Growth: ${currentAgents}/${maxAgents} agents | next batch: ~${batchSize} agents in ${timeStr}`;
}
