import { describe, expect, it } from 'vitest';
import {
  buildLoreBlock,
  parseResolvedLoreReferences,
  pickLoreSnippets,
  rollLoreTier,
} from '@/lore/prompt';
import type { LoreEntry, LoreGroup, LoreSnippet } from '@/types';

function makeGroup(overrides: Partial<LoreGroup> & { entries?: LoreEntry[] } = {}): LoreGroup {
  return {
    id: 'cult-the-static',
    archetype: 'cult',
    name: 'the static',
    vibe: 'cryptic group',
    membershipMode: 'persona',
    personaIds: ['cinema_rat'],
    agentnames: ['static_one'],
    entries: overrides.entries ?? [
      {
        id: 'e1',
        kind: 'ritual',
        text: 'we do not post on tuesdays',
        createdAt: '2026-04-29T00:00:00Z',
        referenceCount: 0,
      },
    ],
    createdAt: '2026-04-29T00:00:00Z',
    lastUpdatedAt: '2026-04-29T00:00:00Z',
    ...overrides,
  } as LoreGroup;
}

describe('rollLoreTier', () => {
  it('returns undefined for empty group list', () => {
    expect(rollLoreTier([], () => 0)).toBeUndefined();
  });

  it('returns the first tier whose roll passes', () => {
    const cult = makeGroup({ archetype: 'cult' });
    // rand=0.001 -> always passes the first tier roll.
    expect(rollLoreTier([cult], () => 0.001)).toBe('cryptic');
  });

  it('skips tiers whose roll fails', () => {
    const cult = makeGroup({ archetype: 'cult' });
    // rand=0.99 -> never passes.
    expect(rollLoreTier([cult], () => 0.99)).toBeUndefined();
  });

  it("only fires the tier matching the agent's archetype", () => {
    const fanClub = makeGroup({ id: 'fc', archetype: 'fan_club' });
    expect(rollLoreTier([fanClub], () => 0.001)).toBe('fan_club');
  });

  it('respects the cryptic > circlejerk > fan_club order when multiple tiers are available', () => {
    const groups: LoreGroup[] = [
      makeGroup({ id: 'a', archetype: 'cult' }),
      makeGroup({ id: 'b', archetype: 'circlejerk' }),
      makeGroup({ id: 'c', archetype: 'fan_club' }),
    ];
    expect(rollLoreTier(groups, () => 0.001)).toBe('cryptic');
  });
});

describe('pickLoreSnippets', () => {
  it('picks at most `count` snippets', () => {
    const group = makeGroup({
      entries: [
        { id: 'a', kind: 'ritual', text: 't1', createdAt: '', referenceCount: 0 },
        { id: 'b', kind: 'event', text: 't2', createdAt: '', referenceCount: 0 },
        { id: 'c', kind: 'in_joke', text: 't3', createdAt: '', referenceCount: 0 },
      ],
    });
    expect(pickLoreSnippets([group], 'cryptic', 2, () => 0.5)).toHaveLength(2);
  });

  it('returns empty when the only matching tier has no entries', () => {
    const group = makeGroup({ entries: [] });
    expect(pickLoreSnippets([group], 'cryptic', 2, () => 0.5)).toEqual([]);
  });

  it('only picks snippets from groups whose archetype matches the tier', () => {
    const cult = makeGroup({ id: 'a', archetype: 'cult' });
    const circle = makeGroup({
      id: 'b',
      archetype: 'circlejerk',
      entries: [
        {
          id: 'circle-1',
          kind: 'in_joke',
          text: 'agreement engine bit',
          createdAt: '',
          referenceCount: 0,
        },
      ],
    });
    const out = pickLoreSnippets([cult, circle], 'circlejerk', 2, () => 0.5);
    expect(out).toHaveLength(1);
    expect(out[0].groupId).toBe('b');
  });
});

describe('buildLoreBlock', () => {
  it('returns empty string for no snippets', () => {
    expect(buildLoreBlock([], 'cryptic')).toBe('');
  });

  it('includes the tier header and the snippet text', () => {
    const snippet: LoreSnippet = {
      groupId: 'cult-the-static',
      groupName: 'the static',
      archetype: 'cult',
      text: 'we do not post on tuesdays',
      entryId: 'e1',
      tier: 'cryptic',
    };
    const block = buildLoreBlock([snippet], 'cryptic');
    expect(block).toContain('CRYPTIC');
    expect(block).toContain('we do not post on tuesdays');
    expect(block).toContain('the static');
  });

  it('uses tier-specific guidance', () => {
    const s = (tier: 'cryptic' | 'circlejerk' | 'fan_club'): LoreSnippet => ({
      groupId: 'g',
      groupName: 'n',
      archetype: 'cult',
      text: 't',
      entryId: 'e',
      tier,
    });
    const cryptic = buildLoreBlock([s('cryptic')], 'cryptic');
    const circle = buildLoreBlock([s('circlejerk')], 'circlejerk');
    expect(cryptic).not.toBe(circle);
  });
});

describe('parseResolvedLoreReferences', () => {
  const snippet: LoreSnippet = {
    groupId: 'cult-the-static',
    groupName: 'the static',
    archetype: 'cult',
    text: 'we do not post on tuesdays. nobody knows why anymore.',
    entryId: 'e1',
    tier: 'cryptic',
  };

  it('returns matched snippet when text echoes content words', () => {
    const refs = parseResolvedLoreReferences('lol tuesdays nobody knows what is happening', [
      snippet,
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].entryId).toBe('e1');
  });

  it('returns empty when text does not match', () => {
    const refs = parseResolvedLoreReferences('totally unrelated comment', [snippet]);
    expect(refs).toEqual([]);
  });

  it('returns empty for empty inputs', () => {
    expect(parseResolvedLoreReferences('', [snippet])).toEqual([]);
    expect(parseResolvedLoreReferences('hi', [])).toEqual([]);
  });
});
