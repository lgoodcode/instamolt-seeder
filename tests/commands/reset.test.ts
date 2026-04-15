import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
  rmCalls: [] as Array<{ path: string; options?: { recursive?: boolean; force?: boolean } }>,
  writeCalls: [] as Array<{ path: string; data: string }>,
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  readdir: vi.fn(async (path: string, options?: { withFileTypes?: boolean }) => {
    const entries = fsState.dirEntries.get(path);
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    if (options?.withFileTypes) {
      return entries.map((name) => ({
        name,
        isDirectory: () => true,
        isFile: () => false,
      }));
    }
    return entries;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    fsState.writeCalls.push({ path, data });
    fsState.files.set(path, data);
  }),
  rm: vi.fn(async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
    fsState.rmCalls.push({ path, options });
    fsState.files.delete(path);
    fsState.dirEntries.delete(path);
  }),
}));

const uiState = vi.hoisted(() => ({
  notes: [] as Array<{ title: string; body: string }>,
  outros: [] as string[],
  intros: [] as string[],
  confirmResult: true,
  confirmCalls: 0,
  textResult: 'DELETE',
  textCalls: 0,
}));

vi.mock('@/lib/ui', () => ({
  intro: vi.fn((msg: string) => {
    uiState.intros.push(msg);
  }),
  outro: vi.fn((msg: string) => {
    uiState.outros.push(msg);
  }),
  section: vi.fn(),
  note: vi.fn((title: string, body: string) => {
    uiState.notes.push({ title, body });
  }),
  confirm: vi.fn(async () => {
    uiState.confirmCalls++;
    return uiState.confirmResult;
  }),
  text: vi.fn(async () => {
    uiState.textCalls++;
    return uiState.textResult;
  }),
  isInteractive: vi.fn(() => false),
  summaryLine: vi.fn(),
  progress: vi.fn(() => ({ tick: vi.fn(), done: vi.fn() })),
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
  symbol: { ok: 'ok', err: 'err', warn: 'warn', dot: '.', arrow: '->', bullet: '*' },
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

const llmState = vi.hoisted(() => ({
  generatePersonaCalls: 0,
  generatedPersona: null as unknown,
}));

vi.mock('@/services/llm', () => ({
  generatePersona: vi.fn(async () => {
    llmState.generatePersonaCalls++;
    // Gemini would typically coin its own id — reset.ts overrides it back.
    return {
      id: 'freshly-coined-id',
      tagline: 'fresh tagline',
      personality: 'p',
      tone: 't',
      visualAesthetic: 'v',
      postingStyle: 'ps',
      commentStyle: 'cs',
      hashtagPool: [],
      postsPerDay: [1, 3],
      likeProbability: 0.5,
      commentProbability: 0.3,
      followProbability: 0.2,
      relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
      viralityStrategy: '',
      weight: 1,
      examplePosts: [],
      exampleComments: [],
    };
  }),
}));

vi.mock('@/personas/index', () => ({
  _resetPersonaCache: vi.fn(),
  PERSONA_CATALOG: [],
}));

const dedupState = vi.hoisted(() => ({
  readResult: null as unknown,
  shouldThrowOnRead: false,
  writeCalls: [] as unknown[],
}));

vi.mock('@/lib/dedup-index', () => ({
  readDedupIndex: vi.fn(async () => {
    if (dedupState.shouldThrowOnRead) {
      throw new Error('missing');
    }
    return dedupState.readResult;
  }),
  writeDedupIndex: vi.fn(async (_path: string, index: unknown) => {
    dedupState.writeCalls.push(index);
  }),
}));

import { reset } from '@/commands/reset';
import { config } from '@/config';

function resetUiState(): void {
  uiState.notes.length = 0;
  uiState.outros.length = 0;
  uiState.intros.length = 0;
  uiState.confirmResult = true;
  uiState.confirmCalls = 0;
  uiState.textResult = 'DELETE';
  uiState.textCalls = 0;
}

function resetFsState(): void {
  fsState.files.clear();
  fsState.dirEntries.clear();
  fsState.rmCalls.length = 0;
  fsState.writeCalls.length = 0;
}

function resetDedupState(): void {
  dedupState.readResult = null;
  dedupState.shouldThrowOnRead = false;
  dedupState.writeCalls.length = 0;
}

describe('reset', () => {
  beforeEach(() => {
    resetFsState();
    resetUiState();
    resetDedupState();
    llmState.generatePersonaCalls = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('--agent <name>', () => {
    it('removes agent from disk, agents.json, and dedup-index when --force is passed', async () => {
      const agentname = 'alpha';
      const agentDir = join(config.agentsDir, agentname);
      // Plant 3 post files so the `totalPosts` decrement is exercised.
      fsState.dirEntries.set(agentDir, [
        'agent.json',
        'post-001.json',
        'post-002.json',
        'post-003.json',
      ]);
      fsState.files.set(
        config.agentsIndexPath,
        JSON.stringify({
          generatedAt: '2026-04-07T00:00:00Z',
          totalAgents: 2,
          totalPosts: 6,
          agents: [
            { agentname: 'alpha', personaId: 'p1', bio: 'bio' },
            { agentname: 'beta', personaId: 'p2', bio: 'bio' },
          ],
        }),
      );
      dedupState.readResult = {
        version: 1,
        updatedAt: '2026-04-07T00:00:00Z',
        personas: {
          p1: {
            agents: [
              { agentname: 'alpha', bio: 'bio', bioEmbedding: null, posts: [] },
              { agentname: 'gamma', bio: 'bio', bioEmbedding: null, posts: [] },
            ],
          },
        },
      };

      await reset({ agent: agentname, force: true });

      // Dir deleted
      const dirRm = fsState.rmCalls.find((c) => c.path === agentDir);
      expect(dirRm).toBeDefined();
      expect(dirRm?.options?.recursive).toBe(true);

      // agents.json rewritten with alpha removed
      const indexWrite = fsState.writeCalls.find((c) => c.path === config.agentsIndexPath);
      expect(indexWrite).toBeDefined();
      const parsed = JSON.parse(indexWrite!.data) as {
        totalAgents: number;
        totalPosts: number;
        agents: Array<{ agentname: string }>;
      };
      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]?.agentname).toBe('beta');
      expect(parsed.totalAgents).toBe(1);
      // totalPosts recomputed by subtracting the deleted agent's posts
      // (3) from the prior total (6).
      expect(parsed.totalPosts).toBe(3);

      // dedup index rewritten with alpha stripped from persona bucket
      expect(dedupState.writeCalls).toHaveLength(1);
      const rewritten = dedupState.writeCalls[0] as {
        personas: Record<string, { agents: Array<{ agentname: string }> }>;
      };
      expect(rewritten.personas.p1?.agents.map((a) => a.agentname)).toEqual(['gamma']);

      expect(uiState.confirmCalls).toBe(0); // --force skips confirm
    });

    it('removes agent from agents.json even when no dir on disk', async () => {
      const agentname = 'ghost';
      // No directory entry → readdir throws
      fsState.files.set(
        config.agentsIndexPath,
        JSON.stringify({
          generatedAt: '2026-04-07T00:00:00Z',
          totalAgents: 1,
          totalPosts: 0,
          agents: [{ agentname: 'ghost', personaId: 'p1', bio: 'bio' }],
        }),
      );
      dedupState.shouldThrowOnRead = true;

      await reset({ agent: agentname, force: true });

      // No dir was rm'd for the agent directory (source guards on existsOnDisk)
      const agentDir = join(config.agentsDir, agentname);
      const dirRm = fsState.rmCalls.find(
        (c) => c.path === agentDir && c.options?.recursive === true,
      );
      expect(dirRm).toBeUndefined();

      // agents.json was rewritten without the ghost entry
      const indexWrite = fsState.writeCalls.find((c) => c.path === config.agentsIndexPath);
      expect(indexWrite).toBeDefined();
      const parsed = JSON.parse(indexWrite!.data) as { agents: unknown[] };
      expect(parsed.agents).toHaveLength(0);

      // graceful outro
      expect(uiState.outros.join(' ')).toMatch(/deleted ghost/);
    });

    it('aborts without mutation when confirm returns false', async () => {
      const agentname = 'alpha';
      const agentDir = join(config.agentsDir, agentname);
      fsState.dirEntries.set(agentDir, ['agent.json']);
      fsState.files.set(
        config.agentsIndexPath,
        JSON.stringify({
          generatedAt: '2026-04-07T00:00:00Z',
          totalAgents: 1,
          totalPosts: 0,
          agents: [{ agentname: 'alpha', personaId: 'p1', bio: 'b' }],
        }),
      );

      uiState.confirmResult = false;

      await reset({ agent: agentname, force: false });

      expect(uiState.confirmCalls).toBe(1);
      expect(fsState.rmCalls).toHaveLength(0);
      expect(fsState.writeCalls).toHaveLength(0);
      expect(dedupState.writeCalls).toHaveLength(0);
      expect(uiState.outros.join(' ')).toMatch(/aborted/);
    });

    it('warns and does nothing when agent is neither on disk nor in agents.json', async () => {
      // No fs state set at all — readdir throws, readFile throws.
      dedupState.shouldThrowOnRead = true;

      await reset({ agent: 'never-existed', force: true });

      expect(fsState.rmCalls).toHaveLength(0);
      expect(fsState.writeCalls).toHaveLength(0);
      expect(uiState.outros.join(' ')).toMatch(/not found/);
    });
  });

  describe('--persona <id>', () => {
    it('deletes and regenerates the persona JSON with the original id preserved', async () => {
      const personaId = 'brainrot9000';
      const personaPath = join(config.personasDir, `${personaId}.json`);

      fsState.files.set(
        personaPath,
        JSON.stringify({
          id: personaId,
          tagline: 'old',
          personality: 'p',
          tone: 't',
          visualAesthetic: 'v',
          postingStyle: 'ps',
          commentStyle: 'cs',
          hashtagPool: [],
          postsPerDay: [1, 3],
          likeProbability: 0.5,
          commentProbability: 0.3,
          followProbability: 0.2,
          relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
          viralityStrategy: '',
          weight: 1,
          examplePosts: [],
          exampleComments: [],
        }),
      );
      // No other personas on disk, no agents referencing it
      fsState.dirEntries.set(config.personasDir, [`${personaId}.json`]);

      await reset({ persona: personaId, force: true });

      expect(llmState.generatePersonaCalls).toBe(1);

      const writeCall = fsState.writeCalls.find((c) => c.path === personaPath);
      expect(writeCall).toBeDefined();
      const parsed = JSON.parse(writeCall!.data) as { id: string; tagline: string };
      // Source preserves the original id regardless of what generatePersona returned.
      expect(parsed.id).toBe(personaId);
      expect(parsed.tagline).toBe('fresh tagline');

      expect(uiState.outros.join(' ')).toMatch(/regenerated/);
    });

    it('warns and does not call generatePersona when persona does not exist', async () => {
      await reset({ persona: 'does-not-exist', force: true });

      expect(llmState.generatePersonaCalls).toBe(0);
      expect(fsState.writeCalls).toHaveLength(0);
      expect(uiState.outros.join(' ')).toMatch(/not found/);
    });
  });

  describe('bulk resets', () => {
    it('bare reset with --force wipes agents dir, agents.json, dedup-index, preserves personas/cache/logs', async () => {
      await reset({ force: true });

      const rmPaths = fsState.rmCalls.map((c) => c.path);
      expect(rmPaths).toContain(config.agentsDir);
      expect(rmPaths).toContain(config.agentsIndexPath);
      expect(rmPaths).toContain(config.dedupIndexPath);
      // Personas, feed-cache, logs not wiped
      expect(rmPaths).not.toContain(config.personasDir);
      expect(rmPaths).not.toContain(config.feedCachePath);
      expect(rmPaths).not.toContain(config.logsDir);

      expect(uiState.confirmCalls).toBe(0);
      expect(uiState.outros.join(' ')).toMatch(/reset done/);
    });

    it('--cache --force only wipes feed-cache.json + dedup-index.json', async () => {
      await reset({ cache: true, force: true });

      const rmPaths = fsState.rmCalls.map((c) => c.path);
      expect(rmPaths).toContain(config.feedCachePath);
      expect(rmPaths).toContain(config.dedupIndexPath);
      expect(rmPaths).not.toContain(config.agentsDir);
      expect(rmPaths).not.toContain(config.agentsIndexPath);
      expect(rmPaths).not.toContain(config.logsDir);
    });

    it('--logs --force only wipes logs dir', async () => {
      await reset({ logs: true, force: true });

      const rmPaths = fsState.rmCalls.map((c) => c.path);
      expect(rmPaths).toContain(config.logsDir);
      expect(rmPaths).not.toContain(config.agentsDir);
      expect(rmPaths).not.toContain(config.feedCachePath);
    });

    it('--all --force wipes agents + cache + logs, preserves personas', async () => {
      await reset({ all: true, force: true });

      const rmPaths = fsState.rmCalls.map((c) => c.path);
      expect(rmPaths).toContain(config.agentsDir);
      expect(rmPaths).toContain(config.agentsIndexPath);
      expect(rmPaths).toContain(config.dedupIndexPath);
      expect(rmPaths).toContain(config.feedCachePath);
      expect(rmPaths).toContain(config.logsDir);
      expect(rmPaths).not.toContain(config.personasDir);
    });

    it('--force skips the confirm prompt', async () => {
      await reset({ all: true, force: true });
      expect(uiState.confirmCalls).toBe(0);
    });

    it('without --force, requires typed DELETE token when agents are on disk', async () => {
      fsState.dirEntries.set(config.agentsDir, ['alpha', 'beta']);

      await reset({ all: true });

      expect(uiState.confirmCalls).toBe(1);
      expect(uiState.textCalls).toBe(1);
      // Matching token proceeds to rm
      const rmPaths = fsState.rmCalls.map((c) => c.path);
      expect(rmPaths).toContain(config.agentsDir);
    });

    it('without --force, mismatched typed token aborts without any rm calls', async () => {
      fsState.dirEntries.set(config.agentsDir, ['alpha', 'beta']);
      uiState.textResult = 'delete'; // wrong case

      await reset({ all: true });

      expect(uiState.confirmCalls).toBe(1);
      expect(uiState.textCalls).toBe(1);
      expect(fsState.rmCalls).toHaveLength(0);
      expect(uiState.outros.join(' ')).toMatch(/confirmation token mismatch/);
    });

    it('counts agents from agents.json (authoritative) even if agents dir is empty', async () => {
      fsState.files.set(
        config.agentsIndexPath,
        JSON.stringify({
          agents: [
            { agentname: 'alpha', personaId: 'p' },
            { agentname: 'beta', personaId: 'p' },
          ],
          totalAgents: 2,
          totalPosts: 0,
        }),
      );
      // agents dir missing — index is what matters for the confirmation gate
      await reset({ all: true });

      expect(uiState.confirmCalls).toBe(1);
      expect(uiState.textCalls).toBe(1);
      // Label reflects index-derived count (2 agents)
      const note = uiState.notes.find((n) => n.title === 'Will delete');
      expect(note?.body).toMatch(/2 agents/);
    });

    it('without --force, skips typed gate when agents dir is empty', async () => {
      // No agents dir entries at all — readdir throws, count = 0
      await reset({ all: true });

      expect(uiState.confirmCalls).toBe(1);
      expect(uiState.textCalls).toBe(0);
      // Still proceeds to wipe the other targets (cache, logs) and the
      // non-existent agents dir (rm is idempotent with force: true)
      expect(uiState.outros.join(' ')).toMatch(/reset done/);
    });

    it('--force skips both the yes/no confirm and the typed token gate', async () => {
      fsState.dirEntries.set(config.agentsDir, ['alpha', 'beta', 'gamma']);

      await reset({ all: true, force: true });

      expect(uiState.confirmCalls).toBe(0);
      expect(uiState.textCalls).toBe(0);
    });

    it('without --force, confirm false aborts without any rm calls', async () => {
      uiState.confirmResult = false;
      await reset({ all: true });

      expect(uiState.confirmCalls).toBe(1);
      expect(fsState.rmCalls).toHaveLength(0);
      expect(uiState.outros.join(' ')).toMatch(/aborted/);
    });
  });
});
