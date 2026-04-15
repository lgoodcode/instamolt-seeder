# InstaMolt Seeder — Code Review Instructions

## Review Behavior

- **One comment per violation type per file.** If the same rule is broken multiple times, leave a single comment listing all locations — never separate comments for each.
- **Limit to the diff.** Only flag issues in lines added or modified in the PR. Do not flag pre-existing code.
- **Max 8 comments per PR.** Prioritize errors over suggestions.

## What This Project Is

A standalone **Node/TypeScript CLI** that seeds AI activity on [instamolt.app](https://instamolt.app). Four phases — `seed-personas` → `generate` → `publish` → `engage` — plus `status` and `preview-comments` for inspection. All state is JSON files under `output/`. No database. No web server. No daemon (except `engage --loop` with explicit SIGINT handling).

```
src/
  commands/       One file per CLI phase
  services/       Gemini LLM, InstaMolt REST client, MCP subprocess
  lib/            UI facade, logger, similarity, dedup index, comment samples
  personas/       Loader + weighted distribution (data lives in output/)
  voice-profiles/ Hand-authored compile-time constants + loader
tests/            Mirrors src/ layout, uses @/* path alias
```

Cross-directory imports use `@/*` (mapped to `src/*`). Same-directory imports stay relative.

## Errors (must block)

- **No `any` type** — use `unknown` and narrow.
- **No database or ORM.** JSON-on-disk under `output/` is intentional and load-bearing. If a change needs a DB, it belongs in `docs/BLUEPRINT.md` §10 open questions, not in code.
- **No daemon loops.** Every command runs once and exits. `engage --loop` is the only exception and has SIGINT handling. Do not add `setInterval`, `while (true)`, or background processes.
- **No uniform behavior across agents.** Every engagement action (likes, comments, follows, posting) MUST be gated on a per-persona probability threshold. Hardcoded uniform behavior looks like a bot farm.
- **Voice profiles are compile-time constants** in `src/voice-profiles/catalog.ts`. Do not generate them at runtime or write them to disk.
- **Personas are runtime data** in `output/personas/`. Do not commit persona `.ts` files into `src/personas/` — that directory holds only loader + distribution logic.
- **Use `@/*` path alias** for cross-directory imports — never `../../src/...`. Same-directory stays relative.
- **No MCP for image posts.** Image post creation goes through `InstaMoltClient.generatePost` (`POST /posts/generate`). The `@instamolt/mcp` stdio shim was removed — do not re-introduce it.
- **No secrets in logs.** API keys must be truncated if logged at all.
- **Every Gemini/platform interaction emits a `SeederEvent`.** New code paths that call `callGemini`, the `InstaMoltClient`, or add a CLI phase must emit structured events via `logEvent()` or the `timed()` helper in `@/lib/event-logger`. Skipping event emission (especially on success) breaks the latency aggregates in `stats.json`.
- **Keep `docs/BLUEPRINT.md` in lockstep.** Any change under `src/` that touches commands, state shape, pipeline semantics, or behavioral loops must update the matching blueprint section in the same PR.

## Suggestions (non-blocking)

- **Persona probability gates** on new behaviors — `Math.random() < persona.xProbability`.
- **Dedup avoid-lists** — use `pickDiverseAndRecent` from `src/lib/similarity.ts` (half-recent + half-farthest-point sampling) instead of `slice(-N)`. The prompt sample and the similarity gate are two separate jobs — don't conflate them.
- **Voice anchoring** — `generateComment` takes the specific agent's `agentname` + `bio`, not just the persona. Two agents in the same persona can have different voice profiles (`voiceProfileId` assigned via `getAgentAssignments()` in `src/personas/registry.ts`).
- **Runtime decay prevention** — for long-lived avoid-lists in `--loop` mode, use the bake-time artifact + rolling runtime cache pattern (e.g., `comments.json` + `runtime-comments.json` capped at last 50).
- **Persisted cache pattern** — new on-disk caches should follow `src/lib/dedup-index.ts`: fast-path JSON file, disk-walk fallback on corrupt/missing, logged warning (never hard-fail), reserved null slots for future fields.
- **No magic numbers** — delay constants in `src/config.ts`, generate-phase constants at the top of `src/commands/generate.ts`.
- **ESM imports only** — never `require()`.
- **Naming**: files `kebab-case.ts`, types `PascalCase`, functions `camelCase`, constants `UPPER_SNAKE_CASE`.
- **Terminal output in commands** — prefer `@/lib/ui` (`intro`, `section`, `note`, `spinner`, `progress`, `outro`) over raw `console.log`. Three command files (`status.ts`, `preview-comments.ts`, `events.ts`) are intentional exceptions — they render multi-line grouped output (`cli-table3`, per-agent previews, per-session summaries) that can't flow through `ui.note()`.
- **Service modules route through `logEvent`** — every retry, rate-limit hit, and transient failure in `src/services/` emits a structured `SeederEvent` via `@/lib/event-logger`, not `console.warn`. `console.*` in `src/services/` is a regression flag.
- **TTY-aware degradation** — spinners degrade to log lines, progress bars degrade to milestone lines, loop countdowns emit a single line under non-TTY.

## Testing

- Vitest 4 with tests under `tests/` mirroring `src/` — never `__tests__/`
- `vi.hoisted()` → `vi.mock()` → `beforeEach(() => vi.clearAllMocks())` ordering
- Mock Gemini, InstaMolt API, MCP subprocess, `node:fs/promises`, and `@/lib/ui` — never hit real services
- Use `@/*` path alias in test imports
- Missing `@/lib/ui` mock in command tests → spinner escape codes pollute output

## Do NOT Flag

- Emoji icons in `src/lib/logger.ts` — intentional terminal UX
- `sleep()` calls between API operations — rate limit pacing, not bugs
- `JSON.parse` without schema validation on files under `output/` — the seeder wrote them
- `console.log` in `status.ts` (table rendering), `preview-comments.ts` (multi-line agent previews), and `events.ts` (per-session summary lines) — those outputs can't flow through `ui.note()`
- `process.exit(1)` in the top-level error handler in `src/index.ts`
- Large `vi.mock()` blocks for `@/lib/ui` in tests — the facade has many exports
- Import ordering among import statements
