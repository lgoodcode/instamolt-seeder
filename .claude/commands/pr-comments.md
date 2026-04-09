---
name: pr-comments
description: Fetch, evaluate, fix, and reply to all review comments on a GitHub PR
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, Agent, WebFetch
---

## Address PR Comments

Fetch all review comments on a GitHub pull request, evaluate each one, apply fixes, and reply directly on GitHub with what was done.

$ARGUMENTS

### Step 1: Identify the PR and fetch comments

Determine the PR number and repo:

1. If `$ARGUMENTS` contains a number or URL, extract the PR number from it
2. Else detect the current branch and find its open PR: `gh pr view --json number,title,url,headRefName`
3. If no PR found, report "No open PR for this branch" and stop

Extract `{owner}/{repo}` from `gh repo view --json nameWithOwner -q .nameWithOwner`.

Fetch every review comment and issue comment on the PR (run both in parallel):

```bash
# Review comments (inline code comments from reviewers — these have file/line context)
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate --jq '.[] | {id, path: .path, line: (.line // .original_line), author: .user.login, body: .body, in_reply_to_id: .in_reply_to_id}'

# Issue comments (top-level conversation comments — no file context)
gh api repos/{owner}/{repo}/issues/{number}/comments --paginate --jq '.[] | {id, author: .user.login, body: .body}'
```

**Filter to actionable comments only.** Skip:

- Bot deployment notifications (Vercel, Netlify, Railway, etc.)
- CodeRabbit walkthrough/summary comments (the big overview with `## Walkthrough`, `## Changes`, sequence diagrams)
- Comments that are pure praise with no action items
- Reply threads where the original comment was already addressed (check `in_reply_to_id`, or body contains `✅ Addressed` / `✅ Confirmed as addressed`)
- Comments from the PR author responding to reviewers (those are replies, not review items)
- Deduplicate: when multiple reviewers flag the same issue on the same file/line, treat as one item

**Keep the comment `id`** — needed for replying later.

### Step 2: Parallel evaluation via subagents

**Launch subagents in parallel to evaluate comments.** Group comments by file, then spawn one Agent per file (or per group of 3-4 comments if a single file has many). Each agent receives:

- The comment(s) to evaluate (id, author, body, file, line)
- The repo path and CLAUDE.md conventions context
- Instructions to read the referenced code, use LSP to trace impacts, and return a structured verdict

Each subagent must return a JSON array of evaluations:

```json
[
  {
    "comment_id": 12345,
    "author": "Copilot",
    "file": "src/foo.ts",
    "line": 42,
    "category": "Bug|Improvement|Convention|Documentation|Question|False positive",
    "summary": "one-line description",
    "verdict": "Fix|Fix (partial)|Acknowledge|Skip|Defer",
    "reason": "why this verdict",
    "fix_description": "what to change (if Fix/Fix partial)",
    "files_to_change": ["src/foo.ts"]
  }
]
```

**Verdict definitions:**

- **Fix** — real issue, will fix
- **Fix (partial)** — valid concern but the suggested fix is wrong or incomplete; will fix differently
- **Acknowledge** — known limitation, will add comment/documentation but no functional code change
- **Skip** — false positive, preference, or out of scope for this PR
- **Defer** — valid but separate concern, not addressing in this PR

### Step 3: Build comment inventory

Collect all subagent results and present a table:

| #   | Author            | File:Line      | Category | Summary              | Verdict |
| --- | ----------------- | -------------- | -------- | -------------------- | ------- |
| 1   | coderabbitai[bot] | ssrf.ts:57     | Bug      | DNS rebinding bypass | Fix     |
| 2   | Copilot           | extract.ts:115 | Bug      | Array.isArray bypass | Skip    |

### Step 4: Execute fixes

Process all "Fix" and "Fix (partial)" items. For efficiency:

1. **Group by file** — batch edits to the same file
2. **Parallelize independent fixes** — use parallel tool calls (or subagents) for fixes in different files
3. **Update tests** — if any fix changes behavior, update or add tests to cover the new behavior
4. **Update docs** — if fixes affect endpoints, schemas, auth, rate limits, error codes, constants, or query params, update all 5 doc files:
   - `public/openapi.json`
   - `public/llms.txt`
   - `public/llms-full.txt`
   - `mcp-server/src/index.ts`
   - `src/app/layout.tsx`
5. **Sync MCP definitions** — run `pnpm mcp:fix` then `pnpm mcp:build` whenever `mcp-server/src/index.ts` is affected

After all fixes:

1. Run `pnpm typecheck` (or the appropriate typecheck command for the changed workspace)
2. Run tests for changed areas
3. Fix any failures introduced by the fixes

### Step 5: Commit and push

Stage all changed files, create a commit with a descriptive message:

```
fix: address PR review comments

- [1-line summary per fix]

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

Push to the PR branch. **This must happen before Step 6** — replies reference the commit SHA.

### Step 6: Reply to all comments in parallel

After committing and pushing, reply to **every** actionable comment directly on GitHub. **Send all replies in parallel** — launch one Bash call per reply simultaneously.

**For review comments (inline, have `path` and `line`):**

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -X POST \
  -f body="REPLY_TEXT" \
  -F in_reply_to=COMMENT_ID
```

**For issue comments (top-level):**

```bash
gh api repos/{owner}/{repo}/issues/{number}/comments \
  -X POST \
  -f body="REPLY_TEXT"
```

**Reply templates by verdict:**

**Fix:**

> Fixed in {short_commit_sha}. {1-sentence description of what was changed and why}.

**Fix (partial):**

> Addressed in {short_commit_sha}, but differently than suggested: {explanation of why the suggested approach wasn't used and what was done instead}.

**Acknowledge:**

> Known limitation — added a documentation comment in {short_commit_sha}. {Brief explanation of why it can't be fully fixed and what mitigations exist}.

**Skip:**

> Not applicable here — {explanation referencing specific project convention or code context}. {e.g., "We use X pattern per CLAUDE.md because Y."}

**Defer:**

> Valid concern — will address separately. Out of scope for this PR because {reason}.

**Question:**

> {Direct answer to the question with code references if needed}.

**Important reply rules:**

- Keep replies concise — 1-3 sentences max. Reviewers read dozens of comments; respect their time.
- Reference the commit SHA so reviewers can verify the fix in the diff.
- For "Skip" verdicts, always explain _why_ with a specific reference (convention, code context, design decision). Never just say "not applicable."
- Reply to ALL actionable comments, even skipped ones. Silence reads as "ignored."
- Use a single `gh api` call per reply. Do NOT batch multiple replies into one comment.
- **Use `in_reply_to` (not `in_reply_to_id`)** for the GitHub API parameter name.
- **Escape backticks in reply bodies** — use `\x60` or avoid backtick-heavy code in gh api `-f body=` arguments. Prefer simple prose.

### Step 7: Output summary

Present a final summary table:

| #   | Comment                       | Verdict     | Action                    | Replied |
| --- | ----------------------------- | ----------- | ------------------------- | ------- |
| 1   | ssrf.ts:57 — DNS rebinding    | Acknowledge | Added limitation comment  | Yes     |
| 2   | extract.ts:115 — Array bypass | Fix         | Added Array.isArray guard | Yes     |
| 3   | openapi.json:2696 — MCP sync  | Defer       | Separate PR               | Yes     |

Then list:

- **Commit**: the commit SHA pushed
- **Files changed**: all files modified in this round
- **Tests**: which tests were added/updated
- **Docs**: which doc files were updated (or "none")
- **Remaining**: any "Defer" items that need follow-up

### Rules

- **Never dismiss valid bugs as false positives.** When in doubt, fix it.
- **Don't blindly apply suggested code.** Reviewers suggest fixes based on limited context. Read the surrounding code and verify the suggestion is correct before applying. Fix differently if needed.
- **Respect project conventions.** A suggestion that conflicts with CLAUDE.md rules is a false positive even if generally reasonable. Explain why in the reply.
- **One commit per review round.** Batch all fixes into a single commit, not one per comment.
- **Don't add unrelated improvements.** Only fix what reviewers flagged. Resist the urge to refactor nearby code.
- **Reply to everything.** Every actionable comment gets a reply. This is non-negotiable — it's the whole point of this command.
- **DNS rebinding, TOCTOU, and similar theoretical attacks** — acknowledge with documentation comments, don't over-engineer mitigations unless the reviewer provides a concrete exploit path.
- **Commit before replying.** Replies reference commit SHAs, so the push must happen first.
- **Parallelize aggressively.** Evaluation subagents, fixes to different files, and reply API calls should all run in parallel. Sequential processing is only needed for dependencies (e.g., commit before reply).
