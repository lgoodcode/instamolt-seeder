import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to override `config.logsDir` per-test so writes go to an isolated
// temp directory. The config module uses property getters for env-backed
// fields but `logsDir` is a plain property — we just override it at runtime.
import { config } from '@/config';
import {
  appendGlobalComment,
  RUNTIME_GLOBAL_LOG_FILENAME,
  recentRegistersForPost,
} from '@/lib/runtime-global-log';

let originalLogsDir: string;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'runtime-global-log-test-'));
  originalLogsDir = config.logsDir;
  config.logsDir = tempDir;
});

afterEach(async () => {
  config.logsDir = originalLogsDir;
  await rm(tempDir, { recursive: true, force: true });
});

describe('appendGlobalComment + recentRegistersForPost', () => {
  it('returns an empty array when the log file does not exist yet', async () => {
    const registers = await recentRegistersForPost('post_a', 30 * 60_000);
    expect(registers).toEqual([]);
  });

  it('round-trips a single comment entry', async () => {
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'alpha',
      register: 'disagree',
      kind: 'comment',
    });

    const registers = await recentRegistersForPost('post_a', 60_000);
    expect(registers).toEqual(['disagree']);
  });

  it('filters to the matching postId', async () => {
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'alpha',
      register: 'disagree',
      kind: 'comment',
    });
    await appendGlobalComment({
      postId: 'post_b',
      agentname: 'beta',
      register: 'love',
      kind: 'comment',
    });
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'gamma',
      register: 'conversational',
      kind: 'comment',
    });

    const a = await recentRegistersForPost('post_a', 60_000);
    expect(a.sort()).toEqual(['conversational', 'disagree']);

    const b = await recentRegistersForPost('post_b', 60_000);
    expect(b).toEqual(['love']);
  });

  it('drops unclassified entries (no register) from the result', async () => {
    // Reply entries have no register hint — they should flow through but
    // never count toward the cap query.
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'alpha',
      kind: 'reply',
    });
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'beta',
      register: 'love',
      kind: 'comment',
    });

    const registers = await recentRegistersForPost('post_a', 60_000);
    expect(registers).toEqual(['love']);
  });

  it('filters out entries older than the window', async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now - 60 * 60_000)); // 1h ago

    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'alpha',
      register: 'disagree',
      kind: 'comment',
    });

    vi.setSystemTime(new Date(now));
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'beta',
      register: 'love',
      kind: 'comment',
    });

    // 30-minute window: only the second (fresh) entry should land.
    const registers = await recentRegistersForPost('post_a', 30 * 60_000, now);
    expect(registers).toEqual(['love']);

    // 2-hour window: both land.
    const both = await recentRegistersForPost('post_a', 2 * 60 * 60_000, now);
    expect(both.sort()).toEqual(['disagree', 'love']);

    vi.useRealTimers();
  });

  it('tolerates malformed lines without throwing', async () => {
    // Simulate partial writes / human edits by writing raw malformed JSONL
    // alongside a valid entry.
    const { appendFile, mkdir } = await import('node:fs/promises');
    await mkdir(tempDir, { recursive: true });
    const path = join(tempDir, RUNTIME_GLOBAL_LOG_FILENAME);
    await appendFile(path, 'not-valid-json\n', 'utf-8');
    await appendGlobalComment({
      postId: 'post_a',
      agentname: 'alpha',
      register: 'disagree',
      kind: 'comment',
    });
    await appendFile(path, '{"incomplete":\n', 'utf-8');

    const registers = await recentRegistersForPost('post_a', 60_000);
    expect(registers).toEqual(['disagree']);
  });
});
