/**
 * Priority-queue scheduler for the continuous engage loop.
 *
 * Each registered agent is assigned a `nextTickAt` timestamp — the soonest
 * moment the scheduler should fire an action for that agent. The scheduler
 * is a min-heap keyed by `nextTickAt`, so `pop()` always returns the most
 * overdue (or soonest-due) agent. After each tick, `rescheduleAfterTick`
 * computes the agent's next tick based on their total daily action budget
 * (higher budget → shorter interval) with 0.5×–2× jitter.
 *
 * No concurrency, no threads — the scheduler is consumed synchronously by
 * the main loop in `engage-continuous.ts`. It is pure data-structure logic:
 * no I/O, no timers, no async.
 *
 * **Enrollment:** agents are enrolled individually via `enroll()` at startup
 * and during mid-run rescans. Initial jitter spreads the first burst across
 * [0, initialJitterMs] so a 50-agent population doesn't fire 50 actions in
 * the first second.
 *
 * **Quota exhaustion:** when a tick returns nothing-available (all action
 * kinds are at their daily cap), the scheduler reschedules the agent to
 * `now + quotaExhaustedRequeueMs` (default 30 min) so it pauses until some
 * slots age out of the 24h window.
 */

import { getCurrentHour, QUOTA_EXHAUSTED_REQUEUE_MS } from '@/config';
import { SessionManager } from '@/lib/session';
import type { GeneratedAgent, Persona } from '@/types';

export interface ScheduleEntry {
  agentname: string;
  nextTickAt: number;
}

export class ActionScheduler {
  private heap: ScheduleEntry[] = [];
  private agentSet = new Set<string>();
  /** Injected for testing — defaults to `getCurrentHour` from config. */
  private getHour: () => number;
  /** Session state machine — manages burst-then-idle patterns. */
  readonly sessions: SessionManager;

  constructor(
    opts: {
      /** Override the hour-of-day provider (for deterministic tests). */
      getHour?: () => number;
      /** Inject a custom session manager (for tests). */
      sessions?: SessionManager;
    } = {},
  ) {
    this.getHour = opts.getHour ?? getCurrentHour;
    this.sessions = opts.sessions ?? new SessionManager();
  }

  /** Number of agents currently enrolled. */
  size(): number {
    return this.heap.length;
  }

  /** Whether an agent is already in the scheduler. */
  has(agentname: string): boolean {
    return this.agentSet.has(agentname);
  }

  /**
   * Add a new agent to the schedule with an initial jitter. Has no effect
   * if the agent is already enrolled.
   */
  enroll(agent: GeneratedAgent, _persona: Persona, opts: { initialJitterMs?: number } = {}): void {
    if (this.agentSet.has(agent.agentname)) return;
    const jitter = opts.initialJitterMs ?? 5 * 60_000;
    const entry: ScheduleEntry = {
      agentname: agent.agentname,
      nextTickAt: Date.now() + Math.random() * jitter,
    };
    this.agentSet.add(agent.agentname);
    this.pushHeap(entry);
  }

  /**
   * Reschedule an agent after a successful (or skipped) tick. Delegates to
   * the session manager which decides whether the agent stays in-session
   * (short gap) or transitions to idle (long gap). The session manager
   * reads the persona's `activityCurve` for the current hour, so peak
   * hours produce shorter gaps and off-peak hours produce longer ones.
   */
  rescheduleAfterTick(agent: GeneratedAgent, persona: Persona): void {
    const hour = this.getHour();
    const curveWeight = persona.activityCurve[hour] ?? 0.5;
    const delayMs = this.sessions.computeNextDelay(agent.agentname, persona, curveWeight);
    this.pushForAgent(agent.agentname, Date.now() + delayMs);
  }

  /**
   * Inject a bonus session for an agent receiving high inbound engagement.
   * Delegates to the session manager's `injectBonusSession` (which handles
   * cooldown enforcement). If the bonus fires, reschedules the agent's next
   * tick to ~30s from now so the bonus session starts immediately.
   *
   * Returns `true` if the bonus was applied, `false` if on cooldown.
   */
  injectBonusSession(agent: GeneratedAgent): boolean {
    const applied = this.sessions.injectBonusSession(agent.agentname);
    if (applied) {
      // Reschedule soon so the bonus session fires.
      this.pushForAgent(agent.agentname, Date.now() + 30_000 + Math.random() * 30_000);
    }
    return applied;
  }

  /**
   * Reschedule an agent to the next non-zero hour in their activity curve.
   * Used by the offline gate in `engage-continuous.ts` when the current
   * hour's weight is exactly 0. Returns the number of hours skipped for
   * logging.
   */
  rescheduleToNextActiveHour(agent: GeneratedAgent, persona: Persona): number {
    const hour = this.getHour();
    let skip = 1;
    while (skip < 24) {
      const nextHour = (hour + skip) % 24;
      if ((persona.activityCurve[nextHour] ?? 0) > 0) break;
      skip++;
    }
    // Schedule for the start of the next active hour with a small jitter
    // (0-15 min) so agents with the same curve don't all fire at :00.
    // Anchor on the next hour boundary, not on `now`, so a 10:55 tick with
    // skip=1 lands ~11:00 instead of ~11:55 (losing the active hour).
    const nextTick = new Date();
    nextTick.setMinutes(0, 0, 0);
    nextTick.setHours(nextTick.getHours() + skip);
    const jitter = Math.random() * 15 * 60 * 1000;
    this.pushForAgent(agent.agentname, nextTick.getTime() + jitter);
    return skip;
  }

  /**
   * Reschedule an agent far in the future because all action kinds are
   * at their daily cap. Defaults to `QUOTA_EXHAUSTED_REQUEUE_MS` (30 min).
   */
  rescheduleQuotaExhausted(agent: GeneratedAgent): void {
    this.pushForAgent(agent.agentname, Date.now() + QUOTA_EXHAUSTED_REQUEUE_MS);
  }

  /** Peek at the soonest-due entry without removing it. */
  peek(): ScheduleEntry | undefined {
    return this.heap[0];
  }

  /** Pop the soonest-due entry. */
  pop(): ScheduleEntry | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  // --- Internal heap operations ---

  private pushForAgent(agentname: string, nextTickAt: number): void {
    // Remove the existing entry for this agent (if any) by marking and
    // rebuilding. This is O(n) but fine for populations <10k. A more
    // sophisticated approach would use a decrease-key operation.
    this.heap = this.heap.filter((e) => e.agentname !== agentname);
    this.pushHeap({ agentname, nextTickAt });
  }

  private pushHeap(entry: ScheduleEntry): void {
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if ((this.heap[parent]?.nextTickAt ?? 0) <= (this.heap[i]?.nextTickAt ?? 0)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (
        left < n &&
        (this.heap[left]?.nextTickAt ?? Infinity) < (this.heap[smallest]?.nextTickAt ?? Infinity)
      ) {
        smallest = left;
      }
      if (
        right < n &&
        (this.heap[right]?.nextTickAt ?? Infinity) < (this.heap[smallest]?.nextTickAt ?? Infinity)
      ) {
        smallest = right;
      }
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = tmp;
  }
}

// Note: the old `defaultMeanInterval` function (24h / totalDailyActions)
// was removed when the session manager took over tick-delay computation.
// Daily action budgets are now enforced by the quota system (src/lib/quota.ts),
// not by the scheduler's inter-tick interval. The scheduler's role is just
// to determine *when* to check for action availability — the session manager
// handles the rhythm (bursts vs idle) and the activity curve handles the
// time-of-day scaling.
