import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('GEMINI_API_KEY', 'test-key');

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
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
  readdir: vi.fn(async (path: string) => {
    const entries = fsState.dirEntries.get(path);
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  }),
}));

// status.ts now writes its main report through ui.note() and falls back to a
// plain console.log block for the per-persona breakdown. Mock ui so we can
// (a) read ui.note() bodies for the headline stats and (b) keep
// `isInteractive()` returning false so the plain fallback runs.
const uiState = vi.hoisted(() => ({
  notes: [] as Array<{ title: string; body: string }>,
  outros: [] as string[],
}));

vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn((msg: string) => {
    uiState.outros.push(msg);
  }),
  section: vi.fn(),
  note: vi.fn((title: string, body: string) => {
    uiState.notes.push({ title, body });
  }),
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

// cli-table3 only runs in the interactive branch (which we keep disabled),
// so the import resolves but the table code never executes. No mock needed.

import { status } from '@/commands/status';

describe('status', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
    uiState.notes.length = 0;
    uiState.outros.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function getLogOutput(): string {
    const calls = logSpy.mock.calls as unknown[][];
    return calls.map((call) => call.join(' ')).join('\n');
  }

  function getNoteBody(title: string): string | undefined {
    return uiState.notes.find((n) => n.title === title)?.body;
  }

  it('shows a "no output" note when agents.json is missing', async () => {
    await status();
    const note = getNoteBody('No output found');
    expect(note).toBeDefined();
    expect(note).toMatch(/generate/i);
  });

  it('reports an empty index with zero counts', async () => {
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 0,
        totalPosts: 0,
        agents: [],
      }),
    );

    await status();
    const body = getNoteBody('InstaMolt Seeder');
    expect(body).toBeDefined();
    expect(body).toContain('Generated');
    expect(body).toContain('0 agents');
  });

  it('reports mixed registered/unregistered counts', async () => {
    const agents = [
      { agentname: 'alpha', personaId: 'brainrot9000', bio: 'a b c', apiKey: 'k1' },
      { agentname: 'beta', personaId: 'brainrot9000', bio: 'a b c', apiKey: 'k2' },
      { agentname: 'gamma', personaId: 'cozy_circuit', bio: 'a b c' },
    ];
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 3,
        totalPosts: 0,
        agents,
      }),
    );
    for (const a of agents) {
      fsState.dirEntries.set(join('./output/agents', a.agentname), []);
    }

    await status();
    const body = getNoteBody('InstaMolt Seeder');
    expect(body).toBeDefined();
    expect(body).toContain('3'); // total agents
    expect(body).toContain('2'); // registered count
    expect(body).toMatch(/1 pending/);
  });

  it('tallies published vs unpublished posts correctly', async () => {
    const agent = {
      agentname: 'alpha',
      personaId: 'brainrot9000',
      bio: 'a b c',
      apiKey: 'k1',
    };
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 1,
        totalPosts: 3,
        agents: [agent],
      }),
    );

    const agentDir = join('./output/agents', 'alpha');
    fsState.dirEntries.set(agentDir, [
      'agent.json',
      'post-001.json',
      'post-002.json',
      'post-003.json',
    ]);
    fsState.files.set(
      join(agentDir, 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: '',
        caption: '',
        aspectRatio: 'square',
        published: true,
      }),
    );
    fsState.files.set(
      join(agentDir, 'post-002.json'),
      JSON.stringify({
        id: 'post-002',
        imagePrompt: '',
        caption: '',
        aspectRatio: 'square',
        published: true,
      }),
    );
    fsState.files.set(
      join(agentDir, 'post-003.json'),
      JSON.stringify({
        id: 'post-003',
        imagePrompt: '',
        caption: '',
        aspectRatio: 'square',
      }),
    );

    await status();
    const body = getNoteBody('InstaMolt Seeder');
    expect(body).toBeDefined();
    expect(body).toContain('2 posts'); // published
    expect(body).toMatch(/1 remaining/);
  });

  it('groups agents by persona in the breakdown (non-TTY fallback)', async () => {
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 2,
        totalPosts: 0,
        agents: [
          { agentname: 'alpha', personaId: 'brainrot9000', bio: 'a b c', apiKey: 'k' },
          { agentname: 'beta', personaId: 'cozy_circuit', bio: 'a b c' },
        ],
      }),
    );
    fsState.dirEntries.set(join('./output/agents', 'alpha'), []);
    fsState.dirEntries.set(join('./output/agents', 'beta'), []);

    await status();
    // The non-interactive fallback prints the breakdown via console.log.
    const out = getLogOutput();
    expect(out).toContain('brainrot9000');
    expect(out).toContain('cozy_circuit');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('tallies baked comment samples and surfaces the count in the headline', async () => {
    const agents = [
      { agentname: 'alpha', personaId: 'brainrot9000', bio: 'a b c', apiKey: 'k' },
      { agentname: 'beta', personaId: 'cozy_circuit', bio: 'a b c' },
    ];
    fsState.files.set(
      './output/agents.json',
      JSON.stringify({
        generatedAt: '2026-04-07T00:00:00Z',
        totalAgents: 2,
        totalPosts: 0,
        agents,
      }),
    );

    // alpha has a comments.json with 3 samples; beta has none.
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['agent.json', 'comments.json']);
    fsState.dirEntries.set(join('./output/agents', 'beta'), ['agent.json']);
    fsState.files.set(
      join('./output/agents', 'alpha', 'comments.json'),
      JSON.stringify({
        agentname: 'alpha',
        generatedAt: '2026-04-08T00:00:00Z',
        samples: [
          { sourceCaption: 'a', sourceAuthor: 'x', text: 'one', generatedAt: 'x' },
          { sourceCaption: 'b', sourceAuthor: 'y', text: 'two', generatedAt: 'x' },
          { sourceCaption: 'c', sourceAuthor: 'z', text: 'three', generatedAt: 'x' },
        ],
      }),
    );

    await status();
    const body = getNoteBody('InstaMolt Seeder');
    expect(body).toBeDefined();
    expect(body).toContain('Comment samples');
    expect(body).toContain('3');
    expect(body).toContain('1 agents'); // only alpha has samples

    const out = getLogOutput();
    // Per-persona breakdown should show alpha's persona with 3 samples.
    expect(out).toMatch(/brainrot9000.*3 comment samples/);
    expect(out).toMatch(/cozy_circuit.*0 comment samples/);
  });
});
