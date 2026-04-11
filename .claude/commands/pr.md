---
description: Create a pull request with auto-generated summary from branch changes
allowed-tools: Bash(git *), Bash(gh *), Read, Grep, Glob
---

## Create Pull Request

Create a PR for the current branch targeting `main`.

### Step 1: Gather context

Run these in parallel:

1. `git fetch origin main` — update remote base reference
2. `git status` — check for uncommitted changes (warn if any)
3. `git log origin/main..HEAD --oneline` — all commits on this branch
4. `git diff origin/main...HEAD --stat` — changed files summary
5. `git diff origin/main...HEAD` — full diff
6. `git rev-parse --abbrev-ref HEAD` — current branch name
7. Check if the branch has a remote tracking branch (`git rev-parse --abbrev-ref @{upstream}`)

### Step 2: Push if needed

If the branch is not pushed or is ahead of the remote, push with `git push -u origin <branch>`.

### Step 3: Determine PR title

Use the **commit convention** from recent history (`fix:`, `feat:`, `chore:`, etc.):

- If single commit on branch: use its message as the title
- If multiple commits: synthesize a title that captures the overall change

**Title rules**:

- Under 72 characters
- Use conventional commit prefix (`fix:`, `feat:`, `chore:`, `refactor:`, `test:`, `docs:`, `perf:`)
- Do NOT include `(#XX)` — GitHub adds the PR number automatically
- Lowercase after the prefix

### Step 4: Generate PR body

Analyze ALL commits and the full diff (not just the latest commit) to write the body:

```
## Summary
<2-5 bullet points explaining what changed and why>

## Test plan
<bulleted checklist of how to verify the changes>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Summary rules**:

- Lead with the "why", not the "what"
- Reference Sentry issues, bug reports, or feature requests if applicable
- Mention key files/areas changed
- Keep each bullet to 1-2 sentences

**Test plan rules**:

- Include concrete verification steps (commands to run, things to check)
- Include `pnpm typecheck` and any relevant test commands
- For production-observable changes, include monitoring steps (e.g., "Monitor Sentry for 24h")

### Step 5: Create the PR

Check if a PR already exists for this branch: `gh pr view --json url -q .url`. If one exists, report its URL and stop.

Otherwise, create the PR:

```bash
gh pr create --base main --title "<title>" --body "$(cat <<'EOF'
## Summary
...

## Test plan
...

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL when done.

### Step 6: Report

Print the PR URL so the user can review it.
