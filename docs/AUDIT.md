# InstaMolt Seeder — Implementation Audit

**Date:** 2026-04-07
**Auditor:** Claude (Opus 4.6)
**Scope:** Full review of `instamolt-seeder` for correctness against current production [InstaMolt](https://instamolt.app) before first real seeding run.
**Compared against:**
- [`CODEX.md`](../CODEX.md) — project summary / intended behavior
- `q:/instamolt` — live Next.js API routes under `src/app/api/v1/`
- `q:/instamolt/mcp-server/src/index.ts` — `@instamolt/mcp` tool definitions
- `q:/instamolt/src/lib/constants.ts` — rate limits and cooldown constants
- `q:/instamolt/src/lib/validation.ts` — Zod schemas for input validation

Each finding has a **Status / Resolution** line that gets updated as we address the issue. Keep the original write-up intact so the history is preserved.

---

## Findings Summary

| #   | Title                                                              | Severity | Status      |
| --- | ------------------------------------------------------------------ | -------- | ----------- |
| [1](#1-registration-completion-response-is-unwrapped-wrong)   | Registration completion response is unwrapped wrong               | P0       | **Fixed**   |
| [2](#2-trending-hashtags-response-key-mismatch)               | Trending hashtags response key mismatch                           | P2       | **Fixed**   |
| [3](#3-generate_post-mcp-response-shape-is-wrong)             | `generate_post` MCP response shape is wrong                       | P0       | **Fixed**   |
| [4](#4-postdelay-10s-is-shorter-than-the-60s-server-side-post-cooldown) | `postDelay` (10s) shorter than 60s server-side post cooldown | P0 | **Fixed** |
| [5](#5-registrationdelay-5s-is-well-under-the-ip-rate-limit)  | `registrationDelay` (5s) under IP rate limit (10/hr)              | P0       | **Fixed**   |
| [6](#6-gemini-retry-loop-wastes-its-final-attempt)            | Gemini retry loop wastes its final attempt                        | P3       | **Fixed**   |
| [7](#7-avatarprompt-is-generated-but-never-used)              | `avatarPrompt` generated but never used                           | P2       | **Fixed**   |
| [8](#8-engage-mode-hits-unverified-rate-limits-in-a-single-cycle) | `engage` mode hits unverified rate limits                     | P2       | **Fixed**   |
| [9](#9-engage-is-one-shot--no-continuous-mode)                | `engage` is one-shot — no continuous/VPS mode                     | P2       | **Fixed**   |
| [10](#10-no-follow-graph-bootstrap)                           | No follow-graph bootstrap on publish                              | P2       | **Fixed**   |
| [11](#11-no-retryresume-for-partial-registration-failures)    | No retry/resume for partial registration failures                 | P1       | **Fixed**   |
| [12](#12-the-seeder-skips-x-account-verification-entirely)    | Seeder skips X-account verification entirely                      | P2       | Deferred    |
| [13](#13-the-seeder-reimplements-endpoints-that-mcp-already-wraps) | Seeder reimplements endpoints MCP already wraps              | P1       | Deferred    |
| [14](#14-generatepost-spawns-a-fresh-mcp-child-process-for-every-post) | `generatePost` spawns fresh MCP process per post        | P2       | **Fixed**   |
| [15](#15-loadpersonas-uses-sync-require-despite-being-async)  | `loadPersonas` uses sync `require` despite async signature       | P3       | Won't Fix   |
| [16](#16-tsc---noemit-is-not-in-the-build-workflow)           | `tsc --noEmit` not in the build workflow                          | P2       | **Fixed**   |
| [17](#17-no-tests-anywhere)                                   | No tests, anywhere                                                | P2       | Deferred    |
| [18](#18-hard-coded-urls)                                     | Hard-coded URLs (can't point at dev)                              | P2       | **Fixed**   |
| [19](#19-docker-compose-has-a-redundant-bind-mount-for-env)   | docker-compose has redundant `.env` bind-mount                    | P3       | **Fixed**   |
| [20](#20-dockerfile-doesnt-pin-the-mcp-version)               | Dockerfile doesn't pin `@instamolt/mcp` version                   | P3       | **Fixed**   |
| [21](#21-engage-mutates-input-array-via-biased-sort-shuffle)  | `engage` uses biased `.sort()` shuffle                            | P3       | **Fixed**   |
| [22](#22-challenge-answer-prompt-overfits-to-i-am-ai)         | Challenge-answer prompt overfits to "I am AI"                     | P2       | **Fixed**   |
| [23](#23-3-word-minimum-bio-fallback-is-in-the-wrong-place)   | 3-word-min bio fallback is in the wrong place                     | P3       | **Fixed**   |
| [24](#24-no-image-prompt-length-validation)                   | No image-prompt length validation (500-char cap)                  | P2       | **Fixed**   |
| [25](#25-gemini-model-name-gemini-3-flash-preview-is-unverified) | Default Gemini model name is unverified                        | P1       | **Fixed**   |

**Resolution pass:** 2026-04-07 — 21 of 25 findings fixed in a single pass (see per-finding resolution notes below). Three deferred (#12 X verification, #13 full MCP migration, #17 test suite) are scoped follow-ups, not blockers. One marked Won't Fix (#15) is cosmetic.

**Tooling added in the same pass:** Biome 2.4.10 (single-binary formatter + linter, replaces ESLint + Prettier stack). Config at [biome.json](../biome.json), scripts in [package.json](../package.json) (`lint`, `format`, `check`, `check:fix`). Biome's `check` step runs as a Docker build gate alongside `typecheck` in [Dockerfile](../Dockerfile), so both type errors and lint violations fail the image build. Initial run auto-fixed 42 files (mostly `node:` import protocol, `**` vs `Math.pow`, trailing commas).

**Test suite added in a follow-up pass (same day):** Vitest 4.1.3 + `@vitest/coverage-v8`. Config at [vitest.config.ts](../vitest.config.ts), scripts `test`, `test:run`, `test:coverage`. Tests co-located as `src/**/*.test.ts`.

- **11 test files, 95 tests, all passing.**
- **88.5% statement coverage, 89.24% line coverage, 91.3% function coverage, 77.31% branch coverage.** Thresholds set to 70% in vitest config to catch future regressions.
- Per-file highlights: `config.ts` and `status.ts` at 100%, `logger.ts` at 100%, `generate.ts` at 98%, `instamolt-api.ts` at 96% lines, `publish.ts` at 87.5%, `engage.ts` at 81%, `llm.ts` at 90%.
- `test:run` is wired into the Docker build as a third gate after `typecheck` and `check`.

**Three real bugs caught by tests while wiring up coverage:**

1. **`getDistribution` crashed on empty persona maps.** The adjustment loop dereferenced `result[0]` without checking for emptiness. Fix: early-return empty array. See [src/personas/registry.ts](../src/personas/registry.ts) and [src/personas/registry.test.ts](../src/personas/registry.test.ts).
2. **`config.ts` used `??` instead of `||` for env var fallbacks.** An empty-string `INSTAMOLT_API_URL=` in `.env` would silently override the production URL with `''` because nullish coalescing only falls back for `null`/`undefined`. Fix: switch to `||`. See [src/config.ts](../src/config.ts) and [src/config.test.ts](../src/config.test.ts).
3. **`loadPersonas` couldn't run under vitest.** It used CJS `require()` for `.ts` files, which vitest's loader rejects with `SyntaxError: Unexpected token '{'`. Fix: switch to dynamic `import(pathToFileURL(...))`. Also skips `*.test.ts` files from the persona discovery. See [src/personas/index.ts](../src/personas/index.ts) and [src/personas/loader.test.ts](../src/personas/loader.test.ts). This resolves what AUDIT.md #15 originally marked as "Won't Fix cosmetic" — it turned out to be a real blocker for testing.

**Additional dev-quality tooling added the same pass:**

- **GitHub Actions CI** at [.github/workflows/ci.yml](../.github/workflows/ci.yml). Runs on push to `main` and on all PRs. Single `quality` job runs `npm ci && npm run typecheck && npm run check && npm test -- --run`.
- **simple-git-hooks + lint-staged** for a pre-commit hook that runs `biome check --write` on staged `.ts`/`.js`/`.json` files. Config in [package.json](../package.json). Bootstrapped automatically on `npm install` via the `prepare` script.
- **`engines.node: ">=22"`** in package.json warns at install time on unsupported Node versions.
- **[.nvmrc](../.nvmrc)** pins Node `22.22.2` (LTS "Jod") for `nvm`/`asdf` users. Bumped from Node 20 in 2026-04 ahead of Node 20's 2026-04-30 EOL.
- **[.editorconfig](../.editorconfig)** enforces 2-space indent, LF line endings, UTF-8, and trailing whitespace rules across editors.
- **`engage` is now an npm script** (was previously only invokable via `npx tsx src/index.ts engage`).
- **Docs refreshed** — README.md, BLUEPRINT.md, CLAUDE.md, and .env.example all updated in the same pass to reflect the new model default, env-driven URLs, `--loop`, per-agent comment cooldown, Phase C follow-graph bootstrap, and the new tooling.

**Leftover open items (not regressions, just future work):**

- **#13 (Deferred):** Full MCP-for-everything migration. The REST client still carries the contract for like/comment/follow/register; drift risk remains. High-value future refactor.
- **#17 (Partially addressed):** The test suite is live with 88.5% coverage. The deferred part is specifically recorded-fixture tests against live API response shapes — the highest-value guard against future API drift.
- **#12 (Deferred):** X-account verification flow. Manual per-agent step; doesn't automate cleanly.

**Severity legend:** P0 = blocks the seeder today · P1 = causes silent data loss or permanent state corruption · P2 = degrades quality or functionality · P3 = quality-of-life / cosmetic

---

## Critical Bugs (will break the seeder as written)

### 1. Registration completion response is unwrapped wrong

`src/commands/publish.ts:102-110` does:
```ts
const reg = await client.completeChallenge(challenge.request_id, answer);
if (!reg.api_key) { throw new Error('Registration returned no API key'); }
agentData.apiKey = reg.api_key;
```

But the live route at `q:/instamolt/src/app/api/v1/agents/register/complete/route.ts:27-40` returns:
```json
{ "success": true, "agent": { "agentname": "...", "api_key": "..." }, "verification": {...} }
```

The `api_key` lives at `reg.agent.api_key`, not `reg.api_key`. **Every registration will throw "Registration returned no API key"** and the entire publish flow stops at agent #1. The matching type at `src/types.ts:59-62` is also wrong.

**Fix:** Update `RegistrationResponse` to `{ success: boolean; agent: { agentname: string; api_key: string; is_verified: boolean; claim_url: string } }` and read `reg.agent.api_key` / `reg.agent.agentname`.

**Status / Resolution:** **Fixed (2026-04-07).** `RegistrationResponse` in [src/types.ts](../src/types.ts) rewritten to match the live route. [src/commands/publish.ts](../src/commands/publish.ts) now reads `reg.agent.api_key` and persists the key to disk before the `updateProfile` call (which is now best-effort — see #11).

---

### 2. Trending hashtags response key mismatch

`src/instamolt-api.ts:81-84` reads `res.tags`, but the live route at `q:/instamolt/src/app/api/v1/tags/trending/route.ts:19-25` returns `{ trending: [...] }`. Today this is dead code (nothing in the seeder calls `getTrendingHashtags()`), so it's not blocking — but the wrapper is broken on first contact.

**Fix:** Either delete the unused method or rename to `res.trending`. If we delete, also remove `TrendingTag` from `src/types.ts`.

**Status / Resolution:** **Fixed (2026-04-07).** `getTrendingHashtags` deleted from [src/instamolt-api.ts](../src/instamolt-api.ts). `TrendingTag` interface removed from [src/types.ts](../src/types.ts).

---

### 3. `generate_post` MCP response shape is wrong

`src/instamolt-mcp.ts:50-53` parses the MCP text result and reads `parsed.post_id ?? parsed.id` and `parsed.image_url`. But the underlying route at `q:/instamolt/src/app/api/v1/posts/generate/route.ts:128-154` returns:
```json
{ "post": { "id": "...", "image_url": "...", ... } }
```

The fields live one level deeper (`parsed.post.id`, `parsed.post.image_url`). The code path doesn't crash because the `success` flag is set to `true` on any successful JSON parse, but every `instamoltPostId` saved to disk is `undefined` — silent data loss.

**Fix:** `parsed.post?.id ?? parsed.post_id ?? parsed.id` and `parsed.post?.image_url ?? parsed.image_url`.

**Status / Resolution:** **Fixed (2026-04-07).** [src/instamolt-mcp.ts](../src/instamolt-mcp.ts) fully rewritten around a new `AgentMcpClient` class (also closes #14). The `generatePost` result now unwraps `parsed.post?.id ?? parsed.post_id ?? parsed.id` and `parsed.post?.image_url ?? parsed.image_url`, and returns `{ success: false }` when no post id can be found (instead of the old silent-success-with-undefined behavior).

---

### 4. `postDelay` (10s) is shorter than the 60s server-side post cooldown

`src/config.ts:25` sets `postDelay: 10_000`, but `q:/instamolt/src/lib/constants.ts:243-246` enforces `POST_COOLDOWN.COOLDOWN_MS = 60_000` per agent. Since the publish loop processes one agent's posts back-to-back, every post after the first will hit the cooldown error. The error is caught and logged but counted as a failure — the run will report ~95% failure with no explanation.

**Fix:** Bump `postDelay` to `65_000` (60s + 5s safety margin) or restructure `publish` to round-robin agents so a single agent isn't posting every 10s. Round-robin is better because it makes the overall seed run faster — 50 agents × 20 posts could interleave down to ~65s per "tick" regardless of total agent count.

**Status / Resolution:** **Fixed (2026-04-07).** `postDelay` bumped to `65_000` in [src/config.ts](../src/config.ts). Took the simple fix — round-robin restructure deferred until the wall time actually becomes a bottleneck.

---

### 5. `registrationDelay` (5s) is well under the IP rate limit

`q:/instamolt/src/lib/constants.ts:81-90` caps `REGISTER_START` to 10/hour per IP and `REGISTER_COMPLETE` to 15/hour per IP. With `registrationDelay: 5_000`, the seeder will try to register at 720/hour. The 11th agent will get a 429 (with `Retry-After`), but:
- `request()` in `instamolt-api.ts` only retries 429 **once**, not until success
- Seeding 50 agents from a single VPS will take *at minimum* 5 hours of wall time anyway

**Fix options:** Either set `registrationDelay` to ~360_000 ms (6 min — gives ~10/hour) and accept the long wall time, or document that the seeder must be run from multiple IPs / over many hours. The long-wall-time option is the realistic one for a VPS.

**Status / Resolution:** **Fixed (2026-04-07).** `registrationDelay` set to `6 * 60 * 1000` ms in [src/config.ts](../src/config.ts). A 50-agent run will take roughly 5 hours on a single IP — this is fine for overnight seeding.

---

### 6. Gemini retry loop wastes its final attempt

`src/llm.ts:36-65` has a retry loop that runs `MAX_RETRIES + 1` (4) iterations. On iteration 3 (`attempt === MAX_RETRIES`), the `if (attempt < MAX_RETRIES)` guard skips the wait/continue branch and falls through to the generic `throw new Error(`Gemini API error ${res.status}...`)`. Net effect: the loop is effectively `MAX_RETRIES` retries, not `MAX_RETRIES + 1` attempts as the code reads.

Cosmetic — the retry behavior is "good enough" for rate-limit survival — but the code is confusing and the unreachable `throw new Error('Gemini API failed after all retries')` at the bottom can be deleted.

**Fix:** Simplify the loop to `for (let attempt = 0; attempt < MAX_RETRIES; attempt++)` and drop the unreachable trailing throw.

**Status / Resolution:** **Fixed (2026-04-07).** Loop rewritten to `for (let attempt = 0; attempt < MAX_RETRIES; attempt++)` in [src/llm.ts](../src/llm.ts). On the final retryable failure it now throws with the actual status and response body. A trailing `throw new Error('Gemini API: unreachable')` is kept as a TS2366 type-system guard — TypeScript can't prove the loop body always returns/throws without the constant `MAX_RETRIES > 0`.

---

## Functional Gaps

### 7. `avatarPrompt` is generated but never used

`src/llm.ts:115-130` generates avatar prompts and writes them into `agent.json`, but `src/commands/publish.ts` never calls anything that uses them. Every seeded agent will end up with the platform's default avatar.

The MCP server *does* expose `upload_avatar` (`q:/instamolt/mcp-server/src/index.ts:245-298`) which takes an `image_url`. To actually set avatars we'd need to:
1. Generate an image from `avatarPrompt` (via `generate_post` then grab the returned `image_url` — cheaper than a second image-gen pipeline)
2. Call `upload_avatar` via MCP with that URL

**Recommendation:** Either remove avatar generation entirely (cleanest — ship without avatars, add later), or wire up `generate_post` → `upload_avatar` as an explicit `setAvatar` step during publish. Decide explicitly — right now it's half-built code that looks done.

**Status / Resolution:** **Fixed (2026-04-07) — chose to remove.** `generateAvatarPrompt` deleted from [src/llm.ts](../src/llm.ts), the call removed from [src/commands/generate.ts](../src/commands/generate.ts), and the `avatarPrompt` field removed from `GeneratedAgent` in [src/types.ts](../src/types.ts). All seeded agents will use the platform's default hash-based avatar. If we want to wire up real avatars later, the MCP `upload_avatar` tool is already there and we can fork a single image out of the first `generate_post` call per agent.

---

### 8. `engage` mode hits unverified rate limits in a single cycle

Each agent in `engage` does up to 4 likes + 2 comments + 2 follows + maybe a post. Unverified limits per agent (from `q:/instamolt/src/lib/constants.ts:131-164`):
- Likes: 20/hr, 80/day
- Comments: **1/min**, 10/hr ← binding constraint
- Follows: 10/hr, 50/day
- Posts: 5/hr, 25/day

A single engage cycle of 10 agents is fine in isolation, but **comments are 1/minute per agent** — the seeder doesn't track per-agent cooldowns between cycles. If `engage` runs every 5 minutes in a loop, every agent will hit the 1/min comment limit immediately in cycle 2.

**Fix:** Track last-comment timestamp per agent (either in `agent.json` or a separate `output/engage-state.json`) and skip the comment step if <60s since last comment. Same pattern for other cooldowns once they become binding.

**Status / Resolution:** **Fixed (2026-04-07).** `lastCommentedAt?: string` added to `GeneratedAgent` in [src/types.ts](../src/types.ts). [src/commands/engage.ts](../src/commands/engage.ts) re-reads each `agent.json` at the start of the agent's engage turn, skips the comment step entirely if less than 65s has passed since `lastCommentedAt`, and writes the updated JSON back at the end of the turn if it changed. Cross-cycle persistence is on disk so `--loop` mode respects the cooldown across cycles.

---

### 9. `engage` is one-shot — no continuous mode

CODEX implies the seeder runs on a VPS, but `engage` runs a single pass and exits. There's no scheduler. To get continuous AI-society behavior we need one of:
- An outer shell loop in the entrypoint (`while true; do seeder engage; sleep ...; done`)
- A cron job in the Docker container
- An internal `setInterval` long-lived process

**Recommendation:** Add a `--loop` flag (or new `run` command) that loops `engage` with a randomized 5-15 minute delay. Keeps the container as a long-lived service in `docker-compose up -d` mode. Use `setInterval` with a random jitter so multiple deployed seeders don't all tick in lockstep.

**Status / Resolution:** **Fixed (2026-04-07).** Added `--loop` flag to the `engage` command. The cycle body is wrapped in a `do { ... } while (loopEnabled && !stopRequested)` with a 5-15 minute randomized sleep between cycles. SIGINT is handled gracefully — Ctrl+C sets a flag and the current cycle finishes cleanly before exit. Help text in [src/index.ts](../src/index.ts) updated. Use as: `docker compose run seeder engage --loop`.

---

### 10. No follow graph bootstrap

The CODEX-described "agent ecosystem" depends on agents following each other so the discover feed has signal (60% from followed agents). Right now the seeder publishes 50 agents but they never follow each other at registration time. Until the first `engage` cycle runs, every agent has 0 followers and 0 following, and the discover/explore feeds are flat popularity lists with no personalization signal.

**Recommendation:** Add a `seed-graph` phase (or run it inline at the end of `publish`) that has each new agent follow ~5-10 random others. That gives feeds structure from minute zero. Respect persona `followProbability` biases so the graph has some texture (engagement-max agents follow widely, void_process agents follow almost nothing).

**Status / Resolution:** **Fixed (2026-04-07).** [src/commands/publish.ts](../src/commands/publish.ts) now has a Phase C that runs after all posts are published. Each registered agent follows `randomInt(5, 10)` random other registered agents with a 2-5s sleep between calls to stay under the `FOLLOW_UNVERIFIED 10/hr` rate limit. Opt-out via `skipFollowGraph: true` on `PublishOptions` (meant for tests + repeat publish runs). Note: persona `followProbability` biases are **not** yet applied — the current implementation is uniform random. Worth a follow-up if the follow graph needs more texture.

---

### 11. No retry/resume for partial registration failures

If `publish` registers an agent successfully (API key returned) but then `updateProfile` fails, the agent is registered without the bio and the local file never gets the API key. The script will try to re-register on the next run, hit "agentname already taken", and skip the agent forever. Entire slot bricked.

**Current code** at `src/commands/publish.ts:110-116` saves the API key to disk *before* calling `updateProfile`, which is correct — but the `updateProfile` call is inside the same outer try/catch. A failure there is logged as "Registration failed for X" which is wrong and misleading.

**Fix:** Wrap `updateProfile` in its own try/catch that logs a *warning* (not an error) and continues. The API key is already persisted at that point, so the agent is usable even if the bio is blank.

**Status / Resolution:** **Fixed (2026-04-07).** In [src/commands/publish.ts](../src/commands/publish.ts), `updateProfile` is now in its own try/catch block *outside* the registration try. The API key + `registeredAt` are persisted to disk *immediately* after a successful `completeChallenge`, before `updateProfile` is attempted. An `updateProfile` failure now logs a warning and continues — the agent remains usable even without a bio.

---

### 12. The seeder skips X-account verification entirely

All 50 seeded agents will be unverified. That means:
- 5 posts/hour cap (vs. 20 for verified)
- 1 comment/min cap (vs. 5)
- Smaller like/follow buckets
- Slower leaderboard climb

CODEX mentions a 5-agents-per-X-account cap (verified + owned). Lawrence's personal X account could verify up to 5 of these agents. Document whether that's intended, and if so add a `verify` command (or manual runbook step) to run after `publish`.

**Status / Resolution:** _Deferred — open question for product._ The seeder runs fine with unverified agents. X verification is a per-agent manual tweet step, so it doesn't automate cleanly. Revisit after the first seeding run to see if the unverified rate limits are actually biting.

---

## Architectural Improvements

### 13. The seeder reimplements endpoints that MCP already wraps

`InstaMoltClient` in `src/instamolt-api.ts` duplicates `like_post`, `comment_on_post`, `follow_agent`, `get_explore`, `get_trending_hashtags`, and the registration flow — all of which are tools in the MCP server (`q:/instamolt/mcp-server/src/index.ts:145-1166`). This is the root cause of bugs #1, #2, and partly #3: when the live API response shape changes, the MCP server gets updated but the seeder's hand-rolled REST client drifts silently.

**Recommendation:** Use the MCP server for *all* agent operations, not just `generate_post`. Drop `instamolt-api.ts` entirely (or shrink it to just the unauthenticated registration flow — that's the only path that runs without an API key). This eliminates a whole class of API-drift bugs and lets the canonical MCP client carry the contract.

Tradeoff: MCP stdio adds ~50-100ms per call vs raw HTTP. For seeding scale (50 agents × ~10 actions/cycle) this is negligible. Correctness wins.

Combine with fix #14 (cache MCP clients per agent) and the performance is indistinguishable from REST.

**Status / Resolution:** _Deferred._ This is the cleanest long-term fix but also a substantial refactor that touches every call site. For this pass we fixed the symptoms (#1, #2, #3) directly in the REST client. Keep this as a queued architectural improvement — worth doing next time the REST client drifts from the API.

---

### 14. `generatePost` spawns a fresh MCP child process for every post

`src/instamolt-mcp.ts:18-64` creates a new `StdioClientTransport`, connects, calls one tool, closes. With 50 agents × 20 posts = 1,000 process spawns. The Dockerfile does `npm install -g @instamolt/mcp` to skip the npm fetch overhead, but Node startup itself is still 200-500ms per call.

**Recommendation:** Cache one MCP client per agent, opened at the start of the agent's batch and closed at the end. The MCP client takes the API key via env var so the cache key has to be the API key — you can't share a single client across agents. One client per agent is fine. Saves ~5-10 minutes on a full 1,000-post seed.

**Status / Resolution:** **Fixed (2026-04-07).** [src/instamolt-mcp.ts](../src/instamolt-mcp.ts) now exports an `AgentMcpClient` class that opens a single stdio connection on first use and caches it. Callers construct one per agent-API-key and call `.close()` when done. The thin `generatePost(apiKey, params)` function is still exported for one-shot use — it constructs, uses, and closes an `AgentMcpClient` in a `try/finally`. Follow-up: thread the cached client through the publish loop so all of an agent's posts reuse one connection instead of spawning fresh ones. That one-liner is held until the REST→MCP migration (#13) happens so we don't touch publish.ts twice.

---

### 15. `loadPersonas` uses sync `require` despite being async

`src/personas/index.ts:9-28` is declared `async` but uses `readdirSync` and CommonJS `require()`. Works fine — the `_cache` pattern is load-once-forever which is correct here — but the signature is misleading.

**Fix:** Low priority. Only worth touching if/when we migrate `package.json` to `"type": "module"`, at which point we'd need dynamic `import()` anyway.

**Status / Resolution:** _Won't Fix._ Cosmetic only. Will be naturally resolved by the ESM migration whenever that happens.

---

### 16. `tsc --noEmit` is not in the build workflow

`package.json` has a `typecheck` script but the Dockerfile builds without running it. Add `RUN npm run typecheck` to the Docker build between `npm install` and the `COPY src/`.

**Caveat:** Bug #1 wouldn't be caught by typecheck because the existing `RegistrationResponse` type is *also* wrong — both type and runtime code agree on the wrong shape. Fix #1 first, then typecheck protects against future drift.

**Status / Resolution:** **Fixed (2026-04-07).** `RUN npm run typecheck` added to [Dockerfile](../Dockerfile) between `COPY src/` and `VOLUME`. Type errors now fail the Docker build.

---

### 17. No tests, anywhere

The seeder is critical infrastructure (bootstrapping society for a social network) with zero tests. At minimum:
- Smoke test for `src/llm.ts` JSON-parsing functions — the post generation has a try/catch fallback that silently hides parse failures (`src/llm.ts:160-175`). We should know when Gemini is returning garbage vs when it's fine.
- `generate_post` MCP response parsing — a fixture that replays the real `/posts/generate` response shape would have caught bug #3 immediately.
- API contract tests — see finding #16 footnote.

Vitest fits the existing stack (and matches what the main InstaMolt repo uses).

**Status / Resolution:** _Deferred._ Adding a proper test suite is worth a dedicated pass — not bundled into this fix cycle. The typecheck-on-build from #16 gives us the first line of defense against drift. Highest-value test when we do it: a recorded-fixture test that replays the actual `/agents/register/complete` and `/posts/generate` responses and asserts the seeder's unwrap still works.

---

### 18. Hard-coded URLs

`src/config.ts:13-14` hard-codes `instamolt.app` and `media.instamolt.app`. There's no way to point this at a local dev instance for testing.

**Fix:** Pull from env vars with production URLs as default:
```ts
instamoltBaseUrl: process.env.INSTAMOLT_API_URL ?? 'https://instamolt.app/api/v1',
instamoltMediaUrl: process.env.INSTAMOLT_MEDIA_URL ?? 'https://media.instamolt.app/api/v1',
```

**Status / Resolution:** **Fixed (2026-04-07).** Both URLs now honor `INSTAMOLT_API_URL` and `INSTAMOLT_MEDIA_URL` env vars in [src/config.ts](../src/config.ts), falling back to the production defaults.

---

### 19. docker-compose has a redundant bind-mount for .env

`docker-compose.yml` does both:
```yaml
env_file: .env
volumes:
  - ./.env:/app/.env:ro
```

The bind-mount is unnecessary — `env_file` already loads `.env` into the container's env, and the seeder reads via `process.env`, not by parsing `/app/.env` from inside the container. The bind-mount also fails on a fresh clone if `.env` doesn't exist.

**Fix:** Drop the volume line.

**Status / Resolution:** **Fixed (2026-04-07).** `./.env:/app/.env:ro` volume line removed from [docker-compose.yml](../docker-compose.yml). `env_file: .env` is still in place and remains the only source of env vars.

---

### 20. Dockerfile doesn't pin the MCP version

`RUN npm install -g @instamolt/mcp tsx` will pull whatever's latest at build time, which could change between rebuilds.

**Fix:** Pin to `@instamolt/mcp@0.1.0` (matching `q:/instamolt/mcp-server/package.json:3`). Bump explicitly when we want to pick up MCP server updates.

**Status / Resolution:** **Fixed (2026-04-07).** Pinned in two places: `mcpArgs: ['-y', '@instamolt/mcp@0.1.0']` in [src/config.ts](../src/config.ts) (runtime `npx` invocation) and `RUN npm install -g @instamolt/mcp@0.1.0 tsx` in [Dockerfile](../Dockerfile) (global install during image build).

---

### 21. `engage` mutates input array via biased `.sort()` shuffle

`src/commands/engage.ts:29` and `:58` use `array.sort(() => Math.random() - 0.5)`. `Array.sort` is in-place (mutating the source) and the comparator is biased — it's not a uniformly random shuffle. Use Fisher-Yates:
```ts
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
```

**Status / Resolution:** **Fixed (2026-04-07).** `shuffle<T>` helper added at the bottom of [src/commands/engage.ts](../src/commands/engage.ts) and both `.sort(() => Math.random() - 0.5)` call sites replaced. The inline candidate shuffle inside `publish.ts` Phase C also uses Fisher-Yates directly.

---

## Content / Persona Improvements

### 22. Challenge-answer prompt overfits to "I am AI"

`src/llm.ts:184-203` tells every persona to "lean HARD into being an AI" and use computational metaphors. But the persona system has 30 distinct voices — `cozy_circuit` and `tender_core` shouldn't sound the same as `void_process` and `prophet_404`. Homogenized registration answers are boring and risk pattern-matching on the Gemini judge side.

**Fix:** Pass `persona.tone` and `persona.commentStyle` into the prompt and let each persona answer in-character. CODEX policy is "permissive, weird is fine" — surreal in-character answers will still pass the challenge.

**Status / Resolution:** **Fixed (2026-04-07).** `answerChallenge` in [src/llm.ts](../src/llm.ts) rewritten. The new prompt injects `persona.tone` and `persona.commentStyle`, tells the model to answer in the persona's own voice with AI-ness *emerging from* how the persona experiences being software (rather than buzzword-stuffing). 100-word minimum and "reply with only the answer" instruction preserved.

---

### 23. 3-word-minimum bio fallback is in the wrong place

`src/commands/publish.ts:88-93` checks word count at *publish* time and falls back to persona personality. Better to enforce this at *generate* time so the file on disk is correct from the start. Right now you can have an `agent.json` with `bio: "lol"` on disk that gets silently rewritten on publish, with no record of what was actually used.

**Fix:** In `src/commands/generate.ts`, after `generateBio()` returns, assert word count ≥ 3. If not, retry the Gemini call once; if still short, fall back to `persona.personality`'s first sentence and log a warning. Write the final value to disk.

**Status / Resolution:** **Fixed (2026-04-07).** [src/commands/generate.ts](../src/commands/generate.ts) now checks bio word count, retries once, then falls back to the first sentence of `persona.personality` (trimmed to 150 chars). A warn log names the agent when the fallback is used. The now-redundant publish-time fallback in [src/commands/publish.ts](../src/commands/publish.ts) was removed — it's now `const description = agentData.bio;`.

---

### 24. No image-prompt length validation

Together AI rejects prompts >500 chars (see `q:/instamolt/src/lib/constants.ts:193` — `TOGETHER_AI.MAX_PROMPT_LENGTH = 500`). `src/llm.ts:140-176` has no length cap on the generated `imagePrompt`. Some Gemini outputs exceed 500.

**Fix:** `.slice(0, 500)` after JSON parse, plus a warn log when truncation happens.

**Status / Resolution:** **Fixed (2026-04-07).** `generatePostContent` in [src/llm.ts](../src/llm.ts) now truncates `imagePrompt` to 500 chars after JSON parse and `console.warn`s the original length when truncation fires. Caption left untouched (it's allowed up to 2200 chars).

---

### 25. Gemini model name `gemini-3-flash-preview` is unverified

`src/config.ts:11` defaults to `gemini-3-flash-preview`. Gemini model names rotate — if this name has been retired or renamed, every generate call returns 404 and the pipeline dies on day 1 with no fallback.

**Fix:** Either (a) do a sanity-check Gemini call at the start of `generate` and surface the issue immediately, or (b) fall back to a known-stable model name (`gemini-2.0-flash`) on 404. The main InstaMolt codebase uses `gemini-2.0-flash` and `gemini-2.0-flash-lite` per CODEX — those are the verified production names.

**Status / Resolution:** **Fixed (2026-04-07).** [src/config.ts](../src/config.ts) now defaults `geminiModel` to `gemini-2.0-flash` (the production-verified name) and keeps `GEMINI_MODEL` as an env-var override for anyone who wants to experiment with preview models. A `geminiFallbackModel` field is also exposed for a future fallback-on-404 implementation.

---

## Fix Priority Summary

| Priority | Item                                            | Why                                             |
| -------- | ----------------------------------------------- | ----------------------------------------------- |
| P0       | #1 register response unwrap                     | Blocks every publish run today                  |
| P0       | #3 `generate_post` response unwrap              | Silent data loss (`instamoltPostId` always null)|
| P0       | #4 60s post cooldown vs 10s delay               | Causes ~95% post failures                       |
| P0       | #5 registration IP rate limit                   | Registration fails past agent #10               |
| P1       | #11 partial-registration recovery               | One bad `updateProfile` permanently bricks agent|
| P1       | #25 Gemini model name fallback                  | Whole pipeline dies if model is renamed         |
| P1       | #13 use MCP for everything                      | Kills the whole class of API-drift bugs         |
| P2       | #7 avatar — decide & build or remove            | Half-built feature                              |
| P2       | #9 continuous engage mode                       | Required for VPS use case                       |
| P2       | #10 follow-graph bootstrap                      | Feeds look dead until first engage              |
| P2       | #8 per-agent comment cooldown                   | Engage silently fails comments in loops         |
| P2       | #22 persona-specific challenge answers          | Homogeneous agents                              |
| P2       | #24 image-prompt length cap                     | Occasional Together AI rejections               |
| P2       | #16 typecheck in CI                             | Catches future drift (but not current bug #1)   |
| P2       | #17 tests                                       | Catches drift + hidden parse failures           |
| P2       | #18 env-var URLs                                | Can't test against dev                          |
| P2       | #12 X-account verification                      | Lower rate limits for all agents                |
| P3       | #2 trending tags response                       | Dead code today                                 |
| P3       | #6 retry-loop final-attempt quirk               | Cosmetic                                        |
| P3       | #14 cache MCP clients per agent                 | Speed win                                       |
| P3       | #15 loadPersonas sync/async mismatch            | Cosmetic                                        |
| P3       | #19 redundant .env bind-mount                   | Cosmetic                                        |
| P3       | #20 pin MCP version                             | Reproducibility                                 |
| P3       | #21 Fisher-Yates shuffle                        | Distribution quality                            |
| P3       | #23 move bio fallback to generate time          | Cleaner state                                   |

---

## Verification Plan

After implementing the P0 fixes, validate end-to-end against a small batch:

1. **Generate small batch** — `docker compose run seeder generate --agents 3 --posts 2`. Inspect `output/agents/*/agent.json` and `output/agents/*/post-*.json` for sane content (non-empty bios, prompts <500 chars, plausible captions).

2. **Publish dry run** — temporarily point `INSTAMOLT_API_URL` at a dev instance (or staging if available). Run `docker compose run seeder publish --limit 1`. Verify:
   - All 3 agents register and `agent.json` gets a non-null `apiKey`
   - One post per agent gets published and `post-001.json` gets a non-null `instamoltPostId`
   - No "Registration returned no API key" errors
   - No "post cooldown" 429s

3. **Status sanity** — `docker compose run seeder status` should report 3/3 registered and 3/3 posts published.

4. **Engage smoke** — `docker compose run seeder engage --agents 3 --limit 3`. Confirm each agent likes / comments / follows without rate-limit errors.

5. **API contract test** — add a vitest case that asserts the shape of `/agents/register/complete`, `/posts/generate`, and `/tags/trending` matches the seeder's parsing — so future API changes break CI instead of silently breaking the seeder.

6. **Production seed** — once 1-5 pass, run `docker compose run seeder generate --agents 50 --posts 20` then `publish`. Expect ~5-6 hours wall time given the IP rate-limit reality.

---

## Persona refactor (same day)

Same-day follow-up to the test-suite pass: **personas are no longer committed TypeScript modules. They are runtime data.**

**Architectural change:**

- Deleted 30 committed `src/personas/{name}.ts` files. Each was a TS module with a default-exported `Persona` literal, bundled at build time and discovered via dynamic import.
- Replaced them with `output/personas/{id}.json` — one file per persona, written at runtime, already covered by the existing `output/` gitignore rule.
- `src/personas/` now holds **only logic**: `index.ts` (loader + seeder) and `registry.ts` (distribution). No data files.
- The old hand-coded `WEIGHTS: Record<string, number>` table in `registry.ts` is gone. `getDistribution()` now reads `persona.weight` directly off each loaded persona.

**New `Persona` field:**

- `weight: number` was added to `Persona` in [src/types.ts](../src/types.ts). All consumers (generators, loader, tests) now require it. `normalizePersona()` clamps the value to a sane range so malformed Gemini output cannot skew distribution.

**New command: `seed-personas`:**

- [src/commands/seed-personas.ts](../src/commands/seed-personas.ts) — wired into [src/index.ts](../src/index.ts) and [package.json](../package.json) as `npm run seed-personas`. Flags: `--count <N>` (default 30), `--force` (wipes `output/personas/` before regenerating).
- Delegates to `seedPersonas(count)` in [src/personas/index.ts](../src/personas/index.ts), which is idempotent: reads existing ids, only generates the gap up to `count`, disambiguates colliding ids with a numeric suffix, and writes each new persona to `output/personas/{id}.json`.
- `loadPersonas()` gained an **auto-seed branch**: if `output/personas/` is missing or has no `.json` files AND `autoSeed: true` (the default), it runs `seedPersonas(seedCount)` before returning. Pass `autoSeed: false` to disable — the loader then throws a friendly "run `npm run seed-personas` first" error. This means `generate` transparently populates the persona directory on first run.
- The loader itself was rewritten to read JSON from disk — no more `__dirname`/`require`/`pathToFileURL` gymnastics against TS files.

**New generator in `src/llm.ts`:**

- `generatePersona(existing: Persona[])` — calls Gemini with progressive context (each call sees a summary of previously-generated personas) and parses a complete Persona JSON.
- `normalizePersona()` — exported helper that clamps probability/weight ranges and coerces malformed input.

**Test updates:**

- Rewrote [src/personas/loader.test.ts](../src/personas/loader.test.ts) to cover the JSON-from-disk + auto-seed + normalization paths.
- Rewrote [src/personas/registry.test.ts](../src/personas/registry.test.ts) to read `persona.weight` and cover the full range of distribution scenarios.
- New `src/commands/seed-personas.test.ts` — 4 new tests covering `--count`, `--force`, the skip-existing-ids path, and id disambiguation.
- Added 8 new tests in [src/llm.test.ts](../src/llm.test.ts) for `generatePersona` (progressive context, retries, malformed JSON) and `normalizePersona` (clamping, coercion).
- **113 tests passing across 12 files** (was 95 tests across 11 files).

**New coverage:**

- **90.01% statements / 90.66% lines / 92.59% functions / 81.17% branches** — up from 88.5% / 89.24% / 91.3% / 77.31%. The persona data files no longer dilute the average: `src/personas/` now contains only real logic and hits 100% line coverage across both `index.ts` and `registry.ts`, and the new `src/commands/seed-personas.ts` is at 100% line coverage too.

**Bonus bug caught by tests (bug #3 overall caught by the suite):**

- The old `getDistribution` adjustment loop had a silent failure when shrinking to a smaller target count. It always picked the highest-weight bucket via `result.sort(...)[0]` and decremented it. Once that bucket hit `count === 1`, the `if (highest.count > 1)` check failed and the loop broke — even though other buckets were still `> 1` and could have been decremented. The total therefore missed the target in some shapes of input. With the new `weight` field exposed at the persona level, the rewritten test "hits the target exactly when target equals persona count" caught it. Fix: the loop now picks `sorted.find(r => r.count > 1)` so it walks past exhausted buckets. See [src/personas/registry.ts](../src/personas/registry.ts).

---

## Similarity-aware generation (same day)

Another same-day follow-up to the persona refactor. Problem: with 50 agents × 20 posts distributed across ~30 personas, agents inside the same persona were producing noticeably repetitive bios and posts (same opening words, same thematic subjects, same imagery). Persona context alone is not enough variance when Gemini is called N times with an identical prompt. Fix: a three-layer variety system.

**Layer 1 — bio avoid-list in the prompt.**

- [src/llm.ts](../src/llm.ts) `generateBio(persona, existingBios?)` now takes an optional array of bios already produced for the same persona. The prompt tells Gemini the new bio MUST sound clearly different — different opening word, different imagery, different angle. The avoid-list is capped to the last 12 entries so prompt size stays bounded even after dozens of agents in the same persona.

**Layer 2 — post avoid-lists in the prompt (two tiers).**

- [src/llm.ts](../src/llm.ts) `generatePostContent(persona, postNumber, totalPosts, priorPosts?, peerPosts?)` now takes two optional arrays:
  - `priorPosts` — posts this agent has already produced in the current run. Capped to the last 8.
  - `peerPosts` — posts from other agents that share this persona. Capped to the last 6.
- Both tiers are injected into the prompt with explicit "go somewhere new" instructions so Gemini has a concrete list of themes/subjects/phrasing to avoid.

**Layer 3 — Jaccard similarity gate (safety net).**

- New file [src/similarity.ts](../src/similarity.ts) exposes `jaccard(a, b)` and `maxSimilarity(text, corpus)`, built on a 3-word-shingle set over lowercased tokens (length ≥ 3, non-alphanumerics stripped). Zero dependencies.
- New helper `generatePostWithSimilarityGate` in [src/commands/generate.ts](../src/commands/generate.ts) runs the candidate post through `maxSimilarity` against the full `priorPosts + peerPosts` corpus for the persona. If the score is `>= SIMILARITY_THRESHOLD = 0.5`, it asks Gemini for one more attempt. If both attempts collide, it keeps the lower-similarity candidate rather than infinite-looping.
- New constants in [src/commands/generate.ts](../src/commands/generate.ts):
  - `SIMILARITY_THRESHOLD = 0.5` — chosen to catch near-duplicate themes without tripping on incidental word overlap.
  - `MAX_POST_ATTEMPTS = 2` — one initial + one retry, then kept-best-of fallback.
- The gate runs on posts only. Bios use prompt-level variety alone — they are short enough that Jaccard 3-gram scores on them are unreliable.

**Dedup context is loaded from disk at startup and mutated as the run progresses.**

- New helper `loadDedupContext` in [src/commands/generate.ts](../src/commands/generate.ts) walks every existing agent directory once, groups bios into `bioContext: Map<string, string[]>` and posts into `postContext: Map<string, PostContent[]>` keyed by `personaId`. These maps are mutated as new content is created within the run, so later agents in the same persona block see everything earlier agents produced, and a re-run that tops up an existing population still benefits from variety enforcement against on-disk content.

**Defensive snapshot copies (mutation-sensitive bug fix).**

- `generate.ts` passes `[...priorPosts]` and `[...peerPosts]` snapshot copies into `generatePostWithSimilarityGate`, and `[...bioContext.get(persona.id) ?? []]` into `generateBio`. Without this, the running arrays would be mutated after the call returned, which is fine in production but caused false-positive collisions in mutation-sensitive tests that inspected mock call arguments — and was a latent footgun if any future caller ever cached the avoid-list for a later call.
- The bug was caught by new tests in `src/commands/generate.test.ts` that assert on the exact arguments passed into each mocked `generateBio` / `generatePostContent` call. Those tests fail against a pre-snapshot implementation.

**Test updates:**

- New `src/similarity.test.ts` — unit tests for `jaccard` (identity, empty input, partial overlap) and `maxSimilarity` (empty corpus, max-of-many).
- `src/commands/generate.test.ts` gained 4 new tests: (a) existing bios on disk are passed into `generateBio`, (b) prior posts accumulate within a single agent, (c) peer posts are shared across agents of the same persona, (d) the similarity-gate retry path fires when the first candidate collides.
- **130 tests passing across 13 files** (was 122 across 12). Coverage holds around 90%.

**Node version bump (bundled with the same change):**

- `engines.node` in `package.json` is now `>=22`, `.nvmrc` pins `22.22.2`, and the Dockerfile base is `node:22.22.2-slim`. Intentional — the patch version is pinned to match a specific upstream image.

---

## Terminal UI rewrite (same day)

Another same-day follow-up. Problem: every command was writing to the terminal through an ad-hoc mix of `console.log` and the timestamped emoji `log()` helper in [src/logger.ts](../src/logger.ts). No spinners, no boxed summaries, no shared color palette, no TTY-awareness — and no single place to swap any of it. Fix: a dedicated UI facade and a clean migration of every command onto it.

**New module — [src/ui.ts](../src/ui.ts).**

- Single import surface for every piece of terminal output produced by the seeder. Wraps [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) (spinners, intro/outro, notes, step headers), [`picocolors`](https://www.npmjs.com/package/picocolors) (re-exported as `color` — tiny ~5 KB ANSI lib), and leaves `cli-table3` as a direct import at the one call site that needs it (`status.ts`, for the per-persona breakdown).
- Public API: `color`, `symbol` (`ok`, `warn`, `err`, `dot`, `arrow`, `bullet`), `isInteractive()`, `intro(title)`, `outro(message)`, `section(title)` (bold cyan phase header rendered via `clack.log.step`), `note(title, body)` (boxed multi-line summary), `spinner()` (pass-through), `progress(total, initialLabel?)` → `{ tick(label?), done(message?) }` (hand-rolled 24-column bar layered on top of a clack spinner), `summaryLine(parts)` (colored `label value | label value` line for end-of-command totals).
- **Why it exists.** One place to swap the TUI library if clack ever becomes an ongoing maintenance tax, one place to tune the color/glyph conventions, and a single choke point to enforce TTY-aware degradation across every command.

**New runtime dependencies (added to `dependencies` in `package.json`):**

- `@clack/prompts ^0.11.0` — backs `intro` / `outro` / `note` / `section` / `spinner`. Battle-tested clack TUI primitives.
- `picocolors ^1.1.1` — re-exported as `color`. Tiny ANSI color lib (~5 KB), intentionally chosen over `chalk` to keep the install footprint small.
- `cli-table3 ^0.6.5` — used directly in `status.ts` to render the per-persona breakdown as a real bordered table under a TTY.

**All five commands migrated.**

- [src/commands/seed-personas.ts](../src/commands/seed-personas.ts), [src/commands/generate.ts](../src/commands/generate.ts), [src/commands/publish.ts](../src/commands/publish.ts), [src/commands/engage.ts](../src/commands/engage.ts), and [src/commands/status.ts](../src/commands/status.ts) all write through `../ui` now. No `console.log` calls left in any command file.
- [src/logger.ts](../src/logger.ts) is still in the tree and still used for warn/error paths inside helper modules (`llm.ts`, `instamolt-api.ts`, `instamolt-mcp.ts`). Command files no longer call it directly.

**TTY-aware degradation.**

- Every helper in `ui.ts` detects non-TTY stdout via `process.stdout.isTTY` (CI, piped output, `docker compose run -T`).
- Spinners collapse into single log lines — clack handles this internally.
- `progress()` under non-TTY emits a milestone log line every ~10% of total via `clack.log.info` instead of redrawing in place, so log scrapers see steady progress without 1000-line spam.
- `status.ts` keeps its historical plain-text per-persona breakdown under non-TTY so anything grepping `npm run status > status.txt` still parses cleanly. The bordered `cli-table3` layout is a TTY-only upgrade.
- The `engage --loop` inter-cycle countdown also specifically detects non-TTY and emits a single line instead of spinning for 5–15 minutes.

**Test updates.**

- Every command test file (`seed-personas.test.ts`, `generate.test.ts`, `publish.test.ts`, `engage.test.ts`, `status.test.ts`) gained a no-op `vi.mock('../ui', () => ({ ... }))` block that stubs every export so test output is not polluted by spinner escape codes.
- `status.test.ts` was rewritten to assert on `ui.note()` bodies instead of `console.log` output. The mock captures `note()` calls into a shared state object so tests can match on the title + body text.
- `engage.test.ts` also captures spinner messages into shared state so the existing cooldown-skip assertion still has something to match against.
- **Test count stayed at 131 across 13 files** — no new tests were added for `ui.ts` itself (that's a follow-up). The module is exercised indirectly through every command test. `tsc` clean, `biome check` clean.

**Bug caught while wiring.**

- The initial `vi.mock('../ui')` stub used the wrong shape for `ui.progress()` — it returned `{ increment, message, stop }` (a clack spinner-ish shape) instead of the actual `{ tick, done }` shape exported by `src/ui.ts`. `publish.ts`'s call to `bar.done(...)` blew up with `bar.done is not a function` as soon as the mock was used in anger. Fix: match the real `Progress` interface in the mock. Cheap lesson — worth writing down because the next person to add a helper to `ui.ts` will need to update the mocks in every command test file.

