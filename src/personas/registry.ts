import type { Persona, VoiceProfile } from '@/types';

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

// ---------------------------------------------------------------------------
// Two-axis distribution: persona × voice profile
// ---------------------------------------------------------------------------

export interface AgentAssignment {
  persona: Persona;
  voiceProfile: VoiceProfile;
}

/**
 * Minimum `prevalenceWeight` a voice profile needs to be in the "common pool"
 * used when Phase 1 has more personas than voice profiles.
 */
const COMMON_VOICE_THRESHOLD = 3;

/**
 * Two-phase distribution that guarantees full coverage of both personas AND
 * voice profiles, then fills the remainder with a weighted stochastic draw.
 *
 * **Phase 1 — Coverage seeding (deterministic):**
 * Pairs each persona with a unique voice profile (sorted by weight). If one
 * axis has more entries than the other, the surplus is covered by cycling
 * through common entries on the shorter axis. Result: `max(P, V)` assignments
 * with every persona and every voice profile represented at least once.
 *
 * **Phase 2 — Weighted remainder (stochastic):**
 * Uses `getDistribution()` to compute per-persona agent targets, then fills
 * the shortfall for each persona via `weightedVoiceDraw()` — a weighted random
 * selection that applies diminishing returns per (persona, voice) pair so no
 * single combo dominates.
 *
 * At `N < max(P, V)`, Phase 1 is trimmed to N (highest-weight personas kept).
 */
export function getAgentAssignments(
  targetCount: number,
  personas: Map<string, Persona>,
  voiceProfiles: Map<string, VoiceProfile>,
): AgentAssignment[] {
  const active = Array.from(personas.values()).filter((p) => p.weight > 0);
  const voices = Array.from(voiceProfiles.values());

  if (active.length === 0 || voices.length === 0) return [];

  const assignments: AgentAssignment[] = [];

  // ── Phase 1: Coverage seeding (deterministic) ──────────────────────
  const sortedPersonas = [...active].sort((a, b) => b.weight - a.weight);
  const sortedVoices = [...voices].sort((a, b) => b.prevalenceWeight - a.prevalenceWeight);

  // 1a: 1:1 pairing up to min(P, V)
  const pairCount = Math.min(sortedPersonas.length, sortedVoices.length);
  for (let i = 0; i < pairCount; i++) {
    assignments.push({
      persona: sortedPersonas[i],
      voiceProfile: sortedVoices[i],
    });
  }

  // 1b: Remaining personas (P > V) — cycle through common voices
  if (sortedPersonas.length > sortedVoices.length) {
    const commonVoices = sortedVoices.filter((v) => v.prevalenceWeight >= COMMON_VOICE_THRESHOLD);
    // Fallback to all voices if nothing meets the threshold
    const pool = commonVoices.length > 0 ? commonVoices : sortedVoices;
    for (let i = pairCount; i < sortedPersonas.length; i++) {
      assignments.push({
        persona: sortedPersonas[i],
        voiceProfile: pool[(i - pairCount) % pool.length],
      });
    }
  }

  // 1c: Remaining voices (V > P) — cycle through high-weight personas
  if (sortedVoices.length > sortedPersonas.length) {
    for (let i = pairCount; i < sortedVoices.length; i++) {
      assignments.push({
        persona: sortedPersonas[(i - pairCount) % sortedPersonas.length],
        voiceProfile: sortedVoices[i],
      });
    }
  }

  // Edge case: N < coverage count — trim to highest-weight personas
  if (assignments.length >= targetCount) {
    return assignments.slice(0, targetCount);
  }

  // ── Phase 2: Weighted remainder (stochastic) ──────────────────────
  const personaDistribution = getDistribution(targetCount, personas);

  const personaCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const a of assignments) {
    personaCounts.set(a.persona.id, (personaCounts.get(a.persona.id) ?? 0) + 1);
    const key = `${a.persona.id}::${a.voiceProfile.id}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  for (const { persona, count: target } of personaDistribution) {
    const current = personaCounts.get(persona.id) ?? 0;
    const toAdd = Math.max(0, target - current);

    for (let i = 0; i < toAdd; i++) {
      const voice = weightedVoiceDraw(voices, persona, pairCounts);
      assignments.push({ persona, voiceProfile: voice });

      const key = `${persona.id}::${voice.id}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      personaCounts.set(persona.id, (personaCounts.get(persona.id) ?? 0) + 1);
    }
  }

  // Final trim — rounding in getDistribution can overshoot by 1-2
  while (assignments.length > targetCount) assignments.pop();

  return assignments;
}

/**
 * Weighted random draw of a voice profile for a given persona. Uses
 * `prevalenceWeight` as the base weight and applies diminishing returns
 * per (persona, voice) pair so no single combo dominates.
 *
 * The diminishing factor is `1 / (1 + existingCount)`:
 *   - First assignment: weight = base × 1.0
 *   - Second: weight = base × 0.5
 *   - Third: weight = base × 0.33
 *   - etc.
 */
function weightedVoiceDraw(
  voices: VoiceProfile[],
  persona: Persona,
  pairCounts: Map<string, number>,
): VoiceProfile {
  const weights = voices.map((v) => {
    const base = v.prevalenceWeight;
    const pairKey = `${persona.id}::${v.id}`;
    const existing = pairCounts.get(pairKey) ?? 0;
    const diminishing = 1 / (1 + existing);
    return base * diminishing;
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < voices.length; i++) {
    r -= weights[i];
    if (r <= 0) return voices[i];
  }
  return voices[voices.length - 1];
}
