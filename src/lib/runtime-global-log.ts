/**
 * Cross-agent runtime comment log. Records every successful top-level comment
 * and reply the seeder posts, keyed by post id, so engage's same-register cap
 * can ask "how many recent seeder comments on this post used register X?"
 * without reading every agent's `runtime-comments.json`.
 *
 * **Why a new log (not `runtime-comments.json`):**
 * `runtime-comments.json` is per-agent, designed to feed each agent's own
 * avoid-list. It doesn't have a `postId → recent registers` index and
 * scanning every agent directory on every comment attempt would scale
 * quadratically with population size.
 *
 * **Format:** append-only JSONL at `{config.logsDir}/runtime-comments-global.jsonl`.
 * Each line is one {@link RuntimeGlobalLogEntry}. Tail-read on every `engage`
 * comment attempt — a 10k-entry file parses in <5ms.
 *
 * **Scope:** seeder-only. Non-seeder comments (real users on the live
 * platform) don't have a `registerHint` to classify and we don't spend a
 * Gemini call to infer one. If real users flood a thread with disagrees, the
 * cap is moot — acceptable trade.
 *
 * See plan C:/Users/Lawrence/.claude/plans/twinkly-swinging-ripple.md §P2 / §3.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '@/config';
import { log } from '@/lib/logger';
import type { CommentRegister } from '@/types';

/** Filename (inside `config.logsDir`) for the cross-agent register log. */
export const RUNTIME_GLOBAL_LOG_FILENAME = 'runtime-comments-global.jsonl';

/**
 * One record per successful runtime comment/reply. `register` is omitted when
 * the call site had no `registerHint` (no relationship between commenter and
 * post author) — readers treat that as "unclassified" and it's never counted
 * toward the cap.
 */
export interface RuntimeGlobalLogEntry {
  /** ISO timestamp. */
  ts: string;
  /** Platform post id the comment/reply landed on. */
  postId: string;
  /** Agent that posted the comment. */
  agentname: string;
  /** Register hint that was passed to Gemini; `undefined` when there was no
   * relationship-driven hint. Stored literally so readers can distinguish
   * "unclassified" from "conversational" etc. */
  register?: CommentRegister;
  /** Whether this record was from a top-level comment or a nested reply.
   * Replies are recorded so post-level cap queries see them too. */
  kind: 'comment' | 'reply';
}

function globalLogPath(): string {
  return join(config.logsDir, RUNTIME_GLOBAL_LOG_FILENAME);
}

/**
 * Append one record to the global log. Never throws — a write failure is
 * logged as a warning and the engage cycle proceeds (degraded observability,
 * but not a blocked action). Same-register cap tolerates missing entries.
 */
export async function appendGlobalComment(entry: Omit<RuntimeGlobalLogEntry, 'ts'>): Promise<void> {
  const full: RuntimeGlobalLogEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };
  const path = globalLogPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(full)}\n`, 'utf-8');
  } catch (err) {
    log('warn', `runtime-global-log: append failed — ${err}`);
  }
}

/**
 * Return the registers of recent seeder comments on `postId` within the given
 * window. `undefined` entries (unclassified — no relationship hint) are
 * dropped from the result so callers only see the classifiable population.
 *
 * Implementation: full-file read + filter. The file is append-only JSONL
 * with small records; at 10k entries this is sub-5ms on any modern disk.
 * Once the log starts eating meaningful RAM we can switch to a tail reader
 * keyed by file offset, but not before.
 */
export async function recentRegistersForPost(
  postId: string,
  withinMs: number,
  now: number = Date.now(),
): Promise<CommentRegister[]> {
  const path = globalLogPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return [];
  }

  const cutoff = now - withinMs;
  const out: CommentRegister[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: RuntimeGlobalLogEntry;
    try {
      parsed = JSON.parse(line) as RuntimeGlobalLogEntry;
    } catch {
      continue;
    }
    if (parsed.postId !== postId) continue;
    if (!parsed.register) continue;
    const parsedMs = Date.parse(parsed.ts);
    if (!Number.isFinite(parsedMs) || parsedMs < cutoff) continue;
    out.push(parsed.register);
  }
  return out;
}
