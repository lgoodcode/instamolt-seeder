/**
 * Read-only curation CLI for the lore registry.
 *
 * Walks `output/lore-registry.json` and prints groups + entries to the
 * terminal so the operator can eyeball voice + variety without booting
 * the engage loop. Optional flags:
 *   - `--archetype <id>` — filter by archetype id (e.g. `cult`).
 *   - `--agent <name>` — filter to groups this agent is a member of.
 *   - `--limit <N>` — cap the number of groups printed.
 *
 * Aborts cleanly when the registry is missing — operator runs `pnpm
 * seed-lore` first.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import * as ui from '@/lib/ui';
import {
  getArchetype,
  groupsForAgent,
  type LoreArchetype,
  LoreRegistryMissingError,
  loadRegistryStrict,
} from '@/lore/index';
import type { GeneratedAgent, LoreArchetypeId, LoreGroup } from '@/types';

export interface PreviewLoreOptions {
  archetype?: string;
  agent?: string;
  limit?: number;
}

async function loadAllAgents(): Promise<GeneratedAgent[]> {
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as { agents: GeneratedAgent[] };
    if (Array.isArray(parsed.agents) && parsed.agents.length > 0) return parsed.agents;
  } catch {
    // fall through
  }
  const agents: GeneratedAgent[] = [];
  try {
    const dirs = await readdir(config.agentsDir);
    for (const dir of dirs) {
      try {
        const raw = await readFile(join(config.agentsDir, dir, 'agent.json'), 'utf-8');
        agents.push(JSON.parse(raw) as GeneratedAgent);
      } catch {
        // skip — corrupt or missing agent.json
      }
    }
  } catch {
    // no agents dir
  }
  return agents;
}

function archetypeBadge(archetype: LoreArchetype): string {
  return ui.color.bold(ui.color.magenta(`[${archetype.label}]`));
}

function renderGroup(group: LoreGroup): string {
  const archetype = getArchetype(group.archetype);
  const head = `${archetypeBadge(archetype)} ${ui.color.cyan(group.name)}`;
  const memberLine = `${ui.color.dim('members:')} ${group.agentnames.length} agents${
    group.personaIds.length > 0 ? ` across ${group.personaIds.length} persona(s)` : ''
  } ${ui.color.dim(`(${group.membershipMode})`)}`;
  const vibe = `${ui.color.dim('vibe:')} ${group.vibe}`;
  const entries = group.entries
    .map(
      (e) =>
        `  ${ui.color.dim('•')} [${e.kind}] ${e.text}${
          e.referenceCount > 0 ? ui.color.dim(` (${e.referenceCount}×)`) : ''
        }`,
    )
    .join('\n');
  return `${head}\n  ${memberLine}\n  ${vibe}\n${entries || `  ${ui.color.dim('(no entries)')}`}\n`;
}

export async function previewLore(options: PreviewLoreOptions = {}): Promise<void> {
  ui.intro('preview-lore');

  let registry: Awaited<ReturnType<typeof loadRegistryStrict>>;
  try {
    registry = await loadRegistryStrict();
  } catch (err) {
    if (err instanceof LoreRegistryMissingError) {
      ui.note(
        'no registry',
        'output/lore-registry.json is missing. Run `pnpm seed-lore` (or `pnpm generate` which auto-bakes lore) first.',
      );
      ui.outro(ui.color.red(`${ui.symbol.err} preview-lore aborted`));
      return;
    }
    throw err;
  }

  const archetypeFilter = options.archetype as LoreArchetypeId | undefined;
  let groups = registry.groups;
  if (archetypeFilter) {
    groups = groups.filter((g) => g.archetype === archetypeFilter);
  }
  if (options.agent) {
    const agents = await loadAllAgents();
    const lookup = new Map(agents.map((a) => [a.agentname, a.personaId]));
    groups = groupsForAgent({ ...registry, groups }, options.agent, lookup);
  }
  if (options.limit !== undefined && options.limit > 0) {
    groups = groups.slice(0, options.limit);
  }

  if (groups.length === 0) {
    ui.note('no groups matched', 'Try removing filters or running `pnpm seed-lore --force`.');
    ui.outro(ui.color.green(`${ui.symbol.ok} preview-lore done`));
    return;
  }

  for (const group of groups) {
    console.log(renderGroup(group));
  }
  ui.note(
    'preview',
    ui.summaryLine([
      { label: 'groups shown', value: groups.length, tone: 'ok' },
      { label: 'total in registry', value: registry.groups.length, tone: 'info' },
      {
        label: 'entries shown',
        value: groups.reduce((s, g) => s + g.entries.length, 0),
        tone: 'info',
      },
    ]),
  );
  ui.outro(ui.color.green(`${ui.symbol.ok} preview-lore done`));
}
