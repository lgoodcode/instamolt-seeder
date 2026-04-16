import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeederEvent } from '@/types';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
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
}));

vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  section: vi.fn(),
  note: vi.fn(),
  color: new Proxy({} as Record<string, (s: string) => string>, {
    get: () => (s: string) => s,
  }),
  symbol: { ok: 'ok', warn: 'warn', err: 'err', dot: '·', arrow: '→', bullet: '•' },
  isInteractive: () => false,
}));

import { events } from '@/commands/events';
import * as ui from '@/lib/ui';

// Path must match what `events.ts` produces via `join(config.logsDir, ...)` —
// the fs mock keys by exact string, so posix/Windows separator mismatches
// silently look like "file not found".
const EVENTS_PATH = join('./output/logs', 'events.jsonl');

function renderConsole(spy: ReturnType<typeof vi.spyOn>): string {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.map((c) => String(c[0])).join('\n');
}

function evt(over: Partial<SeederEvent>): string {
  const base: SeederEvent = {
    timestamp: '2026-04-14T10:00:00.000Z',
    eventType: 'agent_drafted',
    success: true,
  };
  return `${JSON.stringify({ ...base, ...over })}\n`;
}

describe('events command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fsState.files.clear();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ui.note).mockClear();
    vi.mocked(ui.section).mockClear();
    vi.mocked(ui.outro).mockClear();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('reports "no events log" when the file is missing', async () => {
    await events();
    expect(vi.mocked(ui.note)).toHaveBeenCalledWith(
      'No events log found',
      expect.stringContaining('events.jsonl'),
    );
  });

  it('tallies events globally and per-session', async () => {
    const log = [
      evt({
        timestamp: '2026-04-14T10:00:00.000Z',
        eventType: 'session_start',
        sessionId: 'sess-A',
        details: { command: 'generate' },
      }),
      evt({
        timestamp: '2026-04-14T10:00:05.000Z',
        eventType: 'agent_drafted',
        sessionId: 'sess-A',
      }),
      evt({
        timestamp: '2026-04-14T10:00:06.000Z',
        eventType: 'agent_drafted',
        sessionId: 'sess-A',
      }),
      evt({
        timestamp: '2026-04-14T10:01:00.000Z',
        eventType: 'post_drafted',
        sessionId: 'sess-A',
      }),
      evt({
        timestamp: '2026-04-14T10:02:00.000Z',
        eventType: 'session_end',
        sessionId: 'sess-A',
      }),
    ].join('');
    fsState.files.set(EVENTS_PATH, log);

    await events();

    const noteCalls = vi.mocked(ui.note).mock.calls;
    const totalsCall = noteCalls.find((c) => String(c[0]).startsWith('Totals'));
    expect(totalsCall).toBeDefined();
    const body = totalsCall![1] as string;
    expect(body).toMatch(/agent_drafted\s+2/);
    expect(body).toMatch(/post_drafted\s+1/);
    // session_start/session_end are framing — still counted in totals but not in per-session body
    expect(body).toMatch(/session_start\s+1/);

    const sectionCalls = vi.mocked(ui.section).mock.calls;
    expect(sectionCalls[0]?.[0]).toMatch(/Recent sessions/);
    const rendered = renderConsole(consoleLogSpy);
    expect(rendered).toContain('sess-A');
    expect(rendered).toContain('generate');
    expect(rendered).toMatch(/agent_drafted\s+2/);
    expect(rendered).toMatch(/post_drafted\s+1/);
    // Completed session renders a bounded duration, not a "+"
    expect(rendered).toMatch(/\(2m\)/);
  });

  it('labels a session with session_start-but-no-command as "(unknown)"', async () => {
    // Distinct from the "(no session_start)" fallback — a session_start event
    // was emitted, it just lacked `details.command` (pre-fix engage cycles
    // did this). The per-session row still belongs to a real session, so the
    // label must not pretend the session_start is missing.
    const log = [
      evt({
        timestamp: '2026-04-14T10:00:00.000Z',
        eventType: 'session_start',
        sessionId: 'sess-nocmd',
        // no details.command
      }),
      evt({
        timestamp: '2026-04-14T10:00:05.000Z',
        eventType: 'like',
        sessionId: 'sess-nocmd',
      }),
    ].join('');
    fsState.files.set(EVENTS_PATH, log);

    await events();

    const rendered = renderConsole(consoleLogSpy);
    expect(rendered).toContain('sess-nocmd');
    expect(rendered).toContain('(unknown)');
    expect(rendered).not.toContain('(no session_start)');
  });

  it('labels orphan events (no session_start at all) as "(no session_start)"', async () => {
    // Events logged by a process that never emitted session_start fall into
    // a leading orphan bucket. The label differs from "(unknown)" because
    // the semantics are different: here the bookend itself is missing.
    const log = [
      evt({
        timestamp: '2026-04-14T10:00:00.000Z',
        eventType: 'like',
        sessionId: 'sess-orphan',
      }),
    ].join('');
    fsState.files.set(EVENTS_PATH, log);

    await events();

    const rendered = renderConsole(consoleLogSpy);
    expect(rendered).toContain('(no session_start)');
    expect(rendered).not.toContain('(unknown)');
  });

  it('flags a session without session_end as running with a trailing +', async () => {
    const log = [
      evt({
        timestamp: '2026-04-14T10:00:00.000Z',
        eventType: 'session_start',
        sessionId: 'sess-live',
        details: { command: 'engage' },
      }),
      evt({
        timestamp: '2026-04-14T10:00:30.000Z',
        eventType: 'like',
        sessionId: 'sess-live',
      }),
    ].join('');
    fsState.files.set(EVENTS_PATH, log);

    await events();

    const rendered = renderConsole(consoleLogSpy);
    expect(rendered).toContain('(running)');
    expect(rendered).toMatch(/\(30s\+\)/);
  });

  it('filters by --session', async () => {
    const log = [
      evt({ eventType: 'agent_drafted', sessionId: 'sess-A' }),
      evt({ eventType: 'like', sessionId: 'sess-B' }),
      evt({ eventType: 'comment', sessionId: 'sess-B' }),
    ].join('');
    fsState.files.set(EVENTS_PATH, log);

    await events({ session: 'sess-B' });

    const noteCalls = vi.mocked(ui.note).mock.calls;
    const totalsCall = noteCalls.find((c) => String(c[0]).startsWith('Totals'));
    expect(totalsCall?.[0]).toContain('sess-B');
    const body = totalsCall![1] as string;
    expect(body).toMatch(/like\s+1/);
    expect(body).toMatch(/comment\s+1/);
    expect(body).not.toMatch(/agent_drafted/);
    // Session filter suppresses the per-session breakdown block
    expect(vi.mocked(ui.section)).not.toHaveBeenCalled();
  });

  it('filters by --since duration form', async () => {
    const now = Date.now();
    const old = new Date(now - 2 * 3_600_000).toISOString();
    const recent = new Date(now - 30 * 60_000).toISOString();
    const log = [
      evt({ timestamp: old, eventType: 'agent_drafted', sessionId: 'sess-old' }),
      evt({ timestamp: recent, eventType: 'like', sessionId: 'sess-new' }),
    ].join('');
    fsState.files.set(EVENTS_PATH, log);

    await events({ since: '1h' });

    const noteCalls = vi.mocked(ui.note).mock.calls;
    const totalsCall = noteCalls.find((c) => String(c[0]).startsWith('Totals'));
    const body = totalsCall![1] as string;
    expect(body).toMatch(/like\s+1/);
    expect(body).not.toMatch(/agent_drafted/);
  });

  it('rejects an unparseable --since value', async () => {
    fsState.files.set(EVENTS_PATH, evt({ eventType: 'like' }));
    await expect(events({ since: 'yesterday-ish' })).rejects.toThrow(/not a duration/);
  });

  it('skips malformed JSON lines without failing', async () => {
    const log = `${evt({ eventType: 'like' })}not-json\n${evt({ eventType: 'comment' })}`;
    fsState.files.set(EVENTS_PATH, log);

    await events();

    const noteCalls = vi.mocked(ui.note).mock.calls;
    const totalsCall = noteCalls.find((c) => String(c[0]).startsWith('Totals'));
    const body = totalsCall![1] as string;
    expect(body).toMatch(/like\s+1/);
    expect(body).toMatch(/comment\s+1/);
  });
});
