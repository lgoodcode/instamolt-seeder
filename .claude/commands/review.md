---
description: Full codebase-aware code review of staged or recent changes
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git status), LSP
---

## Code Review

Review the following changes with full codebase context for the **instamolt-seeder** CLI.

$ARGUMENTS

### Diff source

Determine the right diff automatically:

1. If there are staged changes → review `git diff --cached`
2. Else if the current branch differs from `main` → review `git diff main...HEAD`
3. Else → review `git diff HEAD~1`

Show the changed file list and full diff for whichever source applies.

If all three sources yield an empty diff, report "No changes to review" and stop.

### Review process

1. **Read all changed files in full** — not just the diff. Use parallel Read calls where possible. Understand surrounding context before flagging anything.
2. **Trace with LSP** — use `goToDefinition` and `findReferences` to check consumers affected by type/signature changes (especially in `src/services/`, `src/lib/`, `src/types.ts`).
3. **Cross-reference** — check related files (`src/config.ts`, `src/types.ts`, `src/lib/ui.ts`, the relevant service in `src/services/`, the matching test under `tests/`) for consistency with the changes.
4. **Check git history** — for each significantly changed file, run `git log --oneline -5 -- <file>`. Flag if:
   - A change reverts a recent intentional refactor (check the commit message)
   - A pattern was previously removed and is being re-introduced
   - A file was recently touched for the same concern (possible merge artifact)
     Skip this for new files.

### Anti-pattern scan

Scan the diff for these seeder-specific violations (each from `CLAUDE.md`):

| Anti-pattern | What to flag |
| --- | --- |
| `any` type | Use `unknown` and narrow, or define a proper type in `src/types.ts` |
| `console.log` in command files (`src/commands/*.ts`) | Must write through `@/lib/ui` (`ui.intro` / `ui.section` / `ui.note` / `ui.spinner` / `ui.progress`) |
| `@/lib/logger` import in command files | Logger is reserved for `src/services/*` warn/error. Commands write through `@/lib/ui` |
| Relative cross-directory imports (`../../src/...`) | Use the `@/*` path alias (mapped in `tsconfig.json` and `vitest.config.ts`) |
| `require()` / CommonJS | ESM only — use `import` |
| New `while (true)` / `setInterval` daemon | Forbidden — every command is single-shot. `engage --loop` is the only sanctioned loop and lives in `src/index.ts` |
| New database, ORM, or persistence layer | Forbidden — state lives in `output/*.json`. JSON-on-disk is intentional |
| New `.ts` persona files under `src/personas/` (other than `index.ts` / `registry.ts`) | Personas are runtime data under `output/personas/*.json`. To add personas, edit JSON or run `npm run seed-personas` |
| Magic numbers in `src/` | Extract to `src/config.ts` |
| Direct `@google/generative-ai` import outside `src/services/llm.ts` | All Gemini calls go through that wrapper (3-retry exponential backoff lives in one place) |
| Direct `fetch` to `instamolt.app` outside `src/services/instamolt-api.ts` | All API calls go through the client and must respect 429 + `Retry-After` |
| Fresh `npx -y @instamolt/mcp` per call inside a loop | Use `AgentMcpClient` from `src/services/instamolt-mcp.ts` to cache the stdio client per agent |
| Tests under `__tests__/` | Use `tests/<mirror-of-src-path>.test.ts` (no double underscores) |
| Test file next to source under `src/` | Tests live under `tests/` only — Vitest's `include` is `tests/**/*.test.ts` |
| Uniform engagement behavior across personas | New behaviors must read a per-persona threshold/weight — uniform behavior looks like a bot farm |
| Bumping `@instamolt/mcp` in only one place | Pinned in **both** `src/config.ts` and the `Dockerfile` — must move in lockstep |
| `src/` change without `docs/BLUEPRINT.md` update | Any change to commands, state shape, pipeline semantics, persona schema, integrations, or behavioral loops must update BLUEPRINT.md in the same PR |
| Edits to `docs/CODEX.md` from this repo | CODEX.md is the upstream platform blueprint — never edit it from the seeder |

### False positives — do NOT flag

- Pre-existing issues not introduced in this diff
- Issues a linter, typechecker, or test runner would catch (imports, types, formatting) — assume `npm run check` / `npm run typecheck` / `npm run test:run` run separately
- Intentional `// biome-ignore` with explanatory comment
- Patterns that look wrong but match an established convention in peer files
- General quality opinions (test coverage, naming aesthetics) unless `CLAUDE.md` explicitly requires it
- Code on unchanged lines adjacent to the diff
- `output/**` files (these are runtime state, not source)
- The structured logger usage inside `src/services/llm.ts`, `src/services/instamolt-api.ts`, `src/services/instamolt-mcp.ts` (explicitly allowed)

### Command file checks

If changes touch `src/commands/*.ts`:

- **Idempotent** — re-running the command must be safe. `apiKey` present = already registered, `published: true` = already posted, `comments.json` present = samples already baked.
- **UI facade only** — every terminal output goes through `@/lib/ui`. No `console.log`, no direct `@/lib/logger` imports.
- **No daemon** — single-shot exit. The only sanctioned loop is `engage --loop` handled in `src/index.ts`.
- **Per-persona variety** — any new engagement action reads a per-persona probability/weight from the loaded `Persona`.

### Service file checks

If changes touch `src/services/*.ts`:

- Gemini calls only inside `services/llm.ts`, behind the 3-retry wrapper
- API calls only inside `services/instamolt-api.ts`, with 429 + `Retry-After` handling
- MCP calls go through `services/instamolt-mcp.ts` — use `AgentMcpClient` when issuing several calls for the same agent in the same process
- Verify any new endpoint actually exists in the platform at `q:\instamolt\src\app\api\v1\` — the seeder and platform must agree on shapes
- `@/lib/logger` is allowed here for warn/error

### Within-persona variety checks

If changes touch `src/commands/generate.ts`, `src/services/llm.ts`, or any of the `generateBio` / `generatePostContent` / `generateComment` signatures:

- Preserve the avoid-list parameters (`existingBios`, `priorPosts`, `peerPosts`, `priorComments`)
- Preserve the Jaccard 3-gram similarity gate (`src/lib/similarity.ts`) and the `SIMILARITY_THRESHOLD` / `MAX_POST_ATTEMPTS` retry loop in `generate.ts`
- Comments must remain voice-anchored: `generateComment(persona, agent, caption, author, priorComments?)` takes the agent's `agentname` + `bio`, not just the persona

### Persona file checks

- Persona content lives at `output/personas/{id}.json`. Edits should target JSON files or extend `seedPersonas`/`generatePersona` in `src/personas/index.ts` + `src/services/llm.ts`.
- `src/personas/` should only ever contain `index.ts` (loader) and `registry.ts` (distribution). Reject new `.ts` files there.

### Test checks

If test files are in the diff:

- Files live under `tests/`, mirroring the `src/` path (e.g. `src/services/llm.ts` → `tests/services/llm.test.ts`)
- Imports use `@/*` instead of `../../src/...`
- If a new export was added to `src/lib/ui.ts`, the no-op `@/lib/ui` mocks in command test files must be updated
- No `console.log` / `debugger` left behind

### Doc sync

If the change touches commands, state shape, pipeline semantics, persona schema, external integrations, or behavioral loops, flag that **`docs/BLUEPRINT.md` must be updated in the same PR** per the lockstep rule in `CLAUDE.md`.

For founder-facing operational changes, also consider whether `docs/SEEDING.md` needs an update.

**Never touch `docs/CODEX.md` from this repo** — that's the platform's blueprint and is updated only from `q:\instamolt`.

### Output format

**Summary** — what changed and why (1-3 sentences)

**Issues** (grouped by severity)

Severity definitions:

- **Critical** — Data loss or correctness risk that breaks the seeder. Idempotency violation that double-publishes or double-registers, persistence bug that corrupts `output/`, secret leaked into a committed file.
- **High** — Reliability or behavioral risk. Direct Gemini/API/MCP usage bypassing the wrapper, missing 429 handling, daemonization, persona-uniform behavior, MCP version skew between `src/config.ts` and `Dockerfile`.
- **Medium** — Observability, maintainability, or convention risk. `console.log` in commands, missing `@/*` alias, missing variety avoid-list, new magic number, `docs/BLUEPRINT.md` not updated alongside `src/` changes.
- **Low** — Style or convention. Naming inconsistency, redundant type annotations, pattern deviation with no runtime impact.

For each issue:

- **[severity]** **[confidence: certain | likely | possible]** File:line
- What the problem is
- Which rule it violates (anti-pattern table, command/service check, doc sync, etc.)
- Suggested fix

Confidence guide:

- **certain** — directly verifiable from the code (e.g., `console.log` in a command file)
- **likely** — strong evidence, needs broader context to confirm
- **possible** — pattern match that could be intentional

**Doc sync needed** — does `docs/BLUEPRINT.md` (and optionally `docs/SEEDING.md`) need updating? (or "none")

**Looks good** — things done well worth calling out

Be specific and direct. No generic advice. Reference actual file paths and line numbers.
