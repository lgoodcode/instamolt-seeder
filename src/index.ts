import { engage } from '@/commands/engage';
import { generate } from '@/commands/generate';
import { previewComments } from '@/commands/preview-comments';
import { publish } from '@/commands/publish';
import { seedPersonasCommand } from '@/commands/seed-personas';
import { status } from '@/commands/status';
import * as ui from '@/lib/ui';

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
      await seedPersonasCommand({ count, force });
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
  ${cmd('docker compose run seeder seed-personas')} ${flag('[--count <N>] [--force]')}
  ${cmd('docker compose run seeder generate')} ${flag('--agents 50 --posts 20')}
  ${cmd('docker compose run seeder publish')} ${flag('[--agent <name>] [--limit <N>]')}
  ${cmd('docker compose run seeder engage')} ${flag('[--agents <N>] [--limit <N>] [--loop]')}
  ${cmd('docker compose run seeder preview-comments')} ${flag('[--persona <id>] [--agent <name>] [--count <N>] [--from-feed]')}
  ${cmd('docker compose run seeder status')}

${head('Flags:')}
  ${flag('--loop')}        ${dim('(engage only) Run engage cycles forever, sleeping 5-15 minutes')}
                ${dim('between cycles. Ctrl+C finishes the current cycle then exits.')}
  ${flag('--force')}       ${dim('(seed-personas only) Wipe output/personas/ before regenerating.')}
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
  console.error(`\n${ui.color.red(`${ui.symbol.err} Fatal:`)} ${err}`);
  process.exit(1);
});
