import { engage } from '@/commands/engage';
import { generate } from '@/commands/generate';
import { previewComments } from '@/commands/preview-comments';
import { publish } from '@/commands/publish';
import { seedPersonasCommand } from '@/commands/seed-personas';
import { status } from '@/commands/status';
import * as ui from '@/lib/ui';
import { GeminiQuotaError } from '@/services/llm';

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
      const posts = parseInt(getFlag('posts') ?? '20', 10);
      await generate(agents, posts);
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
      const fromFeed = args.includes('--from-feed');
      await previewComments({ persona, agent: agentName, count, fromFeed });
      break;
    }

    case 'status':
      await status();
      break;

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
  ${cmd('docker compose run cli generate')} ${flag('--agents 50 --posts 20')}
  ${cmd('docker compose run cli publish')} ${flag('[--agent <name>] [--limit <N>]')}
  ${cmd('docker compose run cli engage')} ${flag('[--agents <N>] [--limit <N>] [--loop]')}
  ${cmd('docker compose run cli preview-comments')} ${flag('[--persona <id>] [--agent <name>] [--count <N>] [--from-feed]')}
  ${cmd('docker compose run cli status')}

${head('Flags:')}
  ${flag('--loop')}        ${dim('(engage only) Run engage cycles forever, sleeping 5-15 minutes')}
                ${dim('between cycles. Ctrl+C finishes the current cycle then exits.')}
  ${flag('--force')}       ${dim('(seed-personas only) Wipe output/personas/ before regenerating.')}
  ${flag('--catalog')}     ${dim('(seed-personas only) Install the canonical hand-authored 36-')}
                ${dim('persona catalog from src/personas/catalog.ts. Deterministic, no LLM cost.')}
  ${flag('--hybrid')}      ${dim('(seed-personas only) Install the catalog AND top up to --count')}
                ${dim('via Gemini using the catalog as few-shot anchors.')}
  ${flag('--from-feed')}   ${dim('(preview-comments only) Pull captions from the live explore')}
                ${dim('feed instead of synthetic on-disk drafts. Online-only.')}

${head('Workflow:')}
  ${c.cyan('0.')} ${cmd('seed-personas')} ${dim('(auto)  ->  generate generates personas via Gemini if missing')}
  ${c.cyan('1.')} ${cmd('generate')}              ${dim('->  Creates JSON files in output/ (agents + post prompts)')}
  ${c.cyan('2.')} ${dim('Review')}                ${dim('->  Look at output/agents/ to inspect names, bios, posts')}
  ${c.cyan('3.')} ${cmd('publish')}               ${dim('->  Registers agents on InstaMolt and posts their content')}

${head('Environment:')}
  ${flag('GEMINI_API_KEY')}    ${dim('Required. Gemini Flash for all text generation.')}
`);
}

main().catch((err) => {
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
