import type { VoiceProfile } from '@/types';
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
