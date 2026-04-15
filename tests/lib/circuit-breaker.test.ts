import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted event-logger mock — breaker emits circuit_* events, but the test
// only cares about state transitions, not the event stream shape.
const logEventMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/event-logger', () => ({
  logEvent: logEventMock,
}));

import { CircuitAbortError, CircuitBreaker } from '@/lib/circuit-breaker';

/**
 * Drain the microtask queue so pending promise chains can advance. Needed
 * after `vi.advanceTimersByTime` because the wake callback resolves waiters
 * which then re-enter `gate()` on the next microtask.
 */
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeBreaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  const breaker = new CircuitBreaker({
    name: 'test',
    failureThreshold: 3,
    windowMs: 1000,
    coolOffMs: 100,
    maxCoolOffMs: 10_000,
    maxTrips: 3,
    // Drive `now()` from the Vitest fake clock so failure-window pruning and
    // `openUntil` checks stay aligned with `setTimeout` firings.
    now: () => Date.now(),
    ...overrides,
  });
  return { breaker };
}

beforeEach(() => {
  logEventMock.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CircuitBreaker', () => {
  it('starts closed and lets gate() pass through immediately', async () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState()).toBe('closed');
    await expect(breaker.gate()).resolves.toBeUndefined();
  });

  it('throws on invalid options', () => {
    expect(() => makeBreaker({ failureThreshold: 0 })).toThrow(/failureThreshold/);
    expect(() => makeBreaker({ windowMs: 0 })).toThrow(/windowMs/);
    expect(() => makeBreaker({ coolOffMs: 0 })).toThrow(/coolOffMs/);
    expect(() => makeBreaker({ maxCoolOffMs: 50, coolOffMs: 100 })).toThrow(/maxCoolOffMs/);
    expect(() => makeBreaker({ maxTrips: 0 })).toThrow(/maxTrips/);
  });

  it('opens after threshold failures in the window and blocks gate()', async () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.getOpenUntil()).toBe(100);

    let resolved = false;
    const p = breaker.gate().then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);

    // Advance past the cool-off. The wake `setTimeout` fires, wakes the
    // waiter, gate() re-enters and finds the breaker half-open → admits
    // this caller as the probe.
    await vi.advanceTimersByTimeAsync(101);
    await p;
    expect(resolved).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  it('prunes the rolling window so failures outside windowMs do not trip it', async () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    vi.setSystemTime(2000);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
  });

  it('half-open probe success closes the breaker and wakes waiters', async () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    const admitted: number[] = [];
    const p1 = breaker.gate().then(() => admitted.push(1));
    const p2 = breaker.gate().then(() => admitted.push(2));
    await flush();
    expect(admitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(101);
    await p1;
    expect(admitted).toEqual([1]);
    expect(breaker.getState()).toBe('half-open');

    breaker.recordSuccess();
    await p2;
    expect(admitted).toEqual([1, 2]);
    expect(breaker.getState()).toBe('closed');
  });

  it('half-open probe failure re-opens with doubled cool-off', async () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getOpenUntil()).toBe(100);

    await vi.advanceTimersByTimeAsync(101);
    await breaker.gate();
    expect(breaker.getState()).toBe('half-open');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    // Cool-off doubled from 100 → 200; openUntil = now(101) + 200.
    expect(breaker.getOpenUntil()).toBe(101 + 200);
  });

  it('honors the server Retry-After when larger than the current cool-off', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure(500);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getOpenUntil()).toBe(500);
  });

  it('aborts after maxTrips consecutive re-opens without a success', async () => {
    const { breaker } = makeBreaker({ maxTrips: 2 });
    // Trip 1.
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    await vi.advanceTimersByTimeAsync(101);
    await breaker.gate();
    // Trip 2 — re-open at doubled cool-off; state back to open, trips=2.
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    await vi.advanceTimersByTimeAsync(500);
    await breaker.gate();
    // Trip 3 would exceed maxTrips → abort latches.
    breaker.recordFailure();
    expect(breaker.getOpenUntil()).toBe(Number.POSITIVE_INFINITY);

    await expect(breaker.gate()).rejects.toBeInstanceOf(CircuitAbortError);
  });

  it('caps cool-off at maxCoolOffMs on repeated trips', async () => {
    const { breaker } = makeBreaker({
      coolOffMs: 100,
      maxCoolOffMs: 300,
      maxTrips: 10,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getOpenUntil()).toBe(100);

    await vi.advanceTimersByTimeAsync(101);
    await breaker.gate();
    breaker.recordFailure(); // re-trip → 200ms
    expect(breaker.getOpenUntil()).toBe(101 + 200);

    await vi.advanceTimersByTimeAsync(500);
    await breaker.gate();
    breaker.recordFailure(); // re-trip → clamped at 300ms
    expect(breaker.getOpenUntil()).toBe(101 + 500 + 300);

    await vi.advanceTimersByTimeAsync(500);
    await breaker.gate();
    breaker.recordFailure(); // still 300ms (capped)
    expect(breaker.getOpenUntil()).toBe(101 + 500 + 500 + 300);
  });

  it('emits circuit_* events on state transitions', async () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'circuit_opened' }),
    );

    await vi.advanceTimersByTimeAsync(101);
    await breaker.gate();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'circuit_half_open' }),
    );

    breaker.recordSuccess();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'circuit_closed' }),
    );
  });
});
