---
applyTo:
  - "**/*.test.ts"
---

# Vitest Test Rules

## Required Pattern

Tests MUST follow this exact order:

```typescript
// 1. Vitest imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 2. Env stubs (if needed — before any module imports that read process.env)
vi.stubEnv('GEMINI_API_KEY', 'test-key');

// 3. vi.hoisted() — define mock state shared across mocks and tests
const mocks = vi.hoisted(() => ({
  spinnerMessages: [] as string[],
}));

// 4. vi.mock() — register module mocks (uses hoisted variables)
vi.mock('@/lib/ui', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  section: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    message: vi.fn((msg: string) => { mocks.spinnerMessages.push(msg); }),
    stop: vi.fn(),
  })),
  progress: vi.fn(() => ({ tick: vi.fn(), done: vi.fn() })),
  isInteractive: vi.fn(() => false),
  summaryLine: vi.fn(),
  color: {
    red: (s: string) => s, green: (s: string) => s,
    yellow: (s: string) => s, cyan: (s: string) => s,
    dim: (s: string) => s, bold: (s: string) => s,
  },
  symbol: { ok: '✓', err: '✗', warn: '!', arrow: '→' },
}));

vi.mock('@/services/llm', () => ({
  generateAgentName: vi.fn(async () => 'alpha'),
  generateBio: vi.fn(async () => 'A test bio for the agent.'),
}));

// 5. Imports that consume mocked modules
import { generate } from '@/commands/generate';

// 6. Clear mocks before each test
beforeEach(() => vi.clearAllMocks());

// 7. Tests
describe('generate', () => {
  it('should create agents for each persona allocation', async () => { ... });
  it('should skip personas that are already fully allocated', async () => { ... });
});
```

Vitest automatically hoists `vi.mock()` calls above all imports at runtime, so the module under test receives the mocked modules regardless of import order.

## What to Mock

- **Gemini API** — mock `@/services/llm` generators (they make real HTTP calls to Google)
- **InstaMolt REST API** — mock `@/services/instamolt-api` (`InstaMoltClient` methods)
- **MCP subprocess** — mock `@/services/instamolt-mcp` (`generatePost`, `AgentMcpClient`)
- **File system** — mock `node:fs/promises` (`readFile`, `writeFile`, `readdir`, `mkdir`) when testing state persistence
- **Terminal UI** — mock `@/lib/ui` as a no-op stub so spinners/progress bars don't pollute test output

## Rules

- Place test files in `tests/` in a directory layout that mirrors `src/` (e.g., `src/services/llm.ts` → `tests/services/llm.test.ts`)
- Never use `__tests__/` directory naming
- File name: `{module-name}.test.ts`
- Use the `@/*` path alias for imports from `src/`, not relative `../../src/...` paths
- Test error paths and edge cases, not just happy paths
- Mock external integrations — never hit real Gemini, InstaMolt, or the file system during tests
