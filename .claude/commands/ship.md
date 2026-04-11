---
description: Run lint, typecheck, tests, then commit and push, then create a PR
allowed-tools: Bash, Read, Edit, Grep, Glob, Skill
---

## Ship Changes

Run the seeder's full ship pipeline: Biome check, typecheck, tests, commit, push, and create a PR.

### Step 1: Verify there are changes to ship

Run `git status` and `git diff --stat`. If there are no changes (staged or unstaged), stop and report "Nothing to ship."

### Step 2: Run gates in order

Each gate must pass before continuing. Stop and surface the failure if any gate fails — do not proceed to commit.

1. `pnpm check` — Biome lint + format check over `src/` and `tests/`
   - If the only failures are write-safe formatting issues, run `pnpm check:fix` and re-run `pnpm check`
   - For real lint errors, fix the underlying code and re-run
2. `pnpm typecheck` — `tsc --noEmit`
3. `pnpm test:run` — one-shot Vitest pass

### Step 3: Stage and commit

1. **Stage by name** — never `git add -A` or `git add .`. List files explicitly so generated artifacts under `output/` and untracked scratch files don't sneak in.
2. **Synthesize a commit message** from the diff using conventional commit format (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`). Match the style of `git log --oneline -10`.
3. **Commit** with a `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer via heredoc.

The pre-commit hook (`simple-git-hooks` → `lint-staged` → `biome check --write`) will run automatically against staged files.

### Step 4: Handle pre-commit hook failures

If the pre-commit hook fails:

1. Read the hook output and fix the underlying issue
2. Re-stage the fixed files
3. Create a **NEW** commit — never `git commit --amend` after a hook failure (the original commit didn't happen, and `--amend` would modify the previous commit)
4. Never pass `--no-verify` to skip the hook

### Step 5: Push

If the branch has no upstream, `git push -u origin <branch>`. Otherwise `git push`.

### Step 6: Create or update the PR

Check if a PR already exists for this branch: `gh pr view --json url,number,title -q '"\(.url) \(.number) \(.title)"'`.

- If a PR exists, report that the push updated it.
- If no PR exists, invoke the `/pr` command to create one.

**Always** report the result with both the `owner/repo#N` short reference AND the full URL link. Example:

> PR created: **owner/repo#42** — [feat: add comment voice anchors](https://github.com/owner/repo/pull/42)

### Rules

- **Never `--no-verify`** unless the user explicitly asks for it. It skips the pre-commit hook.
- **Never `--amend`** after a hook failure. Create a new commit.
- **Never `git add -A` / `git add .`** — stage by name only.
- **Never bypass a failed gate** — fix the root cause.
- If `docs/BLUEPRINT.md` is out of sync with the `src/` changes being shipped, flag it before committing per the lockstep rule in `CLAUDE.md`.
