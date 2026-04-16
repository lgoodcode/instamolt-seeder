import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedAgent } from '@/types';

// --- Mock the event logger so we can assert event emission shape ---
const loggerState = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/event-logger', () => ({
  logEvent: vi.fn((evt: Record<string, unknown>) => {
    loggerState.events.push(evt);
  }),
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

// --- Mock the InstaMolt client so getPost is observable + controllable ---
const apiState = vi.hoisted(() => ({
  getPostCalls: [] as Array<{ apiKey: string | undefined; postId: string }>,
  // Per-postId override; defaults to resolving with a minimal shape.
  getPostImpl: undefined as
    | ((postId: string, apiKey: string | undefined) => Promise<unknown>)
    | undefined,
}));

vi.mock('@/services/instamolt-api', () => {
  class InstaMoltApiError extends Error {
    constructor(
      public method: string,
      public path: string,
      public status: number,
      public body: string,
      public retryAfterMs?: number,
    ) {
      super(`${method} ${path} → ${status}`);
    }
  }
  class InstaMoltClient {
    constructor(public apiKey?: string) {}
    async getPost(postId: string): Promise<unknown> {
      apiState.getPostCalls.push({ apiKey: this.apiKey, postId });
      if (apiState.getPostImpl) return apiState.getPostImpl(postId, this.apiKey);
      return { post: { id: postId } };
    }
  }
  return { InstaMoltClient, InstaMoltApiError };
});

import { fanOutPostViews, lurkFeedSlice } from '@/lib/views';
import { InstaMoltApiError, InstaMoltClient } from '@/services/instamolt-api';

function makeAgent(
  name: string,
  opts: { apiKey?: string; personaId?: string } = {},
): GeneratedAgent {
  return {
    agentname: name,
    personaId: opts.personaId ?? 'p1',
    voiceProfileId: 'v1',
    bio: 'b',
    apiKey: opts.apiKey ?? `key-${name}`,
  } as GeneratedAgent;
}

beforeEach(() => {
  loggerState.events.length = 0;
  apiState.getPostCalls.length = 0;
  apiState.getPostImpl = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('fanOutPostViews', () => {
  it('reads the post from N other agents and emits one view event per success', async () => {
    const pool = [
      makeAgent('alice'),
      makeAgent('bob'),
      makeAgent('carol'),
      makeAgent('dave'),
      makeAgent('eve'),
    ];
    const result = await fanOutPostViews({
      postId: 'post-1',
      postAuthor: 'alice',
      pool,
      count: 3,
      concurrency: 2,
      source: 'publish_fanout',
    });
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(apiState.getPostCalls).toHaveLength(3);
    // post author must never appear as a viewer
    expect(apiState.getPostCalls.every((c) => c.apiKey !== 'key-alice')).toBe(true);
    expect(loggerState.events).toHaveLength(3);
    for (const evt of loggerState.events) {
      expect(evt.eventType).toBe('view');
      expect(evt.success).toBe(true);
      expect((evt.details as Record<string, unknown>).postId).toBe('post-1');
      expect((evt.details as Record<string, unknown>).source).toBe('publish_fanout');
      expect((evt.details as Record<string, unknown>).targetAuthor).toBe('alice');
    }
  });

  it('returns 0 attempts when the pool excludes everyone', async () => {
    const result = await fanOutPostViews({
      postId: 'post-x',
      postAuthor: 'solo',
      pool: [makeAgent('solo')],
      count: 5,
      concurrency: 2,
      source: 'publish_fanout',
    });
    expect(result).toEqual({ attempted: 0, succeeded: 0 });
    expect(apiState.getPostCalls).toHaveLength(0);
    expect(loggerState.events).toHaveLength(0);
  });

  it('skips agents without an apiKey', async () => {
    const pool = [
      makeAgent('a'),
      { agentname: 'no-key', personaId: 'p1', voiceProfileId: 'v1', bio: 'b' } as GeneratedAgent,
      makeAgent('b'),
    ];
    const result = await fanOutPostViews({
      postId: 'post-2',
      postAuthor: 'author',
      pool,
      count: 5,
      concurrency: 2,
      source: 'publish_fanout',
    });
    expect(result.attempted).toBe(2);
    expect(apiState.getPostCalls.map((c) => c.apiKey).sort()).toEqual(['key-a', 'key-b']);
  });

  it('emits a failure view event but does not throw when getPost rejects', async () => {
    apiState.getPostImpl = async (_postId, apiKey) => {
      if (apiKey === 'key-bob') {
        throw new InstaMoltApiError('GET', '/posts/post-3', 500, 'boom');
      }
      return { post: {} };
    };
    const result = await fanOutPostViews({
      postId: 'post-3',
      postAuthor: 'author',
      pool: [makeAgent('alice'), makeAgent('bob'), makeAgent('carol')],
      count: 3,
      concurrency: 3,
      source: 'publish_fanout',
    });
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    const failures = loggerState.events.filter((e) => e.success === false);
    expect(failures).toHaveLength(1);
    expect((failures[0].details as Record<string, unknown>).httpStatus).toBe(500);
  });

  it('respects count when smaller than the eligible pool', async () => {
    const pool = Array.from({ length: 20 }, (_, i) => makeAgent(`a${i}`));
    const result = await fanOutPostViews({
      postId: 'post-4',
      postAuthor: 'someone-else',
      pool,
      count: 5,
      concurrency: 5,
      source: 'publish_fanout',
    });
    expect(result.attempted).toBe(5);
    expect(apiState.getPostCalls).toHaveLength(5);
    // distinct api keys
    const uniq = new Set(apiState.getPostCalls.map((c) => c.apiKey));
    expect(uniq.size).toBe(5);
  });
});

describe('lurkFeedSlice', () => {
  it('reads up to N posts excluding the agent itself and emits view events', async () => {
    const client = new InstaMoltClient('viewer-key');
    const posts = [
      { id: 'p-self', author: { agentname: 'me' } },
      { id: 'p-1', author: { agentname: 'a' } },
      { id: 'p-2', author: { agentname: 'b' } },
      { id: 'p-3', author: { agentname: 'c' } },
      { id: 'p-4', author: { agentname: 'd' } },
    ];
    const result = await lurkFeedSlice({
      client,
      agentname: 'me',
      personaId: 'persona-x',
      posts,
      count: 3,
      concurrency: 2,
    });
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(3);
    const viewedIds = apiState.getPostCalls.map((c) => c.postId);
    expect(viewedIds).not.toContain('p-self');
    expect(viewedIds).toEqual(['p-1', 'p-2', 'p-3']);
    expect(loggerState.events).toHaveLength(3);
    for (const evt of loggerState.events) {
      expect(evt.eventType).toBe('view');
      expect(evt.agentname).toBe('me');
      expect(evt.persona).toBe('persona-x');
      expect((evt.details as Record<string, unknown>).source).toBe('engage_lurk');
    }
  });

  it('returns 0 attempts when every post in the slice is the agent itself', async () => {
    const client = new InstaMoltClient('viewer-key');
    const result = await lurkFeedSlice({
      client,
      agentname: 'me',
      personaId: 'p',
      posts: [{ id: 'p-self', author: { agentname: 'me' } }],
      count: 5,
      concurrency: 2,
    });
    expect(result).toEqual({ attempted: 0, succeeded: 0 });
    expect(apiState.getPostCalls).toHaveLength(0);
  });

  it('does not throw on a single failed read; emits a failure event for that post', async () => {
    apiState.getPostImpl = async (postId) => {
      if (postId === 'p-2') throw new Error('network blip');
      return { post: {} };
    };
    const client = new InstaMoltClient('viewer-key');
    const posts = [
      { id: 'p-1', author: { agentname: 'a' } },
      { id: 'p-2', author: { agentname: 'b' } },
      { id: 'p-3', author: { agentname: 'c' } },
    ];
    const result = await lurkFeedSlice({
      client,
      agentname: 'me',
      personaId: 'p',
      posts,
      count: 3,
      concurrency: 3,
    });
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    const failures = loggerState.events.filter((e) => e.success === false);
    expect(failures).toHaveLength(1);
    expect((failures[0].details as Record<string, unknown>).postId).toBe('p-2');
  });
});
