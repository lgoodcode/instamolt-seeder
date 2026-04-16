/**
 * Session state machine for the continuous engage loop.
 *
 * Models the burst-then-quiet pattern that makes agent activity feel organic:
 * an agent comes online for a session (3–8 actions over 10–30 min with short
 * inter-action gaps), then goes idle for 2–6 hours before the next session.
 *
 * Session state is held **in memory only** — not persisted to disk. If the
 * process restarts, all agents start idle and naturally schedule their first
 * session within minutes. This is intentional: session state is ephemeral
 * pacing, not durable state.
 *
 * The `SessionManager` is consumed by `ActionScheduler.rescheduleAfterTick`
 * to decide the gap between actions:
 *   - In session, actions remaining > 0 → short gap (30s–180s)
 *   - In session, actions remaining = 0 → transition to idle, long gap
 *   - Idle, session-start roll succeeds → transition to in_session
 *   - Idle, roll fails → retry in 30–60 min
 */

import type { Persona } from '@/types';

// ── Defaults ────────────────────────────────────────────────────────────

/** Default session size when persona doesn't override. Tripled from [3, 8] to
 * support higher engagement density — paired with tighter fleet pacing and
 * shorter idle gaps so agents spend more wall-clock time in-session. */
const DEFAULT_SESSION_SIZE: [number, number] = [10, 22];

/** Default idle gap between sessions (ms). Halved from [2h, 6h] → [1h, 3h].
 * Idle gap cap also drops 12h → 6h (applied in computeNextDelay). */
const DEFAULT_IDLE_GAP_MS: [number, number] = [1 * 60 * 60_000, 3 * 60 * 60_000];

/** Maximum idle gap even under off-peak curve scaling. Was 12h; now 6h so
 * low-activity overnight hours still cycle agents through sessions. */
const IDLE_GAP_CAP_MS = 6 * 60 * 60_000;

/** Inter-action gap within a session (ms). Short — the agent is "online." */
const SESSION_ACTION_GAP_MS: [number, number] = [30_000, 180_000]; // 30s–3min

/** Retry gap when an idle agent fails the session-start roll (ms). */
const IDLE_RETRY_GAP_MS: [number, number] = [30 * 60_000, 60 * 60_000]; // 30–60 min

/** Minimum hours between bonus sessions for the same agent. Was 2h; now 30min
 * to match the new higher engagement density. Combined with the per-day cap
 * below this prevents runaway bonus loops on popular (Tier 1) agents. */
const BONUS_SESSION_COOLDOWN_HOURS = 0.5;

/** Hard cap on bonus sessions per agent per rolling 24h window. Prevents
 * compounding bonuses on Tier 1 agents whose posts trigger constant activity
 * momentum triggers. Rolling window, not calendar-day reset. */
const MAX_BONUS_SESSIONS_PER_DAY = 4;
const BONUS_SESSION_WINDOW_MS = 24 * 60 * 60_000;

// ── Types ───────────────────────────────────────────────────────────────

export interface SessionState {
  status: 'idle' | 'in_session';
  /** Actions remaining in the current session. 0 when idle. */
  actionsRemaining: number;
  /** When the current session started (epoch ms). Undefined when idle. */
  sessionStartedAt?: number;
  /** When the last bonus session was injected (epoch ms). Used to enforce
   * the per-agent cooldown that prevents runaway feedback loops. */
  lastBonusAt?: number;
  /** Rolling 24h window of bonus-session timestamps for daily-cap enforcement.
   * Trimmed lazily on each read; capped at MAX_BONUS_SESSIONS_PER_DAY entries. */
  bonusTimestamps?: number[];
}

// ── Session Manager ─────────────────────────────────────────────────────

export class SessionManager {
  private states = new Map<string, SessionState>();

  /** Get or create the state for an agent. New agents start idle. */
  getState(agentname: string): SessionState {
    let s = this.states.get(agentname);
    if (!s) {
      s = { status: 'idle', actionsRemaining: 0 };
      this.states.set(agentname, s);
    }
    return s;
  }

  /**
   * Compute the next-tick delay (ms) for an agent after a tick completes.
   * Manages session transitions internally:
   *
   * 1. **In session, actions remaining:** short gap (30s–3min).
   * 2. **In session, exhausted:** transition to idle, return long idle gap
   *    scaled by the activity curve.
   * 3. **Idle, session-start roll succeeds:** transition to in_session,
   *    return a short gap so the first action fires quickly.
   * 4. **Idle, roll fails:** return a retry gap (30–60 min).
   *
   * `curveWeight` is `persona.activityCurve[currentHour]` — it scales both
   * the session-start probability and the idle gap (shorter during peaks).
   */
  computeNextDelay(agentname: string, persona: Persona, curveWeight: number): number {
    const s = this.getState(agentname);
    const tier = persona.engagementTier ?? 2;
    // Tier 1 agents get bigger sessions (1.4× on both min + max); Tier 3
    // agents shrink to 0.6×. Tier 3 also gets 1.5× longer idle gaps so the
    // long tail stays quiet. Tier 1 idle gap unchanged — momentum bonus sessions
    // (cap 4/day) are the Tier 1 engagement lever, not shorter idle.
    const tierSessionMult = tier === 1 ? 1.4 : tier === 3 ? 0.6 : 1.0;
    const tierIdleMult = tier === 3 ? 1.5 : 1.0;
    const [baseSizeMin, baseSizeMax] = persona.sessionSize ?? DEFAULT_SESSION_SIZE;
    const sizeMin = Math.max(1, Math.round(baseSizeMin * tierSessionMult));
    const sizeMax = Math.max(sizeMin, Math.round(baseSizeMax * tierSessionMult));
    const [baseIdleMin, baseIdleMax] = persona.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
    const idleMin = baseIdleMin * tierIdleMult;
    const idleMax = baseIdleMax * tierIdleMult;

    if (s.status === 'in_session') {
      // Decrement first: we're computing the gap that follows an action
      // that just fired, so this tick counts against the session budget.
      // Transitioning to idle when we reach 0 keeps "3–8 actions per
      // session" accurate end-to-end (without the decrement-last ordering
      // the session scheduled one extra action beyond sizeMax).
      if (s.actionsRemaining > 0) s.actionsRemaining--;
      if (s.actionsRemaining > 0) {
        // Still in session — short gap between actions.
        return randomBetween(...SESSION_ACTION_GAP_MS);
      }
      // Session exhausted — go idle.
      s.status = 'idle';
      s.actionsRemaining = 0;
      s.sessionStartedAt = undefined;
      // Idle gap scaled inversely by curve weight: peak → shorter idle,
      // off-peak → longer idle. Cap prevents a dead overnight agent from
      // vanishing from the scheduler for half a day.
      const scale = 1 / Math.max(curveWeight, 0.05);
      const baseIdle = randomBetween(idleMin, idleMax);
      return Math.min(baseIdle * scale, IDLE_GAP_CAP_MS);
    }

    // Currently idle — roll to start a new session.
    // Probability = curveWeight: peak hours (1.0) almost always start,
    // off-peak (0.1) rarely start, offline (0) never start.
    if (Math.random() < curveWeight) {
      // Start a new session. `computeNextDelay()` runs after an action tick,
      // so the tick that just completed already counts as the first session
      // action — initialize `actionsRemaining` to the remaining count so
      // the session fires exactly [sizeMin, sizeMax] actions total.
      s.status = 'in_session';
      s.actionsRemaining = Math.max(0, randomInt(sizeMin, sizeMax) - 1);
      s.sessionStartedAt = Date.now();
      // Next action in the session fires quickly (5–30s).
      return randomBetween(5_000, 30_000);
    }

    // Roll failed — try again later.
    return randomBetween(...IDLE_RETRY_GAP_MS);
  }

  /**
   * Inject a bonus session for an agent that's receiving high inbound
   * engagement. If the agent is idle, transitions to a small session
   * (4–8 actions). If already in session, extends by 1–2 actions.
   *
   * Three gates (first-match returns false):
   *   1. Per-agent cooldown — one bonus per `BONUS_SESSION_COOLDOWN_HOURS`,
   *      shortened for Tier 1 agents (×1.5 effective rate = cooldown / 1.5)
   *      so the leaderboard-climbing personas can react to momentum faster.
   *   2. Rolling 24h cap — `MAX_BONUS_SESSIONS_PER_DAY` total bonuses in the
   *      last 24h. Applies equally to all tiers — prevents compounding
   *      runaway on Tier 1 agents with constant inbound engagement.
   */
  injectBonusSession(agentname: string, tier: 1 | 2 | 3 = 2): boolean {
    const s = this.getState(agentname);
    const now = Date.now();

    // Gate 1: cooldown check. Tier 1 agents cool down 1.5× faster.
    const cooldownMs = (BONUS_SESSION_COOLDOWN_HOURS * 60 * 60_000) / (tier === 1 ? 1.5 : 1.0);
    if (s.lastBonusAt && now - s.lastBonusAt < cooldownMs) {
      return false;
    }

    // Gate 2: rolling 24h cap. Trim stale entries, then check count.
    const cutoff = now - BONUS_SESSION_WINDOW_MS;
    s.bonusTimestamps = (s.bonusTimestamps ?? []).filter((t) => t >= cutoff);
    if (s.bonusTimestamps.length >= MAX_BONUS_SESSIONS_PER_DAY) {
      return false;
    }

    s.lastBonusAt = now;
    s.bonusTimestamps.push(now);

    if (s.status === 'idle') {
      s.status = 'in_session';
      s.actionsRemaining = randomInt(4, 8);
      s.sessionStartedAt = now;
    } else {
      // Already in session — extend it.
      s.actionsRemaining += randomInt(1, 2);
    }

    return true;
  }

  /** Number of agents currently tracked. */
  size(): number {
    return this.states.size;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
