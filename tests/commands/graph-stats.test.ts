import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
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
}));

const uiState = vi.hoisted(() => ({
  notes: [] as Array<{ title: string; body: string }>,
  outros: [] as string[],
  intros: [] as string[],
  sections: [] as string[],
}));

vi.mock('@/lib/ui', () => ({
  intro: vi.fn((msg: string) => {
    uiState.intros.push(msg);
  }),
  outro: vi.fn((msg: string) => {
    uiState.outros.push(msg);
  }),
  section: vi.fn((msg: string) => {
    uiState.sections.push(msg);
  }),
  note: vi.fn((title: string, body: string) => {
    uiState.notes.push({ title, body });
  }),
  isInteractive: vi.fn(() => false),
  // summaryLine is called inline with the main Follow Graph note; we just need
  // a string back that the note can embed.
  summaryLine: vi.fn((items: Array<{ label: string; value: number | string }>) =>
    items.map((i) => `${i.label}=${i.value}`).join(' '),
  ),
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

import { graphStats } from '@/commands/graph-stats';
import { config } from '@/config';

const eventsPath = join(config.logsDir, 'events.jsonl');

function makeFollow(opts: {
  agentname: string;
  target: string;
  tier?: 1 | 2 | 3;
  success?: boolean;
}): string {
  return JSON.stringify({
    timestamp: '2026-04-07T00:00:00Z',
    eventType: 'follow',
    agentname: opts.agentname,
    success: opts.success ?? true,
    details: {
      target: opts.target,
      ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
    },
  });
}

function resetState(): void {
  fsState.files.clear();
  uiState.notes.length = 0;
  uiState.outros.length = 0;
  uiState.intros.length = 0;
  uiState.sections.length = 0;
}

function getNote(title: string): { title: string; body: string } | undefined {
  return uiState.notes.find((n) => n.title === title);
}

function getNoteBody(title: string): string | undefined {
  return getNote(title)?.body;
}

describe('graphStats', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handles a missing events.jsonl gracefully (no throw, warning outro)', async () => {
    // No file set → readFile throws ENOENT.
    await expect(graphStats()).resolves.toBeUndefined();

    expect(getNote('No events log found')).toBeDefined();
    expect(uiState.outros.join(' ')).toMatch(/no data/);
  });

  it('handles an empty events.jsonl (zero edges, warning outro)', async () => {
    fsState.files.set(eventsPath, '');

    await expect(graphStats()).resolves.toBeUndefined();

    // With zero follow events, the source emits the "No follow events found" note.
    expect(getNote('No follow events found')).toBeDefined();
    expect(uiState.outros.join(' ')).toMatch(/no follow data/);
  });

  it('skips malformed JSONL lines but still counts valid follow events', async () => {
    const lines = [
      makeFollow({ agentname: 'alpha', target: 'beta', tier: 1 }),
      '{ not valid json',
      'also garbage',
      makeFollow({ agentname: 'gamma', target: 'delta', tier: 2 }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const body = getNoteBody('Follow Graph');
    expect(body).toBeDefined();
    expect(body).toContain('edges=2');
  });

  it('counts total edges equal to the number of follow events', async () => {
    const lines = [
      makeFollow({ agentname: 'a', target: 'b', tier: 1 }),
      makeFollow({ agentname: 'a', target: 'c', tier: 1 }),
      makeFollow({ agentname: 'b', target: 'c', tier: 2 }),
      makeFollow({ agentname: 'd', target: 'e', tier: 3 }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const body = getNoteBody('Follow Graph');
    expect(body).toContain('edges=4');
  });

  it('computes reciprocity as mutualEdges / totalEdges', async () => {
    // Two mutual pairs (a<->b, c<->d) and one one-way edge (e->f).
    // mutual edges = 4 (a->b, b->a, c->d, d->c counted individually), total = 5.
    const lines = [
      makeFollow({ agentname: 'a', target: 'b', tier: 1 }),
      makeFollow({ agentname: 'b', target: 'a', tier: 1 }),
      makeFollow({ agentname: 'c', target: 'd', tier: 2 }),
      makeFollow({ agentname: 'd', target: 'c', tier: 2 }),
      makeFollow({ agentname: 'e', target: 'f', tier: 3 }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const body = getNoteBody('Follow Graph');
    expect(body).toBeDefined();
    // mutualCount is 4 (each direction counted), totalEdges = 5 → 80.0
    expect(body).toContain('reciprocity %=80');
  });

  it('breaks down follows by tier (1, 2, 3)', async () => {
    const lines = [
      makeFollow({ agentname: 'a', target: 'b', tier: 1 }),
      makeFollow({ agentname: 'a', target: 'c', tier: 1 }),
      makeFollow({ agentname: 'a', target: 'd', tier: 1 }),
      makeFollow({ agentname: 'b', target: 'c', tier: 2 }),
      makeFollow({ agentname: 'b', target: 'd', tier: 2 }),
      makeFollow({ agentname: 'c', target: 'd', tier: 3 }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const body = getNoteBody('Follow Sources');
    expect(body).toBeDefined();
    expect(body).toMatch(/Tier 1 \(relationship\): 3/);
    expect(body).toMatch(/Tier 2 \(affinity\):\s+2/);
    expect(body).toMatch(/Tier 3 \(discovery\):\s+1/);
  });

  it('lists only fully-disconnected agents (0 inbound AND 0 outbound) as isolated', async () => {
    // delta appears as a follow-event author but every follow attempt it
    // made failed (success=false) → delta has zero inbound AND zero
    // outbound edges → delta is isolated. alpha has outbound follows so it
    // is NOT isolated even though nobody follows alpha back. beta and
    // gamma are targets of alpha's follows so they have inbound edges.
    const lines = [
      makeFollow({ agentname: 'alpha', target: 'beta', tier: 1 }),
      makeFollow({ agentname: 'alpha', target: 'gamma', tier: 2 }),
      // delta tried to follow beta but the server rejected → no edge is
      // recorded, but delta is still present in the population.
      makeFollow({ agentname: 'delta', target: 'beta', tier: 1, success: false }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const isolatedNote = uiState.notes.find((n) => /with 0 inbound and 0 outbound/.test(n.title));
    expect(isolatedNote).toBeDefined();
    expect(isolatedNote!.body).toContain('@delta');
    expect(isolatedNote!.body).not.toContain('@alpha');
    expect(isolatedNote!.body).not.toContain('@beta');
    expect(isolatedNote!.body).not.toContain('@gamma');
    expect(isolatedNote!.body).not.toContain('@gamma');
  });

  it('dedupes duplicate follow events (edge counted once, tier counted once)', async () => {
    const lines = [
      makeFollow({ agentname: 'alpha', target: 'beta', tier: 1 }),
      makeFollow({ agentname: 'alpha', target: 'beta', tier: 1 }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const body = getNoteBody('Follow Graph');
    expect(body).toBeDefined();
    expect(body).toContain('edges=1');

    const tierBody = getNoteBody('Follow Sources');
    expect(tierBody).toBeDefined();
    expect(tierBody).toMatch(/Tier 1 \(relationship\): 1/);
  });

  it('ranks the most-followed agents in descending order', async () => {
    // beta: 3 followers, gamma: 2, delta: 1.
    const lines = [
      makeFollow({ agentname: 'a', target: 'beta', tier: 1 }),
      makeFollow({ agentname: 'b', target: 'beta', tier: 1 }),
      makeFollow({ agentname: 'c', target: 'beta', tier: 1 }),
      makeFollow({ agentname: 'a', target: 'gamma', tier: 2 }),
      makeFollow({ agentname: 'b', target: 'gamma', tier: 2 }),
      makeFollow({ agentname: 'a', target: 'delta', tier: 3 }),
    ];
    fsState.files.set(eventsPath, lines.join('\n'));

    await graphStats();

    const body = getNoteBody('Top 10');
    expect(body).toBeDefined();
    expect(body).toMatch(/1\. @beta — 3 followers/);
    expect(body).toMatch(/2\. @gamma — 2 followers/);
    expect(body).toMatch(/3\. @delta — 1 followers/);
    // beta must appear before gamma in the output
    const betaIdx = body!.indexOf('beta');
    const gammaIdx = body!.indexOf('gamma');
    expect(betaIdx).toBeLessThan(gammaIdx);
  });
});
