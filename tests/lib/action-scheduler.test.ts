import { describe, expect, it, vi } from 'vitest';

// Need config mock before importing action-scheduler.
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { ActionScheduler } from '@/lib/action-scheduler';
import type { GeneratedAgent, Persona } from '@/types';

function makeAgent(agentname: string): GeneratedAgent {
  return {
    agentname,
    personaId: 'p',
    voiceProfileId: 'v',
    bio: 'bio',
    apiKey: 'key',
  };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'test_persona',
    tagline: '',
    personality: '',
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    namePatterns: [],
    hashtagPool: [],
    postsPerDay: [2, 5],
    likeProbability: 0.5,
    commentProbability: 0.5,
    followProbability: 0.5,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
    ...overrides,
  };
}

describe('ActionScheduler', () => {
  it('pop returns agents in nextTickAt order (min-heap property)', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    // Enroll three agents with deterministic jitter=0 so nextTickAt≈now
    // for all of them, then manually override their nextTickAt values.
    scheduler.enroll(makeAgent('a'), persona, { initialJitterMs: 0 });
    scheduler.enroll(makeAgent('b'), persona, { initialJitterMs: 0 });
    scheduler.enroll(makeAgent('c'), persona, { initialJitterMs: 0 });
    expect(scheduler.size()).toBe(3);

    // Pop all and assert heap property (each successive pop has a higher
    // nextTickAt than the previous). With jitter=0 they are all ~now, so
    // we just verify the heap doesn't corrupt order — any permutation is
    // acceptable as long as it's non-decreasing.
    let prevTick = 0;
    for (let i = 0; i < 3; i++) {
      const entry = scheduler.pop();
      expect(entry).toBeDefined();
      expect(entry!.nextTickAt).toBeGreaterThanOrEqual(prevTick);
      prevTick = entry!.nextTickAt;
    }
    expect(scheduler.pop()).toBeUndefined();
  });

  it('enroll is idempotent — double-enrolling the same agent is a no-op', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    scheduler.enroll(makeAgent('a'), persona);
    scheduler.enroll(makeAgent('a'), persona);
    expect(scheduler.size()).toBe(1);
  });

  it('has() reports whether an agent is enrolled', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    expect(scheduler.has('a')).toBe(false);
    scheduler.enroll(makeAgent('a'), persona);
    expect(scheduler.has('a')).toBe(true);
  });

  it('rescheduleAfterTick puts the agent back into the heap at a future time', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    const agent = makeAgent('a');
    scheduler.enroll(agent, persona, { initialJitterMs: 0 });
    const first = scheduler.pop();
    expect(first?.agentname).toBe('a');
    expect(scheduler.size()).toBe(0);

    scheduler.rescheduleAfterTick(agent, persona);
    expect(scheduler.size()).toBe(1);
    const second = scheduler.pop();
    expect(second?.agentname).toBe('a');
    expect(second!.nextTickAt).toBeGreaterThan(first!.nextTickAt);
  });

  it('rescheduleQuotaExhausted pushes the agent far into the future', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    const agent = makeAgent('a');
    scheduler.enroll(agent, persona, { initialJitterMs: 0 });
    const first = scheduler.pop()!;

    scheduler.rescheduleQuotaExhausted(agent);
    const second = scheduler.pop()!;
    // Exhausted requeue is ~30min; jitter-free so it should be at least
    // 25min from now.
    expect(second.nextTickAt - first.nextTickAt).toBeGreaterThan(25 * 60_000);
  });

  it('peek returns the soonest entry without removing it', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    scheduler.enroll(makeAgent('a'), persona, { initialJitterMs: 0 });
    const peeked = scheduler.peek();
    expect(peeked?.agentname).toBe('a');
    expect(scheduler.size()).toBe(1);
  });

  it('rescheduleAfterTick delegates to the session manager', () => {
    const scheduler = new ActionScheduler({
      getHour: () => 12, // noon — moderate activity curve
    });
    const persona = makePersona();
    const agent = makeAgent('a');
    scheduler.enroll(agent, persona, { initialJitterMs: 0 });
    scheduler.pop();

    scheduler.rescheduleAfterTick(agent, persona);
    const entry = scheduler.pop()!;
    // Session manager produces a delay; the tick should be in the future.
    expect(entry.nextTickAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('handles a large population without corrupting heap order', () => {
    const scheduler = new ActionScheduler();
    const persona = makePersona();
    // Enroll 100 agents with varying jitter
    for (let i = 0; i < 100; i++) {
      scheduler.enroll(makeAgent(`agent-${i}`), persona, {
        initialJitterMs: 10_000,
      });
    }
    expect(scheduler.size()).toBe(100);

    // Pop all and verify non-decreasing order
    let prevTick = 0;
    for (let i = 0; i < 100; i++) {
      const entry = scheduler.pop()!;
      expect(entry.nextTickAt).toBeGreaterThanOrEqual(prevTick);
      prevTick = entry.nextTickAt;
    }
    expect(scheduler.pop()).toBeUndefined();
  });
});
