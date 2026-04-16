/**
 * Deletes `comments.json` for agents that have at least one unpublished post
 * (any `post-NNN.json` where `published !== true`). The next `pnpm generate`
 * bake phase will re-bake them under whatever `BUDGET_DISTRIBUTION` is
 * current in `src/lib/word-budget.ts`, bringing baked few-shot anchors in
 * line with the latest comment-length shape.
 *
 * Usage:
 *   pnpm tsx scripts/rebake-unpublished-comments.ts [--dry-run]
 *
 * Follow-up after running:
 *   pnpm generate --agents 0 --posts 0
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_DIR = join(REPO_ROOT, 'output', 'agents');

const DRY_RUN = process.argv.includes('--dry-run');

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function agentHasUnpublishedPost(agentDir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(agentDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^post-\d+\.json$/.test(entry)) continue;
    try {
      const raw = await readFile(join(agentDir, entry), 'utf-8');
      const post = JSON.parse(raw);
      if (post?.published !== true) return true;
    } catch {
      // Unreadable or malformed post files are treated as "not confirmed
      // published" — the conservative bias is to re-bake, not to skip.
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const agentNames = await readdir(AGENTS_DIR);

  let scanned = 0;
  let eligible = 0;
  let deleted = 0;
  let missingComments = 0;

  for (const name of agentNames) {
    const agentDir = join(AGENTS_DIR, name);
    try {
      const s = await stat(agentDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    scanned++;

    if (!(await agentHasUnpublishedPost(agentDir))) continue;
    eligible++;

    const commentsPath = join(agentDir, 'comments.json');
    if (!(await fileExists(commentsPath))) {
      missingComments++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] would delete ${commentsPath}`);
    } else {
      await unlink(commentsPath);
      console.log(`deleted ${commentsPath}`);
    }
    deleted++;
  }

  console.log('');
  console.log(`scanned agents:            ${scanned}`);
  console.log(`with unpublished posts:    ${eligible}`);
  console.log(`  of those, no comments:   ${missingComments}`);
  console.log(`${DRY_RUN ? 'would delete' : 'deleted'} comments.json: ${deleted}`);
  if (DRY_RUN) {
    console.log('\nDry run — nothing was touched. Re-run without --dry-run to apply.');
  } else {
    console.log('\nNext: pnpm generate --agents 0 --posts 0');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
