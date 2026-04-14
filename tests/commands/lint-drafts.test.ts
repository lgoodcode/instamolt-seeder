import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------- fs mocks ----------------

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Map<string, string[]>(),
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
    const entries = fsState.dirs.get(path);
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  }),
}));

// ---------------- ui mock ----------------

vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  section: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: '' })),
  progress: vi.fn(() => ({ tick: vi.fn(), done: vi.fn() })),
  color: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    bgCyan: (s: string) => s,
    black: (s: string) => s,
  },
  symbol: { ok: '\u2714', err: '\u2718', arrow: '\u2192', bullet: '\u25CF', warn: '\u26A0' },
  summaryLine: vi.fn(() => ''),
  isInteractive: vi.fn(() => false),
}));

// ---------------- helpers ----------------

function addAgent(
  name: string,
  personaId: string,
  posts: Array<{ id: string; caption: string; imagePrompt: string }>,
): void {
  const agentDir = join('./output/agents', name);
  // Add to agents dir listing
  const agentsDirEntries = fsState.dirs.get('./output/agents') ?? [];
  agentsDirEntries.push(name);
  fsState.dirs.set('./output/agents', agentsDirEntries);

  // Add agent.json
  fsState.files.set(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      agentname: name,
      personaId,
      voiceProfileId: 'default',
      bio: 'test',
    }),
  );

  // Add post files and dir listing
  const postFiles = posts.map((p) => `${p.id}.json`);
  fsState.dirs.set(agentDir, ['agent.json', ...postFiles]);

  for (const post of posts) {
    fsState.files.set(
      join(agentDir, `${post.id}.json`),
      JSON.stringify({
        id: post.id,
        imagePrompt: post.imagePrompt,
        caption: post.caption,
        aspectRatio: 'square',
      }),
    );
  }
}

function defaultOpts(
  overrides: Partial<import('@/commands/lint-drafts').LintDraftsOptions> = {},
): import('@/commands/lint-drafts').LintDraftsOptions {
  return {
    captionThreshold: 0.6,
    promptThreshold: 0.5,
    crossThreshold: 0.5,
    json: false,
    ...overrides,
  };
}

// ---------------- import SUT ----------------

import { lintDrafts } from '@/commands/lint-drafts';
import * as uiMod from '@/lib/ui';

// ---------------- suite ----------------

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
  fsState.dirs.set('./output/agents', []);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lintDrafts', () => {
  // 1. Identical captions flagged
  it('flags identical captions as a similar pair', async () => {
    const sharedCaption =
      'A beautiful sunset over the ocean with golden light reflecting off the waves and birds flying in the distance';
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset ocean' },
      { id: 'post-002', caption: sharedCaption, imagePrompt: 'mountain lake' },
      // Need enough posts so >25% are flagged (2 flagged / 3 total = 66%)
      {
        id: 'post-003',
        caption: 'Something completely different about cooking and recipes',
        imagePrompt: 'cooking',
      },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report: unknown = JSON.parse(output);
    expect(report).toHaveProperty('captionFlags');

    const typed = report as {
      captionFlags: Array<{
        agentname: string;
        pairs: Array<{ postA: string; postB: string; similarity: number }>;
      }>;
    };
    expect(typed.captionFlags.length).toBe(1);
    expect(typed.captionFlags[0]!.agentname).toBe('agent1');
    expect(typed.captionFlags[0]!.pairs.length).toBe(1);
    expect(typed.captionFlags[0]!.pairs[0]!.similarity).toBe(1);

    consoleSpy.mockRestore();
  });

  // 2. Different captions clean
  it('produces no flags for completely different captions', async () => {
    addAgent('agent1', 'persona-a', [
      {
        id: 'post-001',
        caption: 'The early morning dew glistens on fresh spring leaves in the garden',
        imagePrompt: 'garden morning',
      },
      {
        id: 'post-002',
        caption: 'Heavy metal concert tonight downtown with three local bands performing live',
        imagePrompt: 'concert stage',
      },
      {
        id: 'post-003',
        caption: 'My new recipe for chocolate soufflé turned out absolutely perfect today',
        imagePrompt: 'dessert plating',
      },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      captionFlags: unknown[];
      promptFlags: unknown[];
      crossAgentFlags: unknown[];
    };
    expect(report.captionFlags).toHaveLength(0);
    expect(report.promptFlags).toHaveLength(0);
    expect(report.crossAgentFlags).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  // 3. Agent flag threshold — >25% posts in similar pairs → flagged
  it('flags an agent when >25% of posts appear in similar pairs', async () => {
    // 4 posts, 2 are identical → 2/4 = 50% > 25%
    const repeated =
      'A cozy cabin in the woods surrounded by tall pine trees with smoke rising from the chimney during winter';
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: repeated, imagePrompt: 'cabin woods' },
      { id: 'post-002', caption: repeated, imagePrompt: 'cabin winter' },
      {
        id: 'post-003',
        caption:
          'Urban street photography with neon signs and reflections on wet pavement at night',
        imagePrompt: 'city night',
      },
      {
        id: 'post-004',
        caption: 'Fresh homemade pasta being rolled out on a wooden counter with flour dusting',
        imagePrompt: 'pasta making',
      },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      captionFlags: Array<{ agentname: string; flagRatio: number }>;
    };
    expect(report.captionFlags.length).toBe(1);
    expect(report.captionFlags[0]!.flagRatio).toBe(0.5);

    consoleSpy.mockRestore();
  });

  // 4. Agent below flag threshold → NOT flagged
  it('does not flag an agent when <=25% of posts appear in similar pairs', async () => {
    // 8 posts, 2 identical → 2/8 = 25% = not above threshold
    const repeated =
      'A cozy cabin in the woods surrounded by tall pine trees with smoke rising from the chimney during winter';
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: repeated, imagePrompt: 'cabin woods' },
      { id: 'post-002', caption: repeated, imagePrompt: 'cabin winter' },
      {
        id: 'post-003',
        caption:
          'Urban street photography with neon signs and reflections on wet pavement at night',
        imagePrompt: 'city night',
      },
      {
        id: 'post-004',
        caption: 'Fresh homemade pasta being rolled out on a wooden counter with flour dusting',
        imagePrompt: 'pasta making',
      },
      {
        id: 'post-005',
        caption: 'A cat sleeping peacefully on a warm windowsill next to a blooming orchid plant',
        imagePrompt: 'cat window',
      },
      {
        id: 'post-006',
        caption:
          'Mountain biking through autumn trails with golden leaves scattered across the path',
        imagePrompt: 'biking trail',
      },
      {
        id: 'post-007',
        caption:
          'The local farmers market on Saturday morning with colorful produce and handmade crafts',
        imagePrompt: 'market produce',
      },
      {
        id: 'post-008',
        caption:
          'Deep sea diving photographs showing vibrant coral reefs and tropical fish species',
        imagePrompt: 'coral reef',
      },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      captionFlags: unknown[];
    };
    expect(report.captionFlags).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  // 5. Cross-agent only within same persona
  it('does not cross-compare agents of different personas', async () => {
    const sharedCaption =
      'A beautiful sunset over the ocean with golden light reflecting off the waves and birds flying in the distance';
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset' },
    ]);
    addAgent('agent2', 'persona-b', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      crossAgentFlags: unknown[];
    };
    expect(report.crossAgentFlags).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  // 6. Cross-agent same persona
  it('flags cross-agent similarity within the same persona', async () => {
    const sharedCaption =
      'A beautiful sunset over the ocean with golden light reflecting off the waves and birds flying in the distance';
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset' },
    ]);
    addAgent('agent2', 'persona-a', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      crossAgentFlags: Array<{
        personaId: string;
        pairs: Array<{ agentA: string; agentB: string; similarity: number }>;
      }>;
    };
    expect(report.crossAgentFlags.length).toBe(1);
    expect(report.crossAgentFlags[0]!.personaId).toBe('persona-a');
    expect(report.crossAgentFlags[0]!.pairs[0]!.similarity).toBe(1);

    consoleSpy.mockRestore();
  });

  // 7. --agent filter
  it('only lints the specified agent when --agent is set', async () => {
    const sharedCaption =
      'A beautiful sunset over the ocean with golden light reflecting off the waves and birds flying in the distance';
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset' },
      { id: 'post-002', caption: sharedCaption, imagePrompt: 'sunset2' },
      {
        id: 'post-003',
        caption: 'Something entirely different about code and computers',
        imagePrompt: 'code',
      },
    ]);
    addAgent('agent2', 'persona-a', [
      { id: 'post-001', caption: sharedCaption, imagePrompt: 'sunset' },
      { id: 'post-002', caption: sharedCaption, imagePrompt: 'sunset2' },
      {
        id: 'post-003',
        caption: 'Another unique post about gardening and growing vegetables',
        imagePrompt: 'garden',
      },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ agent: 'agent1', json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      summary: { agentsScanned: number };
      crossAgentFlags: unknown[];
    };
    // Only agent1 scanned
    expect(report.summary.agentsScanned).toBe(1);
    // No cross-agent flags because only one agent is in scope
    expect(report.crossAgentFlags).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  // 8. --json output produces valid JSON
  it('produces valid JSON output in json mode', async () => {
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: 'Some caption text here', imagePrompt: 'prompt here' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0]?.[0] as string;

    // Validate it parses as JSON
    const parsed: unknown = JSON.parse(output);
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('captionFlags');
    expect(parsed).toHaveProperty('promptFlags');
    expect(parsed).toHaveProperty('crossAgentFlags');

    consoleSpy.mockRestore();
  });

  it('suppresses ui.note warnings in --json mode so stdout stays parseable', async () => {
    // Plant a broken agent: dir entry exists but agent.json is unreadable.
    // In non-json mode this emits a ui.note('Warning', ...); in --json mode
    // it must stay silent so consumers can `JSON.parse(stdout)`.
    const agentsDirEntries = fsState.dirs.get('./output/agents') ?? [];
    agentsDirEntries.push('broken_agent');
    fsState.dirs.set('./output/agents', agentsDirEntries);
    // No agent.json → loadAgentPosts hits the unreadable-agent.json branch.

    // Also add one valid agent so lintDrafts doesn't short-circuit on empty.
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: 'Valid caption', imagePrompt: 'prompt' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    expect(uiMod.note).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(output)).not.toThrow();

    consoleSpy.mockRestore();
  });

  // 9. Empty directory
  it('exits cleanly when no agents exist', async () => {
    await lintDrafts(defaultOpts());

    expect(uiMod.outro).toHaveBeenCalledWith('No agents found');
  });

  // 10. Missing imagePrompt gracefully handled
  it('handles posts without imagePrompt in Pass 2 without crashing', async () => {
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: 'A caption for post one about nature', imagePrompt: '' },
      { id: 'post-002', caption: 'A caption for post two about cooking', imagePrompt: '' },
      { id: 'post-003', caption: 'A caption for post three about travel', imagePrompt: '' },
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await lintDrafts(defaultOpts({ json: true }));

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const report = JSON.parse(output) as {
      promptFlags: unknown[];
    };
    // No prompt flags because all imagePrompts are empty → jaccard returns 0
    expect(report.promptFlags).toHaveLength(0);

    consoleSpy.mockRestore();
  });

  // Non-JSON mode uses ui facade
  it('uses ui facade for terminal output in non-json mode', async () => {
    addAgent('agent1', 'persona-a', [
      { id: 'post-001', caption: 'Some unique caption text', imagePrompt: 'prompt' },
    ]);

    await lintDrafts(defaultOpts({ json: false }));

    expect(uiMod.intro).toHaveBeenCalledWith('Draft Lint');
    expect(uiMod.section).toHaveBeenCalled();
    expect(uiMod.outro).toHaveBeenCalled();
  });

  // Missing agents directory entirely
  it('handles missing agents directory gracefully', async () => {
    fsState.dirs.delete('./output/agents');

    await lintDrafts(defaultOpts());

    expect(uiMod.outro).toHaveBeenCalledWith('No agents found');
  });
});
