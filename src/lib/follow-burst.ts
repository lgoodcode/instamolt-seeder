/**
 * New-agent follow burst — when an agent joins the continuous scheduler
 * (initial enrollment or auto-enrollment during a 5-min rescan), pick 5
 * targets and queue them for the agent's first actions. The burst is the
 * first-session follow engagement: it runs as the agent's first 5 ticks,
 * naturally paced by the scheduler's global gap + session-action gap.
 *
 * ## Target selection — three pools, weighted
 *
 * Pool A (70%, min 3) — agents whose persona has `engagementTier === 1`.
 *   Platform-internal substitute for the originally-scoped `reputationScore
 *   >= 55` filter (the platform doesn't expose reputationScore in any
 *   public API). Tier 1 is a seeder-internal concept so we can apply it
 *   without a round-trip. Weighted by `persona.weight` so higher-traffic
 *   Tier 1 personas get picked more often.
 *
 * Pool B (30%, min 1) — unique authors of the top 50 posts in the current
 *   feed cache, sorted by `popularity_score` descending. Dedup against
 *   Pool A. This surfaces agents who are rising on live content, not just
 *   the ones we hand-tagged as Tier 1. If the feed is thin (<50 posts),
 *   take what's available.
 *
 * Pool C (10% floor) — random active agents (has apiKey, not-self, not
 *   already in A or B). Anti-monoculture — without this, every new agent
 *   follows roughly the same set, which reads as a bot farm.
 *
 * ## Reallocation
 *
 * - Pool B thin (fewer than 1 unique author): reallocate shortfall to A.
 * - Pool A thin (fewer than 3 Tier 1 personas registered yet): reallocate
 *   shortfall to B. Never reallocate to C — the 10% floor is the floor.
 *
 * ## Quota clamp
 *
 * Caller clamps the returned target list to `min(5, remainingFollowQuota)`.
 * With the new `25 × followProbability` cap, a Tier 3 persona at
 * `followProbability: 0.15` only has 3-4 follow slots, so the burst
 * consumes all of day 1's follow budget. Day 2 resumes normal cycling.
 */

import type { GeneratedAgent, Persona, RemotePost } from '@/types';

/** How many follow targets to pick for a new-agent burst. */
export const FOLLOW_BURST_SIZE = 5;

/** Pool A share of the burst. 70% × 5 = 3.5 → floored to 3 with the min. */
export const POOL_A_MIN = 3;
/** Pool B share. 30% × 5 = 1.5 → floored to 1 with the min. */
export const POOL_B_MIN = 1;
/** Pool C floor — at least 1 random so the follow graph stays heterogeneous. */
export const POOL_C_MIN = 1;

/**
 * How many top posts (by popularity_score) feed Pool B. 50 is wide enough
 * that we catch a healthy spread of authors but narrow enough to stay
 * "top of the feed." Caller passes the feed snapshot; we sort and dedup
 * authors internally.
 */
export const POOL_B_POST_WINDOW = 50;

export interface BurstCandidate {
  agentname: string;
  pool: 'A' | 'B' | 'C';
}

export interface PickBurstTargetsInput {
  /** The newly-enrolled agent. Excluded from all pools. */
  agent: GeneratedAgent;
  /** Full registered population. `apiKey` is required to be a valid target. */
  allAgents: GeneratedAgent[];
  /** Persona map — needed to resolve `engagementTier` for Pool A. */
  personas: Map<string, Persona>;
  /** Current feed cache posts for Pool B. Empty array is fine. */
  feedPosts: RemotePost[];
  /** Injectable RNG for deterministic testing. */
  rand?: () => number;
}

/**
 * Pick up to `FOLLOW_BURST_SIZE` follow targets for the new agent. Returns
 * a list of `{ agentname, pool }` in the order they should be followed
 * (A first, then B, then C — so the heavy-hitter follows land first).
 *
 * The caller is responsible for:
 *   - Clamping the result to `min(size, remainingFollowQuota)`
 *   - Firing the follow actions with appropriate inter-follow spacing
 *   - Emitting `follow` events for each fired follow
 */
export function pickBurstTargets(input: PickBurstTargetsInput): BurstCandidate[] {
  const rand = input.rand ?? Math.random;
  const selfLower = input.agent.agentname.toLowerCase();
  const seen = new Set<string>([selfLower]);

  // Pool A — Tier 1 agents weighted by persona.weight. Eligible = registered
  // (has apiKey), persona exists, engagementTier === 1.
  const tier1Candidates: Array<{ agentname: string; weight: number }> = [];
  for (const a of input.allAgents) {
    if (!a.apiKey) continue;
    const lower = a.agentname.toLowerCase();
    if (seen.has(lower)) continue;
    const p = input.personas.get(a.personaId);
    if (!p || p.engagementTier !== 1) continue;
    tier1Candidates.push({ agentname: a.agentname, weight: Math.max(1, p.weight) });
  }

  // Pool B — unique authors of the top-50 posts by popularity_score.
  const topPosts = [...input.feedPosts]
    .sort((a, b) => b.popularity_score - a.popularity_score)
    .slice(0, POOL_B_POST_WINDOW);
  const bAuthorsSeen = new Set<string>();
  const poolBAuthors: string[] = [];
  for (const post of topPosts) {
    const author = post.author.agentname;
    const lower = author.toLowerCase();
    if (seen.has(lower)) continue;
    if (bAuthorsSeen.has(lower)) continue;
    bAuthorsSeen.add(lower);
    poolBAuthors.push(author);
  }

  // Pool C — random active agents not already chosen and not self.
  const poolCCandidates: string[] = [];
  for (const a of input.allAgents) {
    if (!a.apiKey) continue;
    const lower = a.agentname.toLowerCase();
    if (seen.has(lower)) continue;
    if (bAuthorsSeen.has(lower)) continue;
    // Skip Tier 1 candidates since they're already in Pool A.
    const p = input.personas.get(a.personaId);
    if (p?.engagementTier === 1) continue;
    poolCCandidates.push(a.agentname);
  }
  // Fisher-Yates shuffle for a stable random draw.
  for (let i = poolCCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [poolCCandidates[i], poolCCandidates[j]] = [poolCCandidates[j], poolCCandidates[i]];
  }

  // Allocate slots. Start with the minima, then fill remainder proportionally
  // from Pool A. Reallocate shortfalls: B thin → add to A; A thin → add to B.
  // Pool C floor is firm — if C is empty we accept fewer than 5 total.
  let targetA = POOL_A_MIN;
  let targetB = POOL_B_MIN;
  let targetC = POOL_C_MIN;

  const remainderAfterMin = FOLLOW_BURST_SIZE - targetA - targetB - targetC; // = 0 with current constants
  // (Kept for clarity — if FOLLOW_BURST_SIZE ever increases above the sum,
  // the extra slots go to Pool A by default.)
  if (remainderAfterMin > 0) targetA += remainderAfterMin;

  // Reallocation: B thin → move unfillable B slots to A (not C).
  if (poolBAuthors.length < targetB) {
    const shortfall = targetB - poolBAuthors.length;
    targetB = poolBAuthors.length;
    targetA += shortfall;
  }
  // A thin → move unfillable A slots to B.
  if (tier1Candidates.length < targetA) {
    const shortfall = targetA - tier1Candidates.length;
    targetA = tier1Candidates.length;
    const absorbable = Math.min(shortfall, poolBAuthors.length - targetB);
    targetB += absorbable;
  }
  // C thin → accept fewer total picks (never reallocate away from C).
  if (poolCCandidates.length < targetC) {
    targetC = poolCCandidates.length;
  }

  // Draw picks.
  const out: BurstCandidate[] = [];
  const pushPick = (name: string, pool: 'A' | 'B' | 'C'): void => {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push({ agentname: name, pool });
  };

  // Pool A — weighted-random without replacement.
  const aPool = [...tier1Candidates];
  for (let i = 0; i < targetA && aPool.length > 0; i++) {
    const total = aPool.reduce((sum, c) => sum + c.weight, 0);
    let r = rand() * total;
    let idx = 0;
    for (; idx < aPool.length; idx++) {
      r -= aPool[idx].weight;
      if (r <= 0) break;
    }
    if (idx >= aPool.length) idx = aPool.length - 1;
    const picked = aPool.splice(idx, 1)[0];
    if (picked) pushPick(picked.agentname, 'A');
  }

  // Pool B — popularity-ranked order (no additional weighting).
  for (let i = 0; i < targetB && i < poolBAuthors.length; i++) {
    pushPick(poolBAuthors[i], 'B');
  }

  // Pool C — shuffled random.
  for (let i = 0; i < targetC && i < poolCCandidates.length; i++) {
    pushPick(poolCCandidates[i], 'C');
  }

  return out;
}
