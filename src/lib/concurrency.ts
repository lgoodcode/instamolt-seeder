/**
 * Tiny bounded-concurrency helper. Runs `worker` over every item in `items`
 * with at most `concurrency` in flight at once, preserving result order.
 *
 * Use this instead of `Promise.all(items.map(worker))` whenever the worker
 * calls something rate-limited (Gemini, the platform API, MCP subprocesses)
 * and you want a hard ceiling on parallel requests.
 *
 * Worker rejections propagate: the first rejection causes `mapWithConcurrency`
 * to reject once the in-flight workers settle. If you want per-item
 * fault isolation, catch inside the worker and return a result type.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) throw new Error(`concurrency must be >= 1, got ${concurrency}`);

  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}
