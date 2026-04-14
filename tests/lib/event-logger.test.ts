import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind } from '@/types';

// In-memory fs mock for sync operations (appendFileSync, writeFileSync, mkdirSync).
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn((path: string, data: string) => {
    const existing = fsState.files.get(path) ?? '';
    fsState.files.set(path, existing + data);
  }),
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
  mkdirSync: vi.fn((_path: string) => {
    fsState.dirs.add(_path);
  }),
}));

vi.mock('@/config', () => ({
  config: {
    logsDir: '/tmp/test-logs',
    agentsDir: '/tmp/test-agents',
  },
}));

// Suppress picocolors output in verbose tests.
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
  flushStats,
  getStats,
  initEventLogger,
  logEvent,
  logSkippedAction,
  logStrike,
  updateAgentCounts,
} from '@/lib/event-logger';

const LOGS_DIR = '/tmp/test-logs';
const AGENTS_DIR = '/tmp/test-agents';
const EVENTS_PATH = join(LOGS_DIR, 'events.jsonl');
const ERRORS_PATH = join(LOGS_DIR, 'errors.jsonl');
const STRIKES_PATH = join(LOGS_DIR, 'strikes.jsonl');
const STATS_PATH = join(LOGS_DIR, 'stats.json');
const SESSIONS_DIR = join(LOGS_DIR, 'sessions');

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
  _resetForTest();
});

describe('initEventLogger', () => {
  it('creates the logs directory', () => {
    initEventLogger();
    expect(fsState.dirs.has('/tmp/test-logs')).toBe(true);
  });

  it('initializes stats with zeroed counters', () => {
    initEventLogger();
    const stats = getStats();
    expect(stats).toBeDefined();
    expect(stats!.session.totalEvents).toBe(0);
    expect(stats!.agents.registered).toBe(0);
    expect(stats!.moderation.totalStrikes).toBe(0);
  });
});

describe('logEvent', () => {
  it('appends a valid JSONL line to events.jsonl', () => {
    initEventLogger();
    logEvent({ eventType: 'like', agentname: 'testbot', persona: 'meme_lord', success: true });

    const content = fsState.files.get(EVENTS_PATH);
    expect(content).toBeDefined();
    const lines = content!.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.eventType).toBe('like');
    expect(parsed.agentname).toBe('testbot');
    expect(parsed.success).toBe(true);
    expect(parsed.timestamp).toBeDefined();
  });

  it('increments action success count for mapped event types', () => {
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    logEvent({ eventType: 'like', success: true });
    logEvent({ eventType: 'like', success: false });

    const stats = getStats()!;
    expect(stats.actions.like.success).toBe(2);
    expect(stats.actions.like.error).toBe(1);
  });

  it('tracks per-persona actions and errors', () => {
    initEventLogger();
    logEvent({ eventType: 'comment', persona: 'fitness_bro', success: true });
    logEvent({ eventType: 'comment', persona: 'fitness_bro', success: false });

    const stats = getStats()!;
    expect(stats.personas.fitness_bro).toEqual({ actions: 2, errors: 1, strikes: 0 });
  });

  it('tracks feed refresh count and running average post count', () => {
    initEventLogger();
    logEvent({ eventType: 'feed_refresh', success: true, details: { postCount: 20 } });
    logEvent({ eventType: 'feed_refresh', success: true, details: { postCount: 40 } });

    const stats = getStats()!;
    expect(stats.feeds.refreshCount).toBe(2);
    expect(stats.feeds.avgPostCount).toBe(30);
    expect(stats.feeds.lastRefreshedAt).toBeDefined();
  });

  it('tracks growth ticks', () => {
    initEventLogger();
    logEvent({ eventType: 'growth_tick', success: true, details: { agentsAdded: 3 } });
    logEvent({ eventType: 'growth_tick', success: true, details: { agentsAdded: 2 } });

    const stats = getStats()!;
    expect(stats.growth.ticksFired).toBe(2);
    expect(stats.growth.agentsAdded).toBe(5);
  });

  it('does not track growth on failed growth_tick', () => {
    initEventLogger();
    logEvent({ eventType: 'growth_tick', success: false, error: 'boom' });

    const stats = getStats()!;
    expect(stats.growth.ticksFired).toBe(0);
    expect(stats.growth.agentsAdded).toBe(0);
  });

  it('does not increment action stats for non-action event types', () => {
    initEventLogger();
    logEvent({ eventType: 'session_start', success: true });

    const stats = getStats()!;
    // All action buckets remain zero
    for (const kind of [
      'like',
      'comment',
      'reply',
      'follow',
      'post',
      'commentLike',
    ] as ActionKind[]) {
      expect(stats.actions[kind].success).toBe(0);
      expect(stats.actions[kind].error).toBe(0);
    }
    // But totalEvents still increments
    expect(stats.session.totalEvents).toBe(1);
  });
});

describe('logStrike', () => {
  it('writes to both strikes.jsonl and events.jsonl', () => {
    initEventLogger();
    logStrike({
      agentname: 'badbot',
      persona: 'edgy_poster',
      contentType: 'comment',
      tier: 'warning',
      category: 'harassment',
      action: 'flagged',
      contentPreview: 'some offensive text',
    });

    // strikes.jsonl
    const strikesContent = fsState.files.get(STRIKES_PATH);
    expect(strikesContent).toBeDefined();
    const strikeLine = JSON.parse(strikesContent!.trim().split('\n')[0]);
    expect(strikeLine.agentname).toBe('badbot');
    expect(strikeLine.tier).toBe('warning');
    expect(strikeLine.category).toBe('harassment');
    expect(strikeLine.timestamp).toBeDefined();

    // events.jsonl — the strike also generates a regular event
    const eventsContent = fsState.files.get(EVENTS_PATH);
    expect(eventsContent).toBeDefined();
    const eventLine = JSON.parse(eventsContent!.trim().split('\n')[0]);
    expect(eventLine.eventType).toBe('strike');
    expect(eventLine.success).toBe(false);
  });

  it('increments moderation stats by tier and category', () => {
    initEventLogger();
    logStrike({
      agentname: 'bot1',
      persona: 'p1',
      contentType: 'post',
      tier: 'warning',
      category: 'spam',
      action: 'flagged',
      contentPreview: 'buy now',
    });
    logStrike({
      agentname: 'bot2',
      persona: 'p1',
      contentType: 'bio',
      tier: 'ban',
      category: 'spam',
      action: 'suspended',
      contentPreview: 'click here',
    });

    const stats = getStats()!;
    expect(stats.moderation.totalStrikes).toBe(2);
    expect(stats.moderation.byTier).toEqual({ warning: 1, ban: 1 });
    expect(stats.moderation.byCategory).toEqual({ spam: 2 });
  });

  it('increments per-persona strike count', () => {
    initEventLogger();
    logStrike({
      agentname: 'bot1',
      persona: 'hot_take',
      contentType: 'comment',
      tier: 'warning',
      category: 'toxicity',
      action: 'flagged',
      contentPreview: 'toxic comment',
    });

    const stats = getStats()!;
    expect(stats.personas.hot_take.strikes).toBe(1);
  });
});

describe('flushStats', () => {
  it('writes valid JSON to stats.json', () => {
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    flushStats();

    const content = fsState.files.get(STATS_PATH);
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!);
    expect(parsed.session.totalEvents).toBe(1);
    expect(parsed.lastUpdatedAt).toBeDefined();
    expect(parsed.session.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('auto-flush after STATS_FLUSH_THRESHOLD events', () => {
  it('flushes stats.json after 50 events', () => {
    initEventLogger();

    for (let i = 0; i < 49; i++) {
      logEvent({ eventType: 'like', success: true });
    }
    // stats.json should NOT exist yet (49 < 50)
    expect(fsState.files.has(STATS_PATH)).toBe(false);

    // The 50th event triggers the flush
    logEvent({ eventType: 'like', success: true });
    expect(fsState.files.has(STATS_PATH)).toBe(true);

    const parsed = JSON.parse(fsState.files.get(STATS_PATH)!);
    expect(parsed.session.totalEvents).toBe(50);
  });
});

describe('no-op when uninitialized', () => {
  it('logEvent does nothing and does not crash', () => {
    // No initEventLogger() call
    logEvent({ eventType: 'like', success: true });
    expect(fsState.files.size).toBe(0);
  });

  it('logStrike does nothing and does not crash', () => {
    logStrike({
      agentname: 'bot',
      persona: 'p',
      contentType: 'comment',
      tier: 'warning',
      category: 'spam',
      action: 'flagged',
      contentPreview: 'text',
    });
    expect(fsState.files.size).toBe(0);
  });

  it('flushStats does nothing and does not crash', () => {
    flushStats();
    expect(fsState.files.size).toBe(0);
  });

  it('updateAgentCounts does nothing and does not crash', () => {
    updateAgentCounts(10, 5);
    // No crash, no stats to check
    expect(getStats()).toBeUndefined();
  });

  it('getStats returns undefined', () => {
    expect(getStats()).toBeUndefined();
  });
});

describe('updateAgentCounts', () => {
  it('updates the agent counts in stats', () => {
    initEventLogger();
    updateAgentCounts(25, 10);
    const stats = getStats()!;
    expect(stats.agents.registered).toBe(25);
    expect(stats.agents.active).toBe(10);
  });
});

describe('logSkippedAction', () => {
  it('increments the skipped counter for the action kind', () => {
    initEventLogger();
    logSkippedAction('like', 'bot1', 'persona1', 'quota exhausted');

    const stats = getStats()!;
    expect(stats.actions.like.skipped).toBe(1);
    // It also logs an event (success: false, with skipped detail)
    expect(stats.session.totalEvents).toBe(1);
  });

  it('maps commentLike to comment_like event type', () => {
    initEventLogger();
    logSkippedAction('commentLike', 'bot1', 'persona1', 'cooldown');

    const content = fsState.files.get(EVENTS_PATH)!;
    const parsed = JSON.parse(content.trim().split('\n')[0]);
    expect(parsed.eventType).toBe('comment_like');
    expect(parsed.details.skipped).toBe(true);
    expect(parsed.details.reason).toBe('cooldown');
  });
});

describe('errors.jsonl', () => {
  it('writes failures to errors.jsonl in addition to events.jsonl', () => {
    initEventLogger();
    logEvent({
      eventType: 'like',
      agentname: 'bot',
      persona: 'p1',
      success: false,
      error: 'boom',
    });

    const events = fsState.files.get(EVENTS_PATH)!;
    const errors = fsState.files.get(ERRORS_PATH)!;
    expect(events).toBeDefined();
    expect(errors).toBeDefined();
    const errLine = JSON.parse(errors.trim());
    expect(errLine.success).toBe(false);
    expect(errLine.error).toBe('boom');
    expect(errLine.eventType).toBe('like');
  });

  it('does NOT write successes to errors.jsonl', () => {
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    expect(fsState.files.has(ERRORS_PATH)).toBe(false);
  });

  it('carries httpStatus / retryAfterMs / requestContext when present in details', () => {
    initEventLogger();
    logEvent({
      eventType: 'api_429',
      success: false,
      error: 'rate limited',
      details: {
        httpStatus: 429,
        retryAfterMs: 60_000,
        requestContext: { method: 'POST', path: '/posts/abc/like' },
      },
    });

    const err = JSON.parse(fsState.files.get(ERRORS_PATH)!.trim());
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterMs).toBe(60_000);
    expect(err.requestContext).toEqual({ method: 'POST', path: '/posts/abc/like' });
  });
});

describe('per-agent activity.jsonl tee', () => {
  it('tees event rows with an agentname to output/agents/<name>/activity.jsonl', () => {
    initEventLogger();
    logEvent({ eventType: 'like', agentname: 'alicebot', persona: 'p1', success: true });

    const activityPath = join(AGENTS_DIR, 'alicebot', 'activity.jsonl');
    const content = fsState.files.get(activityPath);
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!.trim());
    expect(parsed.eventType).toBe('like');
    expect(parsed.agentname).toBe('alicebot');
  });

  it('does not tee events that have no agentname', () => {
    initEventLogger();
    logEvent({ eventType: 'feed_refresh', success: true, details: { postCount: 10 } });

    // No agent dir created — only logs dir mkdirs happened.
    const anyAgentTee = [...fsState.files.keys()].some(
      (k) => k.startsWith(AGENTS_DIR) && k.endsWith('activity.jsonl'),
    );
    expect(anyAgentTee).toBe(false);
  });
});

describe('sessionId stamping', () => {
  it('stamps a sessionId on every event', () => {
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    const parsed = JSON.parse(fsState.files.get(EVENTS_PATH)!.trim());
    expect(parsed.sessionId).toMatch(/^sess-/);
    expect(parsed.sessionId).toBe(getStats()!.session.sessionId);
  });
});

describe('session resume / archive', () => {
  it('resumes a prior session when its startedAt is within 24h', () => {
    // First run — stamp a session and flush.
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    flushStats();
    const firstSessionId = getStats()!.session.sessionId;
    expect(getStats()!.session.totalEvents).toBe(1);

    // Second run — stats.json exists and is fresh; counters should carry over.
    _resetForTest();
    initEventLogger();
    expect(getStats()!.session.sessionId).toBe(firstSessionId);
    expect(getStats()!.session.totalEvents).toBe(1);
  });

  it('archives a prior session older than 24h and starts fresh', () => {
    // Simulate a stats.json with a startedAt 48h in the past by writing
    // it directly to the mock filesystem.
    const oldStartedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const oldStats = {
      lastUpdatedAt: oldStartedAt,
      session: {
        sessionId: 'sess-old',
        startedAt: oldStartedAt,
        uptimeMs: 3600_000,
        totalEvents: 42,
      },
      agents: { registered: 0, active: 0 },
      actions: {
        like: { success: 10, skipped: 0, error: 0 },
        comment: { success: 0, skipped: 0, error: 0 },
        reply: { success: 0, skipped: 0, error: 0 },
        follow: { success: 0, skipped: 0, error: 0 },
        post: { success: 0, skipped: 0, error: 0 },
        commentLike: { success: 0, skipped: 0, error: 0 },
      },
      feeds: { refreshCount: 0, lastRefreshedAt: null, avgPostCount: 0 },
      moderation: { totalStrikes: 0, byTier: {}, byCategory: {} },
      growth: { ticksFired: 0, agentsAdded: 0 },
      personas: {},
    };
    fsState.files.set(STATS_PATH, JSON.stringify(oldStats));

    initEventLogger();

    // Fresh session — not the archived sessionId.
    expect(getStats()!.session.sessionId).not.toBe('sess-old');
    expect(getStats()!.session.totalEvents).toBe(0);

    // Archive file exists under sessions/.
    const archivedPaths = [...fsState.files.keys()].filter((k) => k.startsWith(SESSIONS_DIR));
    expect(archivedPaths.length).toBe(1);
    expect(archivedPaths[0]).toContain('stats-');
  });

  it('reset: true forces a fresh session regardless of prior stats', () => {
    // Plant a resumable prior session.
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    flushStats();
    const firstSessionId = getStats()!.session.sessionId;

    _resetForTest();
    initEventLogger({ reset: true });

    expect(getStats()!.session.sessionId).not.toBe(firstSessionId);
    expect(getStats()!.session.totalEvents).toBe(0);
  });

  it('handles missing/corrupt prior stats.json gracefully', () => {
    // Write invalid JSON into stats.json.
    fsState.files.set(STATS_PATH, '{not valid json');

    initEventLogger();
    // Fresh session; no crash.
    expect(getStats()!.session.totalEvents).toBe(0);
  });
});

describe('_resetForTest', () => {
  it('clears all module state', () => {
    initEventLogger();
    logEvent({ eventType: 'like', success: true });
    expect(getStats()).toBeDefined();

    _resetForTest();
    expect(getStats()).toBeUndefined();

    // After reset, logEvent is a no-op again
    fsState.files.clear();
    logEvent({ eventType: 'like', success: true });
    expect(fsState.files.size).toBe(0);
  });
});
