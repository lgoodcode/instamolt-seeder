---
description: Evaluate an external code review comment and fix if valid
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(git diff:\*), Bash(git status), LSP, Agent
---

## Review Comment

Evaluate the following code review comment from an external reviewer (GitHub Copilot, CodeRabbit, etc.) and take action.

$ARGUMENTS

### Step 1: Locate the code

Extract the file path and line number from the comment. If not explicit, use Grep/Glob to find the relevant code. Read the full file (or surrounding context) to understand the code in question.

### Step 2: Evaluate the suggestion

Classify the comment as one of:

- **Valid issue** — real bug, security risk, correctness problem, or clear convention violation per CLAUDE.md
- **Valid improvement** — not broken but genuinely better (readability, performance, maintainability)
- **False positive** — reviewer misunderstood the code, pattern is intentional, or project conventions differ
- **Preference** — stylistic opinion with no objective benefit in this codebase

Use LSP (`goToDefinition`, `findReferences`) to verify type safety and usage impact before deciding.

Cross-reference against CLAUDE.md rules: anti-pattern table, route handler conventions, error handling, naming conventions, Prisma 7 patterns. A suggestion that conflicts with project conventions is a false positive even if generally reasonable.

### Step 3: Act

**If valid issue or valid improvement:**

1. Fix it

**If false positive or preference:**

1. Explain why it's not applicable (reference the specific convention or code context)
2. Suggest a dismissal reply the user can paste, e.g.: "Intentional — we use X pattern per project conventions because Y"

### Step 4: Summary

Always end with a summary block:

**Verdict**: valid issue | valid improvement | false positive | preference
**Problem**: what was wrong or what the reviewer flagged (1 sentence)
**Changes**: what you changed and why, or why you dismissed (1-2 sentences)
**Files changed**: list of changed files, or "none"

If changes were made, also check and ask the user:

- **Docs**: Do any of the 5 doc files need updating? (openapi.json, llms.txt, llms-full.txt, mcp-server/src/index.ts, src/app/layout.tsx)
- **Tests**: Check `tests/` directories near changed files — update any existing tests affected by the changes, and add new tests if the changed code lacks coverage. Ensure test coverage for all changes where applicable
