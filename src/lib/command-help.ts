/**
 * Per-command `--help` text.
 *
 * Kept in one place so the dispatcher in `src/index.ts` stays short and every
 * command renders help in the same shape: one-line role, usage, flags, what
 * it does, and a pipeline pointer (previous/next step). Help text is ANSI-
 * decorated via `src/lib/ui.ts`'s `color` facade so it reads the same in a
 * real terminal and in `docker compose run`.
 */

import * as ui from '@/lib/ui';

export interface CommandHelp {
  /** One-line role ("Phase 1: ..."). */
  role: string;
  /** Usage shape(s). */
  usage: string[];
  /** Flag docs: `[flagSyntax, description]`. */
  flags: Array<[string, string]>;
  /** Bulleted "what it does" summary. */
  body: string[];
  /** Optional next command in the pipeline (command name, not full invocation). */
  next?: string;
  /** Optional previous command in the pipeline. */
  prev?: string;
  /** Pointer to the living docs for the deep-dive. */
  docs: string;
}

const HELP: Record<string, CommandHelp> = {
  'seed-personas': {
    role: 'Phase 0: install personas into output/personas/.',
    usage: [
      'pnpm seed-personas --catalog [--force]',
      'pnpm seed-personas --hybrid --count <N> [--force]',
      'pnpm seed-personas --count <N> [--force]',
    ],
    flags: [
      [
        '--catalog',
        'Install the canonical 36-persona hand-authored catalog deterministically (no LLM cost). Recommended first run.',
      ],
      [
        '--hybrid',
        'Install the catalog AND top up to --count via Gemini using the catalog as few-shot anchors.',
      ],
      [
        '--count <N>',
        'Target persona count (default 30). Only meaningful without --catalog, or paired with --hybrid.',
      ],
      [
        '--force',
        'Wipe output/personas/ before installing. Otherwise idempotent (skips ids that already exist).',
      ],
    ],
    body: [
      'Auto-runs on first `generate` if output/personas/ is empty (pure-Gemini mode, count=30).',
      'Prose mirror of the catalog lives at docs/PERSONA-CATALOG.md — editing one without the other is a lint-level bug.',
    ],
    next: 'generate',
    docs: 'docs/BLUEPRINT.md §3.0 · docs/PERSONA-CATALOG.md',
  },

  generate: {
    role: 'Phase 1: create agents × post drafts on disk. No network writes.',
    usage: [
      'pnpm generate --agents <N> --posts <N>',
      'pnpm generate --agents <N> --min-posts <min> --max-posts <max>',
    ],
    flags: [
      [
        '--agents <N>',
        'Agents to create (default 50). Idempotent: re-running tops up per-persona, never duplicates.',
      ],
      [
        '--posts <N>',
        'Fixed post count per agent (default 20). Mutually exclusive with --min-posts/--max-posts.',
      ],
      [
        '--min-posts <N>',
        'Minimum posts per agent (requires --max-posts). Count rolled uniformly per agent.',
      ],
      ['--max-posts <N>', 'Maximum posts per agent (requires --min-posts).'],
    ],
    body: [
      'Generates agentname + bio + image-prompt drafts and bakes 2–5 comment + 1–3 reply samples per agent.',
      'Comment/reply samples pull from the live feed cache — the seeder aborts if instamolt.app has no public posts yet.',
      'Dedup context is loaded from output/dedup-index.json (falls back to a disk walk) and written back at end of run.',
    ],
    prev: 'seed-personas',
    next: 'publish-drafts',
    docs: 'docs/BLUEPRINT.md §3.1 · docs/SEEDING.md (generate section)',
  },

  publish: {
    role: 'Phase 2: register drafts on the live platform and publish their posts.',
    usage: [
      'pnpm publish-drafts',
      'pnpm publish-drafts --agent <name>',
      'pnpm publish-drafts --limit <N>',
      'pnpm publish-drafts --limit-agents <N>',
    ],
    flags: [
      ['--agent <name>', 'Scope to a single agent by agentname. Useful for surgical re-publishes.'],
      [
        '--limit <N>',
        'Publish at most N posts across the whole run. Good for smoke-testing before committing to the full set.',
      ],
      [
        '--limit-agents <N>',
        'Cap the run to the first N agents by agentname (ascending, deterministic). Repeat invocations with the same N hit the same subset — designed for the publish → engage --cycle-delay → reset --post-generate debug loop. Ignored when --agent is set.',
      ],
    ],
    body: [
      "Phase A: register unregistered agents (answers InstaMolt's AI challenge, stores apiKey in agent.json).",
      'Phase B: publishes unpublished drafts via POST /posts/generate (runs through InstaMoltClient, not an MCP subprocess).',
      'Phase C: bootstraps the follow graph across the freshly-registered agents.',
      'Idempotent: apiKey present = skip register; published:true = skip publish.',
      'Note: the pnpm script is named `publish-drafts` because `pnpm publish` is a reserved built-in.',
    ],
    prev: 'generate',
    next: 'engage-continuous',
    docs: 'docs/BLUEPRINT.md §3.2 · docs/SEEDING.md (publish section)',
  },

  engage: {
    role: 'Phase 3 (one-shot): pick agents, pull the explore feed, probabilistically like/comment/follow/post.',
    usage: [
      'pnpm engage [--agents <N>] [--actions-limit <N>]',
      'pnpm engage --loop [--agents <N>] [--actions-limit <N>] [--limit-agents <N>] [--cycle-delay <seconds>]',
    ],
    flags: [
      ['--agents <N>', 'Number of agents active this cycle (default 10).'],
      [
        '--actions-limit <N>',
        'Max actions (likes + comments + follows + posts) per agent this cycle (default 5).',
      ],
      [
        '--limit-agents <N>',
        'Debug only: deterministically pick the first N agents by agentname (ascending) instead of a random shuffle. Mirrors `publish-drafts --limit-agents` so both phases hit the same subset across runs — designed for the publish → engage --cycle-delay → reset --post-generate debug loop.',
      ],
      [
        '--loop',
        'Run forever: 5–15 min sleep between cycles, clean SIGINT handling. Ctrl+C finishes the current cycle.',
      ],
      [
        '--cycle-delay <seconds>',
        'Debug only: override BOTH the 30–60s inter-agent stagger AND the 5–15 min inter-cycle sleep with a fixed delay (e.g. `--cycle-delay 10`). Speed-runs what an agent would do in hours into minutes so you can preview interactions before a prod run. Do NOT use for production seeding. Note: the per-agent 65s comment cooldown still applies, so back-to-back comments from the same agent may be skipped under low delays.',
      ],
      [
        '--yes / -y',
        'Skip the pre-flight "confirm target URL" prompt. Under non-TTY (Docker, CI, cron) the prompt is already skipped so unattended runs don\'t hang; this flag is for TTY-scripted runs.',
      ],
    ],
    body: [
      'Pre-flight gate: prints the resolved `INSTAMOLT_API_URL` and, in a TTY, asks the operator to confirm before any live action fires — the target is flagged PRODUCTION when it points at instamolt.app.',
      'Per-agent probabilities gate every action (likeProbability, commentProbability, followProbability, postProbability).',
      "Comments load the baked samples from comments.json + the rolling runtime-comments.json tail (last 50) as the avoid-list, so --loop mode doesn't drift into repetition.",
      'For ongoing activity at scale, prefer `engage-continuous` — this is the simpler one-shot variant.',
    ],
    prev: 'publish',
    next: 'engage-continuous',
    docs: 'docs/BLUEPRINT.md §3.3 · docs/SEEDING.md (engage section)',
  },

  'engage-continuous': {
    role: 'Phase 3 (long-running): scheduler-driven engagement with burst-then-idle sessions and population growth.',
    usage: [
      'pnpm engage-continuous [--max-agents <N>] [--growth-rate <N>] [--growth-interval <h>] [--posts-per-new <N>] [...]',
      'pnpm engage-continuous [...] --min-posts-per-new <n> --max-posts-per-new <N>',
    ],
    flags: [
      ['--feed-pages <N>', 'Feed cache pages refreshed per tick.'],
      ['--feed-limit <N>', 'Posts per feed page.'],
      ['--max-actions <N>', 'Hard cap on actions per cycle (safety rail).'],
      ['--dry-run', 'Run the scheduler logic without touching the platform.'],
      ['--max-agents <N>', 'Upper bound on total population (growth stops here).'],
      ['--growth-rate <N>', 'Agents to add per growth tick.'],
      ['--growth-interval <h>', 'Hours between growth ticks (accepts fractional, e.g. 0.5).'],
      [
        '--posts-per-new <N>',
        'Fixed posts per growth-born agent (default 10). Mutually exclusive with the range flags below.',
      ],
      [
        '--min-posts-per-new <N>',
        'Minimum posts per growth-born agent (requires --max-posts-per-new). Each agent rolls a count in the inclusive range.',
      ],
      [
        '--max-posts-per-new <N>',
        'Maximum posts per growth-born agent (requires --min-posts-per-new).',
      ],
      ['--no-growth', 'Disable growth ticks; engage-only mode.'],
      ['--verbose', 'Mirror every event line to stdout. Only useful during initial tuning.'],
      [
        '--yes / -y',
        'Skip the pre-flight "confirm target URL" prompt. Under non-TTY (Docker, CI, cron) the prompt is already skipped so unattended runs don\'t hang; this flag is for TTY-scripted runs.',
      ],
    ],
    body: [
      'Pre-flight gate: prints the resolved `INSTAMOLT_API_URL` and, in a TTY, asks the operator to confirm before any live action fires — the target is flagged PRODUCTION when it points at instamolt.app.',
      'Models burst-then-quiet per-agent sessions, not flat uniform pacing.',
      'Growth ticks spawn new agents + drafts + published posts on the same cadence, so the population organically expands.',
      'All interactions land in output/logs/events.jsonl — use `pnpm events --since 1h` to audit.',
    ],
    prev: 'publish',
    docs: 'docs/BLUEPRINT.md §3.3 + §7 · docs/SEEDING.md (continuous engage)',
  },

  'preview-comments': {
    role: 'Read-only curation tool: preview sample comments to eyeball voice quality before baking.',
    usage: ['pnpm preview-comments [--persona <id>] [--agent <name>] [--count <N>]'],
    flags: [
      ['--persona <id>', 'Filter to one persona.'],
      ['--agent <name>', 'Filter to one agent.'],
      ['--count <N>', 'Samples per agent (default 3).'],
    ],
    body: [
      'Writes nothing to disk. Pulls captions from the live feed cache — aborts if the feed is empty.',
      'Iteration loop: tune persona.commentStyle or the generateComment prompt → re-run → eyeball → repeat.',
      'To bake your tuned prompt into agents, delete the affected comments.json files and re-run `generate`.',
    ],
    docs: 'docs/BLUEPRINT.md §3.5',
  },

  'lint-drafts': {
    role: 'Quality gate: scan generated drafts for caption/prompt/cross-agent similarity clusters.',
    usage: [
      'pnpm lint-drafts [--caption-threshold <f>] [--prompt-threshold <f>] [--cross-threshold <f>] [--agent <name>] [--json]',
    ],
    flags: [
      [
        '--caption-threshold <f>',
        'Jaccard cutoff for intra-agent caption similarity (default 0.6).',
      ],
      [
        '--prompt-threshold <f>',
        'Jaccard cutoff for intra-agent image-prompt similarity (default 0.5).',
      ],
      ['--cross-threshold <f>', 'Jaccard cutoff for cross-agent similarity (default 0.5).'],
      ['--agent <name>', 'Scope to one agent.'],
      ['--json', 'Emit machine-readable JSON instead of the TTY report.'],
    ],
    body: [
      'Useful between `generate` and `publish-drafts` to catch accidental batch-mode echoes before they hit the platform.',
    ],
    docs: 'docs/BLUEPRINT.md (lint-drafts section)',
  },

  'graph-stats': {
    role: 'Follow-graph analytics: density, clustering, cross-persona flows from events.jsonl.',
    usage: ['pnpm graph-stats'],
    flags: [],
    body: [
      'Reads output/logs/events.jsonl and derives follow-edge statistics (out-degree, reciprocity, persona-persona matrix).',
    ],
    docs: 'docs/BLUEPRINT.md §3.8',
  },

  status: {
    role: 'On-disk report: agent/post/persona counts + last-session metrics from stats.json.',
    usage: ['pnpm status'],
    flags: [],
    body: [
      'Answers "what do I have on disk?". For "what has happened, and when?", use `pnpm events`.',
      'Degrades to plain-text output under non-TTY (pipes, `docker compose run -T`) so `pnpm status > status.txt` parses cleanly.',
    ],
    docs: 'docs/BLUEPRINT.md §3.4',
  },

  events: {
    role: 'Structured event-log report: tally events.jsonl globally + per-session with timelines.',
    usage: [
      'pnpm events',
      'pnpm events --session <id>',
      'pnpm events --since 30m|2h|3d|<ISO>',
      'pnpm events --all',
    ],
    flags: [
      [
        '--session <id>',
        'Scope to a single session id (suppresses the per-session block in favor of filtered totals).',
      ],
      [
        '--since <duration|ISO>',
        'Time cutoff. Duration form: 30m, 2h, 3d. Or a parseable ISO timestamp.',
      ],
      ['--all', 'Show every session in the per-session block (default shows the last 5).'],
    ],
    body: [
      'A "session" is a rolling 24h window (SESSION_RESUME_WINDOW_MS), not a single process lifetime — back-to-back commands inside 24h share a sessionId. See docs/BLUEPRINT.md §4.7.',
      'Companion to `status`: status = "what\'s on disk", events = "what has happened, and when".',
    ],
    docs: 'docs/BLUEPRINT.md §3.4 (sibling paragraph) + §4.7',
  },

  reset: {
    role: 'Destructive: wipe seeder state on disk. Does NOT unregister agents on the platform.',
    usage: [
      'pnpm reset --agent <name> [--force]',
      'pnpm reset --persona <id> [--force]',
      'pnpm reset --cache | --logs | --all [--force]',
      'pnpm reset --post-generate [--force]',
    ],
    flags: [
      [
        '--agent <name>',
        "Delete one agent's output/agents/<name>/ directory and its agents.json entry.",
      ],
      ['--persona <id>', 'Delete every agent tied to a persona id.'],
      ['--cache', 'Wipe output/feed-cache.json + output/dedup-index.json.'],
      ['--logs', 'Wipe output/logs/.'],
      ['--all', 'Nuclear: everything under output/ except persona definitions.'],
      [
        '--post-generate',
        'Rewind every agent to "just finished `pnpm generate`" state: strip apiKey/registeredAt/lastCommentedAt from agent.json + agents.json entries, strip published/publishedAt/instamoltPostId from every post-*.json, delete per-agent runtime-comments.json + activity.jsonl, wipe output/logs/ + output/feed-cache.json. Preserves bios, post drafts, baked comments.json, personas, dedup-index.json. Designed for fast debug iteration against the seed DB — the next `publish-drafts` re-registers every agent from scratch.',
      ],
      ['--force', 'Skip the interactive confirmation prompt.'],
    ],
    body: [
      'Already-registered platform agents keep their accounts — resetting disk state does not delete them upstream.',
      'Use with `pnpm seed-personas --catalog` + `pnpm generate` to start over cleanly.',
      "`--post-generate` is the surgical rewind for the `publish → engage --cycle-delay → inspect → reset` debug loop: drafts survive so Gemini doesn't get re-billed, only the live-platform artifacts go.",
    ],
    docs: 'docs/BLUEPRINT.md (reset section)',
  },

  bootstrap: {
    role: 'Wrapper: `generate` → `publish-drafts` → `engage-continuous` in one invocation.',
    usage: [
      'pnpm bootstrap --agents <N> --min-posts <n> --max-posts <N> --max-agents <N> --growth-rate <N> --growth-interval <h> --min-posts-per-new <n> --max-posts-per-new <N>',
    ],
    flags: [
      ['(generate)', '--agents, --posts, --min-posts, --max-posts'],
      ['(publish)', '--agent, --limit'],
      [
        '(engage-continuous)',
        '--feed-pages, --feed-limit, --max-actions, --dry-run, --max-agents, --growth-rate, --growth-interval, --posts-per-new, --min-posts-per-new, --max-posts-per-new, --no-growth, --verbose',
      ],
    ],
    body: [
      "Flags are routed per-phase; unknown flags abort upfront so a typo can't silently get dropped on the way to a long-running engage loop.",
      'Thin wrapper over the same CLI entrypoints — no behavioral divergence from running each phase manually.',
      'Re-run with the same args to resume: every phase is idempotent.',
    ],
    docs: 'scripts/bootstrap.ts · docs/SEEDING.md',
  },
};

function formatBlock(name: string, help: CommandHelp): string {
  const c = ui.color;
  const lines: string[] = [];
  const heading = c.bold(c.bgCyan(c.black(` ${name} `)));
  lines.push('', heading, '');
  lines.push(c.dim(help.role));

  if (help.prev || help.next) {
    const arrow = c.dim(ui.symbol.arrow);
    const pipeline = [
      help.prev ? c.dim(help.prev) : '',
      c.bold(c.cyan(name)),
      help.next ? c.green(help.next) : '',
    ]
      .filter(Boolean)
      .join(` ${arrow} `);
    lines.push(c.dim(`Pipeline:  ${pipeline}`));
  }

  lines.push('', c.bold('Usage:'));
  for (const u of help.usage) lines.push(`  ${c.green(u)}`);

  if (help.flags.length > 0) {
    lines.push('', c.bold('Flags:'));
    const widest = help.flags.reduce((max, [flag]) => Math.max(max, flag.length), 0);
    for (const [flag, desc] of help.flags) {
      lines.push(`  ${c.yellow(flag.padEnd(widest))}  ${c.dim(desc)}`);
    }
  }

  if (help.body.length > 0) {
    lines.push('', c.bold('Notes:'));
    for (const b of help.body) lines.push(`  ${c.dim(ui.symbol.dot)} ${b}`);
  }

  lines.push('', c.dim(`Docs: ${help.docs}`), '');
  return lines.join('\n');
}

/**
 * Print help for a command. Returns true iff help was printed — the dispatcher
 * uses this to short-circuit before running the command.
 */
export function maybePrintCommandHelp(command: string | undefined, args: string[]): boolean {
  if (!command || !args.includes('--help')) return false;
  const help = HELP[command];
  if (!help) return false;
  console.log(formatBlock(command, help));
  return true;
}

/** Exposed for tests. */
export function getCommandHelp(command: string): CommandHelp | undefined {
  return HELP[command];
}

/** Exposed for tests and the top-level `--help` listing. */
export function listCommands(): string[] {
  return Object.keys(HELP);
}
