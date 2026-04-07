import { readdirSync } from 'fs';
import { join } from 'path';
import type { Persona } from '../types';

const SKIP = new Set(['index.ts', 'index.js', 'registry.ts', 'registry.js']);

let _cache: Map<string, Persona> | null = null;

export async function loadPersonas(): Promise<Map<string, Persona>> {
  if (_cache) return _cache;
  const files = readdirSync(__dirname);
  const personaFiles = files.filter(
    (f: string) => (f.endsWith('.ts') || f.endsWith('.js')) && !SKIP.has(f),
  );

  const registry = new Map<string, Persona>();
  for (const file of personaFiles) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(__dirname, file));
    const persona: Persona = mod.default ?? mod.persona;
    if (!persona?.id) continue;
    registry.set(persona.id, persona);
  }

  _cache = registry;
  console.log(`Loaded ${registry.size} personas`);
  return registry;
}
