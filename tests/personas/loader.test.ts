import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Canonicalize fs keys so './output/personas/a.json' and the
// 'output\\personas\\a.json' that path.join produces on Windows agree.
const norm = (p: string): string =>
  p
    .split(/[/\\]/)
    .filter((s) => s !== '' && s !== '.')
    .join('/');

const PERSONAS_DIR = './output/personas';
const PERSONAS_DIR_KEY = norm(PERSONAS_DIR);
const personaFile = (name: string) => join(PERSONAS_DIR, `${name}.json`);
const fileKey = (name: string) => norm(personaFile(name));

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
  mkdirCalls: [] as string[],
}));

const normHoisted = vi.hoisted(
  () =>
    (p: string): string =>
      p
        .split(/[/\\]/)
        .filter((s) => s !== '' && s !== '.')
        .join('/'),
);

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(normHoisted(path));
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    const key = normHoisted(path);
    fsState.files.set(key, content);
    const lastSlash = key.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : key.slice(0, lastSlash);
    const file = key.slice(lastSlash + 1);
    const entries = fsState.dirEntries.get(dir) ?? [];
    if (!entries.includes(file)) entries.push(file);
    fsState.dirEntries.set(dir, entries);
  }),
  readdir: vi.fn(async (path: string) => {
    const entries = fsState.dirEntries.get(normHoisted(path));
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  }),
  mkdir: vi.fn(async (path: string) => {
    const key = normHoisted(path);
    fsState.mkdirCalls.push(key);
    if (!fsState.dirEntries.has(key)) {
      fsState.dirEntries.set(key, []);
    }
  }),
}));

// Mock generatePersona so the loader's auto-seed branch doesn't actually
// call Gemini. Each call returns a synthetic persona with a unique id.
const llmMocks = vi.hoisted(() => ({
  generatePersona: vi.fn(),
  // normalizePersona is a pure utility — re-export the real one so the loader
  // gets sane behavior on the JSON parse path. We re-import it inside the
  // factory body since vi.mock factories must not reference outer scope.
  normalizePersona: vi.fn(),
}));

vi.mock('@/services/llm', async () => {
  const real = await vi.importActual<typeof import('@/services/llm')>('@/services/llm');
  return {
    generatePersona: llmMocks.generatePersona,
    normalizePersona: real.normalizePersona,
  };
});

import { _resetPersonaCache, loadPersonas, seedPersonas } from '@/personas/index';

function makePersona(id: string, weight = 1) {
  return {
    id,
    tagline: 'test tagline',
    personality: `${id} persona`,
    tone: '',
    visualAesthetic: '',
    postingStyle: '',
    commentStyle: '',
    namePatterns: [],
    hashtagPool: [],
    postsPerDay: [1, 3],
    likeProbability: 0.5,
    commentProbability: 0.3,
    followProbability: 0.2,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight,
    examplePosts: [],
    exampleComments: [],
    activityCurve: Array.from({ length: 24 }, () => 0.5),
  };
}

describe('loadPersonas', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    fsState.mkdirCalls = [];
    llmMocks.generatePersona.mockReset();
    _resetPersonaCache();
  });

  afterEach(() => {
    _resetPersonaCache();
  });

  it('returns a Map instance', async () => {
    // Seed two personas on disk so auto-seed isn't triggered.
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['a.json', 'b.json']);
    fsState.files.set(fileKey('a'), JSON.stringify(makePersona('a')));
    fsState.files.set(fileKey('b'), JSON.stringify(makePersona('b')));

    const result = await loadPersonas({ autoSeed: false });
    expect(result).toBeInstanceOf(Map);
  });

  it('throws a friendly error when no personas exist and autoSeed is false', async () => {
    await expect(loadPersonas({ autoSeed: false })).rejects.toThrow(/seed-personas/);
  });

  it('reads every JSON file in output/personas/ and keys the map by id', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, [
      'first.json',
      'second.json',
      'third.json',
      'README.md', // ignored — not .json
    ]);
    fsState.files.set(fileKey('first'), JSON.stringify(makePersona('first', 3)));
    fsState.files.set(fileKey('second'), JSON.stringify(makePersona('second', 2)));
    fsState.files.set(fileKey('third'), JSON.stringify(makePersona('third', 1)));

    const result = await loadPersonas({ autoSeed: false });
    expect(result.size).toBe(3);
    expect(result.has('first')).toBe(true);
    expect(result.has('second')).toBe(true);
    expect(result.has('third')).toBe(true);
    expect(result.get('first')?.weight).toBe(3);
  });

  it('skips JSON files with no id', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['good.json', 'bad.json']);
    fsState.files.set(fileKey('good'), JSON.stringify(makePersona('good')));
    fsState.files.set(fileKey('bad'), JSON.stringify({ weight: 1 }));

    const result = await loadPersonas({ autoSeed: false });
    expect(result.size).toBe(1);
    expect(result.has('good')).toBe(true);
  });

  it('skips JSON files that fail to parse', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['good.json', 'broken.json']);
    fsState.files.set(fileKey('good'), JSON.stringify(makePersona('good')));
    fsState.files.set(fileKey('broken'), '{ not valid json');

    const result = await loadPersonas({ autoSeed: false });
    expect(result.size).toBe(1);
  });

  it('memoizes the loaded map across calls', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['a.json']);
    fsState.files.set(fileKey('a'), JSON.stringify(makePersona('a')));

    const first = await loadPersonas({ autoSeed: false });
    const second = await loadPersonas({ autoSeed: false });
    expect(first).toBe(second);
  });

  it('auto-seeds via Gemini when output/personas/ is empty and autoSeed is true', async () => {
    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`, 1);
    });

    const result = await loadPersonas({ autoSeed: true, seedCount: 3 });
    expect(llmMocks.generatePersona).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(3);
    expect(result.has('gen_1')).toBe(true);
    expect(result.has('gen_2')).toBe(true);
    expect(result.has('gen_3')).toBe(true);
  });
});

describe('seedPersonas', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    fsState.mkdirCalls = [];
    llmMocks.generatePersona.mockReset();
    _resetPersonaCache();
  });

  it('writes N persona JSON files to output/personas/', async () => {
    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`);
    });

    const created = await seedPersonas(5);
    expect(created).toHaveLength(5);
    // Each one was written to disk.
    for (let i = 1; i <= 5; i++) {
      expect(fsState.files.has(fileKey(`gen_${i}`))).toBe(true);
    }
  });

  it('skips existing personas when topping up to a target count', async () => {
    // Pre-seed 2 on disk.
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['gen_1.json', 'gen_2.json']);
    fsState.files.set(fileKey('gen_1'), JSON.stringify(makePersona('gen_1')));
    fsState.files.set(fileKey('gen_2'), JSON.stringify(makePersona('gen_2')));

    let counter = 100;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`);
    });

    const created = await seedPersonas(5);
    // Only 3 new (5 target - 2 existing).
    expect(created).toHaveLength(3);
    expect(llmMocks.generatePersona).toHaveBeenCalledTimes(3);
  });

  it('disambiguates colliding ids returned by Gemini with a numeric suffix', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['dupe.json']);
    fsState.files.set(fileKey('dupe'), JSON.stringify(makePersona('dupe')));

    llmMocks.generatePersona.mockResolvedValue(makePersona('dupe'));

    const created = await seedPersonas(2);
    expect(created).toHaveLength(1);
    // The new persona's id should not collide with the existing 'dupe'.
    expect(created[0].id).not.toBe('dupe');
    expect(created[0].id).toMatch(/dupe_\d+/);
  });

  it('skips a slot and continues when generatePersona throws', async () => {
    let calls = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('Gemini boom');
      return makePersona(`gen_${calls}`);
    });

    const created = await seedPersonas(3);
    // First call failed, next 2 succeeded.
    expect(created).toHaveLength(2);
  });

  it('passes null catalog anchors to generatePersona in legacy gemini mode', async () => {
    // Regression: prior code unconditionally passed PERSONA_CATALOG into the
    // few-shot anchor slot even when mode === 'gemini', contradicting the
    // SeedMode docs that describe 'gemini' as pure invention.
    llmMocks.generatePersona.mockResolvedValue(makePersona('gen_1'));
    await seedPersonas(1, 'gemini');
    expect(llmMocks.generatePersona).toHaveBeenCalledTimes(1);
    const [, catalogArg] = llmMocks.generatePersona.mock.calls[0];
    expect(catalogArg).toBeNull();
  });

  it('passes the canonical catalog as anchors to generatePersona in hybrid mode', async () => {
    // In hybrid mode, the catalog gets installed first (so any top-up only
    // covers the gap above 36) AND it gets passed as the few-shot anchor set.
    llmMocks.generatePersona.mockResolvedValue(makePersona('gen_extra'));
    // Ask for catalog size + 1 so exactly one Gemini top-up call fires after
    // the catalog install. The Gemini call is the one we want to inspect.
    const catalogSize = (await import('@/personas/catalog')).PERSONA_CATALOG.length;
    await seedPersonas(catalogSize + 1, 'hybrid');
    expect(llmMocks.generatePersona).toHaveBeenCalledTimes(1);
    const [, catalogArg] = llmMocks.generatePersona.mock.calls[0];
    expect(Array.isArray(catalogArg)).toBe(true);
    expect((catalogArg as unknown[]).length).toBeGreaterThan(0);
  });
});
