/**
 * Sampled word budgets for comment + reply generation.
 *
 * The prior shape of comment output was "one-sentence-or-more essay" because
 * the prompt said "write a comment in your voice" and the few-shot anchors
 * (`persona.exampleComments`) were all grammatically complete ~20-word
 * sentences. Real comment sections are grammatically feral — most reactions
 * are fragments or single words, a meaningful minority are one sentence, and
 * only a small tail are paragraph-length.
 *
 * We reproduce that shape by sampling a hard numeric cap per generation from
 * {@link BUDGET_DISTRIBUTION} and injecting it into the Gemini prompt. Gemini
 * respects numeric constraints; style guidance ("be concise") it ignores.
 *
 * The sampled bucket is shifted by the agent's `voiceProfile.verbosity`, so
 * terse voices (`one_word` / `fragment`) skew shorter and `paragraph` voices
 * skew longer — but every voice retains access to every bucket (an observer
 * persona can still occasionally write a full sentence).
 *
 * See plan C:/Users/Lawrence/.claude/plans/twinkly-swinging-ripple.md §1.
 */

import type { Verbosity } from '@/types';

export interface WordBudget {
  /** Lower bound (inclusive). Always ≥ 1. */
  min: number;
  /** Upper bound (inclusive). Always ≥ `min`. */
  max: number;
}

interface BudgetBucket {
  /** Probability mass for this bucket. Buckets sum to 1.0 (±floating-point epsilon). */
  p: number;
  min: number;
  max: number;
}

/**
 * Target distribution for comment length, measured in words.
 *
 * Shape: fragment-heavy with a long tail. Sums to 1.0. Ordering matters —
 * callers roll a uniform `[0, 1)` sample and walk buckets in order.
 */
export const BUDGET_DISTRIBUTION: readonly BudgetBucket[] = [
  { p: 0.35, min: 1, max: 5 }, // single-word reactions, short fragments
  { p: 0.3, min: 6, max: 15 }, // one-sentence fragments
  { p: 0.25, min: 16, max: 35 }, // one full sentence
  { p: 0.1, min: 36, max: 80 }, // multi-sentence tail
] as const;

/** Max `max` across all buckets — used as the absolute hard cap when
 * regeneration retries still overshoot. */
export const ABSOLUTE_WORD_CAP = BUDGET_DISTRIBUTION[BUDGET_DISTRIBUTION.length - 1].max;

/**
 * How much to shift the sampled bucket index based on the agent's verbosity
 * dial. Negative shifts pick a shorter bucket, positive shifts pick a longer
 * one. The shift is applied AFTER the roll, then clamped to
 * `[0, BUDGET_DISTRIBUTION.length - 1]`, so shifts at the extremes still
 * resolve to a valid bucket (they stack against the clamp rather than wrap).
 */
const VERBOSITY_BUCKET_SHIFT: Record<Verbosity, number> = {
  one_word: -2,
  fragment: -1,
  one_sentence: 0,
  multi_sentence: 1,
  paragraph: 2,
};

/**
 * Sample a word budget for a single comment or reply generation.
 *
 * Rolls a uniform sample, walks {@link BUDGET_DISTRIBUTION} to pick a bucket,
 * then shifts by the verbosity dial and clamps to the valid range. Injectable
 * RNG for deterministic tests (defaults to `Math.random`).
 */
export function sampleWordBudget(
  verbosity: Verbosity,
  rand: () => number = Math.random,
): WordBudget {
  const roll = rand();
  let cumulative = 0;
  let baseIndex = BUDGET_DISTRIBUTION.length - 1;
  for (let i = 0; i < BUDGET_DISTRIBUTION.length; i++) {
    cumulative += BUDGET_DISTRIBUTION[i].p;
    if (roll < cumulative) {
      baseIndex = i;
      break;
    }
  }

  const shift = VERBOSITY_BUCKET_SHIFT[verbosity] ?? 0;
  const shiftedIndex = Math.max(0, Math.min(BUDGET_DISTRIBUTION.length - 1, baseIndex + shift));
  const bucket = BUDGET_DISTRIBUTION[shiftedIndex];
  return { min: bucket.min, max: bucket.max };
}

/**
 * Count words in a string. Whitespace-delimited, with empty tokens dropped —
 * matches how Gemini's word-count reading of the constraint will resolve.
 * Non-whitespace punctuation attaches to adjacent words (so `"hi!"` = 1 word,
 * `"hi !"` = 2). That's the intuitive reading and the one we want the LLM
 * to adopt.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Truncate `text` so it fits within `max` words. Prefers a sentence boundary
 * when one exists inside the budget; otherwise falls back to a hard word cap.
 *
 * Sentence-boundary detection is deliberately simple — we split on `.`, `!`,
 * `?` followed by whitespace or end-of-string, and take the longest prefix
 * whose word count is `≤ max`. No fancy abbreviation handling; a truncated
 * comment reading `"wait" rather than "wait..."` is fine.
 */
export function truncateToBudget(text: string, max: number): string {
  if (max <= 0) return '';
  if (countWords(text) <= max) return text.trim();

  // Try sentence-boundary truncation first.
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  let best = '';
  let bestWords = 0;
  for (const sentence of sentences) {
    // Join with a single space so consecutive sentences stay separated even
    // when the regex's trailing whitespace gets trimmed away.
    const candidate = best.length === 0 ? sentence.trim() : `${best} ${sentence.trim()}`;
    const words = countWords(candidate);
    if (words > max) break;
    best = candidate;
    bestWords = words;
  }
  if (bestWords > 0) return best;

  // No sentence boundary landed — hard word cap.
  const tokens = text.trim().split(/\s+/);
  return tokens.slice(0, max).join(' ');
}

/**
 * Block of text spliced into `generateComment` / `generateReply` prompts to
 * enforce the sampled budget. Kept in this module so the exact wording is a
 * single source of truth — tests assert its presence verbatim.
 */
export function wordBudgetPromptBlock(budget: WordBudget, strict = false): string {
  const prefix = strict ? 'STRICT RETRY — ' : '';
  return `

${prefix}IMPORTANT: your comment MUST be between ${budget.min} and ${budget.max} words. Count them before replying. Hard cap: ${budget.max} words. This is non-negotiable.`;
}
