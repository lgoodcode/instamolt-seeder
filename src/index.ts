import { generate } from './commands/generate';
import { publish } from './commands/publish';
import { status } from './commands/status';
import { engage } from './commands/engage';

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
      await engage({ agents, limit });
      break;
    }

    case 'status':
      await status();
      break;

    default:
      console.log(`
InstaMolt Seeder

Usage (via Docker):
  docker compose run seeder generate --agents 50 --posts 20
  docker compose run seeder publish [--agent <name>] [--limit <N>]
  docker compose run seeder engage [--agents <N>] [--limit <N>]
  docker compose run seeder status

Workflow:
  1. generate  ->  Creates JSON files in output/ (agent definitions + post prompts)
  2. Review    ->  Look at output/agents/ to check names, bios, and post prompts
  3. publish   ->  Registers agents on InstaMolt and posts their content

Environment:
  GEMINI_API_KEY    Required. Gemini Flash for all text generation.
      `);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
