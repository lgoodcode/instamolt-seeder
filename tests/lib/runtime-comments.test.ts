import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; content: string }>,
  failNextWrite: false,
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    if (fsState.failNextWrite) {
      fsState.failNextWrite = false;
      throw new Error('disk full');
    }
    fsState.files.set(path, content);
    fsState.writes.push({ path, content });
  }),
}));

const logMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ log: logMock }));

import { config } from '@/config';
import {
  appendRuntimeComment,
  loadPriorComments,
  loadRuntimeCommentsFile,
  RUNTIME_COMMENTS_MAX,
} from '@/lib/runtime-comments';
import type { RuntimeCommentsFile } from '@/types';

function runtimePath(agentname: string): string {
  return join(config.agentsDir, agentname, 'runtime-comments.json');
}

describe('runtime-comments', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.writes.length = 0;
    fsState.failNextWrite = false;
    logMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadRuntimeCommentsFile', () => {
    it('returns an empty file when the path is missing (no throw)', async () => {
      const result = await loadRuntimeCommentsFile('ghost');
      expect(result).toEqual({ agentname: 'ghost', comments: [] });
    });

    it('returns an empty file when JSON is corrupt (no throw)', async () => {
      fsState.files.set(runtimePath('alice'), 'not-json{');
      const result = await loadRuntimeCommentsFile('alice');
      expect(result).toEqual({ agentname: 'alice', comments: [] });
    });

    it('returns an empty comments[] when the parsed file lacks a comments array', async () => {
      fsState.files.set(runtimePath('alice'), JSON.stringify({ agentname: 'alice' }));
      const result = await loadRuntimeCommentsFile('alice');
      expect(result.comments).toEqual([]);
    });

    it('round-trips append + read in chronological order', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-13T10:00:00Z'));

      await appendRuntimeComment('alice', { text: 'first' });
      vi.setSystemTime(new Date('2026-04-13T10:01:00Z'));
      await appendRuntimeComment('alice', { text: 'second' });
      vi.setSystemTime(new Date('2026-04-13T10:02:00Z'));
      await appendRuntimeComment('alice', { text: 'third' });

      const result = await loadRuntimeCommentsFile('alice');
      expect(result.comments.map((c) => c.text)).toEqual(['first', 'second', 'third']);
      // generatedAt stamped on each.
      expect(result.comments[0].generatedAt).toBe('2026-04-13T10:00:00.000Z');
      expect(result.comments[2].generatedAt).toBe('2026-04-13T10:02:00.000Z');
    });
  });

  describe('appendRuntimeComment cap behavior', () => {
    it('caps at RUNTIME_COMMENTS_MAX — appending 60 entries keeps exactly 50, trimming the oldest', async () => {
      expect(RUNTIME_COMMENTS_MAX).toBe(50);

      for (let i = 0; i < 60; i++) {
        await appendRuntimeComment('alice', { text: `entry-${i}` });
      }

      const result = await loadRuntimeCommentsFile('alice');
      expect(result.comments).toHaveLength(50);
      // Oldest 10 trimmed → first surviving entry is index 10.
      expect(result.comments[0].text).toBe('entry-10');
      expect(result.comments[49].text).toBe('entry-59');
    });

    it('preserves optional fields (parentCommentId, depth, repliedToActivityId)', async () => {
      await appendRuntimeComment('alice', {
        text: 'reply text',
        postId: 'post-1',
        parentCommentId: 'comment-99',
        depth: 1,
        repliedToActivityId: 'act-42',
      });

      const raw = fsState.files.get(runtimePath('alice'));
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!) as RuntimeCommentsFile;
      expect(parsed.comments[0]).toMatchObject({
        text: 'reply text',
        postId: 'post-1',
        parentCommentId: 'comment-99',
        depth: 1,
        repliedToActivityId: 'act-42',
      });
    });

    it('logs a warning when writeFile fails but does not throw', async () => {
      fsState.failNextWrite = true;
      await expect(appendRuntimeComment('alice', { text: 'hi' })).resolves.toBeUndefined();
      expect(logMock).toHaveBeenCalled();
      const warnCall = logMock.mock.calls.find((args) => args[0] === 'warn');
      expect(warnCall).toBeDefined();
      expect(String(warnCall?.[1])).toContain('runtime-comments');
    });
  });

  describe('loadPriorComments', () => {
    it('returns empty when both files are missing', async () => {
      const result = await loadPriorComments('ghost');
      expect(result).toEqual([]);
    });

    it('returns bake-time samples first, then runtime tail', async () => {
      fsState.files.set(
        join(config.agentsDir, 'alice', 'comments.json'),
        JSON.stringify({
          agentname: 'alice',
          generatedAt: '2026-01-01T00:00:00Z',
          samples: [
            {
              sourceCaption: 'c1',
              sourceAuthor: 'a1',
              text: 'bake-1',
              generatedAt: '2026-01-01T00:00:00Z',
            },
            {
              sourceCaption: 'c2',
              sourceAuthor: 'a2',
              text: 'bake-2',
              generatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );
      fsState.files.set(
        runtimePath('alice'),
        JSON.stringify({
          agentname: 'alice',
          comments: [
            { text: 'runtime-1', generatedAt: '2026-04-13T10:00:00Z' },
            { text: 'runtime-2', generatedAt: '2026-04-13T10:01:00Z' },
          ],
        }),
      );

      const result = await loadPriorComments('alice');
      expect(result).toEqual(['bake-1', 'bake-2', 'runtime-1', 'runtime-2']);
    });

    it('skips empty-string and non-string entries gracefully', async () => {
      fsState.files.set(
        runtimePath('alice'),
        JSON.stringify({
          agentname: 'alice',
          comments: [
            { text: '', generatedAt: '2026-04-13T10:00:00Z' },
            { text: 'valid', generatedAt: '2026-04-13T10:00:00Z' },
            { generatedAt: '2026-04-13T10:00:00Z' },
            null,
          ],
        }),
      );

      const result = await loadPriorComments('alice');
      expect(result).toEqual(['valid']);
    });

    it('returns empty on corrupt files (no throw)', async () => {
      fsState.files.set(join(config.agentsDir, 'alice', 'comments.json'), 'garbage');
      fsState.files.set(runtimePath('alice'), 'also garbage');
      const result = await loadPriorComments('alice');
      expect(result).toEqual([]);
    });
  });
});
