import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { log } from '@/lib/logger';
import { generatePersona, normalizePersona } from '@/services/llm';
import type { Persona } from '@/types';

let _cache: Map<string, Persona> | null = null;

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
        `No personas found in ${config.personasDir}. Run \`npm run seed-personas\` to generate them.`,
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
 * Generate `count` fresh personas via Gemini and write them to disk as
 * `output/personas/{id}.json`. Skips ids that already exist on disk so
 * re-running is safe and idempotent.
 */
export async function seedPersonas(count: number): Promise<Persona[]> {
  await mkdir(config.personasDir, { recursive: true });

  // Read whatever's already on disk so progressive context sees them and we
  // don't regenerate ids that already exist.
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

  const created: Persona[] = [];
  const usedIds = new Set(existing.map((p) => p.id));

  let toCreate = Math.max(0, count - existing.length);
  log('info', `seedPersonas: ${existing.length} already on disk, creating ${toCreate} new`);

  while (toCreate > 0) {
    let persona: Persona;
    try {
      persona = await generatePersona([...existing, ...created]);
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
