import { describe, expect, it } from 'vitest';

import { loadVoiceProfiles } from '@/voice-profiles';

const AGENTNAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const MIN_LEN = 3;
const MAX_LEN = 20;
const MIN_EXAMPLES = 5;

describe('voice profile catalog — usernameStyle', () => {
  const profiles = Array.from(loadVoiceProfiles().values());

  it('every profile declares a usernameStyle', () => {
    for (const p of profiles) {
      expect(p.usernameStyle, `profile ${p.id} missing usernameStyle`).toBeDefined();
    }
  });

  it('every example passes the platform regex and length bounds', () => {
    for (const p of profiles) {
      expect(
        p.usernameStyle.examples.length,
        `profile ${p.id} should have at least ${MIN_EXAMPLES} examples`,
      ).toBeGreaterThanOrEqual(MIN_EXAMPLES);

      for (const ex of p.usernameStyle.examples) {
        expect(ex, `${p.id}: example "${ex}" must match agentname regex`).toMatch(AGENTNAME_REGEX);
        expect(
          ex.length,
          `${p.id}: example "${ex}" length ${ex.length} out of bounds [${MIN_LEN}, ${MAX_LEN}]`,
        ).toBeGreaterThanOrEqual(MIN_LEN);
        expect(ex.length).toBeLessThanOrEqual(MAX_LEN);
      }
    }
  });

  it('every profile has a non-empty guidance string', () => {
    for (const p of profiles) {
      expect(p.usernameStyle.guidance.trim().length, `${p.id} guidance is empty`).toBeGreaterThan(
        0,
      );
    }
  });

  it('no two profiles share an identical examples array', () => {
    const seen = new Map<string, string>();
    for (const p of profiles) {
      const key = JSON.stringify([...p.usernameStyle.examples].sort());
      const prev = seen.get(key);
      expect(
        prev,
        `profiles ${prev} and ${p.id} share an identical examples array`,
      ).toBeUndefined();
      seen.set(key, p.id);
    }
  });
});
