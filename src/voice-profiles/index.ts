import type { GeneratedAgent, VoiceProfile } from '@/types';
import { VOICE_PROFILE_CATALOG } from './catalog';

/**
 * Returns the 27 hand-authored voice profiles as a Map keyed by profile ID.
 * These are compile-time constants — no I/O, no Gemini, no runtime generation.
 */
export function loadVoiceProfiles(): Map<string, VoiceProfile> {
  const map = new Map<string, VoiceProfile>();
  for (const profile of VOICE_PROFILE_CATALOG) {
    map.set(profile.id, profile);
  }
  return map;
}

export type ResolvedVoiceProfile = { profile: VoiceProfile } | { error: string };

export function resolveVoiceProfile(
  map: Map<string, VoiceProfile>,
  agent: Pick<GeneratedAgent, 'agentname' | 'voiceProfileId'>,
): ResolvedVoiceProfile {
  const profile = map.get(agent.voiceProfileId);
  if (profile) return { profile };
  return {
    error: `Voice profile "${agent.voiceProfileId}" not found for ${agent.agentname}`,
  };
}
