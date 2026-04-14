/**
 * Shared helpers for loading the agent's comment avoid-list and appending
 * runtime-posted comments to disk. Used by the continuous engage action
 * executors (`src/lib/engage-actions.ts`).
 *
 * The cycle-mode `src/commands/engage.ts` keeps its own private copies of
 * these helpers — intentionally untouched per the "don't rewrite working
 * code" rule. Shape is a strict superset: new fields (`parentCommentId`,
 * `depth`, `repliedToActivityId`) are optional and older readers ignore
 * them.
 *
 * **Avoid list model:** bake-time samples live in `comments.json` (pristine,
 * written by `generate`) and the rolling runtime tail lives in
 * `runtime-comments.json` (capped at `RUNTIME_COMMENTS_MAX`). `loadPriorComments`
 * concatenates both into a single `string[]` for the LLM's avoid-list slice.
 * Keeping them separate means `comments.json` stays editable for curation
 * and `runtime-comments.json` absorbs the day-to-day drift.
 *
 * See [docs/BLUEPRINT.md §5.X] for the on-disk layout.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { log } from '@/lib/logger';
import type { AgentCommentsFile, RuntimeCommentEntry, RuntimeCommentsFile } from '@/types';

/**
 * Maximum runtime comments retained per agent. Keeps the avoid-list bounded
 * so an agent running in continuous mode for weeks doesn't snowball into a
 * multi-MB file. The inner `slice(-6)` in `generateComment` / `generateReply`
 * would cap the prompt payload anyway, but a tight on-disk cap keeps the
 * file readable and the load fast.
 */
export const RUNTIME_COMMENTS_MAX = 50;

/**
 * Load the agent's comment avoid-list: bake-time `comments.json` samples
 * (pristine, persona/voice anchors) PLUS the rolling `runtime-comments.json`
 * tail (what this agent has actually been saying lately). Both files missing
 * is silently treated as an empty avoid-list.
 *
 * Bake-time samples appear FIRST in the returned list so the most-recent
 * runtime entries always make the `slice(-6)` cut inside the LLM layer —
 * keeping the prompt anchored in fresh voice rather than stale examples.
 */
export async function loadPriorComments(agentname: string): Promise<string[]> {
  const out: string[] = [];

  // Bake-time samples.
  try {
    const raw = await readFile(join(config.agentsDir, agentname, 'comments.json'), 'utf-8');
    const parsed = JSON.parse(raw) as AgentCommentsFile;
    if (Array.isArray(parsed.samples)) {
      for (const s of parsed.samples) {
        if (typeof s.text === 'string' && s.text.length > 0) out.push(s.text);
      }
    }
  } catch {}

  // Runtime tail.
  try {
    const raw = await readFile(join(config.agentsDir, agentname, 'runtime-comments.json'), 'utf-8');
    const parsed = JSON.parse(raw) as RuntimeCommentsFile;
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (c && typeof c.text === 'string' && c.text.length > 0) out.push(c.text);
      }
    }
  } catch {}

  return out;
}

/**
 * Load the agent's full runtime-comments file (including the structured
 * entries with `parentCommentId`, `repliedToActivityId`, etc.). Used by
 * `executeActivityDrivenReply` for dedup — we don't reply to the same
 * inbound activity twice.
 */
export async function loadRuntimeCommentsFile(agentname: string): Promise<RuntimeCommentsFile> {
  const path = join(config.agentsDir, agentname, 'runtime-comments.json');
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as RuntimeCommentsFile;
    return {
      agentname,
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    };
  } catch {
    return { agentname, comments: [] };
  }
}

/**
 * Append a freshly-posted comment entry to `runtime-comments.json`, trimming
 * to the last `RUNTIME_COMMENTS_MAX` entries. Write failures are logged as
 * warnings but do not throw — a missing runtime cache entry simply means
 * the next cycle has a slightly shorter avoid-list.
 *
 * Uses read-modify-write. Concurrent continuous-engage instances against
 * the same agent would race here, but the scheduler processes ticks
 * sequentially within a single process, so no race today.
 */
export async function appendRuntimeComment(
  agentname: string,
  entry: Omit<RuntimeCommentEntry, 'generatedAt'>,
): Promise<void> {
  const path = join(config.agentsDir, agentname, 'runtime-comments.json');
  const existing = await loadRuntimeCommentsFile(agentname);

  existing.comments.push({
    ...entry,
    generatedAt: new Date().toISOString(),
  });

  if (existing.comments.length > RUNTIME_COMMENTS_MAX) {
    existing.comments = existing.comments.slice(-RUNTIME_COMMENTS_MAX);
  }

  try {
    await writeFile(path, JSON.stringify(existing, null, 2), 'utf-8');
  } catch (err) {
    log('warn', `runtime-comments: failed to append for @${agentname} — ${err}`);
  }
}
