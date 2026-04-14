/**
 * Tiny bounded-concurrency helper. Runs `worker` over every item in `items`
 * with at most `concurrency` in flight at once, preserving result order.
 *
 * Use this instead of `Promise.all(items.map(worker))` whenever the worker
 * calls something rate-limited (Gemini, the platform API, MCP subprocesses)
 * and you want a hard ceiling on parallel requests.
 *
 * Worker rejections propagate: the first rejection trips an abort flag so
 * other workers stop pulling new items from the cursor, then the helper
 * rejects once the in-flight workers settle. If you want per-item fault
 * isolation, catch inside the worker and return a result type.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => R | Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) throw new Error(`concurrency must be >= 1, got ${concurrency}`);

  const results: R[] = new Array(items.length);
  let cursor = 0;
  let aborted = false;
  // `hasError` (separate from `firstError`) so that a worker doing
  // `throw undefined` (legal in JS) still propagates — checking
  // `firstError !== undefined` would treat that case as "no error" and
  // silently resolve with a partially-filled result array.
  let hasError = false;
  let firstError: unknown;

  async function runWorker(): Promise<void> {
    while (!aborted) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index] as T, index);
      } catch (err) {
        aborted = true;
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.allSettled(workers);
  if (hasError) throw firstError;
  return results;
}
