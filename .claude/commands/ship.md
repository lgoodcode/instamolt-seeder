---
description: Run gates (openapi:check, check, typecheck, test), commit, push, and create or update a PR. Flags: --draft, --no-pr
allowed-tools: Bash, Read, Edit, Grep, Glob, Skill
---

## Ship Changes

Run the seeder's full ship pipeline: OpenAPI drift check, Biome check, typecheck, tests, commit, push, and create or update a PR.

### Step 0: Parse arguments

`$ARGUMENTS` may contain zero or more flags. Parse them before doing anything else:

| Flag      | Meaning                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `--draft` | Create the PR as a draft (pass `--draft` through to `/pr` in Step 6). Ignored when updating an existing PR.     |
| `--no-pr` | Stop after the push succeeds. Do not create or update a PR. Report the pushed branch + commit SHA instead.     |

Parsing rules:

- Flags may appear in any order.
- Unknown flags: stop and report the unrecognized token rather than silently ignoring it.
- If `$ARGUMENTS` is empty, all booleans are false and the pipeline runs as it did before flags existed.

### Step 1: Verify there are changes to ship

Run `git status` and `git diff --stat`. If there are no changes (staged or unstaged), stop and report "Nothing to ship."

### Step 1.5: BLUEPRINT sync check

[docs/BLUEPRINT.md](../../docs/BLUEPRINT.md) is the seeder's living source of truth — per `CLAUDE.md`, any edit under `src/` that changes commands, state shape, pipeline semantics, persona schema, external integrations, or behavioral loops must update the corresponding section of BLUEPRINT.md in the same PR.

Collect the full set of changed files by unioning **all three** sources (relying on `git diff` alone misses brand-new untracked files):

- Staged + unstaged tracked files: `git diff --name-only HEAD`
- Untracked files: `git ls-files --others --exclude-standard`
- Branch commits not yet on `main`: `git diff --name-only origin/main...HEAD`

Watched paths (changes here may invalidate BLUEPRINT.md):

- `src/commands/**` — pipeline phase semantics (§2–§4)
- `src/services/instamolt-api.ts` — API surface / client behavior
- `src/services/llm.ts` — generator signatures, prompt contracts
- `src/config.ts` — env vars, concurrency knobs, delays
- `src/types.ts` — state shape, persona/agent/post schemas
- `src/personas/**` or `src/voice-profiles/**` — persona/voice catalog changes (also requires PERSONA-CATALOG.md / VOICE-PROFILE-CATALOG.md updates)
- `src/lib/dedup-index.ts`, `src/lib/comment-samples.ts`, `src/lib/feed-cache.ts` — persisted state shapes
- `openapi.json` or `src/types.openapi.ts` — upstream API contract shifts

Sibling docs to check in the same pass:

- `src/personas/catalog.ts` changes → also edit [docs/PERSONA-CATALOG.md](../../docs/PERSONA-CATALOG.md)
- `src/voice-profiles/catalog.ts` changes → also edit [docs/VOICE-PROFILE-CATALOG.md](../../docs/VOICE-PROFILE-CATALOG.md)

If **none** match, skip this step.

If **one or more** match:

1. Read [docs/BLUEPRINT.md](../../docs/BLUEPRINT.md) in full.
2. For each matching file, read its diff (`git diff <file>`) and determine whether the BLUEPRINT section it maps to is now inaccurate. Concrete things to check:
   - New/removed/renamed commands or phases → command table + §2–§4
   - Changed state shape (new on-disk files, new JSON fields) → state-shape section
   - Changed concurrency knobs or delays → config / environment section
   - New persona or voice profile fields → schema section (plus the prose mirror doc)
   - API surface changes → §5 / API client section
3. If BLUEPRINT is stale, **edit it in place**. Keep edits surgical — do not rewrite sections that are still accurate. Preserve existing structure and tone.
4. If unsure whether a change warrants a BLUEPRINT update (e.g. an internal refactor with no observable surface), err on the side of **not updating** and note it briefly to the user.
5. Any BLUEPRINT.md (or sibling catalog doc) edits will be staged and committed alongside the rest of the changes in Step 3 — do not commit separately.

### Step 2: Rename placeholder branch if needed

Run `git branch --show-current`. If the current branch matches the pattern `tmp-<slug>` where `<slug>` is one or more kebab-case segments (e.g. `tmp-orbit`, `tmp-foo-bar`) — these are placeholders created by `pnpm gclean` and similar tooling and don't reflect the actual work — derive a meaningful branch name from the diff and rename:

1. **Derive the new name** from the same diff you'll use for the commit message in Step 4. Use conventional kebab-case prefixes that match the change type:
   - Bug fixes → `fix/short-description`
   - New features → `feat/short-description`
   - Refactors → `refactor/short-description`
   - Chores/maintenance → `chore/short-description`
   - Docs only → `docs/short-description`

   Keep the description short (3–6 words), kebab-case, no trailing punctuation. Example: `feat/voice-anchored-replies`.

2. **Check whether the placeholder branch has an upstream**:

   ```bash
   upstream=$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null)
   ```

   - **No upstream** (command fails or `$upstream` is empty): safe to rename locally with `git branch -m <new-name>`. Proceed.
   - **Upstream exists** (e.g. `origin/tmp-orbit`): the placeholder has already been pushed. **Derive the remote name and old branch name from `$upstream` — never hardcode `origin`**:

     ```bash
     remote="${upstream%%/*}"      # e.g. "origin"
     old_name="${upstream#*/}"     # e.g. "tmp-orbit"
     ```

     Then check whether a PR exists via `gh pr view --json url,number -q '.url' 2>/dev/null`. If a PR exists, **stop and ask the user** before renaming — renaming a branch with an open PR is disruptive. If no PR exists, rename locally (`git branch -m <new-name>`), push the new branch (`git push -u "$remote" <new-name>`), and delete the remote placeholder (`git push "$remote" --delete "$old_name"`).

3. **Error handling**: if any rename/push/delete command fails, **stop immediately and report the error** — partial failures leave the repo with both old and new branches. Do not proceed to subsequent operations.

4. **If the current branch does NOT match `tmp-<slug>`**, skip this step.

5. **Never** rename `main`, `master`, or any branch that doesn't match the `tmp-<slug>` pattern.

### Step 3: Run gates in order

Each gate must pass before continuing. Stop and surface the failure if any gate fails — do not proceed to commit.

1. `pnpm openapi:check` — two drift checks in sequence: (a) live platform spec vs committed `openapi.json`, (b) committed `openapi.json` vs generated `src/types.openapi.ts`. Either mismatch fails the gate.
   - On prod drift: run `pnpm openapi:pull` to fetch + regenerate types, review the diff (new/changed endpoints, renamed fields, etc.), and include the updated `openapi.json` + `src/types.openapi.ts` in this ship.
   - On types drift: run `pnpm openapi:gen` and commit the regenerated file.
   - If the platform is genuinely unreachable (not drifted), escalate to the user before bypassing with `SKIP_OPENAPI_PROD_CHECK=1 pnpm openapi:check` — do not skip on your own.
2. `pnpm check` — Biome lint + format check over `src/`, `tests/`, and `scripts/`
   - If the only failures are write-safe formatting issues, run `pnpm check:fix` and re-run `pnpm check`
   - For real lint errors, fix the underlying code and re-run
3. `pnpm typecheck` — `tsc --noEmit`
4. `pnpm test:run` — one-shot Vitest pass

### Step 4: Stage and commit

1. **Stage by name** — never `git add -A` or `git add .`. List files explicitly so generated artifacts under `output/` and untracked scratch files don't sneak in. Include any BLUEPRINT.md / catalog doc edits from Step 1.5.
2. **Synthesize a commit message** from the diff using conventional commit format (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`). Match the style of `git log --oneline -10`. **If Step 2 renamed the branch**, the commit type should match the prefix used for the rename so branch and commit stay aligned.
3. **Commit** with a `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailer via heredoc.

The pre-commit hook (`simple-git-hooks` → `lint-staged` → `biome check --write`, plus `pnpm openapi:gen` re-stage when `openapi.json` is staged) will run automatically against staged files.

### Step 4.5: Handle pre-commit hook failures

If the pre-commit hook fails:

1. Read the hook output and fix the underlying issue
2. Re-stage the fixed files
3. Create a **NEW** commit — never `git commit --amend` after a hook failure (the original commit didn't happen, and `--amend` would modify the previous commit)
4. Never pass `--no-verify` to skip the hook

### Step 5: Push

If the branch has no upstream, `git push -u origin <branch>`. Otherwise `git push`. If Step 2 already pushed a renamed branch, skip this.

### Step 6: Create or update the PR

**If `--no-pr` was passed in Step 0**, skip this step. Report the pushed branch name, new commit SHA, and remote (e.g. `Pushed feat/foo @ abc1234 to origin. PR not created (--no-pr).`), then stop.

Otherwise, check if a PR already exists for this branch: `gh pr view --json url,number,title -q '"\(.url) \(.number) \(.title)"' 2>/dev/null`.

- **If a PR exists, update its description** to reflect the latest changes:
  1. Derive the base ref from the PR rather than hardcoding `origin/main`:

     ```bash
     number=$(gh pr view --json number -q .number)
     base=$(gh pr view --json baseRefName -q .baseRefName)
     upstream=$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || true)
     remote="${upstream%%/*}"; [ -z "$remote" ] && remote="origin"
     git fetch "$remote" "$base"
     ```

     Gather context against the derived base:
     - `git log "$remote/$base"..HEAD --oneline`
     - `git diff "$remote/$base"...HEAD --stat`
     - `git diff "$remote/$base"...HEAD`
  2. Regenerate the PR body following the same format as `/pr` (Summary bullets + Test plan), analyzing ALL commits and the full diff — not just the latest commit.
  3. Update the PR: `gh pr edit "$number" --body "$(cat <<'EOF' ... EOF)"`
  4. Report that the PR was updated with a fresh description.
  5. `--draft` is **ignored** on an existing PR — never toggle draft state on a PR that's already open. If the user wants to convert, they can run `gh pr ready` / `gh pr draft` manually.
- **If no PR exists**, invoke the `/pr` command to create one. If `--draft` was passed in Step 0, instruct `/pr` to create the PR as a draft (pass `--draft` through to `gh pr create`).

**Always** report the result with both the `owner/repo#N` short reference AND the full URL link. Example:

> PR created: **owner/repo#42** — [feat: add comment voice anchors](https://github.com/owner/repo/pull/42)

### Rules

- **Never `--no-verify`** unless the user explicitly asks for it. It skips the pre-commit hook.
- **Never `--amend`** after a hook failure. Create a new commit.
- **Never `git add -A` / `git add .`** — stage by name only.
- **Never bypass a failed gate** — fix the root cause.
- **Never** rename `main`/`master` or any branch that doesn't match `tmp-<slug>`.
- **Never** toggle draft state on an existing PR.
