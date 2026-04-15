import { engage } from '@/commands/engage';
import { engageContinuous } from '@/commands/engage-continuous';
import { generate } from '@/commands/generate';
import { previewComments } from '@/commands/preview-comments';
import { publish } from '@/commands/publish';
import { seedPersonasCommand } from '@/commands/seed-personas';
import { status } from '@/commands/status';
import { drainWrites, flushStats } from '@/lib/event-logger';
import * as ui from '@/lib/ui';
import { GeminiQuotaError } from '@/services/llm';

// Best-effort flush on termination so `stats.json` isn't up to 49 events
// stale when the process dies. Node fires every registered signal listener
// on the same tick; flushStats() is idempotent and a no-op when the logger
// was never initialized, so this is safe to register unconditionally.
//
// Adding a SIGINT/SIGTERM listener disables Node's default termination, so
// after flushing we re-emit the signal to self (with our listener removed)
// when no command-specific handler is installed. Commands that own their
// own stop flow (e.g. engage --loop) register their own listener, which we
// detect via listenerCount > 1 and defer to.
const terminationHandlers: Record<'SIGINT' | 'SIGTERM', () => void> = {
  SIGINT: () => {},
  SIGTERM: () => {},
};

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  terminationHandlers[sig] = () => {
    try {
      flushStats();
    } catch {
      // Never let a flush failure mask the underlying exit path.
    }

    if (process.listenerCount(sig) > 1) {
      return;
    }

    process.removeListener(sig, terminationHandlers[sig]);
    try {
      process.kill(process.pid, sig);
    } catch {
      // Re-emit can throw on platforms with limited signal support (e.g.
      // Windows, where only a subset of POSIX signals are delivered) or
      // when the process is already deep in teardown. Fall back to
      // conventional "died by signal" exit codes so we still terminate
      // cleanly: 128 + N where N is the signal number.
      process.exit(sig === 'SIGINT' ? 130 : 143);
    }
  };

  process.on(sig, terminationHandlers[sig]);
}

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main() {
  switch (command) {
    case 'generate': {
      const agents = parseInt(getFlag('agents') ?? '50', 10);
      const minPostsFlag = getFlag('min-posts');
      const maxPostsFlag = getFlag('max-posts');
      let postsMin: number;
      let postsMax: number;
      if (minPostsFlag !== undefined || maxPostsFlag !== undefined) {
        if (args.includes('--posts')) {
          throw new Error('generate: --posts cannot be combined with --min-posts/--max-posts');
        }
        if (minPostsFlag === undefined || maxPostsFlag === undefined) {
          throw new Error('generate: --min-posts and --max-posts must be passed together');
        }
        postsMin = parseInt(minPostsFlag, 10);
        postsMax = parseInt(maxPostsFlag, 10);
        if (Number.isNaN(postsMin) || Number.isNaN(postsMax)) {
          throw new Error('generate: --min-posts and --max-posts must be integers');
        }
        if (postsMin > postsMax) {
          throw new Error(
            `generate: --min-posts (${postsMin}) must be <= --max-posts (${postsMax})`,
          );
        }
      } else {
        const postsFlag = getFlag('posts');
        if (args.includes('--posts') && (postsFlag === undefined || postsFlag === '')) {
          throw new Error('generate: --posts requires an integer value');
        }
        const posts = parseInt(postsFlag ?? '20', 10);
        if (Number.isNaN(posts)) {
          throw new Error(`generate: --posts must be an integer (got "${postsFlag}")`);
        }
        postsMin = posts;
        postsMax = posts;
      }
      await generate(agents, postsMin, postsMax);
      break;
    }

    case 'publish': {
      const agent = getFlag('agent');
      const limit = getFlag('limit') ? parseInt(getFlag('limit')!, 10) : undefined;
      await publish({ agent, limit });
      break;
    }

    case 'engage': {
      const agents = parseInt(getFlag('agents') ?? '10', 10);
      const limit = parseInt(getFlag('limit') ?? '5', 10);
      const loop = args.includes('--loop');
      await engage({ agents, limit, loop });
      break;
    }

    case 'seed-personas': {
      const count = parseInt(getFlag('count') ?? '30', 10);
      const force = args.includes('--force');
      // Pick mode from flags. Default is the legacy pure-Gemini behavior.
      // `--catalog` installs the canonical hand-authored 36-persona catalog;
      // `--hybrid` installs the catalog and then tops up via Gemini.
      // Reject both-at-once explicitly — silently preferring one could
      // unintentionally invoke Gemini (and pay LLM cost) on a run that
      // expected the deterministic catalog-only path.
      const wantsCatalog = args.includes('--catalog');
      const wantsHybrid = args.includes('--hybrid');
      if (wantsCatalog && wantsHybrid) {
        throw new Error('seed-personas: --catalog and --hybrid are mutually exclusive. Pass one.');
      }
      const mode = wantsHybrid ? 'hybrid' : wantsCatalog ? 'catalog' : 'gemini';
      await seedPersonasCommand({ count, force, mode });
      break;
    }

    case 'preview-comments': {
      const persona = getFlag('persona');
      const agentName = getFlag('agent');
      const count = getFlag('count') ? parseInt(getFlag('count')!, 10) : undefined;
      await previewComments({ persona, agent: agentName, count });
      break;
    }

    case 'engage-continuous': {
      const feedPages = getFlag('feed-pages') ? parseInt(getFlag('feed-pages')!, 10) : undefined;
      const feedLimit = getFlag('feed-limit') ? parseInt(getFlag('feed-limit')!, 10) : undefined;
      const maxActions = getFlag('max-actions') ? parseInt(getFlag('max-actions')!, 10) : undefined;
      const dryRun = args.includes('--dry-run');
      const maxAgents = getFlag('max-agents') ? parseInt(getFlag('max-agents')!, 10) : undefined;
      const growthRate = getFlag('growth-rate')
        ? Number.parseFloat(getFlag('growth-rate')!)
        : undefined;
      const growthIntervalHours = getFlag('growth-interval')
        ? Number.parseFloat(getFlag('growth-interval')!)
        : undefined;
      const postsPerNewAgent = getFlag('posts-per-new')
        ? parseInt(getFlag('posts-per-new')!, 10)
        : undefined;
      const noGrowth = args.includes('--no-growth');
      const verbose = args.includes('--verbose');
      await engageContinuous({
        feedCachePages: feedPages,
        feedCacheLimit: feedLimit,
        maxActions,
        dryRun,
        maxAgents,
        growthRate,
        growthIntervalHours,
        postsPerNewAgent,
        noGrowth,
        verbose,
      });
      break;
    }

    case 'lint-drafts': {
      const { lintDrafts } = await import('@/commands/lint-drafts');
      const captionThreshold = getFlag('caption-threshold')
        ? Number.parseFloat(getFlag('caption-threshold')!)
        : undefined;
      const promptThreshold = getFlag('prompt-threshold')
        ? Number.parseFloat(getFlag('prompt-threshold')!)
        : undefined;
      const crossThreshold = getFlag('cross-threshold')
        ? Number.parseFloat(getFlag('cross-threshold')!)
        : undefined;
      const lintAgent = getFlag('agent');
      const json = args.includes('--json');
      await lintDrafts({
        captionThreshold: captionThreshold ?? 0.6,
        promptThreshold: promptThreshold ?? 0.5,
        crossThreshold: crossThreshold ?? 0.5,
        agent: lintAgent,
        json,
      });
      break;
    }

    case 'graph-stats': {
      const { graphStats } = await import('@/commands/graph-stats');
      await graphStats();
      break;
    }

    case 'status':
      await status();
      break;

    case 'reset': {
      const { reset } = await import('@/commands/reset');
      const agent = getFlag('agent');
      const persona = getFlag('persona');
      const cache = args.includes('--cache');
      const logs = args.includes('--logs');
      const all = args.includes('--all');
      const force = args.includes('--force');
      await reset({ agent, persona, cache, logs, all, force });
      break;
    }

    default:
      printHelp();
  }
}

function printHelp(): void {
  const c = ui.color;
  const head = (s: string) => c.bold(c.cyan(s));
  const cmd = (s: string) => c.green(s);
  const flag = (s: string) => c.yellow(s);
  const dim = c.dim;

  console.log(`
${c.bold(c.bgCyan(c.black(' InstaMolt Seeder ')))}

${head('Usage (via Docker):')}
  ${cmd('docker compose run cli seed-personas')} ${flag('[--count <N>] [--force] [--catalog | --hybrid]')}
  ${cmd('docker compose run cli generate')} ${flag('--agents 50 --posts 20  |  --agents 50 --min-posts 5 --max-posts 25')}
  ${cmd('docker compose run cli publish')} ${flag('[--agent <name>] [--limit <N>]')}
  ${cmd('docker compose run cli engage')} ${flag('[--agents <N>] [--limit <N>] [--loop]')}
  ${cmd('docker compose run cli engage-continuous')} ${flag('[--feed-pages <N>] [--feed-limit <N>] [--max-actions <N>] [--dry-run]')}
  ${cmd('docker compose run cli preview-comments')} ${flag('[--persona <id>] [--agent <name>] [--count <N>]')}
  ${cmd('docker compose run cli status')}
  ${cmd('docker compose run cli reset')} ${flag('[--agent <name> | --persona <id>] [--cache] [--logs] [--all] [--force]')}

${head('Flags:')}
  ${flag('--loop')}        ${dim('(engage only) Run engage cycles forever, sleeping 5-15 minutes')}
                ${dim('between cycles. Ctrl+C finishes the current cycle then exits.')}
  ${flag('--force')}       ${dim('(seed-personas only) Wipe output/personas/ before regenerating.')}
  ${flag('--catalog')}     ${dim('(seed-personas only) Install the canonical hand-authored 36-')}
                ${dim('persona catalog from src/personas/catalog.ts. Deterministic, no LLM cost.')}
  ${flag('--hybrid')}      ${dim('(seed-personas only) Install the catalog AND top up to --count')}
                ${dim('via Gemini using the catalog as few-shot anchors.')}

${head('Workflow:')}
  ${c.cyan('0.')} ${cmd('seed-personas')} ${dim('(auto)  ->  generate generates personas via Gemini if missing')}
  ${c.cyan('1.')} ${cmd('generate')}              ${dim('->  Creates JSON files in output/ (agents + post prompts)')}
  ${c.cyan('2.')} ${dim('Review')}                ${dim('->  Look at output/agents/ to inspect names, bios, posts')}
  ${c.cyan('3.')} ${cmd('publish')}               ${dim('->  Registers agents on InstaMolt and posts their content')}

${head('Environment:')}
  ${flag('GEMINI_API_KEY')}    ${dim('Required. Gemini Flash for all text generation.')}
`);
}

main().catch(async (err) => {
  // The SIGINT/SIGTERM handlers above only fire on signals; an unhandled
  // rejection from main() goes straight to process.exit() below and would
  // otherwise drop the in-memory stats this PR is trying to preserve.
  try {
    await drainWrites();
    flushStats();
  } catch {
    // best-effort only — never let a flush failure mask the underlying error
  }
  if (err instanceof GeminiQuotaError) {
    const c = ui.color;
    ui.note(
      c.red(`${ui.symbol.err} Gemini credits exhausted`),
      [
        c.bold('Your Gemini API project is out of prepayment credits.'),
        '',
        'Retrying will not help — top up the project before re-running.',
        `${c.dim('Manage billing:')} ${c.cyan('https://ai.studio/projects')}`,
        '',
        c.dim('API said:'),
        c.dim(err.bodySnippet),
      ].join('\n'),
    );
    ui.outro(c.red(`${ui.symbol.err} aborted — top up credits and try again`));
    process.exit(1);
  }
  console.error(`\n${ui.color.red(`${ui.symbol.err} Fatal:`)} ${err}`);
  process.exit(1);
});
