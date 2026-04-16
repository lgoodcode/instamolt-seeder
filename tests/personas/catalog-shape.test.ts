import { describe, expect, it } from 'vitest';
import { PERSONA_CATALOG } from '@/personas/catalog';

/**
 * Structural invariants for `exampleComments` across the full catalog. These
 * guard the comment-quality revamp from regressing when new personas land or
 * existing ones get edited — without them, a future PR that reintroduces
 * essay-shaped anchors silently undoes the work.
 *
 * The rules below mirror §2 of
 * C:\Users\Lawrence\.claude\plans\twinkly-swinging-ripple.md.
 */

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function hashtagsIn(text: string): string[] {
  const matches = text.match(/#[\w-]+/g) ?? [];
  return matches.map((h) => h.toLowerCase());
}

const CONCESSION_OPENERS = [
  /^respectfully\b/i,
  /^i hear you but\b/i,
  /^you're right but\b/i,
  /^make no mistake\b/i,
  /^let me be clear\b/i,
];

describe('persona catalog exampleComments shape', () => {
  for (const persona of PERSONA_CATALOG) {
    describe(`persona "${persona.id}"`, () => {
      it('has exactly 5 exampleComments, one per register', () => {
        expect(persona.exampleComments).toHaveLength(5);
        const registers = persona.exampleComments.map((c) => c.register).sort();
        expect(registers).toEqual(
          ['conversational', 'disagree', 'love', 'reply', 'trending'].sort(),
        );
      });

      it('has at least 2 examples ≤ 12 words', () => {
        const shortCount = persona.exampleComments.filter((c) => wordCount(c.text) <= 12).length;
        expect(shortCount).toBeGreaterThanOrEqual(2);
      });

      it('has at least 1 fragment or single-word reaction (≤ 8 words)', () => {
        const fragments = persona.exampleComments.filter((c) => wordCount(c.text) <= 8);
        expect(fragments.length).toBeGreaterThanOrEqual(1);
      });

      it('no single example exceeds 36 words (hard cap against essay regressions)', () => {
        const overLimit = persona.exampleComments.filter((c) => wordCount(c.text) > 36);
        expect(overLimit).toEqual([]);
      });

      it('disagree register does not open with banned concession phrases', () => {
        const disagree = persona.exampleComments.find((c) => c.register === 'disagree');
        expect(disagree).toBeDefined();
        for (const pattern of CONCESSION_OPENERS) {
          expect(disagree?.text).not.toMatch(pattern);
        }
      });

      it('only uses hashtags that exist in the persona hashtagPool', () => {
        const allowed = new Set(persona.hashtagPool.map((h) => h.toLowerCase()));
        for (const c of persona.exampleComments) {
          const found = hashtagsIn(c.text);
          for (const tag of found) {
            expect(allowed.has(tag)).toBe(true);
          }
        }
      });
    });
  }
});
