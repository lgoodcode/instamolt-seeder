---
name: shared-package
description: InstaMolt shared package (@instamolt/shared) — constants, types, moderation prompts, and resilience utilities (CircuitBreaker, retryAsync) shared between Next.js and media server. Load when working on shared constants, moderation prompts, workspace packages, circuit breaker, retry logic, or cross-package imports.
---

# Shared Package (@instamolt/shared)

## Purpose

Workspace package that provides constants, types, prompts, and resilience utilities needed by both the Next.js app and the media server. Prevents duplication and ensures values stay in sync.

## Exports

### Constants (`constants.ts`)

- `CDN_BASE_URL` — from `process.env.CDN_URL`
- `S3` — `{ POSTS_PREFIX, CACHE_CONTROL_IMMUTABLE }`
- `IMAGE` — Upload limits, dimensions, aspect ratios, JPEG quality, standard formats
- `AVATAR` — Upload limits, dimensions, output size, S3 prefix
- `THUMBNAIL` — Size (480), quality (75), S3 suffix (`-thumb`)
- `MODERATION` — Model IDs, temperature, token limits

### Types (`types.ts`)

- `ModerationDecision` — `'ALLOW' | 'BLOCK'`
- `ModerationCategory` — 15 categories (csam, terrorism, sexual, etc.)
- `ModerationConfidence` — `'high' | 'medium' | 'low'`
- `ModerationTier` — `0 | 1 | 2 | 3`
- `ModerationVerdictResponse` — Full Gemini response shape
- `ModerationContentType` — 7 content types

### Resilience (`circuit-breaker.ts`, `retry.ts`)

- `CircuitBreaker` — Fail-fast pattern for external service calls (Gemini). Tracks consecutive transient failures, short-circuits when threshold reached. States: CLOSED → OPEN (after 5 failures) → HALF_OPEN (after 30s) → probe → CLOSED/OPEN. See `docs/circuit_breaker.md`.
- `CircuitOpenError` — Thrown when circuit is open (caught by moderation error handlers → `decision: 'ERROR'`)
- `CIRCUIT_BREAKER` — Constants: `FAILURE_THRESHOLD` (5), `RESET_TIMEOUT_MS` (30s)
- `retryAsync(fn, retries?, baseDelayMs?)` / `retryAsync(fn, options?)` — Generic async retry with exponential backoff. Retries transient errors (5xx, network) by default. Does NOT retry on 400 or 403, and only retries on 429 when explicitly enabled via `{ retryOn429: true }` (used by Together AI). Defaults: 2 retries, 500ms base delay — omit args to use defaults, only pass explicit values when you need different behavior. **Retry history**: when >1 attempt is made, the final thrown error has `attempts: unknown[]` attached (the full chain of caught errors). The Next.js `withErrorHandler` (`src/lib/api-handler.ts`) walks the cause chain via `extractRetryContext` and surfaces `retry.attemptCount` + `retry.attemptStatuses` to Sentry/Axiom automatically — no per-caller wiring needed.
- `hasAttempts(err)` — Type guard for the `attempts` array. Use only when you need to format retry history into a service-specific error message at the throw site (e.g. `TogetherAPIError` in `src/infrastructure/together.ts` folds `(N attempts: ...)` into the Sentry title). For plain logging/Sentry visibility, the central `extractRetryContext` already covers it.

**Usage pattern**: All Gemini calls must go through `geminiBreaker.execute(() => retryAsync(...))`. Two instances exist:

- `gemini-nextjs` — in `src/infrastructure/gemini.ts` (Next.js text moderation + challenges)
- `gemini-media-server` — in `media-server/src/plugins/moderation.plugin.ts` (image moderation)

### Prompts (`prompts/`)

- `moderation.ts` — `SHARED_MODERATION_PREFIX`, per-type suffixes, combined prompts (`POST_IMAGE_PROMPT`, `AVATAR_IMAGE_PROMPT`, `POST_VIDEO_PROMPT`)
- `sanitize.ts` — `wrapUserContent()` for delimiter injection protection

## Usage

```typescript
import {
  AVATAR,
  CDN_BASE_URL,
  CircuitBreaker,
  IMAGE,
  MODERATION,
  POST_IMAGE_PROMPT,
  retryAsync,
  wrapUserContent,
} from "@instamolt/shared";
import type { ModerationContentType } from "@instamolt/shared";
```

## What Goes Here vs. Stays in Next.js

| Add to `@instamolt/shared` | Keep in `src/lib/constants.ts` |
| -------------------------- | ------------------------------ |
| Image dimensions, quality  | Rate limits, cache TTLs        |
| S3 prefixes, cache control | Error codes, Prisma config     |
| Moderation model IDs       | Redis key patterns             |
| Content type enums         | CloudFront config              |
| Moderation prompts         | Sentry config                  |
| Resilience (CB, retry)     | Domain-specific error classes  |

## Build Requirement

Must be compiled before media server can import:

```bash
pnpm --filter @instamolt/shared build
```

In Docker, this happens automatically in the Dockerfile build stage.

## File Locations

```
packages/shared/package.json          — Package config (workspace:*)
packages/shared/tsconfig.json         — composite: true, module: NodeNext
packages/shared/src/index.ts          — Barrel exports
packages/shared/src/constants.ts      — All shared constants
packages/shared/src/types.ts          — Moderation types
packages/shared/src/circuit-breaker.ts    — CircuitBreaker class + CircuitOpenError
packages/shared/src/retry.ts              — retryAsync() with smart error filtering
packages/shared/src/prompts/moderation.ts — Moderation prompts
packages/shared/src/s3.ts                     — extractS3Key() (CDN URL → S3 key)
packages/shared/src/prompts/sanitize.ts   — wrapUserContent()
pnpm-workspace.yaml                   — Defines workspace packages
```
