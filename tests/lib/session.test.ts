import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { SessionManager } from '@/lib/session';
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
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
    ...overrides,
  };
}

// Defaults from src/lib/session.ts — duplicated here as test constants because
// the module keeps them private. Keep in sync if the source changes.
const SESSION_ACTION_GAP_MIN = 30_000;
const SESSION_ACTION_GAP_MAX = 180_000;
const DEFAULT_IDLE_GAP_MIN = 2 * 60 * 60_000;
const DEFAULT_IDLE_GAP_MAX = 6 * 60 * 60_000;
const IDLE_RETRY_GAP_MIN = 30 * 60_000;
const IDLE_RETRY_GAP_MAX = 60 * 60_000;
const FIRST_ACTION_MIN = 5_000;
const FIRST_ACTION_MAX = 30_000;
const BONUS_SESSION_COOLDOWN_MS = 2 * 60 * 60_000;

describe('SessionManager', () => {
  let randomSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    randomSpy?.mockRestore();
    randomSpy = undefined;
  });

  it('getState creates a fresh idle state for a new agent', () => {
    const mgr = new SessionManager();
    const s = mgr.getState('alice');
    expect(s.status).toBe('idle');
    expect(s.actionsRemaining).toBe(0);
    expect(s.sessionStartedAt).toBeUndefined();
    expect(s.lastBonusAt).toBeUndefined();
  });

  it('getState returns the same object across calls for one agent', () => {
    const mgr = new SessionManager();
    const a = mgr.getState('alice');
    const b = mgr.getState('alice');
    expect(a).toBe(b);
    expect(mgr.size()).toBe(1);
  });

  it('in_session with actionsRemaining > 0 returns a gap in SESSION_ACTION_GAP_MS range', () => {
    const mgr = new SessionManager();
    const persona = makePersona();
    // Start in-session via an idle roll that succeeds: mock random to force
    // the idle-path branch into session start.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0); // roll succeeds, size picks min
    mgr.computeNextDelay('a', persona, 1.0); // transitions idle → in_session
    const state = mgr.getState('a');
    expect(state.status).toBe('in_session');
    // Snapshot: state is a live reference held by the manager, so read the
    // count before the next computeNextDelay mutates it.
    const beforeCount = state.actionsRemaining;
    expect(beforeCount).toBeGreaterThan(0);

    // Now mid-session — return a short gap.
    randomSpy.mockReturnValue(0.5);
    const delay = mgr.computeNextDelay('a', persona, 1.0);
    expect(delay).toBeGreaterThanOrEqual(SESSION_ACTION_GAP_MIN);
    expect(delay).toBeLessThanOrEqual(SESSION_ACTION_GAP_MAX);
    // Action consumed.
    expect(mgr.getState('a').actionsRemaining).toBe(beforeCount - 1);
  });

  it('in_session with actionsRemaining = 0 transitions to idle and returns a scaled idle gap', () => {
    const mgr = new SessionManager();
    const persona = makePersona();

    // Force into in_session with actionsRemaining = 0 directly.
    const state = mgr.getState('a');
    state.status = 'in_session';
    state.actionsRemaining = 0;
    state.sessionStartedAt = Date.now();

    // Math.random() is used exactly once here (for the idle gap jitter).
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const delayFull = mgr.computeNextDelay('a', persona, 1.0);

    expect(mgr.getState('a').status).toBe('idle');
    expect(mgr.getState('a').actionsRemaining).toBe(0);
    expect(mgr.getState('a').sessionStartedAt).toBeUndefined();

    // With curveWeight=1.0, scale is 1 → plain idle gap.
    expect(delayFull).toBeGreaterThanOrEqual(DEFAULT_IDLE_GAP_MIN);
    expect(delayFull).toBeLessThanOrEqual(DEFAULT_IDLE_GAP_MAX);

    // Same mechanics again but with a lower curveWeight — must be longer
    // (or capped at 12h).
    const state2 = mgr.getState('b');
    state2.status = 'in_session';
    state2.actionsRemaining = 0;
    randomSpy.mockReturnValue(0.5);
    const delayLowCurve = mgr.computeNextDelay('b', persona, 0.2);
    // 0.2 curve → scale = 5 → gap multiplied up (capped at 12h).
    expect(delayLowCurve).toBeGreaterThan(delayFull);
    expect(delayLowCurve).toBeLessThanOrEqual(12 * 60 * 60_000);
  });

  it('idle with successful session-start roll transitions to in_session and returns a short first-action gap', () => {
    const mgr = new SessionManager();
    const persona = makePersona();

    // First Math.random() is the session-start roll (needs to be < curveWeight)
    // Second Math.random() picks actionsRemaining within [sizeMin, sizeMax]
    // Third Math.random() is the 5s–30s first-action jitter
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0);
    const delay = mgr.computeNextDelay('a', persona, 1.0);

    const state = mgr.getState('a');
    expect(state.status).toBe('in_session');
    expect(state.actionsRemaining).toBeGreaterThan(0);
    expect(state.sessionStartedAt).toBe(Date.now());

    expect(delay).toBeGreaterThanOrEqual(FIRST_ACTION_MIN);
    expect(delay).toBeLessThanOrEqual(FIRST_ACTION_MAX);
  });

  it('idle with failed session-start roll stays idle and returns a retry gap', () => {
    const mgr = new SessionManager();
    const persona = makePersona();

    // random=0.99 > curveWeight=0.1, so roll fails.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const delay = mgr.computeNextDelay('a', persona, 0.1);

    expect(mgr.getState('a').status).toBe('idle');
    expect(mgr.getState('a').actionsRemaining).toBe(0);
    expect(delay).toBeGreaterThanOrEqual(IDLE_RETRY_GAP_MIN);
    expect(delay).toBeLessThanOrEqual(IDLE_RETRY_GAP_MAX);
  });

  it('honors persona.sessionSize override — forces the session count into the override range', () => {
    const mgr = new SessionManager();
    const persona = makePersona({ sessionSize: [1, 2] });

    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0);
    mgr.computeNextDelay('a', persona, 1.0);
    const state = mgr.getState('a');
    // With sessionSize [1,2] and random=0 → randomInt picks 1; the idle→session
    // transition treats the tick that triggered it as the first session
    // action, so actionsRemaining is stored as N-1 = 0. One total action fires.
    expect(state.actionsRemaining).toBe(0);

    // With random=0.999 → randomInt picks 2, so one additional action
    // remains after the triggering tick.
    randomSpy.mockReturnValue(0.999);
    const s2 = mgr.getState('b');
    s2.status = 'idle';
    mgr.computeNextDelay('b', persona, 1.0);
    expect(mgr.getState('b').actionsRemaining).toBe(1);
  });

  it('honors persona.idleGapMs override — idle gap shifts to the override range', () => {
    const mgr = new SessionManager();
    const customMin = 10 * 60_000;
    const customMax = 20 * 60_000;
    const persona = makePersona({ idleGapMs: [customMin, customMax] });

    const state = mgr.getState('a');
    state.status = 'in_session';
    state.actionsRemaining = 0;

    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const delay = mgr.computeNextDelay('a', persona, 1.0);

    // With curveWeight=1.0, scale = 1 → plain override gap.
    expect(delay).toBeGreaterThanOrEqual(customMin);
    expect(delay).toBeLessThanOrEqual(customMax);
  });

  it('injectBonusSession returns true on first call, forces in_session with a small size, sets lastBonusAt', () => {
    const mgr = new SessionManager();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0);

    const before = Date.now();
    const result = mgr.injectBonusSession('a');
    expect(result).toBe(true);

    const s = mgr.getState('a');
    expect(s.status).toBe('in_session');
    // Bonus size range is [2, 4]; random=0 → 2.
    expect(s.actionsRemaining).toBe(2);
    expect(s.sessionStartedAt).toBe(before);
    expect(s.lastBonusAt).toBe(before);
  });

  it('injectBonusSession returns false when called again within cooldown', () => {
    const mgr = new SessionManager();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0);

    expect(mgr.injectBonusSession('a')).toBe(true);
    // Advance by less than cooldown.
    vi.setSystemTime(Date.now() + BONUS_SESSION_COOLDOWN_MS - 1);
    expect(mgr.injectBonusSession('a')).toBe(false);
  });

  it('injectBonusSession returns true again after cooldown window elapses', () => {
    const mgr = new SessionManager();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0);

    expect(mgr.injectBonusSession('a')).toBe(true);
    // Advance past cooldown.
    vi.setSystemTime(Date.now() + BONUS_SESSION_COOLDOWN_MS + 1);
    expect(mgr.injectBonusSession('a')).toBe(true);
  });

  it('injectBonusSession on an in-session agent extends instead of replacing', () => {
    const mgr = new SessionManager();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.0);

    // Seed: idle → in_session with a known action count.
    mgr.computeNextDelay('a', makePersona(), 1.0);
    const beforeCount = mgr.getState('a').actionsRemaining;
    expect(mgr.getState('a').status).toBe('in_session');

    // Inject bonus — should extend (add 1 or 2) not replace.
    const ok = mgr.injectBonusSession('a');
    expect(ok).toBe(true);
    const after = mgr.getState('a');
    expect(after.status).toBe('in_session');
    expect(after.actionsRemaining).toBeGreaterThan(beforeCount);
    expect(after.actionsRemaining - beforeCount).toBeLessThanOrEqual(2);
  });
});
