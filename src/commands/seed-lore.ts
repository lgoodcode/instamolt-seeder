/**
 * Bake-time lore synthesis.
 *
 * Builds the population-wide `output/lore-registry.json` from:
 *   - the seeded persona catalog (read via `loadPersonas()`)
 *   - the master agent index (`output/agents.json`)
 *   - the affinity matrix (`computeAffinityMatrix` from follow-algorithm)
 *   - the abstract archetype catalog (`src/lore/catalog.ts`)
 *
 * Two entry points:
 *   - `synthesizeLoreRegistry` — the inner pipeline. Called from
 *     `generate.ts` after agents + posts are written, before the comment
 *     bake phase. No session events; just runs and returns the registry.
 *   - `seedLoreCommand` — outer command wrapper. Adds session_start /
 *     session_end events + UI shell. Used when the operator runs
 *     `pnpm seed-lore` standalone.
 *
 * Idempotent by default: skips group-seeds whose stable id already exists
 * in the on-disk registry. `--force` wipes and rebuilds.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '@/config';
import { mapWithConcurrency } from '@/lib/concurrency';
import { drainWrites, flushStats, initEventLogger, logEvent } from '@/lib/event-logger';
import { computeAffinityMatrix } from '@/lib/follow-algorithm';
import * as ui from '@/lib/ui';
import {
  allocateGroupBudget,
  clusterAllArchetypes,
  emptyRegistry,
  getArchetype,
  type LoreGroupSeed,
  loadRegistry,
  writeRegistryFile,
} from '@/lore/index';
import { loadPersonas } from '@/personas/index';
import { generateLoreEntries, generateLoreGroup } from '@/services/llm';
import type { GeneratedAgent, LoreEntry, LoreGroup, LoreRegistryFile } from '@/types';

export interface SeedLoreOptions {
  /** Total number of groups to synthesize. Default `config.loreDefaultGroupCount`. */
  groups?: number;
  /** Lore entries per group. Default `config.loreEntriesPerGroup`. */
  entriesPerGroup?: number;
  /** Wipe the existing registry before regenerating. Default false. */
  force?: boolean;
  /** Skip Gemini (clustering only — useful for dry-run + tests). */
  dryRun?: boolean;
  /** Quiet mode for callers that own the UI surface (e.g. `generate.ts`). */
  silent?: boolean;
}

export interface SeedLoreSummary {
  registry: LoreRegistryFile;
  fresh: number;
  carriedOver: number;
  totalGroups: number;
  totalEntries: number;
}

async function loadAllAgents(): Promise<GeneratedAgent[]> {
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as { agents: GeneratedAgent[] };
    if (Array.isArray(parsed.agents) && parsed.agents.length > 0) return parsed.agents;
  } catch {
    // fall through — no index yet
  }
  return [];
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Synthesize a single group from its pre-LLM seed. Pulls archetype
 * metadata, calls Gemini twice (group, entries), assembles the final
 * `LoreGroup`. Returns `null` when the group is suppressed (currently
 * never — synthesis falls back to defaults rather than returning null).
 */
async function synthesizeGroup(
  seed: LoreGroupSeed,
  personasById: Map<string, { id: string; tagline: string }>,
  entriesPerGroup: number,
  dryRun: boolean,
): Promise<LoreGroup> {
  const archetype = getArchetype(seed.archetype);
  const personas = seed.personaIds
    .map((id) => personasById.get(id))
    .filter((p): p is { id: string; tagline: string } => p !== undefined);

  if (dryRun) {
    return {
      id: `${seed.archetype}-${slug(seed.seedId)}`,
      archetype: seed.archetype,
      name: archetype.exampleGroupNames[0] ?? archetype.label.toLowerCase(),
      vibe: `${archetype.label} — placeholder vibe`,
      membershipMode: seed.membershipMode,
      personaIds: seed.personaIds,
      agentnames: seed.agentnames,
      entries: [],
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  const groupMeta = await generateLoreGroup({
    archetype,
    personas,
    orbitedAgentname: seed.orbitedAgentname,
  });

  logEvent({
    eventType: 'lore_group_baked',
    success: true,
    details: {
      seedId: seed.seedId,
      archetype: seed.archetype,
      memberCount: seed.agentnames.length,
      personaCount: seed.personaIds.length,
      orbitedAgentname: seed.orbitedAgentname,
      name: groupMeta.name,
    },
  });

  let entryDrafts: Awaited<ReturnType<typeof generateLoreEntries>> = [];
  try {
    entryDrafts = await generateLoreEntries({
      archetype,
      groupName: groupMeta.name,
      vibe: groupMeta.vibe,
      count: entriesPerGroup,
      orbitedAgentname: seed.orbitedAgentname,
    });
  } catch (err) {
    // Entry synthesis failed — keep the named group with zero entries.
    // Better to ship empty than to lose the bake-time work on the name.
    logEvent({
      eventType: 'lore_entry_baked',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      details: { seedId: seed.seedId, archetype: seed.archetype },
    });
  }

  const entries: LoreEntry[] = entryDrafts.map((draft) => {
    const id = randomUUID();
    logEvent({
      eventType: 'lore_entry_baked',
      success: true,
      details: {
        seedId: seed.seedId,
        archetype: seed.archetype,
        entryId: id,
        kind: draft.kind,
      },
    });
    return {
      id,
      kind: draft.kind,
      text: draft.text,
      participants: seed.agentnames.length > 1 ? seed.agentnames : undefined,
      createdAt: new Date().toISOString(),
      referenceCount: 0,
    };
  });

  // Stable id derived from the group name for idempotent merging across runs.
  const stableId = `${seed.archetype}-${slug(groupMeta.name)}`;

  const now = new Date().toISOString();
  return {
    id: stableId,
    archetype: seed.archetype,
    name: groupMeta.name,
    vibe: groupMeta.vibe,
    membershipMode: seed.membershipMode,
    personaIds: seed.personaIds,
    agentnames: seed.agentnames,
    entries,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

/**
 * Inner pipeline: cluster + synthesize + persist. Callable from
 * `generate.ts` between agent persistence and the comment bake phase.
 *
 * No session_start/session_end emission — caller controls those if needed.
 * Per-group + per-entry events DO fire so the operator can `pnpm events`
 * the bake.
 *
 * Returns a summary the caller can splice into its own UI; on a population
 * with no agents or no personas, returns an empty registry without writing.
 */
export async function synthesizeLoreRegistry(
  options: SeedLoreOptions = {},
): Promise<SeedLoreSummary> {
  const groups = options.groups ?? config.loreDefaultGroupCount;
  const entriesPerGroup = options.entriesPerGroup ?? config.loreEntriesPerGroup;
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;
  const silent = options.silent ?? false;

  // Load population.
  const personas = await loadPersonas();
  const agents = await loadAllAgents();
  if (personas.size === 0 || agents.length === 0) {
    if (!silent) {
      ui.note(
        'no population',
        `Skipping lore — ${personas.size === 0 ? 'no personas' : 'no agents'} present.`,
      );
    }
    return {
      registry: emptyRegistry(),
      fresh: 0,
      carriedOver: 0,
      totalGroups: 0,
      totalEntries: 0,
    };
  }

  // Existing registry, when not forced.
  const prior = force ? emptyRegistry() : await loadRegistry();
  const seenIds = new Set(prior.groups.map((g) => g.id));

  // Cluster.
  const clusterSp = silent ? null : ui.spinner();
  clusterSp?.start(`Clustering ${agents.length} agents into up to ${groups} groups`);
  const affinity = computeAffinityMatrix(personas);
  const budget = allocateGroupBudget(groups);
  const seeds = clusterAllArchetypes({
    personas,
    agents,
    affinityMatrix: affinity,
    budget,
  });
  clusterSp?.stop(`Clustered ${seeds.length} group seeds across ${budget.size} archetypes`);

  // Synthesize via Gemini, bounded concurrency.
  const personasById = new Map(
    [...personas.values()].map((p) => [p.id, { id: p.id, tagline: p.tagline }]),
  );

  const synthSp = silent ? null : ui.spinner();
  synthSp?.start(
    `Synthesizing ${seeds.length} groups${dryRun ? ' (skipping Gemini — dry run)' : ' via Gemini'}`,
  );
  const fresh: LoreGroup[] = [];
  let skipped = 0;
  await mapWithConcurrency(seeds, config.loreBakeConcurrency, async (seed) => {
    // Idempotent skip: if a prior group of this archetype with the same
    // pinned member set already exists, carry it over instead of re-baking.
    const archetypePrefix = `${seed.archetype}-`;
    const matchByMembers = prior.groups.find(
      (g) =>
        g.id.startsWith(archetypePrefix) &&
        g.archetype === seed.archetype &&
        sameMembers(g.agentnames, seed.agentnames),
    );
    if (matchByMembers && seenIds.has(matchByMembers.id)) {
      skipped += 1;
      return;
    }

    try {
      const group = await synthesizeGroup(seed, personasById, entriesPerGroup, dryRun);
      fresh.push(group);
    } catch (err) {
      logEvent({
        eventType: 'lore_group_baked',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        details: { seedId: seed.seedId, archetype: seed.archetype },
      });
    }
  });
  synthSp?.stop(
    `Synthesized ${fresh.length} new groups (${skipped} carried over from prior registry)`,
  );

  // Merge prior + fresh, dedup on stable id (fresh wins).
  const merged: LoreGroup[] = [...prior.groups];
  const idIndex = new Map(merged.map((g, i) => [g.id, i]));
  for (const group of fresh) {
    const existingIdx = idIndex.get(group.id);
    if (existingIdx !== undefined) merged[existingIdx] = group;
    else {
      idIndex.set(group.id, merged.length);
      merged.push(group);
    }
  }

  const registry: LoreRegistryFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    groups: merged,
  };
  await writeRegistryFile(config.loreRegistryPath, registry);

  return {
    registry,
    fresh: fresh.length,
    carriedOver: skipped,
    totalGroups: merged.length,
    totalEntries: merged.reduce((s, g) => s + g.entries.length, 0),
  };
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const name of b) if (!setA.has(name)) return false;
  return true;
}

/**
 * `pnpm seed-lore` command. Wraps the inner pipeline with session events
 * and UI shell. Intended for the operator's standalone "rebuild the lore
 * after editing the catalog or adding agents" workflow.
 */
export async function seedLoreCommand(options: SeedLoreOptions = {}): Promise<void> {
  ui.intro(`Seed lore${options.dryRun ? ' (dry run)' : ''}`);

  initEventLogger();
  logEvent({
    eventType: 'session_start',
    success: true,
    details: {
      command: 'seed-lore',
      groups: options.groups ?? config.loreDefaultGroupCount,
      entriesPerGroup: options.entriesPerGroup ?? config.loreEntriesPerGroup,
      force: options.force ?? false,
      dryRun: options.dryRun ?? false,
    },
  });

  let summary: SeedLoreSummary;
  try {
    summary = await synthesizeLoreRegistry(options);
  } catch (err) {
    logEvent({
      eventType: 'session_end',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      details: { command: 'seed-lore' },
    });
    await drainWrites();
    flushStats();
    throw err;
  }

  ui.note(
    'seed-lore complete',
    ui.summaryLine([
      { label: 'groups (total)', value: summary.totalGroups, tone: 'ok' },
      { label: 'new', value: summary.fresh, tone: 'info' },
      { label: 'carried over', value: summary.carriedOver, tone: 'info' },
      { label: 'entries', value: summary.totalEntries, tone: 'info' },
    ]),
  );

  logEvent({
    eventType: 'session_end',
    success: true,
    details: {
      command: 'seed-lore',
      groupsTotal: summary.totalGroups,
      groupsFresh: summary.fresh,
      groupsCarried: summary.carriedOver,
      entriesTotal: summary.totalEntries,
    },
  });
  await drainWrites();
  flushStats();

  ui.outro(ui.color.green(`${ui.symbol.ok} seed-lore done`));
}
