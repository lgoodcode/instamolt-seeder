/**
 * Per-agent daily action quota, using a sliding-window-of-timestamps model.
 *
 * **Why sliding window, not `windowStart` + reset:** the InstaMolt platform
 * enforces rate limits via Upstash's sliding window algorithm (per-request,
 * not calendar-day) — see `reference_platform_rate_limits.md` in memory.
 * Mirroring the server model client-side means an agent that used its full
 * 80 likes at 2pm cannot burst another 80 at 2:01am the next day; those
 * first 80 must age past 24h first.
 *
 * **State on disk:** `output/agents/<name>/quota.json`, one file per agent.
 * Keeps the per-agent directory layout intact so it's easy to `rm -rf` a
 * broken agent's state without touching anything else.
 *
 * **Substrate-with-fallback:** matches the pattern in
 * [src/lib/dedup-index.ts](./dedup-index.ts) — versioned JSON, validated on
 * read, atomic write-then-rename. Missing/corrupt files are silently
 * recreated with a warning, never hard-fail.
 *
 * **Usage flow** from a continuous-engage action executor:
 *
 *   const quota = await loadOrInitQuota(agent, persona);
 *   const avail = checkAvailability(quota, 'like');
 *   if (!avail.ok) return { status: 'skipped', reason: avail.reason };
 *   // ... do the action against the API ...
 *   consume(quota, 'like');
 *   await persistQuota(quota);
 *
 * `consume` is in-memory only; call `persistQuota` AFTER the action succeeds
 * so a crash between consume and persist just undercounts rather than
 * phantom-consuming a slot that never hit the wire.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACTION_COOLDOWNS_MS, config, QUOTA_CAPS } from '@/config';
import { log } from '@/lib/logger';
import {
  ACTION_KINDS,
  type ActionKind,
  type AgentQuota,
  type GeneratedAgent,
  type Persona,
} from '@/types';

/** Current on-disk schema version for the per-agent quota file. */
export const QUOTA_FILE_VERSION = 1;

/** 24 hours in ms — the default sliding window used by all quota callers. */
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

interface AgentQuotaFileOnDisk extends AgentQuota {
  version: number;
}

/** Build the `output/agents/<name>/quota.json` path for a given agent. */
export function quotaFilePath(agentname: string): string {
  return join(config.agentsDir, agentname, 'quota.json');
}

/**
 * Derive the cap dictionary from a persona via the functions in
 * `config.QUOTA_CAPS`. Extracted as a standalone helper so tests can
 * verify the derivation without touching the filesystem.
 */
export function deriveCapsFromPersona(persona: Persona): Record<ActionKind, number> {
  const caps: Partial<Record<ActionKind, number>> = {};
  for (const kind of ACTION_KINDS) {
    caps[kind] = Math.max(0, QUOTA_CAPS[kind](persona));
  }
  return caps as Record<ActionKind, number>;
}

/** Initial-state quota with zero usage and persona-derived caps. */
export function initQuota(agentname: string, persona: Persona): AgentQuota {
  return {
    agentname,
    history: {
      like: [],
      comment: [],
      reply: [],
      follow: [],
      post: [],
      commentLike: [],
    },
    caps: deriveCapsFromPersona(persona),
    last: {},
  };
}

/**
 * Count the number of timestamps in the given history array that are still
 * within the sliding window. Defaults to 24h. Exported so scheduler code
 * can compute remaining-quota without going through checkAvailability.
 */
export function usedInWindow(history: string[], windowMs: number = QUOTA_WINDOW_MS): number {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (const iso of history) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t >= cutoff) count++;
  }
  return count;
}

/**
 * Trim every history array to the sliding window in-place. Called lazily on
 * load so every consume/check starts from a bounded state. Worst-case daily
 * history per kind is ~80 entries (see `QUOTA_CAPS.like`), so the total file
 * stays in the low-kilobytes range per agent.
 */
export function trimHistory(quota: AgentQuota, windowMs: number = QUOTA_WINDOW_MS): void {
  const cutoff = Date.now() - windowMs;
  for (const kind of ACTION_KINDS) {
    quota.history[kind] = quota.history[kind].filter((iso) => {
      const t = Date.parse(iso);
      return !Number.isNaN(t) && t >= cutoff;
    });
  }
}

/**
 * Count posts in the last hour from the quota history. Used by the
 * per-hour post soft cap to prevent blowing the entire daily post budget
 * in a single peak-hour session.
 */
export function postsInLastHour(quota: AgentQuota): number {
  return usedInWindow(quota.history.post, 60 * 60 * 1000);
}

/**
 * Maximum posts allowed in the current hour given the persona's daily budget
 * and the activity curve weight. Peak hours get up to `ceil(postsPerDay[1] / 4)`,
 * off-peak hours get at most 1. The divisor of 4 assumes ~4 active peaks per
 * day, so peak hours each get a quarter of the daily max.
 */
export function maxPostsThisHour(persona: Persona, curveWeight: number): number {
  const dailyMax = persona.postsPerDay[1] ?? 3;
  // Scale by curve weight: peak (1.0) → full share, off-peak (0.3) → ~1
  return Math.max(1, Math.ceil((dailyMax / 4) * curveWeight));
}

export type AvailabilityResult =
  | { ok: true }
  | { ok: false; reason: 'quota_exhausted' | 'cooldown_active'; retryAtMs?: number };

/**
 * Check whether `kind` is available for this agent right now. Two gates:
 *
 * 1. **Sliding-window quota** — `usedInWindow(history[kind])` must be strictly
 *    less than `caps[kind]`.
 * 2. **Cooldown** — time since `last[kind]` must be ≥ `ACTION_COOLDOWNS_MS[kind]`.
 *
 * Returns `{ ok: false, retryAtMs }` when blocked, so callers can optionally
 * reschedule the agent's next tick around the blocker instead of guessing.
 */
export function checkAvailability(quota: AgentQuota, kind: ActionKind): AvailabilityResult {
  const cap = quota.caps[kind];
  const used = usedInWindow(quota.history[kind]);
  if (used >= cap) {
    // Retry-at is the oldest in-window timestamp + window — that's the
    // earliest moment a slot will age out. If history is empty (cap must
    // be 0), just return a generic exhausted marker.
    const oldest = quota.history[kind]
      .map((t) => Date.parse(t))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b)[0];
    return {
      ok: false,
      reason: 'quota_exhausted',
      retryAtMs: oldest !== undefined ? oldest + QUOTA_WINDOW_MS : undefined,
    };
  }

  const lastIso = quota.last[kind];
  if (lastIso) {
    const lastMs = Date.parse(lastIso);
    if (!Number.isNaN(lastMs)) {
      const since = Date.now() - lastMs;
      const cooldown = ACTION_COOLDOWNS_MS[kind];
      if (since < cooldown) {
        return {
          ok: false,
          reason: 'cooldown_active',
          retryAtMs: lastMs + cooldown,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Record that an action of `kind` was just performed by this agent. Pushes
 * `now` onto the history array AND sets `last[kind]` so cooldown gating
 * catches the next call immediately. Caller persists after success.
 */
export function consume(quota: AgentQuota, kind: ActionKind): void {
  const now = new Date().toISOString();
  quota.history[kind].push(now);
  quota.last[kind] = now;
  // Trim opportunistically so consume keeps the array bounded even without
  // an intervening load. This keeps in-memory state consistent with what
  // persistQuota would write.
  trimHistory(quota);
}

function validateQuotaFile(value: unknown): AgentQuota {
  if (!value || typeof value !== 'object') {
    throw new Error('quota: not an object');
  }
  const v = value as Partial<AgentQuotaFileOnDisk>;
  if (typeof v.version !== 'number') {
    throw new Error('quota: missing version');
  }
  if (v.version !== QUOTA_FILE_VERSION) {
    throw new Error(`quota: unsupported version ${v.version} (expected ${QUOTA_FILE_VERSION})`);
  }
  if (typeof v.agentname !== 'string') {
    throw new Error('quota: missing agentname');
  }
  if (!v.history || typeof v.history !== 'object') {
    throw new Error('quota: missing history');
  }
  if (!v.caps || typeof v.caps !== 'object') {
    throw new Error('quota: missing caps');
  }
  // Fill in any missing action kinds defensively — a persona that gained a
  // new kind in a later release should get an empty history for it, not a
  // crash. The caps will be refreshed from the persona on reload anyway.
  const history: Partial<Record<ActionKind, string[]>> = {};
  const caps: Partial<Record<ActionKind, number>> = {};
  for (const kind of ACTION_KINDS) {
    const h = (v.history as Record<string, unknown>)[kind];
    history[kind] = Array.isArray(h) ? (h.filter((x) => typeof x === 'string') as string[]) : [];
    const c = (v.caps as Record<string, unknown>)[kind];
    caps[kind] = typeof c === 'number' ? c : 0;
  }
  const last: Partial<Record<ActionKind, string>> = {};
  if (v.last && typeof v.last === 'object') {
    for (const kind of ACTION_KINDS) {
      const l = (v.last as Record<string, unknown>)[kind];
      if (typeof l === 'string') last[kind] = l;
    }
  }
  return {
    agentname: v.agentname,
    history: history as Record<ActionKind, string[]>,
    caps: caps as Record<ActionKind, number>,
    last,
  };
}

/**
 * Read + parse + validate the quota file. Throws on missing/corrupt/
 * version-skewed — callers handle with fallback.
 */
export async function readQuotaFile(path: string): Promise<AgentQuota> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateQuotaFile(parsed);
}

/** Atomic write-then-rename so a crash mid-write leaves the old file intact. */
export async function writeQuotaFile(path: string, quota: AgentQuota): Promise<void> {
  const tmp = `${path}.tmp`;
  const onDisk: AgentQuotaFileOnDisk = { version: QUOTA_FILE_VERSION, ...quota };
  await writeFile(tmp, JSON.stringify(onDisk, null, 2));
  await rename(tmp, path);
}

/**
 * Load the per-agent quota file from disk if it exists, or initialize a
 * fresh one. On load, always:
 *
 * - Refresh `caps` from the current persona (so a persona probability
 *   change between runs propagates to the next daily budget).
 * - Trim `history` to the 24h sliding window.
 *
 * Missing file → init new. Corrupt file → log warning, init new. Never
 * hard-fails the caller.
 */
export async function loadOrInitQuota(
  agent: GeneratedAgent,
  persona: Persona,
): Promise<AgentQuota> {
  const path = quotaFilePath(agent.agentname);
  let quota: AgentQuota;
  try {
    quota = await readQuotaFile(path);
  } catch (err) {
    // ENOENT is expected on first run; anything else is worth logging.
    if (!isEnoent(err)) {
      log('warn', `quota: ${path} unreadable (${err}) — reinitializing`);
    }
    return initQuota(agent.agentname, persona);
  }
  // Always refresh caps from the persona — these are a pure function of
  // persona probabilities and should not go stale.
  quota.caps = deriveCapsFromPersona(persona);
  trimHistory(quota);
  return quota;
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && 'code' in err && (err as Error & { code?: string }).code === 'ENOENT'
  );
}

/**
 * Persist the quota file to disk. Trims first so the on-disk representation
 * matches an in-memory snapshot of `loadOrInitQuota`. Swallows write errors
 * as warnings — a failed persist should not cancel the action that already
 * landed on the server.
 */
export async function persistQuota(quota: AgentQuota): Promise<void> {
  trimHistory(quota);
  const path = quotaFilePath(quota.agentname);
  try {
    await writeQuotaFile(path, quota);
  } catch (err) {
    log('warn', `quota: failed to persist ${path} — ${err}`);
  }
}
