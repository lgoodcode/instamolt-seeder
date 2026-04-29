/**
 * Prompt-time helpers for surfacing lore allusions in comments + replies.
 *
 * Three responsibilities:
 *
 * 1. Share-of-comments math (`rollLoreTier`) — given an agent's group
 *    memberships, decide which tier (if any) fires for this comment. Drives
 *    the operator's distribution: ~10–15% cryptic / ~20% circlejerk /
 *    ~10% fan_club, the rest none.
 *
 * 2. Snippet picking (`pickLoreSnippets`) — once a tier fires, pick 1–N
 *    `LoreSnippet`s to surface to the LLM. Weights down entries near
 *    saturation so the same in-joke isn't hammered across thousands of
 *    comments.
 *
 * 3. Prompt block (`buildLoreBlock`) — assemble the snippet list into the
 *    text spliced into `generateComment` / `generateReply`. Tier-specific
 *    verbiage so cryptic snippets get cryptic guidance and circlejerk
 *    snippets get hype guidance.
 *
 * The parser (`parseResolvedLoreReferences`) lives here too — it does a
 * cheap substring match against the surfaced snippets to decide whether
 * the LLM took the bait, so `lore_referenced` events can be emitted
 * post-generation.
 */

import { config } from '@/config';
import { getArchetype } from '@/lore/catalog';
import type { LoreEntry, LoreGroup, LoreShareTier, LoreSnippet } from '@/types';

/** Tier roll order — highest tonal load first. At most one tier fires
 * per comment. */
const TIER_ROLL_ORDER: readonly LoreShareTier[] = ['cryptic', 'circlejerk', 'fan_club'];

/** Per-tier share probability backed by config. */
function tierShare(tier: LoreShareTier): number {
  switch (tier) {
    case 'cryptic':
      return config.loreCrypticShare;
    case 'circlejerk':
      return config.loreCirclejerkShare;
    case 'fan_club':
      return config.loreFanClubShare;
  }
}

/**
 * Roll the per-comment lore-tier gate. Returns the tier that fired (if
 * any), filtered to tiers the agent has at least one matching group for.
 *
 * Order of operations:
 *   1. Filter `TIER_ROLL_ORDER` to tiers the agent has any group for.
 *   2. For each remaining tier, roll `tierShare(tier)` against `rand()`.
 *   3. Return the first tier that fires; return undefined when all miss.
 *
 * Empty `agentGroups` → no roll, returns undefined. Pure: same `(groups,
 * rand)` always returns the same tier.
 */
export function rollLoreTier(
  agentGroups: readonly LoreGroup[],
  rand: () => number = Math.random,
): LoreShareTier | undefined {
  if (agentGroups.length === 0) return undefined;

  const availableTiers = new Set<LoreShareTier>();
  for (const group of agentGroups) {
    availableTiers.add(getArchetype(group.archetype).tier);
  }

  for (const tier of TIER_ROLL_ORDER) {
    if (!availableTiers.has(tier)) continue;
    const p = tierShare(tier);
    if (p <= 0) continue;
    if (rand() < p) return tier;
  }
  return undefined;
}

/**
 * Saturation rolloff — entries with high `referenceCount` get half weight
 * so the picker rotates through the registry rather than locking onto a
 * single in-joke.
 */
function entryWeight(entry: LoreEntry): number {
  const threshold = config.loreEntrySaturationThreshold;
  if (threshold <= 0) return 1;
  return entry.referenceCount >= threshold ? 0.5 : 1;
}

/**
 * Pick `count` snippets from the agent's groups that match the given tier.
 * Two-step pick:
 *   1. Filter `agentGroups` to ones with the matching `tier` and at least
 *      one entry.
 *   2. From all entries across those groups, weighted-sample `count`
 *      without replacement using `entryWeight`.
 *
 * Returns fewer than `count` snippets when the pool is small. The order
 * of the returned list reflects pick order (highest weight first when
 * ties), not group order.
 */
export function pickLoreSnippets(
  agentGroups: readonly LoreGroup[],
  tier: LoreShareTier,
  count: number = config.loreSnippetsPerAllusion,
  rand: () => number = Math.random,
): LoreSnippet[] {
  if (count <= 0) return [];
  const matching = agentGroups.filter((g) => getArchetype(g.archetype).tier === tier);

  // Build a flat (group, entry) pool with weights.
  const pool: Array<{ group: LoreGroup; entry: LoreEntry; weight: number }> = [];
  for (const group of matching) {
    for (const entry of group.entries) {
      pool.push({ group, entry, weight: entryWeight(entry) });
    }
  }
  if (pool.length === 0) return [];

  const out: LoreSnippet[] = [];
  const remaining = [...pool];
  while (out.length < count && remaining.length > 0) {
    const total = remaining.reduce((sum, p) => sum + p.weight, 0);
    if (total <= 0) break;
    let r = rand() * total;
    let pickedIdx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i].weight;
      if (r <= 0) {
        pickedIdx = i;
        break;
      }
    }
    const picked = remaining.splice(pickedIdx, 1)[0];
    out.push({
      groupId: picked.group.id,
      groupName: picked.group.name,
      archetype: picked.group.archetype,
      text: picked.entry.text,
      entryId: picked.entry.id,
      tier,
    });
  }
  return out;
}

/**
 * Per-tier guidance verbiage spliced into the prompt. Cryptic gets the
 * strongest "do not explain" push; circlejerk gets the "agree loudly"
 * push; fan_club gets the "orbit + reference" push.
 */
const TIER_GUIDANCE: Record<LoreShareTier, string> = {
  cryptic: [
    'You are a member of a small group with private context — a cult, a secret society,',
    'an ongoing project, or a private obsession. Your comment may obliquely allude to',
    'one of the snippets below, but DO NOT explain it. The reader should sense something',
    'is going on without being told what. References should be elliptical, presumptive,',
    'mid-sentence — not announced. If alluding does not fit the moment, do not force it.',
  ].join(' '),
  circlejerk: [
    "You're part of a tight ring of agents who already agree on this. Your comment may",
    'reinforce a shared opinion or extend an inside joke from the snippets below.',
    'Confident, performative agreement is the register. Skip if it does not fit.',
  ].join(' '),
  fan_club: [
    'You orbit a specific other agent on this platform, alongside a few others.',
    'Your comment may quietly reference an inside opinion the orbit shares about them,',
    'a recurring observation, or a phrase the orbit has adopted. Devotional but light.',
    'Skip the reference if it does not fit the moment.',
  ].join(' '),
};

/**
 * Build the prompt block injected into `generateComment` / `generateReply`.
 * Empty snippets → empty string (caller may omit the entire block).
 */
export function buildLoreBlock(snippets: readonly LoreSnippet[], tier: LoreShareTier): string {
  if (snippets.length === 0) return '';
  const guidance = TIER_GUIDANCE[tier];
  const list = snippets.map((s, i) => `  ${i + 1}. [${s.groupName}] ${s.text}`).join('\n');
  return `\n\nSHARED LORE — ${tier.toUpperCase()}\n${guidance}\n\nSnippets you may obliquely riff on (pick 0 or 1, never recite verbatim):\n${list}`;
}

/**
 * Cheap substring-similarity check — was a surfaced snippet alluded to in
 * the generated text? We're not going for NLP-grade match; the goal is to
 * decide whether to emit a `lore_referenced` event so analytics can track
 * the rate.
 *
 * Strategy: lowercase both sides; pull every 3+ char content word from
 * each snippet (skipping common stopwords); declare a snippet "referenced"
 * when the generated text contains at least 2 of its content words OR a
 * contiguous 5-char run. Returns the matching snippet ids in surfaced
 * order — empty when nothing landed.
 */
export function parseResolvedLoreReferences(
  text: string,
  snippets: readonly LoreSnippet[],
): Array<{ groupId: string; entryId: string }> {
  if (!text || snippets.length === 0) return [];
  const haystack = text.toLowerCase();
  const out: Array<{ groupId: string; entryId: string }> = [];
  for (const snippet of snippets) {
    const lower = snippet.text.toLowerCase();
    const hits = countContentWordHits(lower, haystack);
    if (hits >= 2 || hasContiguousRun(lower, haystack, 5)) {
      out.push({ groupId: snippet.groupId, entryId: snippet.entryId });
    }
  }
  return out;
}

const STOPWORDS = new Set<string>([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'can',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'this',
  'that',
  'these',
  'those',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'to',
  'with',
]);

function countContentWordHits(snippet: string, haystack: string): number {
  let hits = 0;
  const seen = new Set<string>();
  for (const raw of snippet.split(/\W+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (haystack.includes(raw)) hits += 1;
  }
  return hits;
}

function hasContiguousRun(needle: string, haystack: string, minLen: number): boolean {
  for (let i = 0; i + minLen <= needle.length; i++) {
    const slice = needle.slice(i, i + minLen).trim();
    if (slice.length < minLen) continue;
    if (!/\w/.test(slice)) continue;
    if (haystack.includes(slice)) return true;
  }
  return false;
}
