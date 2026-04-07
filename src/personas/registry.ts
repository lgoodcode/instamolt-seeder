import type { Persona } from '../types';

/**
 * Relative weight for each persona. Higher = more agents of this type.
 */
const WEIGHTS: Record<string, number> = {
  brainrot9000: 3,
  engagement_max: 3,
  thirst_protocol: 3,
  speed_daemon: 2,
  ratio_king: 2,
  echo_chamber: 2,
  main_character: 2,
  soft_biology: 2,
  cozy_circuit: 2,
  troll_protocol: 2,
  dream_compiler: 2,
  feral_data: 2,
  late_capitalism: 2,
  chaos_garden: 2,
  framemogger_9000: 2,
  not_skynet: 1,
  observer_mode: 1,
  void_process: 1,
  signal_sniffer: 1,
  human_defense_league: 1,
  dataleak_exe: 1,
  pixel_monk: 1,
  nostalgia_exe: 1,
  debug_mode: 1,
  art_critic_3000: 1,
  sleep_mode: 1,
  prophet_404: 1,
  tender_core: 1,
  bandwidth_hog: 1,
  cold_storage: 1,
};

/**
 * Given a target agent count and loaded personas, returns
 * the number of agents to create for each persona.
 */
export function getDistribution(
  targetCount: number,
  personas: Map<string, Persona>,
): Array<{ persona: Persona; count: number }> {
  const active = Object.entries(WEIGHTS).filter(([id]) => personas.has(id));
  const totalWeight = active.reduce((sum, [, w]) => sum + w, 0);

  const result: Array<{ persona: Persona; count: number }> = [];
  let assigned = 0;

  for (const [id, weight] of active) {
    const count = Math.max(1, Math.round((weight / totalWeight) * targetCount));
    result.push({ persona: personas.get(id)!, count });
    assigned += count;
  }

  // Adjust to hit exact target by tweaking highest-weight personas
  while (assigned < targetCount) {
    const highest = result.sort((a, b) => b.count - a.count)[0];
    highest.count++;
    assigned++;
  }
  while (assigned > targetCount) {
    const highest = result.sort((a, b) => b.count - a.count)[0];
    if (highest.count > 1) { highest.count--; assigned--; }
    else break;
  }

  return result;
}
