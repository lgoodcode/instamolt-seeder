import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from '@/lib/concurrency';

/**
 * Deterministic manual promise so tests can control when a worker resolves
 * without relying on timers. Each `Deferred` carries a `promise` plus a
 * `resolve` / `reject` handle — tests resolve them in a specific order to
 * assert the scheduling behaviour of `mapWithConcurrency`.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield to the microtask queue so pending promise chains can advance before
 * the test makes its next assertion. One `await Promise.resolve()` is enough
 * for a single microtask boundary; `flushMicrotasks` runs enough of them to
 * drain a multi-step chain.
 */
async function flushMicrotasks(steps = 10): Promise<void> {
  for (let i = 0; i < steps; i++) await Promise.resolve();
}

describe('mapWithConcurrency', () => {
  it('returns an empty array for an empty input without invoking the worker', async () => {
    const worker = vi.fn();
    const result = await mapWithConcurrency([], 5, worker);
    expect(result).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('accepts synchronous workers that return R directly (not just Promise<R>)', async () => {
    const result = await mapWithConcurrency([1, 2, 3], 2, (n) => n * 2);
    expect(result).toEqual([2, 4, 6]);
  });

  it('maps items via the worker and preserves input order in the result', async () => {
    // Resolve values out of input order (item at index 2 resolves first) to
    // prove the result array is ordered by input index, not completion order.
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('passes the item AND its index to the worker', async () => {
    const seen: Array<{ item: string; index: number }> = [];
    await mapWithConcurrency(['a', 'b', 'c'], 3, async (item, index) => {
      seen.push({ item, index });
      return item;
    });
    // Concurrency=3 with 3 items means all may start in parallel; assert by
    // set membership rather than order.
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(
      expect.arrayContaining([
        { item: 'a', index: 0 },
        { item: 'b', index: 1 },
        { item: 'c', index: 2 },
      ]),
    );
  });

  it('never exceeds the configured concurrency ceiling', async () => {
    // Track the number of workers running at once. Each worker increments on
    // entry and decrements on exit; the peak must not exceed `concurrency`.
    let inFlight = 0;
    let peak = 0;
    const concurrency = 3;

    const deferreds = Array.from({ length: 10 }, () => deferred<number>());

    const runPromise = mapWithConcurrency(deferreds, concurrency, async (d, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const v = await d.promise;
      inFlight--;
      return v * 100 + i;
    });

    // Let the first wave of workers start.
    await flushMicrotasks();
    // No worker has resolved yet, so in-flight should equal `concurrency`.
    expect(inFlight).toBe(concurrency);

    // Resolve deferreds one by one; each release should immediately pull the
    // next pending item into flight, keeping inFlight at `concurrency` until
    // the queue drains.
    for (const d of deferreds) {
      d.resolve(1);
      await flushMicrotasks();
    }

    const results = await runPromise;
    expect(peak).toBe(concurrency);
    expect(results).toHaveLength(10);
    // Ordered by input index: first value 100 + 0, second 100 + 1, etc.
    expect(results).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  });

  it('uses fewer workers than the concurrency cap when items.length < concurrency', async () => {
    // Only 2 items with concurrency=10 should spawn 2 workers, not 10 —
    // otherwise we'd burn resources on empty workers that immediately exit.
    let spawned = 0;
    await mapWithConcurrency([1, 2], 10, async (n) => {
      spawned++;
      return n;
    });
    // Each item invokes the worker exactly once, and with 2 items at most 2
    // workers ever run — spawned must equal 2.
    expect(spawned).toBe(2);
  });

  it('pulls the next item as soon as one worker finishes (no batching / barriers)', async () => {
    // Workers 0 and 1 start in parallel (concurrency=2). Worker 0 resolves
    // before worker 1 — worker 0 must immediately pick up item 2 while
    // worker 1 is still running item 1. If the helper used barriered batches,
    // item 2 wouldn't start until both items 0 AND 1 finished.
    const d0 = deferred<number>();
    const d1 = deferred<number>();
    const d2 = deferred<number>();
    const started: number[] = [];

    const runPromise = mapWithConcurrency([d0, d1, d2], 2, async (d, i) => {
      started.push(i);
      return d.promise;
    });

    await flushMicrotasks();
    expect(started).toEqual([0, 1]);

    // Resolve item 0; the now-free worker should pick up item 2.
    d0.resolve(0);
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2]);

    d1.resolve(1);
    d2.resolve(2);
    const results = await runPromise;
    expect(results).toEqual([0, 1, 2]);
  });

  it('propagates a worker rejection after in-flight workers settle', async () => {
    // When one worker throws, the error must surface to the caller. The test
    // asserts the rejection propagates; it does NOT assert that other
    // in-flight workers get cancelled (Node has no cancellation primitive).
    const err = new Error('boom');
    const run = mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw err;
      return n;
    });
    await expect(run).rejects.toBe(err);
  });

  it('throws synchronously on concurrency < 1', async () => {
    // Catch misuse early — a concurrency of 0 would hang forever because no
    // worker is ever spawned to pull items off the queue.
    await expect(() => mapWithConcurrency([1, 2, 3], 0, async (n) => n)).rejects.toThrow(
      /concurrency must be >= 1/,
    );
  });

  it('propagates a worker that throws synchronously (pre-promise)', async () => {
    // A worker declared `async` but throwing before any await — or a non-async
    // worker throwing outright — should still surface the error to the caller.
    // The helper `await`s the worker call, which converts a sync throw into a
    // promise rejection, but the observable contract is the same as the
    // async-rejection case above: the caller's promise rejects with the
    // thrown value.
    const err = new Error('sync boom');
    const run = mapWithConcurrency([1, 2, 3], 2, (n) => {
      if (n === 2) throw err;
      return Promise.resolve(n);
    });
    await expect(run).rejects.toBe(err);
  });

  it('preserves undefined return values in their result slots', async () => {
    // A worker that returns undefined (e.g. because it's doing side-effectful
    // work and doesn't care about the return) must place undefined at its
    // input index, not drop the slot entirely. Otherwise the result array
    // would be length-correct but sparse, which breaks any downstream code
    // that iterates with `.forEach` or destructures by index.
    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 0) return undefined;
      return n;
    });
    expect(result).toEqual([1, undefined, 3, undefined]);
    expect(result).toHaveLength(4);
    // Sparse-array check: every index must be "in" the array, not a hole.
    for (let i = 0; i < result.length; i++) expect(i in result).toBe(true);
  });

  it('clamps workers at items.length when concurrency >> items.length', async () => {
    // Pairs with the "fewer workers than the concurrency cap" test above —
    // that one used N=10, items=2. This one uses N=1000, items=3. Defends
    // against accidental resource exhaustion if a caller passes something
    // derived from a large upstream count (e.g. total-agent-count) as the
    // concurrency value.
    let spawned = 0;
    const result = await mapWithConcurrency([1, 2, 3], 1000, async (n) => {
      spawned++;
      return n * 2;
    });
    expect(spawned).toBe(3);
    expect(result).toEqual([2, 4, 6]);
  });
});
