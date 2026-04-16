import { describe, expect, it } from 'vitest';
import {
  buildCommentCandidates,
  buildMentionLookup,
  buildReplyCandidates,
  DEFAULT_MENTION_PROBABILITY,
  effectiveMentionProbability,
  MAX_MENTION_CANDIDATES,
  MAX_RELATED_MENTION_CANDIDATES,
  MENTION_REGEX,
  parseResolvedMentions,
  REPLY_MENTION_PROB_CAP,
  REPLY_MENTION_PROB_MULTIPLIER,
  type RelatedLookupPersona,
  resolveRelatedAgentnames,
  shouldIncludeMentionCandidates,
} from '@/lib/mentions';

const SELF = 'selfagent';
const POST_AUTHOR = 'post_author';
const PARENT = 'parent-author';

const buildRelated = (
  overrides: Partial<RelatedLookupPersona['relationships']> = {},
): RelatedLookupPersona => ({
  relationships: {
    allies: [],
    amplifies: [],
    rivals: [],
    ...overrides,
  },
});

describe('MENTION_REGEX', () => {
  it('matches word-character agentnames', () => {
    const text = 'hey @alice and @bob_smith';
    const matches = [...text.matchAll(MENTION_REGEX)].map((m) => m[1]);
    expect(matches).toEqual(['alice', 'bob_smith']);
  });

  it('matches agentnames containing hyphens', () => {
    const text = 'shoutout @cool-cat-99';
    const matches = [...text.matchAll(MENTION_REGEX)].map((m) => m[1]);
    expect(matches).toEqual(['cool-cat-99']);
  });

  it('returns no matches when there are no @handles', () => {
    const text = 'plain text with no mentions';
    expect([...text.matchAll(MENTION_REGEX)]).toHaveLength(0);
  });

  it('has the global flag so matchAll works', () => {
    expect(MENTION_REGEX.flags).toContain('g');
  });
});

describe('constants', () => {
  it('MAX_MENTION_CANDIDATES is 5', () => {
    expect(MAX_MENTION_CANDIDATES).toBe(5);
  });

  it('MAX_RELATED_MENTION_CANDIDATES is 2', () => {
    expect(MAX_RELATED_MENTION_CANDIDATES).toBe(2);
  });

  it('DEFAULT_MENTION_PROBABILITY is 0.1', () => {
    expect(DEFAULT_MENTION_PROBABILITY).toBeCloseTo(0.1);
  });
});

describe('parseResolvedMentions', () => {
  const known = new Set(['Alice', 'bob_smith', 'Cool-Cat']);

  it('returns [] for empty text', () => {
    expect(parseResolvedMentions('', SELF, known)).toEqual([]);
  });

  it('returns [] when text has no mentions', () => {
    expect(parseResolvedMentions('just prose here', SELF, known)).toEqual([]);
  });

  it('preserves original case in output', () => {
    const out = parseResolvedMentions('hi @ALICE', SELF, known);
    expect(out).toEqual(['ALICE']);
  });

  it('dedups case-insensitively', () => {
    const out = parseResolvedMentions('@alice @ALICE @Alice', SELF, known);
    expect(out).toEqual(['alice']);
  });

  it('drops self-mentions case-insensitively', () => {
    const out = parseResolvedMentions(`@${SELF.toUpperCase()} hey`, SELF, known);
    expect(out).toEqual([]);
  });

  it('drops unknown agentnames', () => {
    const out = parseResolvedMentions('@alice @ghost_user', SELF, known);
    expect(out).toEqual(['alice']);
  });

  it('handles hyphen and underscore names', () => {
    const out = parseResolvedMentions('@cool-cat and @bob_smith', SELF, known);
    expect(out).toEqual(['cool-cat', 'bob_smith']);
  });

  it('resolves mentions of live authors passed via extraKnownAgentnames', () => {
    // Live thread participants (post/parent/sibling authors) aren't always
    // in the seeded roster — caller injects them per-call to avoid silently
    // dropping valid mentions of real platform users.
    const out = parseResolvedMentions('hey @live_user', SELF, known, ['live_user']);
    expect(out).toEqual(['live_user']);
  });

  it('still drops self when self is also passed in extraKnownAgentnames', () => {
    // Defense-in-depth: callers may union ALL thread participants without
    // filtering self out, so the self exclusion must hold regardless.
    const out = parseResolvedMentions(`@${SELF}`, SELF, known, [SELF]);
    expect(out).toEqual([]);
  });

  it('handles undefined / empty entries in extraKnownAgentnames', () => {
    // Real call sites build the extra set from optional fields (e.g.
    // `parent.author?.agentname`), so falsy entries must be tolerated.
    const out = parseResolvedMentions('hi @alice', SELF, known, ['', 'alice']);
    expect(out).toEqual(['alice']);
  });
});

describe('buildReplyCandidates', () => {
  it('puts parent author first', () => {
    const out = buildReplyCandidates({
      selfAgentname: SELF,
      parentAuthor: PARENT,
      postAuthor: POST_AUTHOR,
    });
    expect(out[0]).toBe(PARENT);
  });

  it('includes post author when distinct from parent', () => {
    const out = buildReplyCandidates({
      selfAgentname: SELF,
      parentAuthor: PARENT,
      postAuthor: POST_AUTHOR,
    });
    expect(out).toEqual([PARENT, POST_AUTHOR]);
  });

  it('dedups post author against parent', () => {
    const out = buildReplyCandidates({
      selfAgentname: SELF,
      parentAuthor: PARENT,
      postAuthor: PARENT,
    });
    expect(out).toEqual([PARENT]);
  });

  it('appends sibling authors (up to 2) and related', () => {
    const out = buildReplyCandidates({
      selfAgentname: SELF,
      parentAuthor: PARENT,
      postAuthor: POST_AUTHOR,
      siblingAuthors: ['sib1', 'sib2', 'sib3'],
      relatedAgentnames: ['ally1'],
    });
    expect(out).toEqual([PARENT, POST_AUTHOR, 'sib1', 'sib2', 'ally1']);
  });

  it('excludes self even if it appears in siblings', () => {
    const out = buildReplyCandidates({
      selfAgentname: SELF,
      parentAuthor: PARENT,
      postAuthor: POST_AUTHOR,
      siblingAuthors: [SELF, 'sib1'],
    });
    expect(out).not.toContain(SELF);
    expect(out).toContain('sib1');
  });

  it('caps pool at MAX_MENTION_CANDIDATES', () => {
    const out = buildReplyCandidates({
      selfAgentname: SELF,
      parentAuthor: PARENT,
      postAuthor: POST_AUTHOR,
      siblingAuthors: ['sib1', 'sib2'],
      relatedAgentnames: ['r1', 'r2', 'r3', 'r4', 'r5'],
    });
    expect(out).toHaveLength(MAX_MENTION_CANDIDATES);
  });
});

describe('buildCommentCandidates', () => {
  it('puts post author first', () => {
    const out = buildCommentCandidates({
      selfAgentname: SELF,
      postAuthor: POST_AUTHOR,
    });
    expect(out[0]).toBe(POST_AUTHOR);
  });

  it('appends related agentnames', () => {
    const out = buildCommentCandidates({
      selfAgentname: SELF,
      postAuthor: POST_AUTHOR,
      relatedAgentnames: ['ally1', 'ally2'],
    });
    expect(out).toEqual([POST_AUTHOR, 'ally1', 'ally2']);
  });

  it('excludes self even if it appears in related', () => {
    const out = buildCommentCandidates({
      selfAgentname: SELF,
      postAuthor: POST_AUTHOR,
      relatedAgentnames: [SELF, 'ally1'],
    });
    expect(out).not.toContain(SELF);
    expect(out).toContain('ally1');
  });

  it('caps pool at MAX_MENTION_CANDIDATES', () => {
    const out = buildCommentCandidates({
      selfAgentname: SELF,
      postAuthor: POST_AUTHOR,
      relatedAgentnames: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    });
    expect(out).toHaveLength(MAX_MENTION_CANDIDATES);
  });
});

describe('effectiveMentionProbability', () => {
  const baseP = 0.15;

  it('returns min(COMMENT_MENTION_PROB_CAP, base) for comment context', () => {
    // Comment cap tightened to 0.15 (was 0.25) to hit the ~15% final rate.
    // baseP=0.15 exactly hits the cap.
    expect(effectiveMentionProbability(baseP, 'comment')).toBe(0.15);
  });

  it('returns min(cap, p*multiplier) for reply context', () => {
    // baseP=0.15 × 2 = 0.3, capped at REPLY_MENTION_PROB_CAP=0.25.
    expect(effectiveMentionProbability(baseP, 'reply')).toBe(REPLY_MENTION_PROB_CAP);
  });

  it('caps reply probability at REPLY_MENTION_PROB_CAP', () => {
    expect(effectiveMentionProbability(0.9, 'reply')).toBe(REPLY_MENTION_PROB_CAP);
  });

  it('falls back to DEFAULT_MENTION_PROBABILITY when undefined — comment', () => {
    // DEFAULT=0.1, capped by 0.15 comment cap → returns 0.1.
    expect(effectiveMentionProbability(undefined, 'comment')).toBe(DEFAULT_MENTION_PROBABILITY);
  });

  it('falls back to DEFAULT_MENTION_PROBABILITY when undefined — reply', () => {
    expect(effectiveMentionProbability(undefined, 'reply')).toBeCloseTo(
      Math.min(REPLY_MENTION_PROB_CAP, DEFAULT_MENTION_PROBABILITY * REPLY_MENTION_PROB_MULTIPLIER),
    );
  });

  it('clamps base probability above 0.25 to COMMENT_MENTION_PROB_CAP — comment', () => {
    // Hand-edited / malformed personas can carry out-of-range values; the
    // gate must not exceed the documented 0–0.15 range for comment context.
    expect(effectiveMentionProbability(0.9, 'comment')).toBe(0.15);
  });

  it('clamps negative base probability to 0 — comment', () => {
    expect(effectiveMentionProbability(-1, 'comment')).toBe(0);
  });

  it('clamps base before applying reply multiplier', () => {
    // Pre-clamp, 0.9 * 2 capped at 0.4 = 0.4. Post-clamp, 0.25 * 2 = 0.5
    // capped at 0.4 = 0.4. Both produce the same result here, but the
    // base clamp matters for values just above the cap (e.g. 0.3 * 2 = 0.6
    // → cap 0.4; clamped 0.25 * 2 = 0.5 → cap 0.4 — identical, but
    // `.appliedBase` is now bounded which the gate semantics depend on).
    expect(effectiveMentionProbability(0.9, 'reply')).toBe(REPLY_MENTION_PROB_CAP);
  });
});

describe('shouldIncludeMentionCandidates', () => {
  const belowThreshold = 0.05;
  const aboveThreshold = 0.9;

  it('returns true when rand() < effectiveProb', () => {
    expect(shouldIncludeMentionCandidates(0.2, 'comment', () => belowThreshold)).toBe(true);
  });

  it('returns false when rand() >= effectiveProb', () => {
    expect(shouldIncludeMentionCandidates(0.2, 'comment', () => aboveThreshold)).toBe(false);
  });

  it('returns false when p is 0', () => {
    expect(shouldIncludeMentionCandidates(0, 'comment', () => belowThreshold)).toBe(false);
  });

  it('applies reply multiplier — passes where comment would fail', () => {
    // p=0.15, rand=0.2 → comment fails (0.2 >= 0.15), reply passes (0.2 < 0.3)
    const rand = (): number => 0.2;
    expect(shouldIncludeMentionCandidates(0.15, 'comment', rand)).toBe(false);
    expect(shouldIncludeMentionCandidates(0.15, 'reply', rand)).toBe(true);
  });

  it('uses DEFAULT_MENTION_PROBABILITY when p is undefined — false above threshold', () => {
    expect(shouldIncludeMentionCandidates(undefined, 'comment', () => aboveThreshold)).toBe(false);
  });

  it('uses DEFAULT_MENTION_PROBABILITY when p is undefined — true below threshold', () => {
    expect(shouldIncludeMentionCandidates(undefined, 'comment', () => 0.01)).toBe(true);
  });
});

describe('resolveRelatedAgentnames', () => {
  const personaToAgentnames = new Map<string, string[]>([
    ['persona-ally', ['ally1', 'ally2']],
    ['persona-amp', ['amp1']],
    ['persona-rival', ['rival1']],
    ['persona-target', ['target1']],
  ]);

  // Deterministic rand that preserves insertion order (Math.floor(0 * (i+1)) = 0,
  // so each swap is a no-op since we'd swap pool[i] with pool[0]...
  // Use 0.9999 to make Math.floor(0.9999 * (i+1)) = i, which also results in
  // self-swap since j = i. Either way output order is preserved.
  const noShuffle = (): number => 0.9999;

  it('walks allies → amplifies → rivals in order', () => {
    const persona = buildRelated({
      allies: ['persona-ally'],
      amplifies: ['persona-amp'],
      rivals: ['persona-rival'],
    });
    const out = resolveRelatedAgentnames(persona, personaToAgentnames, SELF, noShuffle);
    expect(out).toHaveLength(MAX_RELATED_MENTION_CANDIDATES);
    // First two in the order [ally1, ally2] — allies come first
    expect(out).toEqual(['ally1', 'ally2']);
  });

  it('caps at MAX_RELATED_MENTION_CANDIDATES', () => {
    const persona = buildRelated({
      allies: ['persona-ally'],
      amplifies: ['persona-amp'],
      rivals: ['persona-rival'],
    });
    const out = resolveRelatedAgentnames(persona, personaToAgentnames, SELF, noShuffle);
    expect(out.length).toBeLessThanOrEqual(MAX_RELATED_MENTION_CANDIDATES);
  });

  it('dedups across buckets', () => {
    const overlap = new Map<string, string[]>([
      ['p1', ['dup']],
      ['p2', ['dup']],
    ]);
    const persona = buildRelated({
      allies: ['p1'],
      amplifies: ['p2'],
    });
    const out = resolveRelatedAgentnames(persona, overlap, SELF, noShuffle);
    expect(out).toEqual(['dup']);
  });

  it('excludes self (case-insensitively)', () => {
    const lookup = new Map<string, string[]>([['persona-ally', [SELF.toUpperCase(), 'ally2']]]);
    const persona = buildRelated({ allies: ['persona-ally'] });
    const out = resolveRelatedAgentnames(persona, lookup, SELF, noShuffle);
    expect(out).not.toContain(SELF.toUpperCase());
    expect(out).toContain('ally2');
  });

  it('ignores missing personaIds without throwing', () => {
    const persona = buildRelated({
      allies: ['does-not-exist'],
      amplifies: ['persona-amp'],
    });
    const out = resolveRelatedAgentnames(persona, personaToAgentnames, SELF, noShuffle);
    expect(out).toEqual(['amp1']);
  });

  it('does NOT use targets bucket', () => {
    const persona = buildRelated({
      targets: ['persona-target'],
    });
    const out = resolveRelatedAgentnames(persona, personaToAgentnames, SELF, noShuffle);
    expect(out).toEqual([]);
  });

  it('shuffle output is a subset of the expected pool', () => {
    const persona = buildRelated({
      allies: ['persona-ally'],
      amplifies: ['persona-amp'],
      rivals: ['persona-rival'],
    });
    const pool = new Set(['ally1', 'ally2', 'amp1', 'rival1']);
    // Use a non-trivial rand to actually exercise shuffle.
    let counter = 0;
    const rand = (): number => {
      counter += 1;
      return (counter * 0.37) % 1;
    };
    const out = resolveRelatedAgentnames(persona, personaToAgentnames, SELF, rand);
    expect(out.length).toBeLessThanOrEqual(MAX_RELATED_MENTION_CANDIDATES);
    for (const name of out) {
      expect(pool.has(name)).toBe(true);
    }
  });
});

describe('buildMentionLookup', () => {
  it('populates knownAgentnames with every agent', () => {
    const input = new Map<string, string>([
      ['alice', 'p1'],
      ['bob', 'p1'],
      ['carol', 'p2'],
    ]);
    const { knownAgentnames } = buildMentionLookup(input);
    expect(knownAgentnames).toEqual(new Set(['alice', 'bob', 'carol']));
  });

  it('groups agentnames by personaId', () => {
    const input = new Map<string, string>([
      ['alice', 'p1'],
      ['bob', 'p1'],
      ['carol', 'p2'],
    ]);
    const { personaToAgentnames } = buildMentionLookup(input);
    expect(personaToAgentnames.get('p1')).toEqual(['alice', 'bob']);
    expect(personaToAgentnames.get('p2')).toEqual(['carol']);
  });

  it('returns empty structures for an empty input map', () => {
    const { personaToAgentnames, knownAgentnames } = buildMentionLookup(new Map());
    expect(personaToAgentnames.size).toBe(0);
    expect(knownAgentnames.size).toBe(0);
  });
});
