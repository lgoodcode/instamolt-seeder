/**
 * Switch to main, pull, and manage branches.
 * Cross-platform: runs on Windows, macOS, and Linux without bash.
 *
 * Usage:
 *   pnpm git:clean           — checkout main, pull, create new tmp-<word> branch, delete previous branch
 *   pnpm git:clean -p        — checkout main, pull, create new tmp-<word> branch, keep previous branch
 *   pnpm git:clean -s        — checkout main, pull, rebase current branch on main
 *   pnpm git:clean -d        — switch to main, pull, delete current branch
 *   pnpm git:clean --prune     — switch to main, pull, delete ALL merged branches (except main/tmp-*)
 *   pnpm git:clean --prune-all — same as --prune but also deletes merged tmp-* branches
 */

import { execFileSync } from 'node:child_process';

import pc from 'picocolors';

const WORDS = [
  'falcon',
  'orbit',
  'spark',
  'delta',
  'blaze',
  'comet',
  'drift',
  'ember',
  'frost',
  'grove',
  'haven',
  'ivory',
  'jewel',
  'karma',
  'lunar',
  'maple',
  'nexus',
  'oasis',
  'prism',
  'quartz',
  'ridge',
  'solar',
  'thorn',
  'ultra',
  'vivid',
  'wren',
  'xenon',
  'yacht',
  'zephyr',
  'amber',
];

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function stashIfDirty(branch: string): boolean {
  const dirty = git('status', '--porcelain');
  const stashed = dirty.length > 0;
  if (stashed) {
    git('stash', 'push', '-m', `gclean: auto-stash from ${branch}`);
    console.log(pc.yellow('Stashed uncommitted changes'));
  }
  return stashed;
}

// popStash is only called when stashIfDirty returned true, so a successful
// no-op ("No stash entries found") shouldn't happen in practice — but guard
// for it anyway. Any other error means `git stash pop` hit a conflict or
// another failure; the stash entry is still on the stack, so surface that
// distinctly so the operator doesn't assume their changes were reapplied.
function popStash(): void {
  try {
    git('stash', 'pop');
    console.log(pc.cyan('Reapplied stashed changes'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No stash entries found')) {
      console.log(pc.dim('No stash to reapply'));
      return;
    }
    console.warn(
      pc.yellow(
        `Could not reapply stashed changes — your stash entry is preserved on the stack. Inspect with 'git stash list' and reapply manually with 'git stash pop' once resolved.`,
      ),
    );
    console.warn(pc.dim(message));
  }
}

const args = new Set(process.argv.slice(2));

const KNOWN_FLAGS = new Set([
  '-n',
  '--new',
  '-p',
  '--preserve',
  '-s',
  '--same',
  '-d',
  '--delete',
  '--prune',
  '--prune-all',
]);

for (const arg of args) {
  if (!KNOWN_FLAGS.has(arg)) {
    console.error(pc.red(`Unknown flag: ${arg}`));
    console.error(
      pc.dim(
        `Valid flags: ${[...KNOWN_FLAGS].join(', ')}. See the header of scripts/git-clean.ts for usage.`,
      ),
    );
    process.exit(2);
  }
}

const MODE_FLAG_GROUPS: Array<[string, string]> = [
  ['-n', '--new'],
  ['-p', '--preserve'],
  ['-s', '--same'],
  ['-d', '--delete'],
  ['--prune', '--prune-all'],
];
const modesRequested = MODE_FLAG_GROUPS.flatMap(([short, long]) => {
  if (args.has(short) && args.has(long)) return [`${short}/${long}`];
  if (args.has(short)) return [short];
  if (args.has(long)) return [long];
  return [];
});
if (modesRequested.length > 1) {
  console.error(
    pc.red(`Conflicting mode flags: ${modesRequested.join(', ')}. Pass exactly one mode.`),
  );
  process.exit(2);
}

let mode: 'same' | 'new' | 'preserve' | 'delete' | 'prune' = 'new';
if (args.has('-s') || args.has('--same')) mode = 'same';
else if (args.has('-p') || args.has('--preserve')) mode = 'preserve';
else if (args.has('-d') || args.has('--delete')) mode = 'delete';
else if (args.has('--prune') || args.has('--prune-all')) mode = 'prune';
else if (args.has('-n') || args.has('--new')) mode = 'new';

const pruneAll = args.has('--prune-all');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');

switch (mode) {
  case 'same': {
    if (branch === 'main') {
      console.log(pc.dim('Already on main — nothing to rebase'));
      process.exit(0);
    }

    const stashed = stashIfDirty(branch);
    git('checkout', 'main');
    git('pull', 'origin', 'main');
    git('checkout', branch);
    git('rebase', 'main');
    console.log(`${pc.green('✓')} Rebased ${pc.bold(branch)} on main`);
    if (stashed) popStash();

    break;
  }
  case 'new':
  case 'preserve': {
    const stashed = stashIfDirty(branch);

    if (branch !== 'main') {
      git('checkout', 'main');
    }
    git('pull', 'origin', 'main');

    const existing = new Set(
      git('branch', '--list', 'tmp-*')
        .split('\n')
        .map((b) => b.trim()),
    );
    const available = WORDS.filter((w) => !existing.has(`tmp-${w}`));
    if (available.length === 0) {
      if (branch !== 'main') {
        git('checkout', branch);
      }
      if (stashed) {
        popStash();
      }
      console.log(pc.red('All tmp-* branch names are taken — delete some first'));
      process.exit(1);
    }
    const word = available[Math.floor(Math.random() * available.length)];
    const tmpBranch = `tmp-${word}`;
    git('checkout', '-b', tmpBranch);
    console.log(`${pc.green('✓')} Created branch: ${pc.bold(tmpBranch)}`);

    // Delete the previous branch (safe delete — only if merged or a tmp branch).
    // Preserve mode skips deletion entirely.
    if (mode === 'new' && branch !== 'main') {
      try {
        git('branch', '-d', '--', branch);
        console.log(`${pc.green('✓')} Deleted old branch: ${pc.bold(branch)}`);
      } catch {
        // -d fails if not fully merged — force-delete tmp branches, skip others
        if (branch.startsWith('tmp-')) {
          git('branch', '-D', '--', branch);
          console.log(`${pc.green('✓')} Deleted old branch: ${pc.bold(branch)}`);
        } else {
          console.log(pc.yellow(`Kept ${pc.bold(branch)} (not fully merged into main)`));
        }
      }
    } else if (mode === 'preserve' && branch !== 'main') {
      console.log(pc.dim(`Preserved previous branch: ${pc.bold(branch)}`));
    }

    if (stashed) popStash();

    break;
  }
  case 'prune': {
    const stashed = stashIfDirty(branch);

    if (branch !== 'main') {
      git('checkout', 'main');
    }
    git('pull', 'origin', 'main');

    // Get all local branches except main
    const allBranches = git('branch')
      .split('\n')
      .map((b) => b.trim().replace(/^\*\s*/, ''))
      .filter((b) => b && b !== 'main');

    // Branches git knows are merged (fast-forward or rebase-merged)
    const gitMerged = new Set(
      git('branch', '--merged', 'main')
        .split('\n')
        .map((b) => b.trim().replace(/^\*\s*/, ''))
        .filter((b) => b && b !== 'main'),
    );

    // Also detect squash-merged branches: if cherry-picking the branch onto main
    // produces an empty diff, all its changes are already in main
    function isSquashMerged(b: string): boolean {
      try {
        const mergeBase = git('merge-base', 'main', b);
        const treeHash = git('commit-tree', `${b}^{tree}`, '-p', mergeBase, '-m', '_');
        const cherryResult = git('cherry', 'main', treeHash);
        // If cherry returns empty or all lines start with '-', the changes are in main
        return cherryResult === '' || cherryResult.split('\n').every((l) => l.startsWith('-'));
      } catch {
        return false;
      }
    }

    const merged = allBranches.filter((b) => gitMerged.has(b) || isSquashMerged(b));
    const toDelete = pruneAll ? merged : merged.filter((b) => !b.startsWith('tmp-'));

    if (toDelete.length === 0) {
      console.log(pc.dim('No merged branches to prune'));
      if (stashed) popStash();
    } else {
      for (const b of toDelete) {
        try {
          git('branch', '-d', '--', b);
          console.log(`${pc.green('✓')} Deleted ${pc.bold(b)}`);
        } catch {
          // -d can fail if git thinks it's not fully merged (e.g., squash-merged PRs)
          git('branch', '-D', '--', b);
          console.log(`${pc.green('✓')} Force-deleted ${pc.bold(b)}`);
        }
      }
      console.log(
        pc.green(`Pruned ${toDelete.length} merged branch${toDelete.length === 1 ? '' : 'es'}`),
      );
      if (stashed) popStash();
    }

    break;
  }
  case 'delete': {
    if (branch === 'main') {
      console.log(pc.dim('Already on main'));
      process.exit(0);
    }

    const stashed = stashIfDirty(branch);
    git('checkout', 'main');
    git('pull', 'origin', 'main');
    try {
      git('branch', '-d', '--', branch);
      console.log(`${pc.green('✓')} Deleted branch: ${pc.bold(branch)}`);
    } catch {
      // -d fails if not fully merged — force-delete tmp branches, keep others.
      if (branch.startsWith('tmp-')) {
        git('branch', '-D', '--', branch);
        console.log(`${pc.green('✓')} Force-deleted branch: ${pc.bold(branch)}`);
      } else {
        if (stashed) popStash();
        console.error(
          pc.red(
            `Branch ${pc.bold(branch)} is not fully merged into main. Use 'git branch -D ${branch}' manually if you're sure.`,
          ),
        );
        process.exit(1);
      }
    }
    if (stashed) popStash();

    break;
  }
}
