/**
 * Reset / clear generated output files.
 *
 * Scopes, in order of blast radius:
 *   - bare (no flags): wipe `output/agents/`, `output/agents.json`, and
 *     `output/dedup-index.json`. Personas, feed cache, and logs preserved.
 *   - `--agent <name>`: delete a single agent's directory, remove its entry
 *     from `agents.json`, and strip it from `dedup-index.json`. Scoped
 *     surgery — no other agent is touched.
 *   - `--persona <id>`: delete a single persona JSON and regenerate it via
 *     Gemini (with the remaining personas as progressive context and the
 *     canonical catalog as few-shot anchors). Agents assigned to that
 *     persona are NOT deleted — they inherit the regenerated attributes.
 *   - `--cache`: wipe `feed-cache.json` + `dedup-index.json`.
 *   - `--logs`: wipe `output/logs/`.
 *   - `--all`: agents + cache + logs (personas always preserved — use
 *     `seed-personas --force` to wipe personas).
 *
 * Personas are never wiped by `reset` — they are expensive to regenerate and
 * usually the thing you want to keep across iteration cycles.
 *
 * `agents.json` contains live API keys for agents registered on
 * instamolt.app. Wiping locally does NOT deregister them remotely — those
 * agents become orphaned on the platform. The interactive confirmation makes
 * this explicit.
 */

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { readDedupIndex, writeDedupIndex } from '@/lib/dedup-index';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { _resetPersonaCache, PERSONA_CATALOG } from '@/personas/index';
import { generatePersona } from '@/services/llm';
import type { AgentsIndex, Persona } from '@/types';

export interface ResetOptions {
  /** Delete a single agent by agentname and strip it from indices. */
  agent?: string;
  /** Delete a single persona JSON and regenerate via Gemini. */
  persona?: string;
  /** Wipe feed-cache.json + dedup-index.json. */
  cache?: boolean;
  /** Wipe output/logs/. */
  logs?: boolean;
  /** Wipe agents + cache + logs (personas preserved). */
  all?: boolean;
  /**
   * Rewind every agent to "just finished `pnpm generate`" state — keep drafts
   * (bio, posts, comments.json) and persona assignments, but strip every
   * artifact written by `publish` / `engage` / `engage-continuous`. For fast
   * iteration cycles against the seed DB: after a debug run, rewind with this
   * flag and the next `publish-drafts` invocation re-registers from scratch.
   */
  postGenerate?: boolean;
  /** Skip interactive confirmation. */
  force?: boolean;
}

export async function reset(options: ResetOptions = {}): Promise<void> {
  // Scoped flags take precedence over bulk flags — `--agent` and `--persona`
  // are surgical operations that shouldn't combine with `--all`.
  if (options.agent) {
    await resetSingleAgent(options.agent, options.force ?? false);
    return;
  }
  if (options.persona) {
    await resetSinglePersona(options.persona, options.force ?? false);
    return;
  }
  if (options.postGenerate) {
    await resetToPostGenerate(options.force ?? false);
    return;
  }

  await resetBulk(options);
}

/** Typed token the operator must enter to confirm a bulk wipe of agents. */
const TYPED_CONFIRMATION_TOKEN = 'DELETE';

/**
 * Count agents for the typed-confirmation gate. `agents.json` is the
 * authoritative source — it's the only file that tracks registered API keys,
 * so a wipe with agents in the index (even if `output/agents/` is missing)
 * still orphans live accounts. Falls back to a directory-only count when the
 * index is missing/corrupt, filtering to subdirectories so stray files (e.g.
 * `.DS_Store`, temp artifacts) don't inflate the count.
 */
async function countAgentsForConfirmation(): Promise<number> {
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const index = JSON.parse(raw) as AgentsIndex;
    if (Array.isArray(index.agents)) return index.agents.length;
  } catch {
    // Fall through to disk-based fallback.
  }
  try {
    const entries = await readdir(config.agentsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function resetBulk(options: ResetOptions): Promise<void> {
  ui.intro('Reset');

  const wipeAgents = options.all || !(options.cache || options.logs);
  const wipeCache = options.all || options.cache === true;
  const wipeLogs = options.all || options.logs === true;
  const agentCount = wipeAgents ? await countAgentsForConfirmation() : 0;

  const targets: string[] = [];
  if (wipeAgents) {
    const label =
      agentCount > 0
        ? `${config.agentsDir}/ (${agentCount} agent${agentCount === 1 ? '' : 's'})`
        : `${config.agentsDir}/ (empty or missing)`;
    targets.push(label, config.agentsIndexPath, config.dedupIndexPath);
  }
  if (wipeCache) {
    if (!targets.includes(config.dedupIndexPath)) targets.push(config.dedupIndexPath);
    targets.push(config.feedCachePath);
  }
  if (wipeLogs) {
    targets.push(`${config.logsDir}/`);
  }

  ui.note(
    'Will delete',
    [
      ...targets.map((t) => `${ui.color.red(ui.symbol.dot)} ${t}`),
      '',
      ui.color.yellow(
        `${ui.symbol.warn} agents.json contains live API keys — wiping here does NOT deregister agents on instamolt.app`,
      ),
      ui.color.dim('Personas are preserved. Use `seed-personas --force` to wipe personas.'),
    ].join('\n'),
  );

  if (!options.force) {
    const ok = await ui.confirm('Proceed?', false);
    if (!ok) {
      ui.outro(ui.color.yellow(`${ui.symbol.warn} aborted`));
      return;
    }

    // Second gate for agent wipes — a single stray Enter shouldn't be enough
    // to nuke a populated agent pool. `--force` skips both gates for CI /
    // docker run --force flows.
    if (wipeAgents && agentCount > 0) {
      const typed = await ui.text(
        `Type ${ui.color.bold(TYPED_CONFIRMATION_TOKEN)} to confirm wiping ${agentCount} agent${agentCount === 1 ? '' : 's'}`,
      );
      if (typed !== TYPED_CONFIRMATION_TOKEN) {
        ui.outro(ui.color.yellow(`${ui.symbol.warn} aborted — confirmation token mismatch`));
        return;
      }
    }
  }

  if (wipeAgents) {
    await rm(config.agentsDir, { recursive: true, force: true });
    await rm(config.agentsIndexPath, { force: true });
    await rm(config.dedupIndexPath, { force: true });
    log('info', 'wiped agents/, agents.json, dedup-index.json');
  }
  if (wipeCache) {
    await rm(config.feedCachePath, { force: true });
    if (!wipeAgents) await rm(config.dedupIndexPath, { force: true });
    log('info', 'wiped feed-cache.json + dedup-index.json');
  }
  if (wipeLogs) {
    await rm(config.logsDir, { recursive: true, force: true });
    log('info', `wiped ${config.logsDir}/`);
  }

  ui.outro(ui.color.green(`${ui.symbol.ok} reset done`));
}

async function resetSingleAgent(agentname: string, force: boolean): Promise<void> {
  ui.intro(`Reset agent — ${agentname}`);

  const agentDir = join(config.agentsDir, agentname);
  let existsOnDisk = true;
  try {
    await readdir(agentDir);
  } catch {
    existsOnDisk = false;
  }

  let index: AgentsIndex | null = null;
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    index = JSON.parse(raw) as AgentsIndex;
  } catch {
    index = null;
  }

  const inIndex = index?.agents.some((a) => a.agentname === agentname) ?? false;

  if (!existsOnDisk && !inIndex) {
    ui.outro(ui.color.yellow(`${ui.symbol.warn} agent "${agentname}" not found`));
    return;
  }

  ui.note(
    'Will delete',
    [
      existsOnDisk
        ? `${ui.color.red(ui.symbol.dot)} ${agentDir}/`
        : ui.color.dim(`(no dir on disk at ${agentDir})`),
      inIndex
        ? `${ui.color.red(ui.symbol.dot)} entry in ${config.agentsIndexPath}`
        : ui.color.dim('(not in agents.json)'),
      `${ui.color.red(ui.symbol.dot)} entry in ${config.dedupIndexPath} (if present)`,
      '',
      ui.color.yellow(
        `${ui.symbol.warn} if this agent was published, its API key is gone — it becomes orphaned on instamolt.app`,
      ),
    ].join('\n'),
  );

  if (!force) {
    const ok = await ui.confirm('Proceed?', false);
    if (!ok) {
      ui.outro(ui.color.yellow(`${ui.symbol.warn} aborted`));
      return;
    }
  }

  // Count this agent's posts before rm'ing so we can keep `agents.json`
  // internally consistent (status and other tooling read `totalPosts` and
  // would otherwise report stale numbers after a targeted reset).
  let deletedPostCount = 0;
  if (existsOnDisk) {
    try {
      const entries = await readdir(agentDir);
      deletedPostCount = entries.filter((e) => e.startsWith('post-') && e.endsWith('.json')).length;
    } catch {
      // Missing or unreadable — nothing to subtract.
    }
    await rm(agentDir, { recursive: true, force: true });
  }

  if (inIndex && index) {
    index.agents = index.agents.filter((a) => a.agentname !== agentname);
    index.totalAgents = index.agents.length;
    index.totalPosts = Math.max(0, index.totalPosts - deletedPostCount);
    await writeFile(config.agentsIndexPath, JSON.stringify(index, null, 2));
  }

  await removeAgentFromDedupIndex(agentname);

  ui.outro(ui.color.green(`${ui.symbol.ok} deleted ${agentname}`));
}

async function removeAgentFromDedupIndex(agentname: string): Promise<void> {
  let index: Awaited<ReturnType<typeof readDedupIndex>>;
  try {
    index = await readDedupIndex(config.dedupIndexPath);
  } catch {
    // Missing, corrupt, or wrong version — nothing to update. `generate`
    // rebuilds it on next run.
    return;
  }

  let mutated = false;
  for (const bucket of Object.values(index.personas)) {
    if (!bucket?.agents) continue;
    const before = bucket.agents.length;
    bucket.agents = bucket.agents.filter((a) => a.agentname !== agentname);
    if (bucket.agents.length !== before) mutated = true;
  }

  if (mutated) {
    await writeDedupIndex(config.dedupIndexPath, index);
  }
}

async function resetSinglePersona(personaId: string, force: boolean): Promise<void> {
  ui.intro(`Reset persona — ${personaId}`);

  const personaPath = join(config.personasDir, `${personaId}.json`);
  let current: Persona | null = null;
  try {
    current = JSON.parse(await readFile(personaPath, 'utf-8')) as Persona;
  } catch {
    current = null;
  }

  if (!current) {
    ui.outro(
      ui.color.yellow(`${ui.symbol.warn} persona "${personaId}" not found at ${personaPath}`),
    );
    return;
  }

  // Count agents currently pointing at this persona so the user knows what
  // inherits the regenerated attributes.
  const agentsOnPersona: string[] = [];
  try {
    const entries = await readdir(config.agentsDir);
    for (const name of entries) {
      try {
        const raw = await readFile(join(config.agentsDir, name, 'agent.json'), 'utf-8');
        const parsed = JSON.parse(raw) as { agentname?: string; personaId?: string };
        if (parsed.personaId === personaId && parsed.agentname) {
          agentsOnPersona.push(parsed.agentname);
        }
      } catch {}
    }
  } catch {}

  ui.note(
    'Will regenerate',
    [
      `${ui.color.red(ui.symbol.dot)} overwrite ${personaPath} with regenerated persona data`,
      `${ui.color.green(ui.symbol.dot)} regenerate via Gemini (catalog as few-shot anchors)`,
      '',
      agentsOnPersona.length > 0
        ? ui.color.yellow(
            `${ui.symbol.warn} ${agentsOnPersona.length} existing agents reference this persona — they will inherit the new attributes`,
          )
        : ui.color.dim('(no existing agents reference this persona)'),
    ].join('\n'),
  );

  if (!force) {
    const ok = await ui.confirm('Proceed?', false);
    if (!ok) {
      ui.outro(ui.color.yellow(`${ui.symbol.warn} aborted`));
      return;
    }
  }

  // Load the remaining personas as progressive context (so the regenerated
  // persona stays distinct from everything else on disk).
  const others = await loadOtherPersonas(personaId);

  const sp = ui.spinner();
  sp.start(`Regenerating ${personaId} via Gemini`);
  let fresh: Persona;
  try {
    fresh = await generatePersona(others, PERSONA_CATALOG);
  } catch (err) {
    sp.stop(`generatePersona failed: ${err}`, 1);
    throw err;
  }

  // Preserve the original id so existing agents keep pointing at a valid
  // persona — Gemini would otherwise coin a new id. Everything else (name,
  // bio style, thresholds, etc.) comes from the fresh regeneration.
  fresh.id = personaId;

  await writeFile(personaPath, JSON.stringify(fresh, null, 2));
  _resetPersonaCache();
  sp.stop(`Regenerated ${personaId}`);

  ui.outro(ui.color.green(`${ui.symbol.ok} persona ${personaId} regenerated`));
}

/**
 * Fields written to `agent.json` by `publish` (apiKey, registeredAt,
 * avatarUrl, avatarGeneratedAt, avatarGenerationSeed) and `engage`
 * (lastCommentedAt). Stripped by `--post-generate` so a subsequent
 * `publish-drafts` re-registers the agent from scratch — including a fresh
 * avatar on the new remote account.
 *
 * Why the avatar fields must go: `--post-generate` drops `apiKey`, so the
 * next `publish-drafts` creates a new platform agent record. The stored
 * `avatarUrl` belongs to the old (now orphaned) remote account. If we kept
 * it, `publish`'s `needsAvatar` gate (`apiKey && !avatarUrl`) would
 * short-circuit and the re-registered agent would stay avatarless on the
 * platform while its local JSON pointed at a stale CDN file. Strip them so
 * the next publish pass regenerates.
 *
 * Preserved: `avatarPrompt`. That's pre-registration (baked by `generate`
 * via Gemini) and is reused by the next publish pass to produce the new
 * avatar — no need to re-run the Gemini prompt-drafting step.
 */
const PUBLISH_ENGAGE_AGENT_FIELDS = [
  'apiKey',
  'registeredAt',
  'lastCommentedAt',
  'avatarUrl',
  'avatarGeneratedAt',
  'avatarGenerationSeed',
] as const;

/**
 * Fields written to `post-*.json` by `publish` when it successfully lands the
 * post on instamolt.app. Stripping them makes the draft eligible for a fresh
 * publish attempt on the next `publish-drafts` run.
 */
const PUBLISH_POST_FIELDS = ['published', 'publishedAt', 'instamoltPostId'] as const;

/**
 * Per-agent sibling files written during engage cycles. Blown away by
 * `--post-generate` so the agent starts the next publish/engage round with a
 * clean runtime state:
 *   - `runtime-comments.json` — rolling tail of comments posted during engage
 *   - `activity.jsonl`        — per-agent event log tee
 */
const ENGAGE_AGENT_SIBLING_FILES = ['runtime-comments.json', 'activity.jsonl'] as const;

/**
 * Rewind every agent to "just finished `pnpm generate`" state without
 * touching the draft content itself. Preserved: bio, post drafts, baked
 * `comments.json`, persona assignments, `dedup-index.json`. Wiped: every
 * field written by `publish` / `engage`, plus `runtime-comments.json`,
 * `activity.jsonl`, `output/logs/`, and `feed-cache.json`.
 */
async function resetToPostGenerate(force: boolean): Promise<void> {
  ui.intro('Reset → post-generate state');

  const agentNames = await listAgentDirs();
  const agentCount = agentNames.length;

  ui.note(
    'Will rewind',
    [
      `${ui.color.red(ui.symbol.dot)} strip apiKey / registeredAt / lastCommentedAt / avatarUrl / avatarGeneratedAt / avatarGenerationSeed from ${agentCount} agent.json file${agentCount === 1 ? '' : 's'} + agents.json entries`,
      `${ui.color.red(ui.symbol.dot)} strip published / publishedAt / instamoltPostId from every post-*.json`,
      `${ui.color.red(ui.symbol.dot)} delete per-agent runtime-comments.json + activity.jsonl`,
      `${ui.color.red(ui.symbol.dot)} delete ${config.logsDir}/ and ${config.feedCachePath}`,
      '',
      ui.color.dim(
        'Preserved: bios, post drafts, comments.json, personas, dedup-index.json, avatarPrompt (avatar image regenerates on next publish against the new account).',
      ),
      ui.color.yellow(
        `${ui.symbol.warn} agents registered against instamolt.app keep their remote accounts — the local apiKey is lost, so they become orphaned on the platform`,
      ),
    ].join('\n'),
  );

  if (!force) {
    const ok = await ui.confirm('Proceed?', false);
    if (!ok) {
      ui.outro(ui.color.yellow(`${ui.symbol.warn} aborted`));
      return;
    }
  }

  let strippedAgents = 0;
  let strippedPosts = 0;
  let deletedSiblings = 0;

  for (const name of agentNames) {
    const agentDir = join(config.agentsDir, name);
    const agentJsonPath = join(agentDir, 'agent.json');
    try {
      const raw = await readFile(agentJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      let mutated = false;
      for (const field of PUBLISH_ENGAGE_AGENT_FIELDS) {
        if (field in parsed) {
          delete parsed[field];
          mutated = true;
        }
      }
      if (mutated) {
        await writeFile(agentJsonPath, JSON.stringify(parsed, null, 2));
        strippedAgents++;
      }
    } catch {
      // Missing agent.json means the agent dir is malformed — skip.
    }

    let entries: string[] = [];
    try {
      entries = await readdir(agentDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith('post-') || !entry.endsWith('.json')) continue;
      const postPath = join(agentDir, entry);
      try {
        const raw = await readFile(postPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        let mutated = false;
        for (const field of PUBLISH_POST_FIELDS) {
          if (field in parsed) {
            delete parsed[field];
            mutated = true;
          }
        }
        if (mutated) {
          await writeFile(postPath, JSON.stringify(parsed, null, 2));
          strippedPosts++;
        }
      } catch {
        // Unreadable or invalid JSON — leave it alone.
      }
    }

    for (const sibling of ENGAGE_AGENT_SIBLING_FILES) {
      const siblingPath = join(agentDir, sibling);
      if (!entries.includes(sibling)) continue;
      await rm(siblingPath, { force: true });
      deletedSiblings++;
    }
  }

  // Rewrite agents.json so `status` and other tooling don't report the
  // stale apiKey/registeredAt from the in-index copy of each agent.
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const index = JSON.parse(raw) as AgentsIndex;
    if (Array.isArray(index.agents)) {
      for (const agent of index.agents) {
        for (const field of PUBLISH_ENGAGE_AGENT_FIELDS) {
          delete (agent as unknown as Record<string, unknown>)[field];
        }
      }
      await writeFile(config.agentsIndexPath, JSON.stringify(index, null, 2));
    }
  } catch {
    // Missing or corrupt agents.json — nothing to strip. `generate` rebuilds it.
  }

  await rm(config.logsDir, { recursive: true, force: true });
  await rm(config.feedCachePath, { force: true });

  log(
    'info',
    `post-generate reset: ${strippedAgents} agent.json, ${strippedPosts} posts, ${deletedSiblings} runtime sibling files, wiped logs/ + feed-cache.json`,
  );
  ui.outro(ui.color.green(`${ui.symbol.ok} rewound ${agentCount} agents to post-generate state`));
}

/**
 * List subdirectories under `output/agents/`. Filters out stray files so the
 * post-generate walk doesn't trip over `.DS_Store` or similar. Returns an
 * empty array when the directory is missing.
 */
async function listAgentDirs(): Promise<string[]> {
  try {
    const entries = await readdir(config.agentsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadOtherPersonas(excludeId: string): Promise<Persona[]> {
  const out: Persona[] = [];
  try {
    const files = await readdir(config.personasDir);
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      if (f === `${excludeId}.json`) continue;
      try {
        const raw = await readFile(join(config.personasDir, f), 'utf-8');
        out.push(JSON.parse(raw) as Persona);
      } catch {}
    }
  } catch {}
  return out;
}
