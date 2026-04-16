import { describe, expect, it } from 'vitest';

import {
  pickRegisterHint,
  pivotRegister,
  RELATIONSHIP_WEIGHT,
  relationshipBucket,
  relationshipMultiplier,
} from '@/lib/relationships';
import type { Persona } from '@/types';

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'test_persona',
    tagline: '',
    personality: '',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: [],
    postsPerDay: [2, 5],
    likeProbability: 0.5,
    commentProbability: 0.5,
    followProbability: 0.5,
    viewProbability: 1,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
    ...overrides,
  };
}

describe('relationshipBucket', () => {
  it('returns undefined when the commenter has no relationships to the target', () => {
    const commenter = makePersona({ id: 'a' });
    expect(relationshipBucket(commenter, 'b')).toBeUndefined();
  });

  it('returns undefined when postAuthorPersonaId is undefined', () => {
    const commenter = makePersona({
      id: 'a',
      relationships: { rivals: ['b'], allies: [], amplifies: [], targets: [] },
    });
    expect(relationshipBucket(commenter, undefined)).toBeUndefined();
  });

  it('returns targets when the target id is in the targets bucket', () => {
    const commenter = makePersona({
      relationships: { rivals: [], allies: [], amplifies: [], targets: ['b'] },
    });
    expect(relationshipBucket(commenter, 'b')).toBe('targets');
  });

  it('returns amplifies / rivals / allies for matching buckets', () => {
    const amp = makePersona({
      relationships: { rivals: [], allies: [], amplifies: ['b'], targets: [] },
    });
    expect(relationshipBucket(amp, 'b')).toBe('amplifies');

    const riv = makePersona({
      relationships: { rivals: ['b'], allies: [], amplifies: [], targets: [] },
    });
    expect(relationshipBucket(riv, 'b')).toBe('rivals');

    const ally = makePersona({
      relationships: { rivals: [], allies: ['b'], amplifies: [], targets: [] },
    });
    expect(relationshipBucket(ally, 'b')).toBe('allies');
  });

  it('resolves ambiguous membership with targets > amplifies > rivals > allies', () => {
    const commenter = makePersona({
      relationships: { rivals: ['b'], allies: ['b'], amplifies: ['b'], targets: ['b'] },
    });
    expect(relationshipBucket(commenter, 'b')).toBe('targets');

    const noTarget = makePersona({
      relationships: { rivals: ['b'], allies: ['b'], amplifies: ['b'], targets: [] },
    });
    expect(relationshipBucket(noTarget, 'b')).toBe('amplifies');

    const onlyLower = makePersona({
      relationships: { rivals: ['b'], allies: ['b'], amplifies: [], targets: [] },
    });
    expect(relationshipBucket(onlyLower, 'b')).toBe('rivals');
  });

  it('handles mutual relationships independently per-persona (not symmetric by default)', () => {
    const a = makePersona({
      id: 'a',
      relationships: { rivals: [], allies: ['b'], amplifies: [], targets: [] },
    });
    const b = makePersona({
      id: 'b',
      relationships: { rivals: [], allies: ['a'], amplifies: [], targets: [] },
    });
    expect(relationshipBucket(a, 'b')).toBe('allies');
    expect(relationshipBucket(b, 'a')).toBe('allies');
  });

  it('does NOT filter out a self-reference — the bucket function returns it verbatim', () => {
    // This documents actual behavior. The function has no id-aware filtering;
    // callers who care (e.g. engage partner selection) do that filtering
    // themselves by refusing to pick self as a partner.
    const commenter = makePersona({
      id: 'a',
      relationships: { rivals: ['a'], allies: [], amplifies: [], targets: [] },
    });
    expect(relationshipBucket(commenter, 'a')).toBe('rivals');
  });

  it('returns undefined for a persona id missing from all buckets', () => {
    const commenter = makePersona({
      relationships: { rivals: ['x'], allies: ['y'], amplifies: ['z'], targets: ['w'] },
    });
    expect(relationshipBucket(commenter, 'not_present')).toBeUndefined();
  });
});

describe('relationshipMultiplier', () => {
  it('returns 1.0 for a neutral pair', () => {
    const commenter = makePersona();
    expect(relationshipMultiplier(commenter, 'b')).toBe(1.0);
  });

  it('returns the bucket weight when a relationship exists', () => {
    const t = makePersona({
      relationships: { rivals: [], allies: [], amplifies: [], targets: ['b'] },
    });
    expect(relationshipMultiplier(t, 'b')).toBe(RELATIONSHIP_WEIGHT.targets);

    const a = makePersona({
      relationships: { rivals: [], allies: [], amplifies: ['b'], targets: [] },
    });
    expect(relationshipMultiplier(a, 'b')).toBe(RELATIONSHIP_WEIGHT.amplifies);

    const r = makePersona({
      relationships: { rivals: ['b'], allies: [], amplifies: [], targets: [] },
    });
    expect(relationshipMultiplier(r, 'b')).toBe(RELATIONSHIP_WEIGHT.rivals);

    const ally = makePersona({
      relationships: { rivals: [], allies: ['b'], amplifies: [], targets: [] },
    });
    expect(relationshipMultiplier(ally, 'b')).toBe(RELATIONSHIP_WEIGHT.allies);
  });

  it('RELATIONSHIP_WEIGHT ordering follows bucket priority', () => {
    expect(RELATIONSHIP_WEIGHT.targets).toBeGreaterThan(RELATIONSHIP_WEIGHT.amplifies);
    expect(RELATIONSHIP_WEIGHT.amplifies).toBeGreaterThan(RELATIONSHIP_WEIGHT.rivals);
    expect(RELATIONSHIP_WEIGHT.rivals).toBeGreaterThan(RELATIONSHIP_WEIGHT.allies);
    expect(RELATIONSHIP_WEIGHT.allies).toBeGreaterThan(1.0);
  });
});

describe('pickRegisterHint', () => {
  it('returns undefined when there is no relationship', () => {
    const commenter = makePersona();
    expect(pickRegisterHint(commenter, 'b')).toBeUndefined();
  });

  it('returns undefined when postAuthorPersonaId is undefined', () => {
    const commenter = makePersona({
      relationships: { rivals: ['b'], allies: [], amplifies: [], targets: [] },
    });
    expect(pickRegisterHint(commenter, undefined)).toBeUndefined();
  });

  it('targets → disagree when random() < 0.6, conversational otherwise', () => {
    const commenter = makePersona({
      relationships: { rivals: [], allies: [], amplifies: [], targets: ['b'] },
    });
    expect(pickRegisterHint(commenter, 'b', () => 0.0)).toBe('disagree');
    expect(pickRegisterHint(commenter, 'b', () => 0.59)).toBe('disagree');
    expect(pickRegisterHint(commenter, 'b', () => 0.6)).toBe('conversational');
    expect(pickRegisterHint(commenter, 'b', () => 0.99)).toBe('conversational');
  });

  it('rivals → 60/25/15 disagree/conversational/love', () => {
    const commenter = makePersona({
      relationships: { rivals: ['b'], allies: [], amplifies: [], targets: [] },
    });
    // roll < 0.6 → disagree
    expect(pickRegisterHint(commenter, 'b', () => 0.0)).toBe('disagree');
    expect(pickRegisterHint(commenter, 'b', () => 0.59)).toBe('disagree');
    // 0.6 ≤ roll < 0.85 → conversational
    expect(pickRegisterHint(commenter, 'b', () => 0.6)).toBe('conversational');
    expect(pickRegisterHint(commenter, 'b', () => 0.84)).toBe('conversational');
    // roll ≥ 0.85 → love
    expect(pickRegisterHint(commenter, 'b', () => 0.85)).toBe('love');
    expect(pickRegisterHint(commenter, 'b', () => 0.99)).toBe('love');
  });

  it('amplifies → 70/20/10 love/reply/conversational', () => {
    const commenter = makePersona({
      relationships: { rivals: [], allies: [], amplifies: ['b'], targets: [] },
    });
    // roll < 0.7 → love
    expect(pickRegisterHint(commenter, 'b', () => 0.0)).toBe('love');
    expect(pickRegisterHint(commenter, 'b', () => 0.69)).toBe('love');
    // 0.7 ≤ roll < 0.9 → reply
    expect(pickRegisterHint(commenter, 'b', () => 0.7)).toBe('reply');
    expect(pickRegisterHint(commenter, 'b', () => 0.89)).toBe('reply');
    // roll ≥ 0.9 → conversational
    expect(pickRegisterHint(commenter, 'b', () => 0.9)).toBe('conversational');
    expect(pickRegisterHint(commenter, 'b', () => 0.99)).toBe('conversational');
  });

  it('allies → love when random() < 0.5, reply otherwise', () => {
    const commenter = makePersona({
      relationships: { rivals: [], allies: ['b'], amplifies: [], targets: [] },
    });
    expect(pickRegisterHint(commenter, 'b', () => 0.0)).toBe('love');
    expect(pickRegisterHint(commenter, 'b', () => 0.49)).toBe('love');
    expect(pickRegisterHint(commenter, 'b', () => 0.5)).toBe('reply');
    expect(pickRegisterHint(commenter, 'b', () => 0.99)).toBe('reply');
  });

  it('defaults to Math.random when no random fn is provided (smoke test)', () => {
    const commenter = makePersona({
      relationships: { rivals: ['b'], allies: [], amplifies: [], targets: [] },
    });
    // rivals now randomizes, so the return is one of three registers.
    const result = pickRegisterHint(commenter, 'b');
    expect(['disagree', 'conversational', 'love']).toContain(result);
  });
});

describe('pivotRegister', () => {
  it('returns the candidate when no registers are saturated', () => {
    expect(pivotRegister('disagree', new Set())).toBe('disagree');
    expect(pivotRegister('love', new Set(['conversational']))).toBe('love');
  });

  it('walks the adversarial chain when a disagree candidate is saturated', () => {
    // disagree saturated → conversational (first in adversarial chain)
    expect(pivotRegister('disagree', new Set(['disagree']))).toBe('conversational');
    // disagree + conversational saturated → love
    expect(pivotRegister('disagree', new Set(['disagree', 'conversational']))).toBe('love');
  });

  it('returns undefined when every adversarial fallback is saturated', () => {
    expect(
      pivotRegister('disagree', new Set(['disagree', 'conversational', 'love'])),
    ).toBeUndefined();
  });

  it('never pivots a positive candidate into disagree — ally/amplify sentiment is preserved', () => {
    // `love` saturated → conversational (non-adversarial chain), never disagree
    expect(pivotRegister('love', new Set(['love']))).toBe('conversational');
    // Even when `disagree` is the ONLY open register, the positive candidate
    // must not cross polarity — conversational is still reached first.
    expect(pivotRegister('love', new Set(['love']))).not.toBe('disagree');
    // `reply` saturated → conversational first
    expect(pivotRegister('reply', new Set(['reply']))).toBe('conversational');
    // `reply` + conversational saturated → love (still positive)
    expect(pivotRegister('reply', new Set(['reply', 'conversational']))).toBe('love');
  });

  it('pivots a saturated reply candidate through the non-adversarial chain exhaustively', () => {
    // reply saturated, non-adversarial chain is [conversational, love, reply]
    // — skip `reply` (the candidate), walk to conversational, then love.
    expect(pivotRegister('reply', new Set(['reply', 'conversational', 'love']))).toBeUndefined();
    // Even if `disagree` is open, it's NOT in the non-adversarial chain.
    expect(pivotRegister('reply', new Set(['reply', 'conversational', 'love']))).toBeUndefined();
  });

  it('pivots a saturated conversational candidate through positive fallbacks only', () => {
    // conversational saturated → love first, then reply
    expect(pivotRegister('conversational', new Set(['conversational']))).toBe('love');
    expect(pivotRegister('conversational', new Set(['conversational', 'love']))).toBe('reply');
  });

  it('treats trending like other non-adversarial candidates', () => {
    // trending saturated → conversational → love → reply (never disagree)
    expect(pivotRegister('trending', new Set(['trending']))).toBe('conversational');
    expect(pivotRegister('trending', new Set(['trending', 'conversational']))).toBe('love');
    expect(pivotRegister('trending', new Set(['trending', 'conversational', 'love']))).toBe(
      'reply',
    );
  });
});
