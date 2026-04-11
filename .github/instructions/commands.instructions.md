---
applyTo:
  - "src/commands/**/*.ts"
---

# Command File Rules

## Terminal Output

Terminal output goes through `@/lib/ui` — prefer `ui.intro`, `ui.section`, `ui.note`, `ui.spinner`, `ui.progress` over raw `console.log`. Exceptions: `status.ts` renders the `cli-table3` table via `console.log(table.toString())` and `preview-comments.ts` prints multi-line agent output directly — both are acceptable because those outputs can't flow through `ui.note()`. The structured `log()` from `@/lib/logger` is used in commands only for `log('info', ...)` / `log('success', ...)` / `log('warn', ...)` one-liner events (e.g., per-agent completion, warnings). Spinners and progress bars are for long-running work; `log()` is for individual status lines.

### Standard command structure:

```typescript
ui.intro('Command Name');

// ... work ...

ui.note('Summary title', summaryBody);
ui.outro(ui.color.green(`${ui.symbol.ok} command done`));
```

### Which UI primitive to use:

| Situation | Primitive |
|-----------|-----------|
| Long-running single operation (registration, Gemini call) | `ui.spinner()` — `.start()`, `.message()`, `.stop()` |
| Counted operations (N posts, N agents) | `ui.progress(total)` — `.tick(label)`, `.done()` |
| Phase boundary within a command | `ui.section('Phase title')` |
| End-of-command totals | `ui.note(title, body)` with `ui.summaryLine([...])` |
| Inter-agent / inter-cycle waits | TTY: live countdown via `ui.spinner()` ticking every second. Non-TTY: single `log('info', ...)` line. |

## Idempotency

Commands are designed to be re-run safely:

- `generate` — skips persona allocations whose count is already met
- `publish` — `apiKey` present in `agent.json` = skip registration; `published: true` in post JSON = skip posting
- `engage` — stateless per cycle (except `lastCommentedAt` persisted for cooldown)
- `seed-personas` — skips existing persona ids unless `--force`

When adding new state, preserve this pattern: check for the presence of a completion marker before doing work.

## SIGINT Handling

The `engage --loop` mode is the only sanctioned long-running process. It uses a `stopRequested` flag set by a `process.on('SIGINT', ...)` handler. The current cycle runs to completion, then the loop exits cleanly. Do not add new long-running modes without the same pattern.

## Error Reporting

- Use `ui.spinner().stop(message, 1)` for failed operations (renders a red cross in clack)
- Log individual item failures and continue — don't abort the entire command on one bad agent/post
- Track error counts and report them in the final `ui.note()` summary
