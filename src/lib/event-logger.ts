import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { config } from '@/config';
import type {
  ActionKind,
  SeederErrorEvent,
  SeederEvent,
  SeederEventType,
  SeederStats,
  StrikeEvent,
} from '@/types';
import { ACTION_KINDS } from '@/types';

const STATS_FLUSH_THRESHOLD = 50;

/**
 * Window within which a previous session's aggregate counters are resumed
 * instead of archived-and-reset. Picked to be "overnight friendly" — start
 * a run in the evening, kill it in the morning, start a second run the same
 * day: stats.json keeps counting. A run starting more than 24h after the
 * previous run's `session.startedAt` gets a fresh session, and the old
 * stats.json is archived to `output/logs/sessions/stats-<ISO>.json`.
 */
const SESSION_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

// Module-level state — initialized by initEventLogger()
let initialized = false;
let eventsPath = '';
let errorsPath = '';
let strikesPath = '';
let statsPath = '';
let sessionsDir = '';
let eventCount = 0;
let verbose = false;
let stats: SeederStats | undefined;
let sessionId = '';

// Per-file promise chain. Keeping one chain per path preserves JSONL ordering
// under concurrent logEvent calls without holding a lock — each enqueue is a
// synchronous pointer swap; the actual append runs on the microtask queue.
const writeQueues: Map<string, Promise<void>> = new Map();

function enqueueAppend(path: string, line: string): void {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev
    .then(() => appendFile(path, line))
    .catch(() => {
      // Best-effort: disk full / permissions must not crash a long-running loop.
    });
  writeQueues.set(path, next);
  // Drop the entry once it settles, but only if no newer append has chained
  // on top of it. Without this, per-agent activity.jsonl paths accumulate
  // a Map entry per distinct agentname ever logged — unbounded on a
  // long-running loop with a rotating agent set.
  next.finally(() => {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  });
}

/**
 * Await all in-flight appends. Async callers should drain before end-of-run
 * so trailing events hit disk before the process exits. Sync SIGINT handlers
 * cannot drain — trailing appends are dropped on Ctrl-C, which is acceptable
 * for best-effort logging.
 */
export async function drainWrites(): Promise<void> {
  const pending = [...writeQueues.values()];
  if (pending.length > 0) await Promise.all(pending);
}

/**
 * Schedule a stats.json flush to run after pending events.jsonl / errors.jsonl
 * appends settle. Prevents stats.json from claiming events that haven't hit
 * disk yet — a crash between a sync `writeFileSync(stats)` and a pending
 * `appendFile(events)` would otherwise leave stats.json ahead of the JSONL
 * logs. Fire-and-forget: the flush itself is sync (`writeFileSync`) so the
 * gap is only the microtask hop between the appends settling and the sync
 * write, not a second window of I/O.
 */
function queueStatsFlush(): void {
  const evPrev = writeQueues.get(eventsPath) ?? Promise.resolve();
  const errPrev = writeQueues.get(errorsPath) ?? Promise.resolve();
  Promise.allSettled([evPrev, errPrev]).then(() => {
    flushStats();
  });
}

function emptyActionStats(): { success: number; skipped: number; error: number } {
  return { success: 0, skipped: 0, error: 0 };
}

function generateSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshStats(): SeederStats {
  const now = new Date().toISOString();
  const actions = {} as Record<ActionKind, { success: number; skipped: number; error: number }>;
  for (const kind of ACTION_KINDS) {
    actions[kind] = emptyActionStats();
  }
  return {
    lastUpdatedAt: now,
    session: { sessionId: generateSessionId(), startedAt: now, uptimeMs: 0, totalEvents: 0 },
    agents: { registered: 0, active: 0 },
    actions,
    feeds: { refreshCount: 0, lastRefreshedAt: null, avgPostCount: 0 },
    moderation: { totalStrikes: 0, byTier: {}, byCategory: {} },
    growth: { ticksFired: 0, agentsAdded: 0 },
    personas: {},
  };
}

/**
 * Read the existing stats.json (if any) and decide whether to resume it
 * (continuing the same session counters) or archive it and start fresh.
 *
 * Resume window is 24h from `session.startedAt` so overnight runs bridge
 * evening and morning cleanly. Older sessions are moved to
 * `output/logs/sessions/stats-<ISO>.json` so the operator still has a
 * historical record. Missing or corrupt prior stats always starts fresh —
 * a broken file must never block a run.
 */
function loadOrArchivePriorStats(): SeederStats {
  try {
    const raw = readFileSync(statsPath, 'utf-8');
    const prev = JSON.parse(raw) as SeederStats;
    const startedAt = Date.parse(prev.session?.startedAt ?? '');
    if (Number.isFinite(startedAt) && Date.now() - startedAt < SESSION_RESUME_WINDOW_MS) {
      // Resume: preserve sessionId + counters. Backfill sessionId for stats
      // files written before this field existed.
      if (!prev.session.sessionId) prev.session.sessionId = generateSessionId();
      return prev;
    }
    // Archive: copy the old file, then start fresh. `mkdirSync` with
    // `recursive` is idempotent, so calling it on every init is cheap.
    try {
      mkdirSync(sessionsDir, { recursive: true });
      const safeStamp = (prev.session?.startedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
      writeFileSync(join(sessionsDir, `stats-${safeStamp}.json`), raw);
    } catch {
      // Archive failure should never block — raw stats.json gets overwritten
      // on the next flush, so at worst we lose the previous aggregate.
    }
  } catch {
    // Missing or corrupt — fresh session.
  }
  return freshStats();
}

export interface InitEventLoggerOpts {
  /** Log every event to stdout in addition to the JSONL files. */
  verbose?: boolean;
  /**
   * Force a fresh session even if a resumable stats.json exists. Useful for
   * tests and for operators who want a clean slate without nuking the logs
   * directory by hand.
   */
  reset?: boolean;
}

export function initEventLogger(opts?: InitEventLoggerOpts): void {
  const logsDir = config.logsDir;
  mkdirSync(logsDir, { recursive: true });
  eventsPath = join(logsDir, 'events.jsonl');
  errorsPath = join(logsDir, 'errors.jsonl');
  strikesPath = join(logsDir, 'strikes.jsonl');
  statsPath = join(logsDir, 'stats.json');
  sessionsDir = join(logsDir, 'sessions');
  verbose = opts?.verbose ?? false;
  stats = opts?.reset ? freshStats() : loadOrArchivePriorStats();
  sessionId = stats.session.sessionId;
  eventCount = 0;
  initialized = true;
}

// Map eventType to ActionKind for stats tracking
const EVENT_TO_ACTION: Partial<Record<SeederEventType, ActionKind>> = {
  like: 'like',
  comment: 'comment',
  reply: 'reply',
  follow: 'follow',
  comment_like: 'commentLike',
  post_published: 'post',
};

/**
 * Tee a rendered event row to the acting agent's per-agent log at
 * `output/agents/<agentname>/activity.jsonl`. Lets the operator
 * `tail -f` a single agent's live timeline without grepping the
 * population-wide `events.jsonl`. Best-effort — never throws.
 */
function teeToAgent(agentname: string, line: string): void {
  const agentDir = join(config.agentsDir, agentname);
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch {
    // Missing directory or file-system error — don't let a tee failure
    // interrupt the main logging path.
    return;
  }
  enqueueAppend(join(agentDir, 'activity.jsonl'), line);
}

export function logEvent(event: Omit<SeederEvent, 'timestamp' | 'sessionId'>): void {
  if (!initialized || !stats) return;

  const full: SeederEvent = {
    ...event,
    sessionId,
    timestamp: new Date().toISOString(),
  };
  const line = `${JSON.stringify(full)}\n`;
  enqueueAppend(eventsPath, line);

  // Per-agent tee so operators can watch one agent's live timeline.
  if (event.agentname) teeToAgent(event.agentname, line);

  // A skipped action (intent-to-engage that aborted before the API call —
  // cooldown, self-target, dedup, quota) is logged with success:false for
  // the event stream, but it is NOT a functional error: don't inflate
  // error counters and don't write it to errors.jsonl.
  const isSkipped = event.details?.skipped === true;

  // Every *real* failure also lands in the dedicated errors log. We build
  // a SeederErrorEvent view here so the row carries the richer shape
  // callers attached via `details` (httpStatus, retryAfterMs, attempt,
  // requestContext, stack).
  if (!event.success && !isSkipped) {
    const d = event.details ?? {};
    const errorEvent: SeederErrorEvent = {
      ...full,
      success: false,
      httpStatus: typeof d.httpStatus === 'number' ? d.httpStatus : undefined,
      retryAfterMs: typeof d.retryAfterMs === 'number' ? d.retryAfterMs : undefined,
      attempt: typeof d.attempt === 'number' ? d.attempt : undefined,
      stack: typeof d.stack === 'string' ? d.stack : undefined,
      requestContext:
        d.requestContext && typeof d.requestContext === 'object'
          ? (d.requestContext as SeederErrorEvent['requestContext'])
          : undefined,
    };
    enqueueAppend(errorsPath, `${JSON.stringify(errorEvent)}\n`);
  }

  // Update in-memory stats
  stats.session.totalEvents++;
  eventCount++;

  const actionKind = EVENT_TO_ACTION[event.eventType];
  if (actionKind) {
    const bucket = stats.actions[actionKind];
    if (event.success) bucket.success++;
    else if (isSkipped) bucket.skipped++;
    else bucket.error++;
  }

  // Per-persona tracking. Skipped actions count toward actions but not
  // errors (same rationale as the per-action bucket above).
  if (event.persona) {
    if (!stats.personas[event.persona]) {
      stats.personas[event.persona] = { actions: 0, errors: 0, strikes: 0 };
    }
    stats.personas[event.persona].actions++;
    if (!event.success && !isSkipped) stats.personas[event.persona].errors++;
  }

  // Feed refresh tracking
  if (event.eventType === 'feed_refresh') {
    stats.feeds.refreshCount++;
    stats.feeds.lastRefreshedAt = full.timestamp;
    const postCount = (event.details?.postCount as number) ?? 0;
    // Running average
    const n = stats.feeds.refreshCount;
    stats.feeds.avgPostCount =
      stats.feeds.avgPostCount + (postCount - stats.feeds.avgPostCount) / n;
  }

  // Growth tracking
  if (event.eventType === 'growth_tick' && event.success) {
    stats.growth.ticksFired++;
    stats.growth.agentsAdded += (event.details?.agentsAdded as number) ?? 0;
  }

  // Verbose stdout
  if (verbose) {
    const icon = event.success ? pc.green('✓') : pc.red('✗');
    const agent = event.agentname ? pc.cyan(`@${event.agentname}`) : '';
    console.log(`${icon} ${pc.dim(event.eventType)} ${agent} ${event.error ?? ''}`);
  }

  // Auto-flush every N events. Chain the stats write behind the pending
  // events.jsonl / errors.jsonl appends so stats.json can never claim events
  // that haven't hit disk yet. SIGINT / end-of-run paths still call
  // flushStats() directly (sync) — the drainWrites() call at the async exit
  // points covers ordering there.
  if (eventCount >= STATS_FLUSH_THRESHOLD) {
    eventCount = 0;
    queueStatsFlush();
  }
}

export function logSkippedAction(
  kind: ActionKind,
  agentname: string,
  persona: string,
  reason: string,
): void {
  if (!initialized || !stats) return;

  // Bucket increment is handled by logEvent via the `details.skipped` flag
  // so skipped counts, error counts, and errors.jsonl stay consistent.
  logEvent({
    eventType: kind === 'commentLike' ? 'comment_like' : (kind as SeederEventType),
    agentname,
    persona,
    success: false,
    details: { skipped: true, reason },
  });
}

export function logStrike(event: Omit<StrikeEvent, 'timestamp'>): void {
  if (!initialized || !stats) return;

  const full: StrikeEvent = { ...event, timestamp: new Date().toISOString() };
  enqueueAppend(strikesPath, `${JSON.stringify(full)}\n`);

  // Update moderation stats
  stats.moderation.totalStrikes++;
  stats.moderation.byTier[event.tier] = (stats.moderation.byTier[event.tier] ?? 0) + 1;
  stats.moderation.byCategory[event.category] =
    (stats.moderation.byCategory[event.category] ?? 0) + 1;

  // Per-persona strike tracking
  if (event.persona) {
    if (!stats.personas[event.persona]) {
      stats.personas[event.persona] = { actions: 0, errors: 0, strikes: 0 };
    }
    stats.personas[event.persona].strikes++;
  }

  // Also log as a regular event so strikes appear in events.jsonl and
  // errors.jsonl (via logEvent's failure tee).
  logEvent({
    eventType: 'strike',
    agentname: event.agentname,
    persona: event.persona,
    success: false,
    details: {
      contentType: event.contentType,
      tier: event.tier,
      category: event.category,
      action: event.action,
    },
  });
}

export function flushStats(): void {
  if (!initialized || !stats) return;
  stats.lastUpdatedAt = new Date().toISOString();
  stats.session.uptimeMs = Date.now() - Date.parse(stats.session.startedAt);
  try {
    writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  } catch {
    // Best-effort: keep the process alive even if stats can't be flushed.
  }
}

export function updateAgentCounts(registered: number, active: number): void {
  if (!initialized || !stats) return;
  stats.agents.registered = registered;
  stats.agents.active = active;
}

export function getStats(): Readonly<SeederStats> | undefined {
  return stats;
}

/** Current session id (stable across the process lifetime). */
export function getSessionId(): string {
  return sessionId;
}

/** Reset module state — only for tests. */
export function _resetForTest(): void {
  initialized = false;
  stats = undefined;
  eventCount = 0;
  verbose = false;
  sessionId = '';
  writeQueues.clear();
}
