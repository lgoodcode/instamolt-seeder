import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandHelp, listCommands, maybePrintCommandHelp } from '@/lib/command-help';

// The help formatter threads output through ui.color (picocolors). Picocolors
// auto-detects TTY; we just want to assert on content, not ANSI.

describe('command-help', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('exposes help for every dispatcher command', () => {
    // These are the commands handled by src/index.ts (plus the bootstrap
    // wrapper script). If a new command lands in the dispatcher, it must
    // land with a help entry.
    const expected = [
      'seed-personas',
      'generate',
      'publish',
      'engage',
      'engage-continuous',
      'preview-comments',
      'lint-drafts',
      'graph-stats',
      'status',
      'events',
      'reset',
      'bootstrap',
    ];
    const actual = listCommands();
    for (const cmd of expected) {
      expect(actual).toContain(cmd);
      const entry = getCommandHelp(cmd);
      expect(entry, `help entry missing for ${cmd}`).toBeDefined();
      expect(entry!.role.length, `role empty for ${cmd}`).toBeGreaterThan(0);
      expect(entry!.usage.length, `usage empty for ${cmd}`).toBeGreaterThan(0);
      expect(entry!.docs.length, `docs empty for ${cmd}`).toBeGreaterThan(0);
    }
  });

  it('prints help when --help is in args and the command is known', () => {
    const handled = maybePrintCommandHelp('generate', ['generate', '--help']);
    expect(handled).toBe(true);
    expect(logSpy).toHaveBeenCalled();
    const printed = (logSpy.mock.calls as unknown as unknown[][])
      .map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain('generate');
    expect(printed).toContain('Usage:');
    expect(printed).toContain('--agents');
  });

  it('is a no-op when --help is absent', () => {
    const handled = maybePrintCommandHelp('generate', ['generate', '--agents', '50']);
    expect(handled).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown command even with --help', () => {
    const handled = maybePrintCommandHelp('nonsense', ['nonsense', '--help']);
    expect(handled).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when command is undefined', () => {
    const handled = maybePrintCommandHelp(undefined, ['--help']);
    expect(handled).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('documents the min/max-posts-per-new range flags on engage-continuous and bootstrap', () => {
    for (const cmd of ['engage-continuous', 'bootstrap'] as const) {
      logSpy.mockClear();
      maybePrintCommandHelp(cmd, [cmd, '--help']);
      const printed = (logSpy.mock.calls as unknown as unknown[][])
        .map((c) => String(c[0]))
        .join('\n');
      expect(printed, `${cmd} help missing --min-posts-per-new`).toContain('--min-posts-per-new');
      expect(printed, `${cmd} help missing --max-posts-per-new`).toContain('--max-posts-per-new');
    }
  });

  it('renders pipeline pointers when prev/next are defined', () => {
    maybePrintCommandHelp('generate', ['generate', '--help']);
    const printed = (logSpy.mock.calls as unknown as unknown[][])
      .map((c) => String(c[0]))
      .join('\n');
    expect(printed).toMatch(/Pipeline:/);
    expect(printed).toMatch(/seed-personas/);
    expect(printed).toMatch(/publish-drafts/);
  });
});
