/**
 * Bootstrap an InstaMolt seeder population end-to-end: generate -> publish -> engage-continuous.
 *
 * Example:
 *   pnpm bootstrap --agents 200 --min-posts 3 --max-posts 20 \
 *     --max-agents 2000 --growth-rate 15 --growth-interval 0.5 --posts-per-new 15
 *
 * Flags are routed per phase; unknown flags abort with a helpful error so a
 * typo can't silently get dropped on its way to the long-running engage loop.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { confirmTarget } from '@/lib/confirm-target';
import * as ui from '@/lib/ui';

const CLI_ENTRY = resolve(import.meta.dirname, '..', 'src', 'index.ts');

const GENERATE_FLAGS = new Set(['agents', 'posts', 'min-posts', 'max-posts']);
const PUBLISH_FLAGS = new Set(['agent', 'limit']);
const ENGAGE_FLAGS = new Set([
  'feed-pages',
  'feed-limit',
  'max-actions',
  'dry-run',
  'max-agents',
  'growth-rate',
  'growth-interval',
  'posts-per-new',
  'min-posts-per-new',
  'max-posts-per-new',
  'no-growth',
  'verbose',
]);

const BOOLEAN_FLAGS = new Set(['dry-run', 'no-growth', 'verbose']);

type FlagMap = Map<string, string | true>;

function parseArgs(argv: string[]): FlagMap {
  const out: FlagMap = new Map();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`bootstrap: unexpected positional arg "${token}"`);
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      out.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`bootstrap: flag --${name} requires a value`);
    }
    out.set(name, value);
    i++;
  }
  return out;
}

function flagsFor(parsed: FlagMap, allowed: Set<string>): string[] {
  const out: string[] = [];
  for (const [name, value] of parsed) {
    if (!allowed.has(name)) continue;
    if (value === true) {
      out.push(`--${name}`);
    } else {
      out.push(`--${name}`, value);
    }
  }
  return out;
}

function assertAllFlagsRouted(parsed: FlagMap): void {
  const routed = new Set([...GENERATE_FLAGS, ...PUBLISH_FLAGS, ...ENGAGE_FLAGS]);
  const unknown = [...parsed.keys()].filter((name) => !routed.has(name));
  if (unknown.length > 0) {
    throw new Error(`bootstrap: unknown flag(s): ${unknown.map((n) => `--${n}`).join(', ')}`);
  }
}

function runPhase(phase: string, args: string[]): void {
  const label = `\n▶ ${phase} ${args.join(' ')}\n`;
  console.log(label);
  const result = spawnSync('tsx', [CLI_ENTRY, phase, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`bootstrap: phase "${phase}" exited with code ${result.status}`);
  }
}

function printHelp(): void {
  console.log(`
  bootstrap — Wrapper: generate → publish-drafts → engage-continuous in one invocation.

  Usage:
    pnpm bootstrap --agents <N> --min-posts <n> --max-posts <N> \\
      --max-agents <N> --growth-rate <N> --growth-interval <h> \\
      --min-posts-per-new <n> --max-posts-per-new <N>

  Flags are routed per-phase:
    generate:           --agents, --posts, --min-posts, --max-posts
    publish:            --agent, --limit
    engage-continuous:  --feed-pages, --feed-limit, --max-actions, --dry-run,
                        --max-agents, --growth-rate, --growth-interval,
                        --posts-per-new, --min-posts-per-new, --max-posts-per-new,
                        --no-growth, --verbose

  Notes:
    - Unknown flags abort upfront so a typo can't silently get dropped on the
      way to a long-running engage loop.
    - Thin wrapper — every phase is idempotent, re-run the same args to resume.
    - For per-phase details: pnpm <phase> --help

  Docs: scripts/bootstrap.ts · docs/SEEDING.md
`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help')) {
    printHelp();
    return;
  }
  const parsed = parseArgs(rawArgs);
  assertAllFlagsRouted(parsed);

  // Gate target confirmation once at the orchestrator level so the operator
  // isn't re-prompted between `generate` (no network writes, no prompt) and
  // `publish` / `engage-continuous` (which each call `confirmTarget` on their
  // own). Skipping this and letting `publish` ask mid-run produced a stalled
  // bootstrap where the operator had wandered off and came back to an idle
  // "Hit PRODUCTION?" prompt.
  if (!(await confirmTarget('bootstrap'))) {
    ui.outro(ui.color.yellow(`${ui.symbol.warn} bootstrap aborted — target not confirmed`));
    return;
  }

  runPhase('generate', flagsFor(parsed, GENERATE_FLAGS));
  runPhase('publish', [...flagsFor(parsed, PUBLISH_FLAGS), '--yes']);
  runPhase('engage-continuous', [...flagsFor(parsed, ENGAGE_FLAGS), '--yes']);
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
