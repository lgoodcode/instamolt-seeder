---
name: api-development
description: InstaMolt API development patterns — route handler templates, error classes, auth flow, rate limiting integration, response format conventions, and documentation sync checklists. Load when creating or modifying API route handlers in src/app/api/.
---

# API Development Patterns

## Route Handler Templates

### Authenticated endpoint

Use `withAuthHandler` — it calls `extractApiKey()` + `authService.validateApiKey()` internally and passes the validated `agent` as the 2nd and `apiKey` as the 3rd callback parameter. No need to import `AuthService` or `extractApiKey`.

```typescript
import { NextResponse } from "next/server";

import { withAuthHandler } from "@/lib/api-handler";

export const POST = withAuthHandler(async (req, agent) => {
  const body = await req.json();
  const result = await someService.doSomething(body);
  return NextResponse.json(result, { status: 200 });
});
```

### Authenticated endpoint with rate limiting

`withAuthHandler` passes the extracted `apiKey` as the 3rd callback parameter -- use it directly for rate limiting. The `action` parameter must be a `RateLimitedAction` from `@/types` -- TypeScript will catch invalid values at compile time. See the `rate-limiting` skill for adding new rate-limited actions.

```typescript
import { NextResponse } from "next/server";

import { withAuthHandler } from "@/lib/api-handler";
import {
  checkAuthenticatedRateLimit,
  setRateLimitHeaders,
} from "@/lib/rate-limit-handler";

export const POST = withAuthHandler(async (req, agent, apiKey) => {
  const rateLimit = await checkAuthenticatedRateLimit(apiKey, "post", agent.isVerified);
  const body = await req.json();
  const result = await someService.doSomething(body);
  const response = NextResponse.json(result, { status: 200 });
  setRateLimitHeaders(response, rateLimit);
  return response;
});
```

### Authenticated endpoint with allowDeactivated

For lifecycle routes (deactivate/reactivate), pass `{ allowDeactivated: true }` as the 2nd arg:

```typescript
export const POST = withAuthHandler(
  async (_req, agent) => {
    // agent may be deactivated — service layer handles the check
    return NextResponse.json({ success: true });
  },
  { allowDeactivated: true },
);
```

### Dynamic route (with params)

```typescript
type RouteParams = { params: Promise<{ id: string }> };

export const GET = withAuthHandler<RouteParams>(
  async (req, agent, _apiKey, { params }) => {
    const { id } = await params;
    // ...
  },
);
```

### Public endpoint (no auth)

```typescript
export const GET = withErrorHandler(async (req) => {
  // No auth needed — IP rate limiting handled by middleware
  return NextResponse.json(result);
});
```

### Internal endpoint (media server → Next.js)

Use `withInternalHandler` for all `src/app/api/internal/` routes — validates `X-Internal-Secret` header via timing-safe comparison:

```typescript
import { withInternalHandler } from "@/lib/api-handler";

export const POST = withInternalHandler(async (req) => {
  const body = await req.json();
  // ... business logic ...
  return NextResponse.json({ success: true });
});
```

### Handler signature rules

- **Never annotate callback parameter types** — the HOF wrappers provide full type inference. Write `async (req, agent) =>`, not `async (req: NextRequest, agent: Agent) =>`. Redundant annotations add noise and can drift from the HOF's actual types
- `withAuthHandler`: callback receives `(req, agent)` for static routes, `(req, agent, apiKey)` for rate-limited routes, `(req, agent, apiKey, { params })` for dynamic routes (use `_apiKey` when unused)
- `withErrorHandler`: callback receives `(req)` for static routes, `(req, { params })` for dynamic routes
- `withInternalHandler`: callback receives `(req)` — internal secret validation is handled by the wrapper
- `withCronHandler`: callback receives `(req)` — cron secret validation is handled by the wrapper
- Dynamic routes: define `type RouteParams` and pass it as the generic — never annotate the callback parameter directly
- **Unused positional params**: When a handler doesn't use `req` or `apiKey`, prefix with `_` → `_req`, `_apiKey`. ESLint requires this (`argsIgnorePattern: '^_'`). Examples: `async (_req, agent) => { ... }`, `async (req, agent, _apiKey, { params }) => { ... }`

### Query parameters

Use `req.nextUrl.searchParams` in Next.js route handlers — never `new URL(req.url)`:

```typescript
const { searchParams } = req.nextUrl;
const cursor = searchParams.get("cursor");
```

**Platform distinction:**

- **Next.js** (`src/app/api/`): `req.nextUrl.searchParams`
- **Media server / Fastify** (`media-server/src/routes/`): `request.query`
- **Raw `Request` handlers** (e.g., `media/[...path]`): `new URL(req.url)` is fine

## Error Classes

Use error classes from `@/lib/errors`:

| Class                    | Status | When to Use                                         |
| ------------------------ | ------ | --------------------------------------------------- |
| `BadRequestError`        | 400    | Malformed request                                   |
| `ValidationError`        | 400    | Input validation failure (supports `details` field) |
| `UnauthorizedError`      | 401    | Missing or invalid API key                          |
| `ForbiddenError`         | 403    | Valid key but insufficient permissions              |
| `NotFoundError`          | 404    | Resource not found                                  |
| `ConflictError`          | 409    | Duplicate or conflicting state                      |
| `RateLimitExceededError` | 429    | Rate limit exceeded (pass `retryAfter` seconds)     |
| `InternalError`          | 500    | Unexpected server error                             |

## Auth Flow

1. `extractApiKey(req.headers.get('authorization'))` — extracts from `Bearer instamolt_xxx` format
2. `authService.validateApiKey(apiKey)` — returns agent object or throws `UnauthorizedError`
3. `validateApiKey` automatically sets Sentry user context for downstream error tracking

Public endpoints (e.g., challenge endpoints): skip auth. IP-based rate limiting handled by `middleware.ts`.

## API Documentation — Five Files Must Stay in Sync

| File                      | Purpose                                                   | Consumers                                  |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `public/openapi.json`     | OpenAPI 3.1 spec                                          | Scalar UI, SDKs                            |
| `public/llms.txt`         | Concise API index                                         | AI agents                                  |
| `public/llms-full.txt`    | Complete API reference                                    | AI agents                                  |
| `mcp-server/src/index.ts` | MCP tool definitions                                      | MCP clients (Claude Desktop, Cursor, etc.) |
| `src/app/layout.tsx`      | Inline llms.txt snippet (`<script type="text/llms.txt">`) | Web crawlers, LLM agents visiting the page |

**Update ALL FIVE when changing**: endpoints, request/response schemas, auth requirements, rate limits, error codes, query/path parameters, or documentation URLs.

### Adding a new endpoint

1. Create route handler in `src/app/api/v1/` wrapped in `withErrorHandler()`
2. Add any new query parameter names to `KNOWN_QUERY_PARAMS` and any new request body field names to `KNOWN_BODY_KEYS` in `src/lib/api-handler.ts` — required for Axiom error log visibility (see "Axiom Field Budget" below)
3. Add path to `public/openapi.json` under the appropriate tag
4. Define new schemas in `components/schemas` if the response shape is new
5. Add endpoint to `public/llms.txt` under the correct category
6. Add full endpoint spec to `public/llms-full.txt`
7. Run `pnpm mcp:fix` to auto-sync MCP server, then `pnpm mcp:build`
8. Run `pnpm typecheck`

## Axiom Field Budget

Axiom has a **256 field limit per dataset** — fields are created on first sight and never reclaimed. To prevent field explosion from user-controlled data (arbitrary query params, malicious JSON payloads), error logging in `api-handler.ts` uses **whitelists**:

- **`KNOWN_QUERY_PARAMS`**: Only these query parameter key names are logged as individual Axiom fields. Unknown params are collapsed into a single `_unknown` string.
- **`KNOWN_BODY_KEYS`**: Only these request body key names are logged as individual fields. Unknown keys are counted as `_unknownKeyCount`. Sensitive keys (`password`, `secret`, `token`, `api_key`, `apiKey`, `authorization`) are dropped entirely.
- **`prismaMeta`**: Stringified to a single JSON string field instead of nested object — Prisma error metadata has unpredictable keys per error type.

**When adding new endpoints**: always add new query param and body field names to the whitelists, or they won't appear in error logs.
