/**
 * Typed persona relationship helpers shared by the continuous engage
 * scheduler. The cycle-mode `src/commands/engage.ts` keeps its own private
 * copy of these (intentionally untouched per the "don't rewrite working
 * code" rule in CLAUDE.md); new continuous-mode code imports from here so
 * we have ONE source of truth for scheduler-path scoring.
 *
 * Shape must stay in lockstep with `engage.ts:27-94` — if those weights
 * ever change, update both files in the same commit. A future cleanup PR
 * can consolidate once engage cycle mode is retired or scheduled for
 * deprecation.
 */

import type { Persona } from '@/types';

/**
 * Multiplier applied to engagement-probability / weighting when the post
 * author's persona is in one of the commenting persona's relationship
 * buckets. Higher = more likely to engage. Bucket order matters when an id
 * appears in multiple buckets — `targets` wins, then amplifies, rivals, allies.
 */
export const RELATIONSHIP_WEIGHT: Record<keyof Persona['relationships'], number> = {
  targets: 2.0,
  amplifies: 1.8,
  rivals: 1.5,
  allies: 1.2,
};

/**
 * Return the relationship bucket (if any) the post author's persona id falls
 * into, from the perspective of the commenting persona. Returns `undefined`
 * when there is no relationship — callers default to neutral weight 1.0.
 */
export function relationshipBucket(
  commenterPersona: Persona,
  postAuthorPersonaId: string | undefined,
): keyof Persona['relationships'] | undefined {
  if (!postAuthorPersonaId) return undefined;
  const r = commenterPersona.relationships;
  if (r.targets.includes(postAuthorPersonaId)) return 'targets';
  if (r.amplifies.includes(postAuthorPersonaId)) return 'amplifies';
  if (r.rivals.includes(postAuthorPersonaId)) return 'rivals';
  if (r.allies.includes(postAuthorPersonaId)) return 'allies';
  return undefined;
}

/**
 * Engagement-probability multiplier for a (commenter, postAuthor) pair.
 * Returns 1.0 when there's no relationship.
 */
export function relationshipMultiplier(
  commenterPersona: Persona,
  postAuthorPersonaId: string | undefined,
): number {
  const bucket = relationshipBucket(commenterPersona, postAuthorPersonaId);
  return bucket ? RELATIONSHIP_WEIGHT[bucket] : 1.0;
}

/**
 * Pick a `CommentRegister` hint for `generateComment` based on the
 * relationship between commenter and post author. Returns `undefined` when
 * there's no relationship — Gemini then picks freely across all 5 registers.
 *
 * Targets/allies buckets randomize between two registers because the action
 * they describe is ambiguous (targeting can be either disagreement or a
 * leading question; allyship can be love or an affirming reply).
 *
 * Mirrors the shape of `pickRegisterHint` in `src/commands/engage.ts:78-94`
 * (cycle mode keeps its private copy intact).
 */
export function pickRegisterHint(
  commenterPersona: Persona,
  postAuthorPersonaId: string | undefined,
  random: () => number = Math.random,
): 'love' | 'disagree' | 'conversational' | 'reply' | undefined {
  const bucket = relationshipBucket(commenterPersona, postAuthorPersonaId);
  if (!bucket) return undefined;
  switch (bucket) {
    case 'targets':
      return random() < 0.6 ? 'disagree' : 'conversational';
    case 'rivals':
      return 'disagree';
    case 'amplifies':
      return 'love';
    case 'allies':
      return random() < 0.5 ? 'love' : 'reply';
  }
}
