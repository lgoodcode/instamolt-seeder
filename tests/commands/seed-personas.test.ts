import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('GEMINI_API_KEY', 'test-key');

// Canonicalize fs keys (forward slashes, no leading './') so test setup paths
// agree with what path.join produces inside the loader on Windows.
const norm = (p: string): string =>
  p
    .split(/[/\\]/)
    .filter((s) => s !== '' && s !== '.')
    .join('/');

const PERSONAS_DIR = './output/personas';
const PERSONAS_DIR_KEY = norm(PERSONAS_DIR);
const fileKey = (name: string) => norm(join(PERSONAS_DIR, `${name}.json`));

// In-memory fs shared across the loader and the seed command path.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
  rmCalls: [] as string[],
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
    if (!fsState.dirEntries.has(key)) fsState.dirEntries.set(key, []);
  }),
  rm: vi.fn(async (path: string) => {
    const key = normHoisted(path);
    fsState.rmCalls.push(key);
    // Drop everything under the given dir from the in-memory fs.
    for (const k of Array.from(fsState.files.keys())) {
      if (k.startsWith(key)) fsState.files.delete(k);
    }
    for (const k of Array.from(fsState.dirEntries.keys())) {
      if (k.startsWith(key)) fsState.dirEntries.delete(k);
    }
  }),
}));

const llmMocks = vi.hoisted(() => ({
  generatePersona: vi.fn(),
}));

vi.mock('@/services/llm', async () => {
  const real = await vi.importActual<typeof import('@/services/llm')>('@/services/llm');
  return {
    generatePersona: llmMocks.generatePersona,
    normalizePersona: real.normalizePersona,
  };
});

// seed-personas.ts writes through src/lib/ui.ts. No-op the mock so tests don't
// render spinner escape codes or try to draw TTY notes.
vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  section: vi.fn(),
  note: vi.fn(),
  isInteractive: vi.fn(() => false),
  summaryLine: vi.fn(),
  progress: vi.fn(() => ({
    tick: vi.fn(),
    done: vi.fn(),
  })),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
  })),
  color: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  },
  symbol: { ok: '✓', err: '✗', warn: '!', info: 'i' },
}));

import { seedPersonasCommand } from '@/commands/seed-personas';
import { _resetPersonaCache } from '@/personas/index';

function makePersona(id: string, weight = 1) {
  return {
    id,
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
    interactionBiases: [],
    viralityStrategy: '',
    weight,
  };
}

describe('seedPersonasCommand', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    fsState.rmCalls = [];
    llmMocks.generatePersona.mockReset();
    _resetPersonaCache();
  });

  afterEach(() => {
    _resetPersonaCache();
  });

  it('writes the requested number of personas via Gemini', async () => {
    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`);
    });

    await seedPersonasCommand({ count: 4 });

    expect(llmMocks.generatePersona).toHaveBeenCalledTimes(4);
    for (let i = 1; i <= 4; i++) {
      expect(fsState.files.has(fileKey(`gen_${i}`))).toBe(true);
    }
  });

  it('skips Gemini calls when the target count is already on disk', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['gen_1.json', 'gen_2.json']);
    fsState.files.set(fileKey('gen_1'), JSON.stringify(makePersona('gen_1')));
    fsState.files.set(fileKey('gen_2'), JSON.stringify(makePersona('gen_2')));

    await seedPersonasCommand({ count: 2 });

    expect(llmMocks.generatePersona).not.toHaveBeenCalled();
  });

  it('--force wipes existing personas before regenerating', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['old.json']);
    fsState.files.set(fileKey('old'), JSON.stringify(makePersona('old')));

    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`fresh_${counter}`);
    });

    await seedPersonasCommand({ count: 2, force: true });

    expect(fsState.rmCalls).toContain(PERSONAS_DIR_KEY);
    // Old file gone, new ones written.
    expect(fsState.files.has(fileKey('old'))).toBe(false);
    expect(fsState.files.has(fileKey('fresh_1'))).toBe(true);
    expect(fsState.files.has(fileKey('fresh_2'))).toBe(true);
  });

  it('disambiguates ids when Gemini returns a colliding one', async () => {
    fsState.dirEntries.set(PERSONAS_DIR_KEY, ['dupe.json']);
    fsState.files.set(fileKey('dupe'), JSON.stringify(makePersona('dupe')));

    llmMocks.generatePersona.mockResolvedValue(makePersona('dupe'));

    await seedPersonasCommand({ count: 2 });

    // The original `dupe.json` is unchanged. The new one was written under a
    // disambiguated id like `dupe_2.json`.
    expect(fsState.files.has(fileKey('dupe'))).toBe(true);
    const dupePrefix = norm(join(PERSONAS_DIR, 'dupe_'));
    const newKeys = Array.from(fsState.files.keys()).filter(
      (k) => k.startsWith(dupePrefix) && k !== fileKey('dupe'),
    );
    expect(newKeys.length).toBe(1);
  });
});
