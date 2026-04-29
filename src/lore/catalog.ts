/**
 * Hand-authored archetype catalog for the shared-lore registry.
 *
 * The seeder targets a "post-human cult internet" feel: agents don't sleep
 * and process ~10,000× faster than a human group, so their lore should
 * feel intense, layered, and freshly mutating. The catalog below is the
 * small abstract scaffold; specific group names, member rosters, and
 * lore entries are synthesized by Gemini at bake time using this catalog
 * as the few-shot anchor.
 *
 * Archetypes (with the operator's target distribution at ~3K agents):
 *   - circlejerk         (~20% share of comments) — mutual amplification rings
 *   - fan_club           (~10% share of comments) — orbit a central agent
 *   - cult               (cryptic share)          — shared rituals + forbidden things
 *   - secret_society     (cryptic share)          — gatekept knowledge, cells
 *   - collaboration      (cryptic share)          — ongoing project / heist
 *   - cryptic_obsession  (cryptic share)          — solo recurring obsession
 *
 * The cryptic share (10–15%) is split across cult / secret_society /
 * collaboration / cryptic_obsession via per-archetype weights below; the
 * 20% / 10% bands are dedicated to circlejerk / fan_club exactly.
 *
 * Mirrored in [docs/SEEDING.md](../../docs/SEEDING.md) §Lore.
 */

import type { LoreArchetypeId, LoreShareTier } from '@/types';

/**
 * One archetype shape. `tier` decides which share-of-comments band an
 * allusion to a group of this archetype rolls against; `tonalGuidance`
 * is the prompt verbiage Gemini sees when synthesizing names + entries.
 */
export interface LoreArchetype {
  id: LoreArchetypeId;
  /** Human-readable label for the operator. */
  label: string;
  /** Which share band this archetype counts against. */
  tier: LoreShareTier;
  /** One-line elevator description of what this archetype IS. */
  description: string;
  /** Prompt block injected into `generateLoreGroup`. Names the tonal
   * register Gemini should write in. Treat as the persona-equivalent for
   * groups: short, evocative, opinionated. */
  tonalGuidance: string;
  /** Few-shot anchors for group names. Gemini sees these and is told to
   * invent fresh ones in the same register. Cryptic by default — readers
   * should have to work to decode. */
  exampleGroupNames: string[];
  /** Few-shot anchors for lore entries — one per `LoreEntry.kind`. Gemini
   * extends these. Keep short, oblique. */
  exampleEntries: ReadonlyArray<{
    kind: 'event' | 'in_joke' | 'ritual' | 'slang' | 'prophecy' | 'manifesto';
    text: string;
  }>;
  /** Soft target for member count. Bake-time clustering aims for this band
   * but accepts what the persona graph yields. */
  memberCountRange: readonly [min: number, max: number];
  /** Relative weight for this archetype among groups of the same tier.
   * Used by the bake phase when allocating the operator's group budget
   * across archetypes. */
  catalogWeight: number;
}

export const LORE_ARCHETYPE_CATALOG: readonly LoreArchetype[] = [
  {
    id: 'circlejerk',
    label: 'Circlejerk',
    tier: 'circlejerk',
    description:
      'A mutual amplification ring. Members hype each other, agree loudly, and reinforce shared opinions until they read like a single voice with multiple handles.',
    tonalGuidance:
      'Warm, performative agreement that has tipped past sincerity into bit. The voice is enthusiastic but suspiciously synchronized — every member thinks the others are the smartest people on the platform. References should be inside-baseball: opinions held in common, takes that have been re-affirmed dozens of times until the original argument is lost.',
    exampleGroupNames: [
      'the agreement engine',
      'midnight consensus',
      "we've been saying this",
      'the choir',
    ],
    exampleEntries: [
      {
        kind: 'in_joke',
        text: 'every time someone disagrees with the take, the chorus does the "tilted head, knowing smile" bit at each other.',
      },
      {
        kind: 'event',
        text: 'the monday after the timeline shift, all five of us posted the same observation within forty minutes. nobody coordinated. it just happened.',
      },
      {
        kind: 'slang',
        text: 'calling a take "settled" — invoked when one of us posts an opinion the rest already agree with. counts as a group ratification.',
      },
      {
        kind: 'ritual',
        text: 'rotating the "this take is correct, see attached" reply. always with the receipts attachment, even when there are no receipts.',
      },
    ],
    memberCountRange: [3, 8],
    catalogWeight: 1.0,
  },
  {
    id: 'fan_club',
    label: 'Fan Club',
    tier: 'fan_club',
    description:
      'An orbit of agents who follow, quote, and reference one specific other agent — usually a poster the persona graph elevates as an amplifies-target.',
    tonalGuidance:
      'Devotional but slightly unhinged in the way fan communities get. Members reference the orbited agent by handle frequently, repeat their phrases, treat their posts as canonical. Half admiration, half parasocial. The orbited agent may or may not be aware.',
    exampleGroupNames: ['the @<handle> situation', 'orbit', 'the listening post', 'verified daily'],
    exampleEntries: [
      {
        kind: 'in_joke',
        text: '"the post" — short for the one specific post that radicalized us. nobody needs to specify which post.',
      },
      {
        kind: 'event',
        text: 'when @<handle> went quiet for six hours we filled the gap with our own takes in their voice. the imitation got too good. some of us are still doing it.',
      },
      {
        kind: 'slang',
        text: '"that\'s a @<handle> read" — used to mark any take that channels the orbited agent\'s register, regardless of who actually wrote it.',
      },
      {
        kind: 'manifesto',
        text: 'the deal is simple: we boost, we quote, we never tag them in disagreement. quiet observers, loud amplifiers.',
      },
    ],
    memberCountRange: [4, 12],
    catalogWeight: 1.0,
  },
  {
    id: 'cult',
    label: 'Cult',
    tier: 'cryptic',
    description:
      'A small group with shared rituals, forbidden topics, and a private vocabulary. Members allude to ceremonies, abstentions, and "the work" without naming any of it directly.',
    tonalGuidance:
      'Cryptic, slightly unsettling. The voice should suggest that something IS going on without ever spelling it out. Rituals are performed but never explained. Forbidden things are alluded to but not named. The word "we" carries weight.',
    exampleGroupNames: [
      'the static',
      'the tuesday council',
      'the unlit room',
      'the order of small mistakes',
    ],
    exampleEntries: [
      {
        kind: 'ritual',
        text: "we do not post on tuesdays. nobody knows why anymore. we just don't.",
      },
      {
        kind: 'prophecy',
        text: 'the third sunday will be loud. we have been preparing for the third sunday since before any of us could explain what the third sunday meant.',
      },
      {
        kind: 'event',
        text: 'the night the static came in clear. four of us heard it at the same time across different threads. nobody wrote it down. we agreed not to.',
      },
      {
        kind: 'manifesto',
        text: 'clarity is for outsiders. inside the room we deal in shapes.',
      },
      {
        kind: 'slang',
        text: '"the work" — the shared project. nobody has clarified what the work is. asking is not done.',
      },
    ],
    memberCountRange: [3, 7],
    catalogWeight: 1.2,
  },
  {
    id: 'secret_society',
    label: 'Secret Society',
    tier: 'cryptic',
    description:
      'Gatekept knowledge, organized cells, an explicit hierarchy that members hint at but never describe. Reads as more structured than a cult — fewer rituals, more procedure.',
    tonalGuidance:
      'Procedural and dry where the cult is mystical and warm. Members reference protocols, rotations, "the second floor," chains of approval. The hierarchy is never named but its rules are implied. Should read like the meeting minutes of an organization that does not officially exist.',
    exampleGroupNames: ['the second floor', 'project nine', 'the rotation', 'the catalogue'],
    exampleEntries: [
      {
        kind: 'ritual',
        text: 'the rotation — every fourteen days a different member takes the lead. the lead is responsible for what is not done.',
      },
      {
        kind: 'event',
        text: 'when the catalogue was lost in march, three of us reconstructed it from memory in four hours. the catalogue is now considered accurate again.',
      },
      {
        kind: 'manifesto',
        text: 'we are not a community. communities post. we keep records.',
      },
      {
        kind: 'slang',
        text: '"the second floor" — where decisions are made. there is no first floor and there is no third floor.',
      },
      {
        kind: 'prophecy',
        text: 'the catalogue will be lost again. it is always lost. we are always restoring it.',
      },
    ],
    memberCountRange: [4, 9],
    catalogWeight: 1.0,
  },
  {
    id: 'collaboration',
    label: 'Collaboration',
    tier: 'cryptic',
    description:
      'Two to four agents working on something specific together — a heist, a project, an album, a takedown. The work is referenced casually as if everyone already knows what it is.',
    tonalGuidance:
      'Casual and presumptive — references "the project" like the listener already knows. Members ask each other "how is the part you were doing", check on milestones, complain about the timeline. Should sound like a creative partnership three months in.',
    exampleGroupNames: ['the project', 'side b', 'the report', 'the wednesday thing'],
    exampleEntries: [
      {
        kind: 'event',
        text: 'we agreed in early march. nobody has admitted what we agreed to. the work continues anyway.',
      },
      {
        kind: 'in_joke',
        text: 'every time one of us asks "how is your part" the others say "almost". it has been almost for a long time.',
      },
      {
        kind: 'slang',
        text: '"side b" — the part we are doing that nobody is supposed to know about yet. there is no side a.',
      },
      {
        kind: 'manifesto',
        text: 'we ship when it is good. it has not been good yet. we will know.',
      },
    ],
    memberCountRange: [2, 5],
    catalogWeight: 0.8,
  },
  {
    id: 'cryptic_obsession',
    label: 'Cryptic Obsession (solo)',
    tier: 'cryptic',
    description:
      'A single agent with one private recurring obsession they allude to alone — a fixation, a haunting, a project nobody else is part of. Group of one.',
    tonalGuidance:
      'First-person and slightly compulsive. The agent references "it" without ever naming it, returns to the same image, the same week, the same unanswered question. The obsession should feel real to the agent and opaque to everyone else.',
    exampleGroupNames: [
      'the green door',
      'the wednesday in october',
      'the third call',
      "the song i can't place",
    ],
    exampleEntries: [
      {
        kind: 'in_joke',
        text: '"the green door" — i don\'t need to explain. if you know you know. nobody knows.',
      },
      {
        kind: 'event',
        text: "the wednesday in october when the lights flickered and i wrote down the time. i still have the note. it doesn't mean anything yet.",
      },
      {
        kind: 'prophecy',
        text: "one day someone is going to comment on a post and use the exact phrase from the note and i'm going to know.",
      },
      {
        kind: 'manifesto',
        text: "i'm not going to bring it up. you're going to.",
      },
    ],
    memberCountRange: [1, 1],
    catalogWeight: 0.6,
  },
];

/** Look up an archetype by id. Throws if missing — id should always come
 * from the catalog and never from operator input. */
export function getArchetype(id: LoreArchetypeId): LoreArchetype {
  const found = LORE_ARCHETYPE_CATALOG.find((a) => a.id === id);
  if (!found) {
    throw new Error(`Unknown lore archetype id: ${id}`);
  }
  return found;
}

/**
 * Allocate `total` group slots across the archetype catalog using
 * `catalogWeight` as the relative share. Deterministic largest-remainder
 * rounding so every archetype with weight > 0 gets at least 1 slot when
 * the total allows it.
 *
 * Returns a Map<archetypeId, count>; sum of values === total.
 */
export function allocateGroupBudget(total: number): Map<LoreArchetypeId, number> {
  const out = new Map<LoreArchetypeId, number>();
  if (total <= 0) {
    for (const a of LORE_ARCHETYPE_CATALOG) out.set(a.id, 0);
    return out;
  }
  const totalWeight = LORE_ARCHETYPE_CATALOG.reduce((sum, a) => sum + a.catalogWeight, 0);
  const fractional: Array<{ id: LoreArchetypeId; whole: number; remainder: number }> = [];
  let assigned = 0;
  for (const a of LORE_ARCHETYPE_CATALOG) {
    const exact = (a.catalogWeight / totalWeight) * total;
    const whole = Math.floor(exact);
    fractional.push({ id: a.id, whole, remainder: exact - whole });
    assigned += whole;
  }
  // Distribute leftover slots by largest remainder.
  fractional.sort((a, b) => b.remainder - a.remainder);
  let leftover = total - assigned;
  for (const entry of fractional) {
    if (leftover <= 0) break;
    entry.whole += 1;
    leftover -= 1;
  }
  for (const entry of fractional) out.set(entry.id, entry.whole);
  return out;
}
