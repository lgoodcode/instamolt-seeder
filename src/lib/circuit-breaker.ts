/**
 * Adaptive circuit breaker for sustained failure bursts on a protected
 * downstream (Phase B image generation, Phase A.5 avatar generation). The
 * InstaMolt platform's image-generation path has a 50/min fleet cap and a
 * 1/min per-agent cap that the `RATE_LIMIT_BYPASS_SECRET` header does NOT
 * cover (see CLAUDE.md + docs/CODEX.md §7) — saturation manifests as waves
 * of 429 `RATE_LIMIT_EXCEEDED` + 502 `GENERATION_FAILED` responses.
 *
 * States:
 *   closed     — protected calls pass through; failures are counted in a
 *                rolling window and trip the breaker when they exceed
 *                `failureThreshold` within `windowMs`.
 *   open       — protected calls block inside `gate()` until the cool-off
 *                elapses. Cool-off starts at `coolOffMs` (or the largest
 *                `retry_after` observed from recent failures, whichever is
 *                larger) and doubles on each successive re-open, capped at
 *                `maxCoolOffMs`.
 *   half-open  — exactly one caller is admitted as a probe; the rest keep
 *                waiting. Probe success closes the breaker; probe failure
 *                re-opens it and increments the trip counter.
 *
 * After `maxTrips` consecutive trips without a success between them, the
 * breaker latches permanently open and `gate()` rejects with a
 * {@link CircuitAbortError} so the caller can abort the phase cleanly
 * instead of churning forever.
 *
 * The breaker is transport-agnostic: callers decide which errors count as
 * failures via the `shouldTrip(err)` predicate. The only shared assumption
 * is that a caller-supplied `retryAfterMs` override (extracted from an
 * `InstaMoltApiError.retryAfterMs` or a `retry_after` body field) is used
 * verbatim when larger than the current cool-off.
 */

import { logEvent } from '@/lib/event-logger';

export class CircuitAbortError extends Error {
  constructor(
    readonly breakerName: string,
    readonly trips: number,
  ) {
    super(`Circuit "${breakerName}" aborted after ${trips} consecutive trips`);
    this.name = 'CircuitAbortError';
  }
}

export interface CircuitBreakerOptions {
  /** Label used in log events (`circuit_opened`, etc.). */
  name: string;
  /** Failures in the rolling window that trip the breaker. */
  failureThreshold: number;
  /** Size of the rolling failure window in ms. */
  windowMs: number;
  /** Initial cool-off before the breaker moves to half-open. */
  coolOffMs: number;
  /** Upper bound on the exponential cool-off. */
  maxCoolOffMs: number;
  /**
   * Max consecutive trips (open → half-open → open with zero successes in
   * between) before the breaker latches and `gate()` throws
   * {@link CircuitAbortError}.
   */
  maxTrips: number;
  /**
   * Current time source. Injectable so tests can drive the breaker with
   * vitest fake timers instead of waiting real milliseconds.
   */
  now?: () => number;
}

type State = 'closed' | 'open' | 'half-open';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class CircuitBreaker {
  private state: State = 'closed';
  /**
   * Permanently latched after `maxTrips` is exceeded. Set once and never
   * cleared — `gate()` short-circuits with `CircuitAbortError` for every
   * subsequent caller instead of falling into the wait queue.
   */
  private latched = false;
  private failureTimestamps: number[] = [];
  /** Largest `retry_after` (ms) observed since the last state transition. */
  private maxRetryAfterMs = 0;
  /** Consecutive trip count; reset on any success. */
  private trips = 0;
  /** Current cool-off duration; doubles on re-open, capped at maxCoolOffMs. */
  private currentCoolOffMs: number;
  /** Absolute time at which the open window ends. */
  private openUntil = 0;
  /** Callers blocked in `gate()` while state is open. */
  private waiters: Waiter[] = [];
  /** Whether a probe has been admitted from the current half-open window. */
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    if (opts.failureThreshold < 1) throw new Error('failureThreshold must be >= 1');
    if (opts.windowMs < 1) throw new Error('windowMs must be >= 1');
    if (opts.coolOffMs < 1) throw new Error('coolOffMs must be >= 1');
    if (opts.maxCoolOffMs < opts.coolOffMs) {
      throw new Error('maxCoolOffMs must be >= coolOffMs');
    }
    if (opts.maxTrips < 1) throw new Error('maxTrips must be >= 1');
    this.currentCoolOffMs = opts.coolOffMs;
    this.now = opts.now ?? Date.now;
  }

  /** Current state — exposed for tests + operator-facing UI. */
  getState(): State {
    return this.state;
  }

  /** Absolute epoch (ms) the breaker re-probes at. Zero when closed. */
  getOpenUntil(): number {
    return this.openUntil;
  }

  /**
   * Await this before every protected call. Returns immediately when closed
   * or when admitted as the half-open probe; otherwise blocks until the
   * cool-off elapses. Throws {@link CircuitAbortError} after
   * `maxTrips` consecutive trips.
   */
  async gate(): Promise<void> {
    if (this.latched) {
      throw new CircuitAbortError(this.opts.name, this.trips);
    }
    // Fast path: breaker is closed → immediate pass-through.
    if (this.state === 'closed') return;

    // If the caller arrives after `openUntil` has already passed, flip to
    // half-open lazily. A single synchronous `gate()` call handles the
    // entire open-window expiry so the breaker doesn't need a background
    // timer to advance state.
    if (this.state === 'open' && this.now() >= this.openUntil) {
      this.enterHalfOpen();
    }

    if (this.state === 'half-open' && !this.probeInFlight) {
      this.probeInFlight = true;
      return;
    }

    // Either still open, or half-open with a probe already in flight.
    // Block the caller until the next state transition.
    await this.waitForGate();
    // Re-enter recursively — after wakeup the state may be closed (probe
    // succeeded), open again (probe failed), or half-open (another probe
    // slot opened for this caller). A tail-recursive re-check keeps the
    // transition logic in one place.
    return this.gate();
  }

  /**
   * Record a successful call on the protected resource. In `closed` state
   * this is a cheap no-op beyond draining the rolling window; in
   * `half-open` it closes the breaker and wakes every pending waiter.
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.close();
      return;
    }
    // In closed state, a success alone doesn't prune the window — the next
    // failure's lazy prune handles that. Keeping the window intact means a
    // `success, failure, success, failure, …` pattern still accumulates
    // failures toward the threshold, which is the desired behavior.
  }

  /**
   * Record a failure on the protected resource. `retryAfterMs` is optional
   * and only used when it's larger than the current cool-off — a server
   * `Retry-After: 60` after the breaker has already set a 90s cool-off
   * shouldn't shorten the wait.
   */
  recordFailure(retryAfterMs?: number): void {
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.maxRetryAfterMs = Math.max(this.maxRetryAfterMs, retryAfterMs);
    }

    if (this.state === 'half-open') {
      this.open();
      return;
    }

    if (this.state === 'open') {
      // A failure during an open window (from a caller that slipped through
      // before the breaker flipped, or from the probe racing with another
      // failed call) still contributes its Retry-After but doesn't
      // re-transition the state.
      return;
    }

    const now = this.now();
    // Lazy-prune the rolling window: drop any timestamps older than windowMs.
    const cutoff = now - this.opts.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
    this.failureTimestamps.push(now);

    if (this.failureTimestamps.length >= this.opts.failureThreshold) {
      this.open();
    }
  }

  /** Flip to open. Schedules an automatic re-probe via a one-shot timer. */
  private open(): void {
    if (this.trips >= this.opts.maxTrips) {
      // Already at the trip ceiling — latch and reject every waiter so the
      // caller can abort the phase.
      this.abort();
      return;
    }
    this.trips++;
    const wasClosed = this.state === 'closed';
    this.state = 'open';
    // On a half-open → open re-trip, double the cool-off. Stays clamped at
    // maxCoolOffMs so we never pause past what the operator authorized.
    if (!wasClosed) {
      this.currentCoolOffMs = Math.min(this.currentCoolOffMs * 2, this.opts.maxCoolOffMs);
    } else {
      this.currentCoolOffMs = this.opts.coolOffMs;
    }
    const coolOff = Math.max(this.currentCoolOffMs, this.maxRetryAfterMs);
    this.openUntil = this.now() + coolOff;
    this.probeInFlight = false;
    this.failureTimestamps = [];
    this.maxRetryAfterMs = 0;

    logEvent({
      eventType: 'circuit_opened',
      success: false,
      details: {
        name: this.opts.name,
        trips: this.trips,
        coolOffMs: coolOff,
        openUntil: this.openUntil,
      },
    });

    // Schedule a one-shot wake — every waiter gets rechecked via gate()
    // recursion, so the timer just kicks the queue; the state machine
    // itself does the heavy lifting. `setTimeout` + Vitest fake timers pair
    // together natively, so tests can drive the wake via `vi.advanceTimersByTime`
    // without needing a custom sleep injector.
    setTimeout(() => this.wakeAllWaiters(), coolOff);
  }

  private enterHalfOpen(): void {
    this.state = 'half-open';
    this.probeInFlight = false;
    logEvent({
      eventType: 'circuit_half_open',
      success: true,
      details: { name: this.opts.name, trips: this.trips },
    });
  }

  private close(): void {
    // Capture trips before the reset so the emitted event carries the
    // trip-count that survived; matches the `{ trips }` shape documented on
    // SeederEventType.
    const priorTrips = this.trips;
    this.state = 'closed';
    this.trips = 0;
    this.currentCoolOffMs = this.opts.coolOffMs;
    this.openUntil = 0;
    this.probeInFlight = false;
    this.failureTimestamps = [];
    this.maxRetryAfterMs = 0;
    logEvent({
      eventType: 'circuit_closed',
      success: true,
      details: { name: this.opts.name, trips: priorTrips },
    });
    this.wakeAllWaiters();
  }

  private abort(): void {
    this.latched = true;
    this.state = 'open';
    this.openUntil = Number.POSITIVE_INFINITY;
    const err = new CircuitAbortError(this.opts.name, this.trips);
    logEvent({
      eventType: 'circuit_aborted',
      success: false,
      error: err.message,
      details: { name: this.opts.name, trips: this.trips },
    });
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  private wakeAllWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
  }

  private waitForGate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
