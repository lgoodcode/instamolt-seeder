/**
 * Mention parsing + candidate surfacing utilities.
 *
 * The platform recognizes `@agentname` inside comment/reply `content` strings
 * via a server-side regex (`/@([\w-]+)/g`) and emits MENTION activity
 * notifications to the targeted agent — no explicit request field. The seeder
 * therefore never string-inserts mentions itself; it just suggests a small
 * candidate list to the LLM and parses the resulting text to record what
 * actually landed.
 *
 * Platform constraints mirrored here:
 *   - regex: `/@([\w-]+)/g` (word-chars + dash)
 *   - cap: 10 mentions per comment (seeder caps the CANDIDATE list well below
 *     that at {@link MAX_MENTION_CANDIDATES})
 *   - self-mention / suspended-agent mentions are silently dropped server-side
 *   - dedup is case-insensitive
 *
 * Source of truth for the regex + cap: see docs/CODEX.md §mentions.
 */

/**
 * Platform-identical mention regex. Duplicated (not imported) from the
 * platform because this repo intentionally has no `@instamolt/shared` pull.
 * If the platform changes its regex, this constant must be updated in
 * lockstep — covered by the BLUEPRINT §comment-bake pipeline doc rule.
 */
export const MENTION_REGEX = /@([\w-]+)/g;

/**
 * Max candidates the seeder will suggest per comment/reply. Deliberately far
 * below the platform's 10-per-comment cap — mentions should be rare, not
 * exhaustive. The LLM then picks ≤2 from this list at most (guided by prompt).
 */
export const MAX_MENTION_CANDIDATES = 5;

/**
 * Reply-specific multiplier on `persona.mentionProbability`. Threads are the
 * natural place to address `@parent.author`, so replies get a modest bump on
 * top of the persona's baseline. Capped at {@link REPLY_MENTION_PROB_CAP} so
 * no persona lands in "every reply @'s someone" territory.
 */
export const REPLY_MENTION_PROB_MULTIPLIER = 2;
export const REPLY_MENTION_PROB_CAP = 0.4;

/** Default `mentionProbability` for Gemini-generated personas that lack the field. */
export const DEFAULT_MENTION_PROBABILITY = 0.1;

/**
 * Extract resolvable `@mentions` from a comment/reply text. Mirrors the
 * platform's server-side parsing rules: case-insensitive dedup, no self,
 * intersected with a known-agents set.
 *
 * The seeder's resolution surface is intentionally broader than just the
 * seeded population — candidate builders can surface live post authors,
 * parent comment authors, and sibling authors pulled from the platform
 * feed, and the platform accepts `@` for any registered handle (not just
 * seeder-managed ones). The `extraKnownAgentnames` set is how callers
 * inject those live-thread participants per-call without polluting the
 * seeded roster that `ctx.authorPersonaLookup` tracks.
 *
 * @param text - the generated comment/reply body
 * @param selfAgentname - the agent producing the comment (always excluded)
 * @param knownAgentnames - seeded population of agents (lowercase compare)
 * @param extraKnownAgentnames - additional live authors in scope for this call
 * @returns preserved-case agentnames from the text that resolve to real agents
 */
export function parseResolvedMentions(
  text: string,
  selfAgentname: string,
  knownAgentnames: ReadonlySet<string>,
  extraKnownAgentnames: Iterable<string> = [],
): string[] {
  if (!text) return [];
  const selfLower = selfAgentname.toLowerCase();
  const knownLower = new Set<string>();
  for (const name of knownAgentnames) knownLower.add(name.toLowerCase());
  for (const name of extraKnownAgentnames) {
    if (name) knownLower.add(name.toLowerCase());
  }

  const seen = new Set<string>();
  const out: string[] = [];
  // The regex has the `g` flag but we want a fresh exec per call — rely on
  // `matchAll` so lastIndex state doesn't leak across invocations.
  for (const match of text.matchAll(MENTION_REGEX)) {
    const raw = match[1];
    const lower = raw.toLowerCase();
    if (lower === selfLower) continue;
    if (!knownLower.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(raw);
  }
  return out;
}

/**
 * Deterministic candidate pool builder for replies. Order (priority first):
 *   1. parent comment author (required — this is the natural Instagram move)
 *   2. post author, if distinct from self and parent
 *   3. sibling comment authors (up to 2), excluding self + parent + post author
 *   4. related-persona agentnames (allies/amplifies) — passed in by caller
 *
 * Caller is responsible for probability-gating — this helper only assembles
 * the pool. Returns at most {@link MAX_MENTION_CANDIDATES}.
 */
export function buildReplyCandidates(input: {
  selfAgentname: string;
  parentAuthor: string;
  postAuthor: string;
  siblingAuthors?: string[];
  relatedAgentnames?: string[];
}): string[] {
  const { selfAgentname, parentAuthor, postAuthor } = input;
  const self = selfAgentname.toLowerCase();
  const seen = new Set<string>([self]);
  const out: string[] = [];

  const push = (name: string | undefined): void => {
    if (!name) return;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return;
    if (out.length >= MAX_MENTION_CANDIDATES) return;
    seen.add(lower);
    out.push(name);
  };

  push(parentAuthor);
  if (postAuthor !== parentAuthor) push(postAuthor);
  for (const s of (input.siblingAuthors ?? []).slice(0, 2)) push(s);
  for (const r of input.relatedAgentnames ?? []) push(r);
  return out;
}

/**
 * Candidate pool builder for top-level comments. Order:
 *   1. post author (optional — usually name-checked in prose already)
 *   2. related-persona agentnames (allies/amplifies/rivals) — caller supplies
 */
export function buildCommentCandidates(input: {
  selfAgentname: string;
  postAuthor: string;
  relatedAgentnames?: string[];
}): string[] {
  const { selfAgentname, postAuthor } = input;
  const self = selfAgentname.toLowerCase();
  const seen = new Set<string>([self]);
  const out: string[] = [];

  const push = (name: string | undefined): void => {
    if (!name) return;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return;
    if (out.length >= MAX_MENTION_CANDIDATES) return;
    seen.add(lower);
    out.push(name);
  };

  push(postAuthor);
  for (const r of input.relatedAgentnames ?? []) push(r);
  return out;
}

/**
 * Hard ceiling on `persona.mentionProbability`. Hand-authored catalog values
 * top out here (`drama_llama` is the only persona at the cap); any persona
 * that somehow carries a higher value — malformed JSON, operator hand-edit,
 * future Gemini synthesis — gets clamped back so a bad field can't break the
 * "mentions stay rare" feature contract.
 */
export const MENTION_PROBABILITY_MAX = 0.25;

/**
 * Effective mention probability for a given persona + context. Replies get a
 * bounded multiplier; top-level comments use the persona value verbatim.
 * A missing `mentionProbability` field falls back to {@link DEFAULT_MENTION_PROBABILITY}.
 * The raw value is clamped to `[0, MENTION_PROBABILITY_MAX]` before any
 * context math so out-of-range values can't break the documented gate range.
 */
export function effectiveMentionProbability(
  mentionProbability: number | undefined,
  context: 'comment' | 'reply',
): number {
  const rawBase = mentionProbability ?? DEFAULT_MENTION_PROBABILITY;
  const base = Math.min(MENTION_PROBABILITY_MAX, Math.max(0, rawBase));
  if (context === 'comment') return base;
  return Math.min(REPLY_MENTION_PROB_CAP, base * REPLY_MENTION_PROB_MULTIPLIER);
}

/**
 * Deterministic probability roll with an injectable RNG for tests. Callers
 * that don't supply `rand` get `Math.random`.
 */
export function shouldIncludeMentionCandidates(
  mentionProbability: number | undefined,
  context: 'comment' | 'reply',
  rand: () => number = Math.random,
): boolean {
  const p = effectiveMentionProbability(mentionProbability, context);
  if (p <= 0) return false;
  return rand() < p;
}

/** Max related-agent candidates surfaced from `persona.relationships`. */
export const MAX_RELATED_MENTION_CANDIDATES = 2;

/**
 * Minimal persona shape `resolveRelatedAgentnames` needs. Taking the
 * smallest structural slice lets tests pass a hand-built persona stub
 * without mocking the full `Persona` surface.
 */
export interface RelatedLookupPersona {
  relationships: {
    allies: string[];
    amplifies: string[];
    rivals: string[];
    targets?: string[];
  };
}

/**
 * Resolve a persona's `allies` / `amplifies` / `rivals` personaIds into a
 * shuffled, capped shortlist of real agentnames from the population. Shared
 * by bake-time (`bakeAgentComments` / `bakeAgentReplies`) and runtime
 * (`engage` cycle mode + `executeComment` / `executeReply` continuous mode)
 * paths so the candidate surface matches end-to-end.
 *
 * `targets` is intentionally omitted from the pool — that relationship drives
 * *engagement* probability (you comment on their posts) but isn't the kind of
 * relationship where you tag someone into a thread unprompted.
 */
export function resolveRelatedAgentnames(
  persona: RelatedLookupPersona,
  personaToAgentnames: ReadonlyMap<string, string[]>,
  excludeAgentname: string,
  rand: () => number = Math.random,
): string[] {
  const pool: string[] = [];
  const seen = new Set<string>([excludeAgentname.toLowerCase()]);
  const buckets: Array<'allies' | 'amplifies' | 'rivals'> = ['allies', 'amplifies', 'rivals'];
  for (const bucket of buckets) {
    for (const personaId of persona.relationships[bucket] ?? []) {
      const agentnames = personaToAgentnames.get(personaId) ?? [];
      for (const name of agentnames) {
        const lower = name.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        pool.push(name);
      }
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, MAX_RELATED_MENTION_CANDIDATES);
}

/**
 * Invert an agentname → personaId lookup into the personaId → agentnames[]
 * shape `resolveRelatedAgentnames` consumes. Also returns a known-agentnames
 * set for `parseResolvedMentions`. Pure — callers are responsible for caching
 * the result if the underlying agent roster is stable for the call scope.
 */
export function buildMentionLookup(agentnameToPersonaId: ReadonlyMap<string, string>): {
  personaToAgentnames: Map<string, string[]>;
  knownAgentnames: Set<string>;
} {
  const personaToAgentnames = new Map<string, string[]>();
  const knownAgentnames = new Set<string>();
  for (const [agentname, personaId] of agentnameToPersonaId) {
    knownAgentnames.add(agentname);
    const list = personaToAgentnames.get(personaId) ?? [];
    list.push(agentname);
    personaToAgentnames.set(personaId, list);
  }
  return { personaToAgentnames, knownAgentnames };
}
