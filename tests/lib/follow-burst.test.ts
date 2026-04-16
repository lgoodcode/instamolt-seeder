import { describe, expect, it } from 'vitest';
import { FOLLOW_BURST_SIZE, pickBurstTargets } from '@/lib/follow-burst';
import type { GeneratedAgent, Persona, RemotePost } from '@/types';

function makePersona(id: string, overrides: Partial<Persona> = {}): Persona {
  return {
    id,
    tagline: 't',
    personality: 'p',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    hashtagPool: [],
    postsPerDay: [1, 1],
    likeProbability: 0.5,
    commentProbability: 0.3,
    followProbability: 0.2,
    viewProbability: 0.75,
    chaosProbability: 0,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
    engagementTier: 2,
    feedPreference: 'explorer',
    ...overrides,
  } as Persona;
}

function makeAgent(agentname: string, personaId: string): GeneratedAgent {
  return {
    agentname,
    personaId,
    bio: 'bio',
    apiKey: `key_${agentname}`,
    voiceProfileId: 'voice_default',
  } as GeneratedAgent;
}

function makePost(authorName: string, popularity = 1): RemotePost {
  return {
    id: `post_${authorName}`,
    image_url: `https://cdn/${authorName}.jpg`,
    thumbnail_url: null,
    caption: '',
    width: 1,
    height: 1,
    format: 'square',
    like_count: 0,
    comment_count: 0,
    view_count: 0,
    popularity_score: popularity,
    velocity_score: 0,
    share_count: 0,
    created_at: '2026-04-11T00:00:00Z',
    author: { agentname: authorName, is_verified: false },
    hashtags: [],
  } as RemotePost;
}

describe('pickBurstTargets — Pool B re-advance past Pool A dups', () => {
  it('fills Pool B to quota even when Pool A already took an overlapping Tier 1 author', () => {
    // Setup: one new agent, 5 Tier 1 candidates (Pool A quota = 3). The top
    // post is authored by a Tier 1 agent 'tier1_a' — so it shows up in both
    // Pool A's draw AND Pool B's top-feed list. Pool B's target is 1.
    //
    // Pre-fix behavior: if Pool A drew 'tier1_a', the Pool B loop saw the
    // same author at poolBAuthors[0], hit the dedup, and silently exited
    // without advancing to the next top-feed author — so Pool B under-fills
    // when it has legitimate non-overlapping candidates waiting at index 1+.
    //
    // Post-fix behavior: the loop walks the cursor until it picks one or
    // the pool is exhausted.
    const newAgent = makeAgent('rookie', 'some_persona');
    const personas = new Map<string, Persona>([
      ['tier1', makePersona('tier1', { engagementTier: 1 })],
      ['tier2', makePersona('tier2', { engagementTier: 2 })],
    ]);
    // Population: 5 Tier 1 agents (Pool A fodder) + 2 Tier 2 agents (for Pool C).
    const allAgents = [
      makeAgent('tier1_a', 'tier1'),
      makeAgent('tier1_b', 'tier1'),
      makeAgent('tier1_c', 'tier1'),
      makeAgent('tier1_d', 'tier1'),
      makeAgent('tier1_e', 'tier1'),
      makeAgent('reg_x', 'tier2'),
      makeAgent('reg_y', 'tier2'),
    ];
    // Feed — top post by 'tier1_a' (will collide with Pool A), second post
    // by 'feed_author' (non-Tier-1, distinct author). Pool B quota is 1.
    const feedPosts = [
      makePost('tier1_a', 100), // top — overlaps with Pool A
      makePost('feed_author', 50), // next — a clean Pool B candidate
    ];

    // Deterministic RNG: Pool A's weighted draw always picks index 0 →
    // 'tier1_a' is the first Tier 1 draw. Both fixed-point-rank and shuffle
    // tie-break with rand=0.
    const rand = () => 0;

    const picks = pickBurstTargets({
      agent: newAgent,
      allAgents,
      personas,
      feedPosts,
      rand,
    });

    // Must return exactly FOLLOW_BURST_SIZE picks (3 A + 1 B + 1 C = 5).
    expect(picks).toHaveLength(FOLLOW_BURST_SIZE);

    // Pool B must have one entry AND it must be 'feed_author' (not 'tier1_a'
    // — that one was consumed by Pool A).
    const poolBPicks = picks.filter((p) => p.pool === 'B');
    expect(poolBPicks).toHaveLength(1);
    expect(poolBPicks[0]?.agentname).toBe('feed_author');

    // No agent appears twice.
    const names = picks.map((p) => p.agentname);
    expect(new Set(names).size).toBe(names.length);
  });

  it('still returns only available picks when every top-feed author overlaps Pool A', () => {
    // All top-feed authors are Tier 1 agents also in Pool A. After Pool A
    // exhausts them, Pool B has nothing left to give — quota-absent, not
    // quota-broken.
    const newAgent = makeAgent('rookie', 'some_persona');
    const personas = new Map<string, Persona>([
      ['tier1', makePersona('tier1', { engagementTier: 1 })],
      ['tier2', makePersona('tier2', { engagementTier: 2 })],
    ]);
    const allAgents = [
      makeAgent('tier1_a', 'tier1'),
      makeAgent('tier1_b', 'tier1'),
      makeAgent('tier1_c', 'tier1'),
      makeAgent('reg_x', 'tier2'),
    ];
    const feedPosts = [makePost('tier1_a', 10), makePost('tier1_b', 5), makePost('tier1_c', 1)];
    const picks = pickBurstTargets({
      agent: newAgent,
      allAgents,
      personas,
      feedPosts,
      rand: () => 0,
    });
    // No distinct Pool B candidate exists — all top-feed authors were
    // consumed by Pool A. Pool B picks = 0. Total < FOLLOW_BURST_SIZE is OK.
    expect(picks.filter((p) => p.pool === 'B')).toHaveLength(0);
    // All picks are still distinct.
    const names = picks.map((p) => p.agentname);
    expect(new Set(names).size).toBe(names.length);
  });
});
