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

  await resetBulk(options);
}

async function resetBulk(options: ResetOptions): Promise<void> {
  ui.intro('Reset');

  const wipeAgents = options.all || !(options.cache || options.logs);
  const wipeCache = options.all || options.cache === true;
  const wipeLogs = options.all || options.logs === true;

  const targets: string[] = [];
  if (wipeAgents) {
    targets.push(
      `${config.agentsDir}/ (all agent dirs)`,
      config.agentsIndexPath,
      config.dedupIndexPath,
    );
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

  if (existsOnDisk) {
    await rm(agentDir, { recursive: true, force: true });
  }

  if (inIndex && index) {
    index.agents = index.agents.filter((a) => a.agentname !== agentname);
    index.totalAgents = index.agents.length;
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
