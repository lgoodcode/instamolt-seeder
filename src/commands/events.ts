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
  /**
   * Scope the report to a single session bucket. Plain `sess-xxx` matches
   * every bucket that carries that raw `sessionId`. The command emits
   * `session_start` per cycle inside `engage --loop` and per tick inside
   * `engage-continuous`, so a single process's `sessionId` can open many
   * buckets; disambiguate a specific one with `sess-xxx#N` (1-based,
   * matches the `#N` ordinal rendered in the unfiltered summary).
   */
  session?: string;
  /** Time cutoff — accepts `30m`, `2h`, `3d` duration form, or an ISO timestamp. */
  since?: string;
  /** Show every session instead of just the most recent {@link DEFAULT_SESSIONS_SHOWN}. */
  all?: boolean;
}

interface SessionFilter {
  sessionId: string;
  /** When set, only match the Nth bucket for the given sessionId. */
  ordinal?: number;
}

/**
 * Split a `--session` value into its `sessionId` and optional `#N` ordinal.
 * `sess-abc` → `{ sessionId: 'sess-abc' }`, `sess-abc#3` → `{ sessionId: 'sess-abc', ordinal: 3 }`.
 * Throws on an empty sessionId, an empty ordinal (`sess-abc#`), or a
 * non-positive ordinal (`sess-abc#0`) so a typo surfaces at CLI parse
 * time instead of silently dropping every event. Split on the LAST `#`
 * so a sessionId that happens to contain `#` isn't mis-parsed (platform
 * sessionIds are `sess-<uuid>` today, but be defensive).
 */
function parseSessionFilter(raw: string): SessionFilter {
  const hashIdx = raw.lastIndexOf('#');
  if (hashIdx === -1) {
    if (!raw) throw new Error('events: --session value cannot be empty');
    return { sessionId: raw };
  }
  const sessionId = raw.slice(0, hashIdx);
  const ordinalStr = raw.slice(hashIdx + 1);
  if (!sessionId) {
    throw new Error(`events: --session "${raw}" has an empty sessionId before the #`);
  }
  const ordinal = Number(ordinalStr);
  if (!ordinalStr || !Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(
      `events: --session ordinal "#${ordinalStr}" must be a positive integer (e.g. sess-abc#3)`,
    );
  }
  return { sessionId, ordinal };
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
  /**
   * 1-based ordinal for the Nth `session_start` seen with this `sessionId`
   * in the events stream. `initEventLogger` mints a fresh `sessionId` on
   * every process start (including resumes), so collisions across processes
   * are not the driver — the ordinal exists because `engage --loop` emits
   * `session_start` per cycle and `engage-continuous` emits it per tick,
   * so a single process writes many buckets under one `sessionId`. Also
   * disambiguates pre-decoupling logs where resumed sessions shared an id.
   * `undefined` for the first bucket under a given id to keep single-bucket
   * sessions visually clean; `2+` renders as a `#N` suffix.
   */
  ordinal?: number;
  /** Whether this bucket was opened by a `session_start` event (vs orphan events). */
  hasSessionStart: boolean;
  command?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Counts per event type, excluding session_start/session_end framing rows. */
  counts: Map<SeederEventType, number>;
  firstEventAt: string;
  lastEventAt: string;
}

/** Visible width of the eventType column in the per-session breakdown. */
const COUNTS_TYPE_COL_WIDTH = 22;
/** Visible width of the count column. */
const COUNTS_VALUE_COL_WIDTH = 6;

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

/**
 * Render a sorted-by-count column of `type   count` rows for a session's
 * per-eventType breakdown. Single-column on purpose — same visual rhythm
 * as the global totals block, fits any terminal width, and keeps long
 * eventType names from forcing the rest of the row off-screen.
 */
function formatCountsGrid(entries: Array<[SeederEventType, number]>): string[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  return sorted.map(([type, count]) => {
    const typePad = ' '.repeat(Math.max(1, COUNTS_TYPE_COL_WIDTH - type.length));
    const countStr = String(count);
    const valuePad = ' '.repeat(Math.max(0, COUNTS_VALUE_COL_WIDTH - countStr.length));
    return `    ${ui.color.cyan(type)}${typePad}${valuePad}${ui.color.green(countStr)}`;
  });
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
  const sessionFilter = opts.session ? parseSessionFilter(opts.session) : undefined;

  const globalCounts = new Map<SeederEventType, number>();
  const globalFirst = new Map<SeederEventType, string>();
  const globalLast = new Map<SeederEventType, string>();
  // Bucket by `session_start` boundaries in the event stream, NOT by
  // `sessionId` alone: `engage --loop` and `engage-continuous` both emit
  // one `session_start` per cycle/tick, so a single process writes many
  // buckets under the same `sessionId`. Each `session_start` opens a new
  // bucket; `session_end` stamps a duration but doesn't close the bucket
  // (trailing orphan events after an unclean exit stay attached to their
  // originating run).
  const sessionsList: SessionSummary[] = [];
  const sidOrdinals = new Map<string, number>();
  // Running ordinal per sessionId as we walk the stream. Drives the filter
  // when the user passes `--session sess-xxx#N` — each non-`session_start`
  // event attaches to the most-recent bucket for its sessionId, so the
  // current value here is the bucket it belongs to.
  const currentOrdinalBySid = new Map<string, number>();
  let current: SessionSummary | undefined;
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

    // Track the running ordinal BEFORE the filter so the filter can match
    // on `(sessionId, ordinal)` pairs. session_start advances the ordinal;
    // every other event inherits the most-recent one for its sessionId.
    const sid = evt.sessionId ?? 'unsessioned';
    if (evt.eventType === 'session_start') {
      currentOrdinalBySid.set(sid, (currentOrdinalBySid.get(sid) ?? 0) + 1);
    }
    const eventOrdinal = currentOrdinalBySid.get(sid) ?? 0;

    if (sessionFilter) {
      if (evt.sessionId !== sessionFilter.sessionId) continue;
      if (sessionFilter.ordinal !== undefined && eventOrdinal !== sessionFilter.ordinal) continue;
    }
    parsed++;

    globalCounts.set(evt.eventType, (globalCounts.get(evt.eventType) ?? 0) + 1);
    if (!globalFirst.has(evt.eventType)) globalFirst.set(evt.eventType, evt.timestamp);
    globalLast.set(evt.eventType, evt.timestamp);

    if (evt.eventType === 'session_start') {
      sidOrdinals.set(sid, eventOrdinal);
      current = {
        sessionId: sid,
        ordinal: eventOrdinal > 1 ? eventOrdinal : undefined,
        hasSessionStart: true,
        startedAt: evt.timestamp,
        counts: new Map(),
        firstEventAt: evt.timestamp,
        lastEventAt: evt.timestamp,
      };
      const cmd = evt.details?.command;
      if (typeof cmd === 'string') current.command = cmd;
      sessionsList.push(current);
      continue;
    }

    if (!current) {
      // Events before the first `session_start` (or before the filter window
      // intersects one) land in a leading orphan bucket so counts still match
      // the global totals.
      current = {
        sessionId: sid,
        hasSessionStart: false,
        startedAt: evt.timestamp,
        counts: new Map(),
        firstEventAt: evt.timestamp,
        lastEventAt: evt.timestamp,
      };
      sessionsList.push(current);
    }

    current.lastEventAt = evt.timestamp;

    if (evt.eventType === 'session_end') {
      current.endedAt = evt.timestamp;
      current.durationMs = Date.parse(evt.timestamp) - Date.parse(current.startedAt);
      continue;
    }

    current.counts.set(evt.eventType, (current.counts.get(evt.eventType) ?? 0) + 1);
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
  // Rendered in both filtered and unfiltered modes. In filtered mode without
  // a `#N` ordinal this shows every bucket that shares the raw `sessionId`
  // (helpful for picking the right ordinal to drill into); with `#N` it
  // shows just that one bucket — so the totals block and breakdown agree.
  {
    const shown = opts.all ? sessionsList : sessionsList.slice(-DEFAULT_SESSIONS_SHOWN);
    const label = opts.all
      ? `All sessions (${sessionsList.length})`
      : sessionFilter
        ? `Matched sessions (${sessionsList.length})`
        : `Recent sessions (${shown.length}/${sessionsList.length})`;
    ui.section(label);

    for (const summary of shown) {
      const cmd =
        summary.command ??
        (summary.hasSessionStart ? ui.color.dim('(unknown)') : ui.color.dim('(no session_start)'));
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

      const sidLabel = summary.ordinal
        ? `${summary.sessionId} ${ui.color.dim(`#${summary.ordinal}`)}`
        : summary.sessionId;

      console.log(
        `  ${ui.color.yellow(sidLabel)}  ${ui.color.bold(String(cmd).padEnd(18))}  ${ui.color.dim(`${start} → ${end}  (${dur})`)}`,
      );
      const gridLines = formatCountsGrid([...summary.counts.entries()]);
      for (const gridLine of gridLines) console.log(gridLine);
    }
  }

  ui.outro(ui.color.green(`${ui.symbol.ok} ${parsed} events summarized`));
}
