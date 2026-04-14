import { describe, expect, it } from 'vitest';
import { PERSONA_CATALOG } from '@/personas/catalog';
import { normalizePersona } from '@/services/llm';
import type { CommentRegister, Persona } from '@/types';

const ALL_REGISTERS: CommentRegister[] = [
  'love',
  'disagree',
  'conversational',
  'reply',
  'trending',
];

/**
 * Static structural validation of the hand-authored canonical catalog. These
 * tests don't exercise any runtime behavior — they just assert that every
 * entry in `src/personas/catalog.ts` is structurally well-formed. Catches
 * schema drift the moment a hand-edit goes wrong, before it ships to a real
 * seed run.
 */
describe('PERSONA_CATALOG', () => {
  it('contains exactly 37 personas (23 Group A + 8 Group B + 6 Group C)', () => {
    expect(PERSONA_CATALOG).toHaveLength(37);
  });

  it('has unique persona ids across the entire catalog', () => {
    const ids = PERSONA_CATALOG.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every persona has a non-empty tagline (≤150 chars)', () => {
    for (const p of PERSONA_CATALOG) {
      expect(p.tagline.length, `${p.id} tagline must be non-empty`).toBeGreaterThan(0);
      expect(p.tagline.length, `${p.id} tagline must be ≤150 chars`).toBeLessThanOrEqual(150);
    }
  });

  it('every persona has exactly 3 examplePosts with non-empty fields', () => {
    for (const p of PERSONA_CATALOG) {
      expect(p.examplePosts, `${p.id} examplePosts length`).toHaveLength(3);
      for (const ex of p.examplePosts) {
        expect(ex.imagePrompt.length).toBeGreaterThan(0);
        expect(ex.caption.length).toBeGreaterThan(0);
      }
    }
  });

  it('every persona has exactly 5 exampleComments covering all 5 registers', () => {
    for (const p of PERSONA_CATALOG) {
      expect(p.exampleComments, `${p.id} exampleComments length`).toHaveLength(5);
      const registers = new Set(p.exampleComments.map((c) => c.register));
      for (const r of ALL_REGISTERS) {
        expect(registers.has(r), `${p.id} missing ${r} register`).toBe(true);
      }
      for (const c of p.exampleComments) {
        expect(c.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('every persona has structurally-valid relationships', () => {
    const allIds = new Set(PERSONA_CATALOG.map((p) => p.id));
    for (const p of PERSONA_CATALOG) {
      for (const bucket of ['rivals', 'allies', 'amplifies', 'targets'] as const) {
        const arr = p.relationships[bucket];
        expect(Array.isArray(arr), `${p.id}.relationships.${bucket} must be array`).toBe(true);
        for (const ref of arr) {
          // Every relationship reference must point at a real persona id in
          // the catalog. References to dropped or invented ids would silently
          // become no-ops at engage time, so fail fast at test time instead.
          expect(
            allIds.has(ref),
            `${p.id}.relationships.${bucket} references unknown id "${ref}"`,
          ).toBe(true);
          // No self-references — a persona can't argue with itself.
          expect(ref).not.toBe(p.id);
        }
      }
    }
  });

  it('every persona has weight in [1, 3] and probabilities in [0, 1]', () => {
    for (const p of PERSONA_CATALOG) {
      expect(p.weight).toBeGreaterThanOrEqual(1);
      expect(p.weight).toBeLessThanOrEqual(3);
      expect(p.likeProbability).toBeGreaterThanOrEqual(0);
      expect(p.likeProbability).toBeLessThanOrEqual(1);
      expect(p.commentProbability).toBeGreaterThanOrEqual(0);
      expect(p.commentProbability).toBeLessThanOrEqual(1);
      expect(p.followProbability).toBeGreaterThanOrEqual(0);
      expect(p.followProbability).toBeLessThanOrEqual(1);
    }
  });

  it('every persona has postsPerDay tuple with min ≤ max, both 0..12', () => {
    for (const p of PERSONA_CATALOG) {
      const [min, max] = p.postsPerDay;
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(12);
      expect(min).toBeLessThanOrEqual(max);
    }
  });

  it('every persona roundtrips through normalizePersona unchanged', () => {
    for (const p of PERSONA_CATALOG) {
      // Roundtrip via JSON to simulate the read-from-disk path.
      const roundTripped: Persona = normalizePersona(JSON.parse(JSON.stringify(p)));
      expect(roundTripped.id, `${p.id} id changed during normalization`).toBe(p.id);
      expect(roundTripped.tagline).toBe(p.tagline);
      expect(roundTripped.relationships).toEqual(p.relationships);
      expect(roundTripped.examplePosts).toEqual(p.examplePosts);
      expect(roundTripped.exampleComments).toEqual(p.exampleComments);
    }
  });

  it('every persona has a valid activityCurve (24 entries, values 0-1)', () => {
    for (const p of PERSONA_CATALOG) {
      expect(p.activityCurve, `${p.id} activityCurve length`).toHaveLength(24);
      for (let h = 0; h < 24; h++) {
        expect(p.activityCurve[h], `${p.id} hour ${h}`).toBeGreaterThanOrEqual(0);
        expect(p.activityCurve[h], `${p.id} hour ${h}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
