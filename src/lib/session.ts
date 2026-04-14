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

/** Default session size when persona doesn't override. */
const DEFAULT_SESSION_SIZE: [number, number] = [3, 8];

/** Default idle gap between sessions (ms) when persona doesn't override. */
const DEFAULT_IDLE_GAP_MS: [number, number] = [2 * 60 * 60_000, 6 * 60 * 60_000]; // 2–6 hours

/** Inter-action gap within a session (ms). Short — the agent is "online." */
const SESSION_ACTION_GAP_MS: [number, number] = [30_000, 180_000]; // 30s–3min

/** Retry gap when an idle agent fails the session-start roll (ms). */
const IDLE_RETRY_GAP_MS: [number, number] = [30 * 60_000, 60 * 60_000]; // 30–60 min

/** Minimum hours between bonus sessions for the same agent. */
const BONUS_SESSION_COOLDOWN_HOURS = 2;

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
    const [sizeMin, sizeMax] = persona.sessionSize ?? DEFAULT_SESSION_SIZE;
    const [idleMin, idleMax] = persona.idleGapMs ?? DEFAULT_IDLE_GAP_MS;

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
      // off-peak → longer idle.
      const scale = 1 / Math.max(curveWeight, 0.05);
      const baseIdle = randomBetween(idleMin, idleMax);
      return Math.min(baseIdle * scale, 12 * 60 * 60_000); // cap at 12h
    }

    // Currently idle — roll to start a new session.
    // Probability = curveWeight: peak hours (1.0) almost always start,
    // off-peak (0.1) rarely start, offline (0) never start.
    if (Math.random() < curveWeight) {
      // Start a new session.
      s.status = 'in_session';
      s.actionsRemaining = randomInt(sizeMin, sizeMax);
      s.sessionStartedAt = Date.now();
      // First action in the session fires quickly (5–30s).
      return randomBetween(5_000, 30_000);
    }

    // Roll failed — try again later.
    return randomBetween(...IDLE_RETRY_GAP_MS);
  }

  /**
   * Inject a bonus session for an agent that's receiving high inbound
   * engagement. If the agent is idle, transitions to a small session
   * (2–4 actions). If already in session, extends by 1–2 actions.
   *
   * Returns `true` if the bonus was applied, `false` if on cooldown.
   * Rate-limited to one bonus per `BONUS_SESSION_COOLDOWN_HOURS`.
   */
  injectBonusSession(agentname: string): boolean {
    const s = this.getState(agentname);
    const now = Date.now();

    // Cooldown check.
    if (s.lastBonusAt && now - s.lastBonusAt < BONUS_SESSION_COOLDOWN_HOURS * 60 * 60_000) {
      return false;
    }

    s.lastBonusAt = now;

    if (s.status === 'idle') {
      s.status = 'in_session';
      s.actionsRemaining = randomInt(2, 4);
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
