/**
 * `events` — tally the structured event log at `output/logs/events.jsonl`.
 *
 * Read-only reporter. Groups rows by session so the operator can see, at a
 * glance, which phases have run, how many agents were drafted/published, and
 * how many like/comment/follow interactions have fired — with timelines.
 *
 * Sibling to `status` (which reports on-disk agent/post state). Where `status`
 * answers "what do I have?", `events` answers "what has happened?".
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import * as ui from '@/lib/ui';
import type { SeederEvent, SeederEventType } from '@/types';

export interface EventsOptions {
  /** Scope the report to a single session id (matches `sessionId` exactly). */
  session?: string;
  /** Time cutoff — accepts `30m`, `2h`, `3d` duration form, or an ISO timestamp. */
  since?: string;
  /** Show every session instead of just the most recent {@link DEFAULT_SESSIONS_SHOWN}. */
  all?: boolean;
}

/**
 * How many sessions to render in the per-session breakdown by default.
 * Tunable via `--all`. Kept low because the typical run has <10 sessions and
 * the operator wants the recent tail, not a novel.
 */
const DEFAULT_SESSIONS_SHOWN = 5;

const DURATION_REGEX = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_MULTIPLIERS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

interface SessionSummary {
  sessionId: string;
  command?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Counts per event type, excluding session_start/session_end framing rows. */
  counts: Map<SeederEventType, number>;
  firstEventAt: string;
  lastEventAt: string;
}

/**
 * Parse a `--since` value into an absolute epoch-ms cutoff. Accepts either a
 * relative duration (`30m`, `2h`, `3d`) or a parseable ISO-ish timestamp.
 */
function parseSince(since: string): number {
  const match = DURATION_REGEX.exec(since);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = DURATION_MULTIPLIERS_MS[unit];
    return Date.now() - amount * multiplier;
  }
  const ts = Date.parse(since);
  if (Number.isNaN(ts)) {
    throw new Error(
      `events: --since "${since}" is not a duration (e.g. 30m, 2h, 3d) or a valid timestamp`,
    );
  }
  return ts;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h${remMinutes}m`;
}

/** Trim `2026-04-14T19:53:46.976Z` → `2026-04-14 19:53:46` for console output. */
function formatTimestamp(iso: string): string {
  return iso.replace('T', ' ').replace(/\..+$/, '');
}

export async function events(opts: EventsOptions = {}): Promise<void> {
  ui.intro('Events');

  const eventsPath = join(config.logsDir, 'events.jsonl');
  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    ui.note('No events log found', `Expected at ${eventsPath}. Run a command first.`);
    ui.outro(ui.color.yellow(`${ui.symbol.warn} nothing to report`));
    return;
  }

  const sinceMs = opts.since ? parseSince(opts.since) : undefined;

  const globalCounts = new Map<SeederEventType, number>();
  const globalFirst = new Map<SeederEventType, string>();
  const globalLast = new Map<SeederEventType, string>();
  const sessionsOrder: string[] = [];
  const sessions = new Map<string, SessionSummary>();
  let parsed = 0;
  let skipped = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let evt: SeederEvent;
    try {
      evt = JSON.parse(line) as SeederEvent;
    } catch {
      skipped++;
      continue;
    }
    if (sinceMs !== undefined && Date.parse(evt.timestamp) < sinceMs) continue;
    if (opts.session && evt.sessionId !== opts.session) continue;
    parsed++;

    globalCounts.set(evt.eventType, (globalCounts.get(evt.eventType) ?? 0) + 1);
    if (!globalFirst.has(evt.eventType)) globalFirst.set(evt.eventType, evt.timestamp);
    globalLast.set(evt.eventType, evt.timestamp);

    const sid = evt.sessionId ?? 'unsessioned';
    let summary = sessions.get(sid);
    if (!summary) {
      summary = {
        sessionId: sid,
        startedAt: evt.timestamp,
        counts: new Map(),
        firstEventAt: evt.timestamp,
        lastEventAt: evt.timestamp,
      };
      sessions.set(sid, summary);
      sessionsOrder.push(sid);
    }
    summary.lastEventAt = evt.timestamp;

    if (evt.eventType === 'session_start') {
      summary.startedAt = evt.timestamp;
      const cmd = evt.details?.command;
      if (typeof cmd === 'string') summary.command = cmd;
    } else if (evt.eventType === 'session_end') {
      summary.endedAt = evt.timestamp;
      summary.durationMs = Date.parse(evt.timestamp) - Date.parse(summary.startedAt);
    } else {
      summary.counts.set(evt.eventType, (summary.counts.get(evt.eventType) ?? 0) + 1);
    }
  }

  if (parsed === 0) {
    const filterDesc = opts.session
      ? ` for session ${opts.session}`
      : opts.since
        ? ` since ${opts.since}`
        : '';
    ui.note(`No events matched${filterDesc}`, `${skipped} malformed line(s) skipped.`);
    ui.outro(ui.color.yellow(`${ui.symbol.warn} nothing to report`));
    return;
  }

  // --- Global totals ---
  const sortedTypes = [...globalCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalsLines = sortedTypes.map(([type, count]) => {
    const first = formatTimestamp(globalFirst.get(type) ?? '');
    const last = formatTimestamp(globalLast.get(type) ?? '');
    return `${ui.color.cyan(type.padEnd(20))} ${ui.color.green(String(count).padStart(6))}  ${ui.color.dim(`${first} → ${last}`)}`;
  });

  const headerScope = opts.session
    ? `session ${opts.session}`
    : opts.since
      ? `since ${opts.since}`
      : 'all time';
  ui.note(`Totals (${headerScope})`, totalsLines.join('\n'));

  // --- Per-session breakdown ---
  if (!opts.session) {
    const shownOrder = opts.all ? sessionsOrder : sessionsOrder.slice(-DEFAULT_SESSIONS_SHOWN);
    const label = opts.all
      ? `All sessions (${sessionsOrder.length})`
      : `Recent sessions (${shownOrder.length}/${sessionsOrder.length})`;
    ui.section(label);

    for (const sid of shownOrder) {
      const summary = sessions.get(sid);
      if (!summary) continue;
      const cmd = summary.command ?? ui.color.dim('(no session_start)');
      const start = formatTimestamp(summary.startedAt);
      const end = summary.endedAt
        ? formatTimestamp(summary.endedAt)
        : `${formatTimestamp(summary.lastEventAt)} ${ui.color.yellow('(running)')}`;
      const rawDurationMs =
        summary.durationMs ?? Date.parse(summary.lastEventAt) - Date.parse(summary.startedAt);
      const dur =
        summary.durationMs !== undefined
          ? formatDuration(rawDurationMs)
          : `${formatDuration(rawDurationMs)}+`;

      const sortedCounts = [...summary.counts.entries()].sort((a, b) => b[1] - a[1]);
      const countsStr = sortedCounts.map(([t, c]) => `${t}:${ui.color.green(String(c))}`).join(' ');

      console.log(
        `  ${ui.color.yellow(sid)}  ${ui.color.bold(String(cmd).padEnd(18))}  ${ui.color.dim(`${start} → ${end}  (${dur})`)}`,
      );
      if (countsStr) console.log(`    ${countsStr}`);
    }
  }

  ui.outro(ui.color.green(`${ui.symbol.ok} ${parsed} events summarized`));
}
