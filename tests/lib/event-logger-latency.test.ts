import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fs mock mirroring tests/lib/event-logger.test.ts so we can keep
// assertions fully synchronous without touching the real filesystem.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn((path: string, data: string) => {
    fsState.files.set(path, data);
  }),
  readFileSync: vi.fn((path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  mkdirSync: vi.fn((path: string) => {
    fsState.dirs.add(path);
  }),
}));

vi.mock('node:fs/promises', () => ({
  appendFile: vi.fn(async (path: string, data: string) => {
    const existing = fsState.files.get(path) ?? '';
    fsState.files.set(path, existing + data);
  }),
}));

vi.mock('@/config', () => ({
  config: {
    logsDir: '/tmp/test-logs-latency',
    agentsDir: '/tmp/test-agents-latency',
  },
}));

vi.mock('picocolors', () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
  },
}));

import {
  _resetForTest,
  drainWrites,
  getStats,
  initEventLogger,
  logEvent,
  timed,
} from '@/lib/event-logger';

beforeEach(async () => {
  await drainWrites();
  fsState.files.clear();
  fsState.dirs.clear();
  _resetForTest();
});

afterEach(async () => {
  await drainWrites();
  _resetForTest();
});

describe('latency bucket creation', () => {
  it('creates a bucket on the first timed event of that type', () => {
    initEventLogger({ reset: true });
    logEvent({ eventType: 'llm_call', success: true, durationMs: 100 });

    const stats = getStats()!;
    const bucket = stats.latency.llm_call;
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
    expect(bucket!.sumMs).toBe(100);
    expect(bucket!.maxMs).toBe(100);
    expect(bucket!.p50Ms).toBe(100);
    expect(bucket!.p95Ms).toBe(100);
    expect(bucket!.samples).toEqual([100]);
  });

  it('does NOT create a bucket when durationMs is absent', () => {
    initEventLogger({ reset: true });
    logEvent({ eventType: 'llm_call', success: true });
    const stats = getStats()!;
    expect(stats.latency.llm_call).toBeUndefined();
  });

  it('does NOT create a bucket when durationMs is NaN', () => {
    initEventLogger({ reset: true });
    logEvent({
      eventType: 'llm_call',
      success: true,
      durationMs: Number.NaN,
    });
    const stats = getStats()!;
    expect(stats.latency.llm_call).toBeUndefined();
  });

  it('does NOT create a bucket when durationMs is Infinity', () => {
    initEventLogger({ reset: true });
    logEvent({
      eventType: 'llm_call',
      success: true,
      durationMs: Number.POSITIVE_INFINITY,
    });
    const stats = getStats()!;
    expect(stats.latency.llm_call).toBeUndefined();
  });
});

describe('latency aggregation', () => {
  it('aggregates count/sum/max/p50/p95 across multiple samples', () => {
    initEventLogger({ reset: true });
    for (const ms of [10, 20, 30, 40, 50]) {
      logEvent({ eventType: 'llm_call', success: true, durationMs: ms });
    }

    const bucket = getStats()!.latency.llm_call!;
    expect(bucket.count).toBe(5);
    expect(bucket.sumMs).toBe(150);
    expect(bucket.maxMs).toBe(50);
    // floor(5 * 50 / 100) = 2 → sorted[2] = 30
    expect(bucket.p50Ms).toBe(30);
    // floor(5 * 95 / 100) = 4 → sorted[4] = 50
    expect(bucket.p95Ms).toBe(50);
  });

  it('applies sliding FIFO at the 500-sample reservoir cap', () => {
    initEventLogger({ reset: true });
    for (let i = 1; i <= 510; i++) {
      logEvent({ eventType: 'llm_call', success: true, durationMs: i });
    }

    const bucket = getStats()!.latency.llm_call!;
    // count keeps growing beyond the cap — it's the lifetime total
    expect(bucket.count).toBe(510);
    // samples window is capped at 500 with oldest dropped
    expect(bucket.samples.length).toBe(500);
    // Oldest 10 (1..10) dropped; newest is 510.
    expect(bucket.samples[0]).toBe(11);
    expect(bucket.samples[bucket.samples.length - 1]).toBe(510);
    expect(bucket.maxMs).toBe(510);
  });
});

describe('timed() helper', () => {
  it('emits a success event with durationMs and returns the value', async () => {
    initEventLogger({ reset: true });
    const result = await timed('like', { agentname: 'a' }, async () => {
      await new Promise((r) => setTimeout(r, 2));
      return 42;
    });
    expect(result).toBe(42);

    const stats = getStats()!;
    expect(stats.actions.like.success).toBe(1);
    const bucket = stats.latency.like;
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
    expect(bucket!.samples[0]).toBeGreaterThanOrEqual(0);
    expect(bucket!.maxMs).toBeGreaterThanOrEqual(0);
  });

  it('emits a failure event with durationMs and rethrows', async () => {
    initEventLogger({ reset: true });
    const err = new Error('boom');
    const promise = timed('like', { agentname: 'a' }, async () => {
      await new Promise((r) => setTimeout(r, 2));
      throw err;
    });
    await expect(promise).rejects.toBe(err);

    const stats = getStats()!;
    // Failure still contributes to the latency bucket for the event type.
    const bucket = stats.latency.like;
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(1);
    expect(bucket!.samples[0]).toBeGreaterThanOrEqual(0);
    // And it lands in the error bucket, not success.
    expect(stats.actions.like.success).toBe(0);
    expect(stats.actions.like.error).toBe(1);
  });
});
