/**
 * Population-wide lore registry I/O.
 *
 * Mirrors the [feed-cache](../lib/feed-cache.ts) substrate-with-fallback
 * shape: versioned JSON with light shape-check on read, atomic write-then-
 * rename, strict + permissive loaders. The registry is created once per
 * generate run by `seed-lore`; runtime `engage` reads it as the fast path
 * and tolerates a missing file (no lore = no allusions = clean degrade).
 *
 * Disk shape: `output/lore-registry.json` —
 * `{ version, generatedAt, groups: LoreGroup[] }`.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { config } from '@/config';
import { log } from '@/lib/logger';
import type { LoreGroup, LoreRegistryFile } from '@/types';

/** Current on-disk schema version. Bump when the shape changes. */
export const LORE_REGISTRY_VERSION = 1;

interface LoreRegistryFileOnDisk extends LoreRegistryFile {
  version: number;
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

export class LoreRegistryMissingError extends Error {
  constructor(message = 'lore-registry.json is missing — run `pnpm seed-lore`') {
    super(message);
    this.name = 'LoreRegistryMissingError';
  }
}

/** Build a fresh empty registry. Used by `seed-lore` as the starting point. */
export function emptyRegistry(): LoreRegistryFile {
  return {
    version: LORE_REGISTRY_VERSION,
    generatedAt: new Date(0).toISOString(),
    groups: [],
  };
}

/**
 * Read + validate the registry from disk. Throws when missing, malformed,
 * or version-skewed. Callers (`loadRegistry`) catch the missing-file case
 * and degrade to "no lore"; structural errors surface so the operator can
 * regenerate.
 */
export async function readRegistryFile(path: string): Promise<LoreRegistryFile> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateRegistry(parsed);
}

function validateRegistry(value: unknown): LoreRegistryFile {
  if (!value || typeof value !== 'object') {
    throw new Error('lore-registry: not an object');
  }
  const v = value as Partial<LoreRegistryFileOnDisk>;
  if (typeof v.version !== 'number') {
    throw new Error('lore-registry: missing version');
  }
  if (v.version !== LORE_REGISTRY_VERSION) {
    throw new Error(
      `lore-registry: unsupported version ${v.version} (expected ${LORE_REGISTRY_VERSION})`,
    );
  }
  if (typeof v.generatedAt !== 'string') {
    throw new Error('lore-registry: missing generatedAt');
  }
  if (!Array.isArray(v.groups)) {
    throw new Error('lore-registry: groups is not an array');
  }
  // Don't deep-validate every entry — JSON.parse already enforces structural
  // sanity, and the loader is defensive about missing fields downstream.
  return {
    version: v.version,
    generatedAt: v.generatedAt,
    groups: v.groups as LoreGroup[],
  };
}

/**
 * Atomic write-then-rename. Crash mid-write leaves the previous registry
 * snapshot intact — same pattern as `writeFeedCacheFile`.
 */
export async function writeRegistryFile(path: string, registry: LoreRegistryFile): Promise<void> {
  const tmp = `${path}.tmp`;
  const onDisk: LoreRegistryFileOnDisk = {
    ...registry,
    version: LORE_REGISTRY_VERSION,
  };
  await writeFile(tmp, JSON.stringify(onDisk, null, 2));
  await rename(tmp, path);
}

/**
 * Permissive loader. Returns the on-disk registry when present and parseable;
 * returns an empty registry when the file is missing OR malformed (with a
 * warn-level log on malformed). Callers in `engage` and the bake phase use
 * this — a missing or corrupt registry should mean "no lore allusions this
 * run", not "abort the loop".
 */
export async function loadRegistry(
  path: string = config.loreRegistryPath,
): Promise<LoreRegistryFile> {
  try {
    return await readRegistryFile(path);
  } catch (err) {
    if (isMissingFileError(err)) return emptyRegistry();
    log(
      'warn',
      `lore-registry: failed to load (${(err as Error).message}) — degrading to empty registry`,
    );
    return emptyRegistry();
  }
}

/**
 * Strict loader. Throws `LoreRegistryMissingError` when the file is absent,
 * propagates structural errors. Used by the curation CLI (`preview-lore`)
 * where "no registry" is operator error worth surfacing.
 */
export async function loadRegistryStrict(
  path: string = config.loreRegistryPath,
): Promise<LoreRegistryFile> {
  try {
    return await readRegistryFile(path);
  } catch (err) {
    if (isMissingFileError(err)) throw new LoreRegistryMissingError();
    throw err;
  }
}

/**
 * Increment `referenceCount` and stamp `lastReferencedAt` on the entry with
 * the given id, in place. Returns true when the entry was found, false
 * otherwise. Pure mutation on the in-memory registry — callers persist with
 * `writeRegistryFile` if they want the change to survive restarts.
 *
 * Runtime engage does NOT persist these increments today (would multiply
 * write amplification by N actions/sec). The counts that matter for the
 * cryptic-tone bake-time picker live in the in-memory registry that
 * `loadRegistry` returns; runtime allusion is logged via `lore_referenced`
 * events instead, which is the source of truth for analytics.
 */
export function incrementReferenceCount(
  registry: LoreRegistryFile,
  groupId: string,
  entryId: string,
): boolean {
  for (const group of registry.groups) {
    if (group.id !== groupId) continue;
    for (const entry of group.entries) {
      if (entry.id !== entryId) continue;
      entry.referenceCount += 1;
      entry.lastReferencedAt = new Date().toISOString();
      return true;
    }
  }
  return false;
}

/**
 * Look up the groups an agent is in. Walks every group; small N (~30
 * groups) so this is cheap. Returns groups in declaration order so callers
 * can rely on a stable ordering across calls.
 */
export function groupsForAgent(
  registry: LoreRegistryFile,
  agentname: string,
  agentnameToPersonaId?: ReadonlyMap<string, string>,
): LoreGroup[] {
  const out: LoreGroup[] = [];
  const personaId = agentnameToPersonaId?.get(agentname);
  for (const group of registry.groups) {
    if (group.agentnames.includes(agentname)) {
      out.push(group);
      continue;
    }
    if (
      personaId !== undefined &&
      (group.membershipMode === 'persona' || group.membershipMode === 'mixed') &&
      group.personaIds.includes(personaId)
    ) {
      out.push(group);
    }
  }
  return out;
}
