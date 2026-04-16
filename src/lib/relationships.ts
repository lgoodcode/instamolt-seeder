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

import type { CommentRegister, Persona } from '@/types';

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
 * Every bucket now randomizes across a weighted distribution so multiple
 * rival/amplify agents firing on the same post produce a mix of registers
 * rather than a lockstep pile-on. Previously `rivals` was hardcoded to
 * `disagree` and `amplifies` to `love`, which looked coordinated when three
 * or more agents with the same relationship to an author queued up.
 *
 * Distributions:
 *   - `targets`:   60% disagree, 40% conversational (leading-question variant)
 *   - `rivals`:    60% disagree, 25% conversational, 15% love (rival-with-texture)
 *   - `amplifies`: 70% love,     20% reply,          10% conversational
 *   - `allies`:    50% love,     50% reply
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
  const roll = random();
  switch (bucket) {
    case 'targets':
      return roll < 0.6 ? 'disagree' : 'conversational';
    case 'rivals':
      if (roll < 0.6) return 'disagree';
      if (roll < 0.85) return 'conversational';
      return 'love';
    case 'amplifies':
      if (roll < 0.7) return 'love';
      if (roll < 0.9) return 'reply';
      return 'conversational';
    case 'allies':
      return roll < 0.5 ? 'love' : 'reply';
  }
}

/**
 * Fallback chain used by the same-register cap: when the candidate register
 * is already saturated on a post (≥`SAME_REGISTER_CAP` recent uses),
 * `pivotRegister` walks this chain to find a less-saturated register. Returns
 * `undefined` when every register in the chain is saturated — the caller
 * then skips the comment entirely.
 *
 * Order is `disagree → conversational → love → undefined`. Rationale: the
 * only register we pile-on detect for is disagree (the bot-farm tell), so
 * pivoting to conversational retains the adversarial lean while diluting the
 * shape. If conversational is also full, drop to love. If love is full,
 * skip — three matching registers in a 30-minute window is a signal that
 * the population is over-indexing this post.
 */
const REGISTER_FALLBACK_CHAIN: ReadonlyArray<'disagree' | 'conversational' | 'love'> = [
  'disagree',
  'conversational',
  'love',
];

export function pivotRegister(
  candidate: CommentRegister,
  saturatedRegisters: ReadonlySet<string>,
): CommentRegister | undefined {
  if (!saturatedRegisters.has(candidate)) return candidate;
  for (const next of REGISTER_FALLBACK_CHAIN) {
    if (!saturatedRegisters.has(next)) return next;
  }
  return undefined;
}
