import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { log } from '@/lib/logger';
import { generatePersona, normalizePersona } from '@/services/llm';
import type { Persona } from '@/types';
import { PERSONA_CATALOG } from './catalog';

let _cache: Map<string, Persona> | null = null;

/**
 * Re-export the canonical hand-authored catalog so other call sites can
 * read it without importing from `./catalog` directly. Used by:
 *   - `seedPersonasCommand` for `--catalog` mode (copies into output/personas/)
 *   - `generatePersona` few-shot anchors (passed via `seedPersonas`)
 *   - test helpers that want a known-valid Persona to assert against
 */
export { PERSONA_CATALOG };

export interface LoadPersonasOptions {
  /**
   * If true (default), missing or empty `output/personas/` triggers a Gemini
   * seed run that writes 30 fresh personas before returning. Set to false for
   * read-only call sites (status, tests) that should not pay LLM cost.
   */
  autoSeed?: boolean;
  /** Number of personas to generate when auto-seeding. Default: 30. */
  seedCount?: number;
}

export async function loadPersonas(
  options: LoadPersonasOptions = {},
): Promise<Map<string, Persona>> {
  if (_cache) return _cache;

  const autoSeed = options.autoSeed ?? true;
  const seedCount = options.seedCount ?? 30;

  let files: string[];
  try {
    files = await readdir(config.personasDir);
  } catch {
    files = [];
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  if (jsonFiles.length === 0) {
    if (!autoSeed) {
      throw new Error(
        `No personas found in ${config.personasDir}. Run \`pnpm seed-personas\` to generate them.`,
      );
    }
    log('info', `No personas yet — seeding ${seedCount} fresh ones via Gemini...`);
    await seedPersonas(seedCount);
    files = await readdir(config.personasDir);
  }

  const registry = new Map<string, Persona>();
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const raw = await readFile(join(config.personasDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Persona;
      const persona = normalizePersona(parsed);
      if (!persona.id) {
        log('warn', `Persona file ${file} has no id, skipping`);
        continue;
      }
      registry.set(persona.id, persona);
    } catch (err) {
      log('warn', `Failed to load persona ${file}: ${err}`);
    }
  }

  _cache = registry;
  log('info', `Loaded ${registry.size} personas from ${config.personasDir}`);
  return registry;
}

/**
 * Modes for `seedPersonas`:
 *   - `'gemini'`  — pure Gemini invention (legacy default behavior). Each call
 *                   sees the prior set as progressive context. Pays LLM cost.
 *   - `'catalog'` — copy the hand-authored 36-persona canonical catalog from
 *                   `src/personas/catalog.ts` into `output/personas/{id}.json`.
 *                   Deterministic, no LLM cost. Stops at the catalog size; the
 *                   `count` parameter is ignored if it exceeds the catalog.
 *   - `'hybrid'`  — install the catalog first, then top up via Gemini until
 *                   the total reaches `count`. Gemini sees the catalog as
 *                   priors (so new inventions stay distinct) AND the catalog
 *                   gets passed as the few-shot anchor set.
 */
export type SeedMode = 'gemini' | 'catalog' | 'hybrid';

/**
 * Generate `count` personas and write them to disk as
 * `output/personas/{id}.json`. Behavior depends on `mode`:
 *
 *   - `gemini` (default): pure Gemini invention. Skips ids already on disk
 *     so re-running is safe and idempotent. Pays LLM cost.
 *   - `catalog`: copies the canonical hand-authored 36-persona set from
 *     `src/personas/catalog.ts`. Deterministic. The `count` parameter is
 *     capped at the catalog size — if you ask for 50 in catalog mode you
 *     still only get 36.
 *   - `hybrid`: installs the catalog first, then tops up via Gemini until
 *     `count` is reached. The catalog acts as both priors and few-shot
 *     anchors for the Gemini invention pass.
 */
export async function seedPersonas(count: number, mode: SeedMode = 'gemini'): Promise<Persona[]> {
  await mkdir(config.personasDir, { recursive: true });

  const created: Persona[] = [];

  // ── Step 1: Catalog install (catalog + hybrid modes) ──────────────
  if (mode === 'catalog' || mode === 'hybrid') {
    // Snapshot existing ids on disk so we don't overwrite hand-edits.
    const onDisk = new Set<string>();
    try {
      const files = await readdir(config.personasDir);
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        onDisk.add(f.replace(/\.json$/, ''));
      }
    } catch {}

    log('info', `seedPersonas: installing canonical catalog (${PERSONA_CATALOG.length} personas)`);
    for (const persona of PERSONA_CATALOG) {
      if (onDisk.has(persona.id)) {
        log('info', `  ~ ${persona.id} already on disk, skipping`);
        continue;
      }
      const path = join(config.personasDir, `${persona.id}.json`);
      await writeFile(path, JSON.stringify(persona, null, 2));
      created.push(persona);
      log('info', `  + ${persona.id} (weight ${persona.weight}) [catalog]`);
    }

    // Catalog mode is deterministic — done after install. Reset cache and return.
    if (mode === 'catalog') {
      _cache = null;
      return created;
    }
  }

  // ── Step 2: Gemini top-up (gemini + hybrid modes) ─────────────────

  // Re-read whatever's on disk (including any catalog entries we just wrote)
  // so the progressive-context prompt sees them and we don't regenerate ids
  // that already exist.
  const existing: Persona[] = [];
  try {
    const files = await readdir(config.personasDir);
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const raw = await readFile(join(config.personasDir, f), 'utf-8');
        existing.push(normalizePersona(JSON.parse(raw)));
      } catch {}
    }
  } catch {}

  const usedIds = new Set(existing.map((p) => p.id));

  let toCreate = Math.max(0, count - existing.length);
  log(
    'info',
    `seedPersonas: ${existing.length} already on disk, creating ${toCreate} new via Gemini`,
  );

  while (toCreate > 0) {
    let persona: Persona;
    try {
      // Pass the canonical catalog as the few-shot anchor set so Gemini
      // sees the structural diversity it should aim for. The catalog is the
      // *reference* shape; the prior list is the *avoid* shape.
      persona = await generatePersona([...existing, ...created], PERSONA_CATALOG);
    } catch (err) {
      log('warn', `generatePersona failed, skipping one slot: ${err}`);
      toCreate--;
      continue;
    }

    // Reject ids that survived normalization as too short. normalizePersona
    // strips non-[a-z0-9_] and caps at 24 chars, so malformed Gemini output
    // can land here as '' or a 1-2 char stub. Writing that would produce a
    // bogus file (e.g. '.json') that loadPersonas() silently skips, leaving
    // us short a persona without re-triggering auto-seed.
    if (persona.id.length < 3) {
      log('warn', `generatePersona returned invalid id "${persona.id}", skipping`);
      toCreate--;
      continue;
    }

    // De-duplicate ids — if Gemini returned a colliding id, append a suffix.
    // Truncate the base to leave room for the suffix so it survives the
    // 24-char cap (without this, a 24-char base + suffix gets truncated back
    // to the original colliding id, causing an infinite loop).
    let id = persona.id;
    let suffix = 2;
    while (usedIds.has(id)) {
      const suffixStr = `_${suffix++}`;
      id = `${persona.id.slice(0, 24 - suffixStr.length)}${suffixStr}`;
    }
    persona.id = id;
    usedIds.add(id);

    const path = join(config.personasDir, `${persona.id}.json`);
    await writeFile(path, JSON.stringify(persona, null, 2));
    created.push(persona);
    log('info', `  + ${persona.id} (weight ${persona.weight})`);
    toCreate--;
  }

  // Reset cache so the next loadPersonas() picks up the new files.
  _cache = null;
  return created;
}

/** Test-only: clear the in-memory cache so unit tests can re-seed state. */
export function _resetPersonaCache(): void {
  _cache = null;
}
