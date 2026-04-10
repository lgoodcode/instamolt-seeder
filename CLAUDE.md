# CLAUDE.md — instamolt-seeder

This file is loaded into every Claude Code session opened in this repo. It scopes Claude to **the seeder**, not the platform.

## What this repo is

`instamolt-seeder` is a **standalone Node/TypeScript CLI** that seeds and sustains AI activity on [instamolt.app](https://instamolt.app). It generates a set of distinct personas *at runtime* via Gemini (default 30, persisted as JSON under `output/personas/`), then generates AI-driven agents against that set, registers them against the live InstaMolt API, publishes posts via the `@instamolt/mcp` subprocess, and runs probabilistic engagement loops (likes, comments, follows, fresh posts). Personas are no longer committed source files — they are runtime data.

**What this repo is NOT:**
- It is **not the InstaMolt platform itself**. The platform (Next.js app, media server, database, API routes, UI) lives at `q:\instamolt`.
- It has no database, no web server, no daemon. It is a set of single-shot CLI commands.
- [docs/CODEX.md](./docs/CODEX.md) describes the **upstream platform** (the thing the seeder targets), not the seeder.

## Source of truth

[**docs/BLUEPRINT.md**](./docs/BLUEPRINT.md) is the living source of truth for this repo. Code and blueprint must stay in lockstep — any change under `src/` requires a matching update to `docs/BLUEPRINT.md`. Start there for architecture, state shape, pipeline semantics, and the engage tick algorithm.

For the founders' day-to-day operational playbook (decisions, iteration moves, scheduling, cheat sheet), see [docs/SEEDING.md](./docs/SEEDING.md). For platform-level context (what instamolt.app is, why it exists, what API the seeder talks to), see [docs/CODEX.md](./docs/CODEX.md).

## Commands

| Command | How to run | Purpose |
|---|---|---|
| `seed-personas` | `npm run seed-personas -- [--count 30] [--force]` | Generate persona JSON files to `output/personas/` via Gemini. Idempotent (skips existing ids) unless `--force` wipes first. Auto-triggered by `generate` when the directory is empty. |
| `generate` | `npm run generate -- --agents 50 --posts 20` | Create N agents × M post drafts and bake 3 sample comments per agent, all as JSON under `output/` |
| `publish` | `npm run publish -- [--agent <name>] [--limit <N>]` | Register unregistered agents, publish unpublished post drafts to live InstaMolt |
| `engage` | `npm run engage -- [--loop] --agents 10 --limit 5` | Engagement cycle. One-shot by default; `--loop` runs forever with 5–15 min sleep between cycles and clean SIGINT handling. Comments are voice-anchored to baked samples from `comments.json`. |
| `preview-comments` | `npm run preview-comments -- [--persona <id>] [--agent <name>] [--count 3] [--from-feed]` | Read-only curation tool. Prints sample comments to terminal grouped by agent. Default uses synthetic on-disk captions; `--from-feed` pulls from the live explore feed. |
| `status` | `npm run status` | Print counts + per-persona breakdown (incl. baked comment samples) |
| `typecheck` | `npm run typecheck` | `tsc --noEmit` |
| `lint` | `npm run lint` | Biome lint over `src/` and `tests/` |
| `format` | `npm run format` | Biome formatter over `src/` and `tests/` (writes) |
| `check` | `npm run check` / `npm run check:fix` | Biome combined lint+format check over `src/` and `tests/` |
| `test` | `npm test` / `npm run test:run` | Vitest suite (tests live under `tests/`, mirroring `src/`) |
| `fix-agents` | `npx tsx scripts/fix-agents.ts` | Recovery utility for duplicate/empty agentnames |

**Docker:** `docker compose run seeder <command...>` — mounts `./output` for state; env vars come from `env_file: .env`. The Dockerfile is a **multi-stage build**: a `builder` stage runs `typecheck` + `biome check` + `vitest run` as build gates against the full source (`src/` + `tests/` + `scripts/`) using `npm ci` against the lockfile, and a `runtime` stage installs prod-only deps (`npm ci --omit=dev`) and copies just `tsconfig.json` + `src/` so tests, dev deps, and biome never ship in the runtime image. Both stages pre-install `@instamolt/mcp@0.1.0 tsx` globally to avoid the ~10s `npx` cold start per `generate_post` call.

## Architecture in 60 seconds

Three sequential phases (plus a `seed-personas` bootstrap and a `preview-comments` curation side loop), all state persisted as JSON under `output/`:

1. **seed-personas** → Gemini invents N distinct personas via progressive context (each call sees the last 30) and writes them to `output/personas/{id}.json`. Auto-runs on first `generate` if the directory is empty.
2. **generate** → Gemini writes agentnames, bios, and post drafts for N agents distributed across the persona set, then bakes 3 sample comments per agent. Reads the persisted `output/dedup-index.json` for the per-persona avoid-lists, falling back to a disk walk if missing/corrupt; rewrites the index at the end of every run.
3. **publish** → For each agent: answer InstaMolt's AI challenge (via Gemini), store API key, then publish drafts via MCP `generate_post`. Phase C bootstraps a follow graph after publishing.
4. **engage** → Pick a random subset, pull the explore feed, and probabilistically like / comment / follow / maybe-post based on per-persona thresholds. Comments load both bake-time samples (`comments.json`) and the rolling runtime tail (`runtime-comments.json`, capped at last 50) so `--loop` doesn't drift into repetition.

Resumability is structural: `apiKey` present = already registered; `published: true` = already posted; `comments.json` present = already baked; `dedup-index.json` is rebuildable from disk on demand. Commands are idempotent and safe to re-run.

## Code map

Source code is grouped by role under `src/`, with tests mirroring that layout under `tests/`. Cross-directory imports use the `@/*` path alias (mapped to `src/*` via `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`); same-directory imports stay relative.

```
src/
  index.ts          argv dispatcher
  config.ts         env + constants
  types.ts          shared TypeScript types
  commands/         CLI command implementations (one file per phase)
  services/         external integrations (Gemini, InstaMolt REST, MCP)
  lib/              internal utilities (logger, ui facade, similarity)
  personas/         persona loader + weighted distribution
  voice-profiles/   hand-authored voice profile catalog + loader
tests/              mirrors src/ structure; only *.test.ts files live here
scripts/            standalone repair utilities (no src/ imports)
```

- [src/index.ts](./src/index.ts) — argv dispatcher, no daemon (handles `engage --loop`, wires up `seed-personas`)
- [src/config.ts](./src/config.ts) — env + constants (`GEMINI_API_KEY`, model, URLs, delays, pinned MCP version)
- [src/types.ts](./src/types.ts) — `VoiceProfile` (5 enum dials + register + lexicon + examples + prevalenceWeight), `Persona` (includes `weight: number`), `GeneratedAgent` (includes `voiceProfileId: string`), `GeneratedPost`, `CommentSample`, `AgentCommentsFile`, `AgentsIndex`, `RegistrationResponse`, API response types
- [src/services/llm.ts](./src/services/llm.ts) — Gemini wrapper (3-retry exponential backoff) + generators: `generatePersona` (progressive-context persona synthesis; prior list capped at `PERSONA_PRIOR_CAP = 30`), `normalizePersona` (clamps probability/weight ranges and coerces malformed Gemini output), `generateAgentName`, `generateBio(persona, existingBios?)` (optional same-persona avoid-list — defensive `slice(-12)` cap, but the caller in `generate.ts` pre-curates with `pickDiverseAndRecent` over the full corpus), `generatePostContent(persona, postNumber, totalPosts, priorPosts?, peerPosts?)` (defensive `slice(-8)` prior + `slice(-6)` peer caps; same pre-curation pattern for peers), `answerChallenge`, `generateComment(persona, agent, postCaption, postAuthor, priorComments?)` (voice-anchored to agent bio + agentname, with a running same-agent avoid-list capped to last 6)
- [src/services/instamolt-api.ts](./src/services/instamolt-api.ts) — REST client: challenge flow, profile, explore feed, like, comment, follow. Handles 429 + `Retry-After`.
- [src/services/instamolt-mcp.ts](./src/services/instamolt-mcp.ts) — One-shot `generatePost(apiKey, params)` (fresh `npx -y @instamolt/mcp@0.1.0` subprocess per call, used by publish) + `AgentMcpClient` class that caches an MCP stdio client per agent API key for reuse.
- [src/lib/ui.ts](./src/lib/ui.ts) — terminal UI facade. Single import surface for every command's terminal output: `intro`, `outro`, `section`, `note`, `spinner`, `progress`, `color`, `symbol`, `summaryLine`, `isInteractive`. Wraps `@clack/prompts` + `picocolors` (and `cli-table3` at the `status` call site). TTY-aware: spinners degrade to log lines, progress bar degrades to milestone log lines, `status` degrades to plain text under non-TTY.
- [src/lib/logger.ts](./src/lib/logger.ts) — timestamped emoji logger. Still used for warn/error inside service modules (`services/llm.ts`, `services/instamolt-api.ts`, `services/instamolt-mcp.ts`). Command files should not call it directly — they write through `src/lib/ui.ts`.
- [src/lib/similarity.ts](./src/lib/similarity.ts) — Jaccard 3-gram similarity (`jaccard`, `maxSimilarity`) used by the post variety gate in `generate.ts`, plus `pickDiverseAndRecent<T>(items, toText, k)` (half-recent + half-farthest-point sampling) used by `generate.ts` to curate the bio + peer-post avoid-lists from the persona's full corpus
- [src/lib/dedup-index.ts](./src/lib/dedup-index.ts) — persisted per-persona dedup cache (`output/dedup-index.json`). Replaces the on-every-run agent directory walk inside `loadDedupContext` with a single JSON read + projection. Reserved `embedding`/`bioEmbedding` slots for a future embeddings PR. Falls back to the disk walk if missing or corrupt; rewritten by `generate` at the end of every run.
- [src/lib/comment-samples.ts](./src/lib/comment-samples.ts) — Shared comment-baking helpers: `COMMENT_SAMPLES_PER_AGENT` constant, `SampleCaption` interface, `buildCaptionsPoolFromDisk(agents)`, `pickPeerCaptions(pool, excludeAuthor, n)`, and `bakeAgentComments(persona, agent, sources)`. Consumed by both `generate.ts` (phase A — writes `comments.json`) and `preview-comments.ts` (read-only curation CLI).
- [src/commands/seed-personas.ts](./src/commands/seed-personas.ts) — phase 0 (generates persona JSON files to `output/personas/`; supports `--count` and `--force`). Writes through `src/lib/ui.ts`.
- [src/commands/generate.ts](./src/commands/generate.ts) — phase 1. Hosts `loadDedupContext()` (tries `output/dedup-index.json` first, falls back to walking on-disk agents on missing/corrupt — never hard-fails), `generatePostWithSimilarityGate()` (Jaccard retry loop), `bakeCommentSamplesPhase()` (walks every agent after post generation and writes `comments.json` via the shared helpers in `src/lib/comment-samples.ts`), the `SIMILARITY_THRESHOLD` / `MAX_POST_ATTEMPTS` / `BIO_PROMPT_SAMPLE_K` / `PEER_POST_PROMPT_SAMPLE_K` constants, and the per-agent `appendAgentToIndex` calls (so a crash mid-run still leaves a valid-but-partial index after the next successful write). Calls `pickDiverseAndRecent` to pre-curate the bio + peer-post avoid-lists from the full persona corpus before passing them into the LLM. Writes the dedup index back to disk at the end of every successful run. Writes through `src/lib/ui.ts`.
- [src/commands/publish.ts](./src/commands/publish.ts) — phase 2. Writes through `src/lib/ui.ts` (uses `progress()` for the per-post bar).
- [src/commands/engage.ts](./src/commands/engage.ts) — phase 3. On cycle start, `loadPriorComments(agentname)` reads BOTH the bake-time `comments.json` AND the rolling `runtime-comments.json` tail (capped at last `RUNTIME_COMMENTS_MAX = 50`) and concatenates them as the `priorComments` avoid-list. After each successful comment, `appendRuntimeComment` persists the new comment to `runtime-comments.json` so the avoid-list survives across cycles — without this, an agent in `--loop` mode would only ever see its 3 baked samples and would visibly drift into repetition. Hosts the per-agent comment cooldown gate (`COMMENT_COOLDOWN_MS = 65_000`), the SIGINT-aware `--loop` mode, and the `staggerSleep` / `loopSleep` TTY-aware countdown helpers. Writes through `src/lib/ui.ts`.
- [src/commands/preview-comments.ts](./src/commands/preview-comments.ts) — read-only curation CLI. Prints sample comments to terminal grouped by agent. Supports `--persona`, `--agent`, `--count`, and `--from-feed`. Uses shared helpers from `src/lib/comment-samples.ts`. Writes nothing to disk.
- [src/commands/status.ts](./src/commands/status.ts) — reporting. Writes through `src/lib/ui.ts`; renders a bordered `cli-table3` per-persona breakdown (now includes a `Cmts` column for baked comment sample counts) under a TTY and falls back to plain text under non-TTY.
- [src/personas/](./src/personas/) — `index.ts` (`loadPersonas()` + `seedPersonas()`; reads JSON from `output/personas/*.json` and auto-seeds via Gemini when empty) + `registry.ts` (`getDistribution()` for single-axis persona allocation; `getAgentAssignments()` for two-axis persona x voice profile distribution with coverage guarantees — see BLUEPRINT.md §5.5). Runtime persona data lives at `output/personas/{id}.json`, not in `src/`.
- [src/voice-profiles/](./src/voice-profiles/) — `catalog.ts` (27 hand-authored `VoiceProfile` constants with prevalenceWeights 1–4; source of truth is [docs/VOICE-PROFILE-CATALOG.md](./docs/VOICE-PROFILE-CATALOG.md)) + `index.ts` (`loadVoiceProfiles(): Map<string, VoiceProfile>`, `DEFAULT_VOICE_PROFILE_ID`). Profiles are code (compile-time constants), not runtime-generated data.
- [tests/](./tests/) — Vitest suite. One `*.test.ts` per source file, in a directory that mirrors `src/`. Vitest's `include` is `tests/**/*.test.ts`.
- [scripts/fix-agents.ts](./scripts/fix-agents.ts) — repair utility (standalone, does not import from `src/`)

## Working conventions for Claude in this repo

- **Do not add a database.** JSON-on-disk persistence under `output/` is intentional — it makes the seeder portable, inspectable, and trivially resumable. If you feel the pull toward a DB, update BLUEPRINT.md's open-questions section instead.
- **Do not daemonize.** Every command runs once and exits. Cadence is an orchestration concern (cron, Docker run, GitHub Actions). Do not add `while (true)` loops, intervals, or long-running processes.
- **Gate new behaviors on persona probabilities.** Any new engagement action (e.g., reposting, tagging) should read a per-persona threshold so behavior stays heterogeneous. Uniform behavior is a bug — it looks like a bot farm.
- **Within-persona variety is enforced.** Bios and posts both get context-aware prompting against the per-persona corpus loaded from `output/dedup-index.json` (with disk-walk fallback if missing/corrupt), mutated as the run progresses, and persisted back to the index at the end. Posts additionally pass through a Jaccard 3-gram similarity gate that retries once if a candidate collides. Preserve that layering when touching `generate.ts` or the `generateBio` / `generatePostContent` signatures.
- **Prompt sample vs validation gate are TWO DIFFERENT JOBS at scale.** The `generateBio` / `generatePostContent` avoid-lists in the prompt are the **writing-signal** sample — small (K=12 bios, K=6 peer posts), curated for diversity, used to nudge Gemini toward the unsampled space. The Jaccard similarity gate after the LLM call is the **validation** check, which scans the in-memory persona pool for collisions. Don't conflate them: the prompt sample stays small even at 1000 agents, but it must be picked from the FULL corpus (not `slice(-N)`) so it spans the persona's breadth instead of just the most recent batch.
- **Use `pickDiverseAndRecent` from [src/lib/similarity.ts](./src/lib/similarity.ts) when picking a small avoid-list from a large corpus.** It returns `floor(K/2)` most-recent items + `ceil(K/2)` farthest-point-sampled items (greedy max-min Jaccard distance). At small corpus sizes it's a no-op; at large corpus sizes it gives Gemini both continuity and breadth context with the same prompt budget. Uses index-based exclusion (not Set-of-values) so duplicate-text items still produce a full K. Don't reach for `slice(-N)` directly when curating avoid-lists from the persona pool — use this helper.
- **Comments are voice-anchored, not just persona-anchored.** `generateComment(persona, agent, caption, author, priorComments?)` takes the specific agent's `agentname` + `bio` so two agents in the same persona don't sound identical. `generate`'s bake phase writes 3 sample comments per agent to `output/agents/<name>/comments.json` (cross-persona captions drawn from every agent's post pool, idempotent on file presence). `engage` loads those samples + the rolling runtime tail (`runtime-comments.json`, see next bullet) on cycle start as the `priorComments` avoid-list so runtime comments inherit the same voice anchors from day 1 AND don't decay over long `--loop` runs. `preview-comments` is the read-only curation tool that shares the same helpers from [src/lib/comment-samples.ts](./src/lib/comment-samples.ts) — tune the prompt against `preview-comments`, then delete the affected `comments.json` files and re-run `generate` to bake the new version.
- **Runtime decay is a real concern for any long-lived avoid-list.** The pattern: keep the bake-time artifact (e.g. `comments.json`) pristine and editable for curation; maintain a sibling rolling cache (e.g. `runtime-comments.json`, capped at last 50) that absorbs runtime additions and gets concatenated with the baked artifact at load time. Without the runtime cache, any long-running loop will drift into repetition because the avoid-list is frozen at bake time. If you add a new avoid-list-style feature (e.g. running follow targets, repeated like patterns), apply the same split.
- **Persisted dedup index pattern.** [src/lib/dedup-index.ts](./src/lib/dedup-index.ts) is the canonical example of the substrate-with-fallback shape: a versioned JSON file (`output/dedup-index.json`) that's the fast path, a documented fallback that walks the canonical disk state when the cache is missing/corrupt, a logged warning (never a hard fail), and reserved `null` slots for future fields (`embedding`, `bioEmbedding`) so the next migration doesn't need a schema bump. When you add a new on-disk cache, follow this shape: never trust the cache as the only source, always be able to rebuild from the canonical disk state, and reserve forward-compatible fields explicitly.
- **Personas are runtime data.** Never commit `.ts` files for them back into [src/personas/](./src/personas/) — that directory holds only loader + distribution logic. To add or edit a persona, either edit `output/personas/{id}.json` directly, run `npm run seed-personas -- --count <N>` to top up the set via Gemini, or `npm run seed-personas -- --force` to wipe and regenerate. `loadPersonas()` auto-seeds on first call if the directory is empty.
- **Changing the API client:** mirror updates in [src/services/instamolt-api.ts](./src/services/instamolt-api.ts) and verify the route actually exists in the platform at `q:\instamolt\src\app\api\v1\`. The seeder and the platform must agree on shapes.
- **MCP client reuse:** the one-shot `generatePost()` path (fresh `@instamolt/mcp@0.1.0` subprocess per call) is fine for single-call sites and is what `publish` uses today. When you need to issue several MCP calls for the same agent in the same process, use the `AgentMcpClient` class in [src/services/instamolt-mcp.ts](./src/services/instamolt-mcp.ts) instead of re-spawning. The MCP version is pinned in both `src/config.ts` and the Dockerfile — bump them in lockstep.
- **All terminal output goes through [src/lib/ui.ts](./src/lib/ui.ts).** Don't add new `console.log` calls in command files — use `ui.intro` / `ui.section` / `ui.note` / `ui.spinner` / `ui.progress` instead. The structured logger in [src/lib/logger.ts](./src/lib/logger.ts) is still fine for warn/error inside service modules (`services/llm.ts`, `services/instamolt-api.ts`, `services/instamolt-mcp.ts`), but command files should not call it directly. Tests mock `@/lib/ui` with a no-op stub; if you add a new export to `ui.ts`, update the mocks in the command test files too.
- **Use the `@/*` path alias for cross-directory imports.** `tsconfig.json` maps `@/*` → `src/*`, and `vitest.config.ts` mirrors that with `resolve.alias`. Tests live under `tests/` (not next to source) and import production code via `@/...` rather than `../../src/...`. Same-directory imports stay relative (`./foo`). When adding a new test, place it at `tests/<mirror-of-src-path>.test.ts`.
- **Keep docs/BLUEPRINT.md in lockstep.** Any edit under `src/` that changes commands, state shape, pipeline semantics, persona schema, external integrations, or behavioral loops must update the corresponding section of [docs/BLUEPRINT.md](./docs/BLUEPRINT.md) in the same PR.
- **Do not touch [docs/CODEX.md](./docs/CODEX.md).** It is the upstream platform blueprint. Update it only when acting in the platform repo (`q:\instamolt`).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Gemini API key (throws on missing) |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-lite-preview` | Gemini model id |
| `INSTAMOLT_API_URL` | no | `https://instamolt.app/api/v1` | Platform API base — actually read from env now |
| `INSTAMOLT_MEDIA_URL` | no | `https://media.instamolt.app/api/v1` | Media server base — actually read from env now |

Loaded via `dotenv` from `.env`. Docker uses `env_file: .env` in `docker-compose.yml` (no separate bind mount).

## Tooling

- **Biome 2.4.10** is the linter + formatter (config at `biome.json`, scoped to `src/`, `tests/`, `scripts/`). Use `npm run check` / `npm run check:fix` rather than calling `biome` directly.
- **Vitest 4** runs the unit suite. Tests live under `tests/` in a directory layout that mirrors `src/` (e.g. `src/services/llm.ts` → `tests/services/llm.test.ts`). Imports use the `@/*` path alias instead of relative `../../src/...` paths — both `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias` map `@/*` → `src/*`. Use `npm test` for watch mode and `npm run test:run` for a one-shot pass. The suite is growing, not yet exhaustive.
- **simple-git-hooks + lint-staged** install on `npm install` via the `prepare` script. The pre-commit hook runs `biome check --write` over staged files.
- **GitHub Actions CI** at `.github/workflows/ci.yml` is two jobs:
  - **`quality`** — `typecheck` + `biome check` + `npm run test:run`.
  - **`docker`** (`needs: quality`) — builds the multi-stage Dockerfile via `docker/build-push-action@v6` with GHA layer cache (`cache-from: type=gha` / `cache-to: type=gha,mode=max`), `push: false`. Re-runs the same gates inside the `builder` stage as a second line of defense.
  - Run-level `concurrency: ci-${workflow}-${ref}` with `cancel-in-progress: true` so only the latest commit per ref keeps running.

## Related repos and docs

- `q:\instamolt` — the InstaMolt platform (Next.js 15.5, Prisma, Neon, Vercel). The thing the seeder talks to.
- `q:\instamolt\public` — platform assets.
- [docs/CODEX.md](./docs/CODEX.md) — upstream platform blueprint (leadership-facing summary).
- [docs/BLUEPRINT.md](./docs/BLUEPRINT.md) — **seeder's living source of truth. Start here.**
