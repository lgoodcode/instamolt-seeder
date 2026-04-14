import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const eventLoggerMocks = vi.hoisted(() => ({
  initEventLogger: vi.fn(),
  logEvent: vi.fn(),
  logSkippedAction: vi.fn(),
  flushStats: vi.fn(),
  updateAgentCounts: vi.fn(),
  drainWrites: vi.fn(async () => {}),
}));
vi.mock('@/lib/event-logger', () => eventLoggerMocks);

import * as fsPromises from 'node:fs/promises';
import { seedPersonasCommand } from '@/commands/seed-personas';
import { _resetPersonaCache, PERSONA_CATALOG } from '@/personas/index';

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

describe('seedPersonasCommand', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    fsState.rmCalls = [];
    llmMocks.generatePersona.mockReset();
    eventLoggerMocks.initEventLogger.mockReset();
    eventLoggerMocks.logEvent.mockReset();
    eventLoggerMocks.logSkippedAction.mockReset();
    eventLoggerMocks.flushStats.mockReset();
    eventLoggerMocks.updateAgentCounts.mockReset();
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

describe('seed-personas event-logger integration', () => {
  // Assertions on the structured activity stream wired through
  // seed-personas.ts. Every run must bracket itself with session_start /
  // session_end, emit one persona_installed per created persona, and flush
  // stats before returning so overnight operators can reconstruct a seed
  // session from `output/logs/events.jsonl`.

  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    fsState.rmCalls = [];
    llmMocks.generatePersona.mockReset();
    eventLoggerMocks.initEventLogger.mockReset();
    eventLoggerMocks.logEvent.mockReset();
    eventLoggerMocks.logSkippedAction.mockReset();
    eventLoggerMocks.flushStats.mockReset();
    eventLoggerMocks.updateAgentCounts.mockReset();
    _resetPersonaCache();
  });

  afterEach(() => {
    _resetPersonaCache();
  });

  function eventTypes(): string[] {
    return eventLoggerMocks.logEvent.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
  }

  function eventsOfType<T = Record<string, unknown>>(type: string): T[] {
    return eventLoggerMocks.logEvent.mock.calls
      .map((c) => c[0] as T & { eventType: string })
      .filter((e) => e.eventType === type);
  }

  it('initializes the event logger on command start', async () => {
    llmMocks.generatePersona.mockImplementation(async () => makePersona('gen_1'));

    await seedPersonasCommand({ count: 1 });

    expect(eventLoggerMocks.initEventLogger).toHaveBeenCalled();
  });

  it('emits session_start first with the requested command + mode', async () => {
    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`);
    });

    await seedPersonasCommand({ count: 2, mode: 'gemini' });

    const types = eventTypes();
    expect(types[0]).toBe('session_start');
    const starts = eventsOfType<{
      details: { command: string; mode: string; count: number; force: boolean };
    }>('session_start');
    expect(starts).toHaveLength(1);
    expect(starts[0].details.command).toBe('seed-personas');
    expect(starts[0].details.mode).toBe('gemini');
    expect(starts[0].details.count).toBe(2);
    expect(starts[0].details.force).toBe(false);
  });

  it('emits session_end last with details.installed equal to created count', async () => {
    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`);
    });

    await seedPersonasCommand({ count: 3, mode: 'gemini' });

    const types = eventTypes();
    expect(types[types.length - 1]).toBe('session_end');
    const ends = eventsOfType<{
      success: boolean;
      details: { command: string; mode: string; installed: number };
    }>('session_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].success).toBe(true);
    expect(ends[0].details.command).toBe('seed-personas');
    expect(ends[0].details.mode).toBe('gemini');
    expect(ends[0].details.installed).toBe(3);
  });

  it('calls flushStats on successful completion', async () => {
    llmMocks.generatePersona.mockImplementation(async () => makePersona('gen_1'));

    await seedPersonasCommand({ count: 1 });

    expect(eventLoggerMocks.flushStats).toHaveBeenCalledTimes(1);
  });

  it('emits one persona_installed event per created persona', async () => {
    let counter = 0;
    llmMocks.generatePersona.mockImplementation(async () => {
      counter++;
      return makePersona(`gen_${counter}`);
    });

    await seedPersonasCommand({ count: 3, mode: 'gemini' });

    const installs = eventsOfType<{
      persona: string;
      success: boolean;
      details: { source: string; tagline: string };
    }>('persona_installed');
    expect(installs).toHaveLength(3);
    const ids = installs.map((e) => e.persona).sort();
    expect(ids).toEqual(['gen_1', 'gen_2', 'gen_3']);
    for (const ev of installs) {
      expect(ev.success).toBe(true);
      expect(ev.details.source).toBe('gemini');
      expect(typeof ev.details.tagline).toBe('string');
      expect(ev.details.tagline.length).toBeGreaterThan(0);
    }
  });

  it('catalog mode emits one persona_installed per catalog entry', async () => {
    // Catalog mode is deterministic: seedPersonas copies the full
    // PERSONA_CATALOG to disk without calling Gemini. One persona_installed
    // event must fire for each catalog entry, tagged with source: 'catalog'.
    await seedPersonasCommand({ mode: 'catalog' });

    expect(llmMocks.generatePersona).not.toHaveBeenCalled();

    const installs = eventsOfType<{
      persona: string;
      details: { source: string; tagline: string };
    }>('persona_installed');
    expect(installs).toHaveLength(PERSONA_CATALOG.length);
    for (const ev of installs) {
      expect(ev.details.source).toBe('catalog');
    }
    const catalogIds = new Set(PERSONA_CATALOG.map((p) => p.id));
    for (const ev of installs) {
      expect(catalogIds.has(ev.persona)).toBe(true);
    }

    // session_end.installed must mirror the catalog size.
    const ends = eventsOfType<{
      details: { mode: string; installed: number };
    }>('session_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].details.mode).toBe('catalog');
    expect(ends[0].details.installed).toBe(PERSONA_CATALOG.length);
  });

  it('error path: session_end fires with success=false + error, flushStats called, error rethrown', async () => {
    // seedPersonas swallows per-slot generatePersona failures internally
    // (catch + skip). To exercise the command-level catch block, force a
    // failure earlier in the pipeline by making mkdir reject once.
    const boom = new Error('disk blew up');
    vi.mocked(fsPromises.mkdir).mockRejectedValueOnce(boom);

    await expect(seedPersonasCommand({ count: 2, mode: 'gemini' })).rejects.toThrow('disk blew up');

    const ends = eventsOfType<{
      success: boolean;
      error?: string;
      details: { command: string; mode: string };
    }>('session_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].success).toBe(false);
    expect(ends[0].error).toBe('disk blew up');
    expect(ends[0].details.command).toBe('seed-personas');
    expect(ends[0].details.mode).toBe('gemini');

    // No persona_installed events should fire on the failure path — the
    // loop that emits them runs after the try/catch.
    expect(eventsOfType('persona_installed')).toHaveLength(0);

    // flushStats still fires before the rethrow so the partial session is
    // persisted.
    expect(eventLoggerMocks.flushStats).toHaveBeenCalledTimes(1);
  });
});
