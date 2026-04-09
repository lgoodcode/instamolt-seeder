---
name: rebase-conflict-resolution
description: Rebase and merge conflict resolution — systematic workflow for reconciling large feature branches, confidence scoring, conflict categorization, cross-PR integration issues, post-rebase verification, and audit documentation. Load when rebasing, merging branches, or resolving git conflicts between large feature PRs.
---

# Rebase & Merge Conflict Resolution

Systematic workflow for rebasing or merging feature branches that overlap with recently merged PRs. Designed for large feature-vs-feature reconciliation where both PRs modify shared infrastructure (types, constants, services, documentation).

## Pre-Rebase Checklist

Before starting the rebase/merge:

1. **Review both PRs** — `gh pr view <number>` for each. Understand the scope, what each PR added/deleted/renamed
2. **Identify overlapping files** — `git diff --name-only base..branch1` vs `git diff --name-only base..branch2`. Files appearing in both lists are conflict candidates
3. **Map deleted/renamed modules** — If PR A deleted `media-client.ts` or renamed `createPost` → `finalizePost`, PR B's references to the old names will break after merge even if they don't conflict
4. **Check type system additions** — Look for new `const ... as const` objects (create union types), new enums, new type unions. PR B may use values that don't exist in PR A's new type
5. **Check test mocks for shared modules** — If PR A introduces a new enum (e.g., `LogCategory`) or const object (e.g., `SERVICE`), PR B's test files that mock these modules will have stale keys

## Conflict Categories

### UU — Both Modified

Most common. Both PRs changed the same file at the same location.

**Resolution strategy**: Choose one PR as the base version, apply the other's additions on top.

- For source code: pick the architecturally dominant change as base
- For documentation/JSON: merge both additions (interleave content from both PRs)
- For config files: usually straightforward value merge

### DU/UD — Delete vs Modify

One PR deleted a file, the other modified it. Git leaves the modified version in the tree.

**Resolution strategy**: If deletion is architectural (module moved to a different service, route superseded by new architecture), accept deletion with `git rm`. **This will recur** across multiple commits in a rebase — apply the same resolution every time.

### Dropped Commits

Git automatically drops commits whose patch is already upstream: `dropping <hash> -- patch contents already upstream`. This is expected and safe — the changes were already applied by the merged PR.

### Empty After Resolution

When accepting one side makes the commit produce no diff (e.g., only change was to a file where you kept HEAD's version). Git drops it. Document as "dropped (empty after resolution)".

## Confidence Scoring

Rate each conflict resolution by confidence level:

### 85+ — Resolve Autonomously

- DU where deletion is architectural (module moved to another service)
- Version bumps in `package.json`
- Documentation header conflicts with clear newer date/version
- Recurring DU conflicts (same file, same resolution as earlier commit)
- Adding both PRs' additions to a list/object at different positions

### 60–84 — Resolve but Flag for Review

- Auto-merged service files where both PRs touched different queries in the same function
- JSON spec merges with many conflict markers (e.g., `openapi.json` with 9 markers)
- Documentation where both PRs added content to the same section
- Config files with overlapping but non-contradictory changes

### Below 60 — Stop and Ask

- Both PRs rewrote the same function with different logic
- Business logic conflicts (e.g., different validation rules for the same field)
- Database schema conflicts (different migrations touching the same table)
- Unclear which PR's approach is architecturally correct

## Common Cross-PR Integration Issues

These are NOT git conflicts — they break silently after the rebase and only surface during verification.

### Type Gaps

**Symptom**: TypeScript error — value not assignable to union type.
**Cause**: PR A adds `const SERVICE = { ... } as const` creating `type ServiceName = ...`. PR B uses service names (e.g., `'cron'`, `'relinquish'`) that aren't in the const.
**Fix**: Add PR B's values to PR A's const object.

### Test Mock Drift

**Symptom**: Tests fail — `expected "vi.fn()" to be called with arguments: ['category_name', ...]` but received `[undefined, ...]`.
**Cause**: PR A introduces an enum (e.g., `LogCategory.FLEET_DETECTED = 'fleet.detected'`). PR B's tests mock the module with old keys (e.g., `LogCategory: { RATE_LIMIT_HIT: 'rate_limit_hit' }`). The service uses `LogCategory.FLEET_DETECTED` but the mock doesn't define it, so it resolves to `undefined`.
**Fix**: Update mock to use correct enum keys and values. Update test expectations to match new category strings.

### Import Drift

**Symptom**: TypeScript error — module not found.
**Cause**: PR A deletes or renames a module. PR B imports the old name.
**Fix**: Update imports to new module path, or delete the file if the module's functionality moved elsewhere.

### Shared Package Sync

**Symptom**: TypeScript error in downstream packages after fixing type gaps.
**Fix**: Run `pnpm build:shared` after modifying `packages/shared/` to rebuild the dist output that consumers import.

## Post-Rebase Verification

Run after every rebase, in this order:

```bash
# 1. Clear stale caches
rm -rf .next/types

# 2. Rebuild shared package (type gaps may have been fixed there)
pnpm build:shared

# 3. TypeScript — catches missing imports, wrong types, stale references
pnpm typecheck

# 4. Full test suite — catches test mock drift, assertion mismatches
npx vitest run

# 5. Scan for leftover conflict markers
grep -rl '<<<<<<< ' . --include='*.ts' --include='*.json' --include='*.md' --include='*.txt'
```

### Additional Grep Checks

After resolving conflicts involving deleted/renamed modules:

```bash
# Check for imports of deleted modules
grep -r '@/infrastructure/media-client' src/ --include='*.ts'

# Check for old function names
grep -r 'import.*createPost' src/ --include='*.ts'

# Check for old enum/const values in test mocks
grep -r "RATE_LIMIT_HIT\|old_category_name" src/ --include='*.test.ts'
```

## Audit Documentation

For complex rebases (3+ conflicts), create a `.rebase/` directory to track all resolutions:

```
.rebase/
├── SUMMARY.md                              # Overview table, conflict summary, final verification
├── 01-{hash}-{message}/
│   ├── summary.md                          # Conflict table, auto-merged files, confidence scores
│   └── conflicts.md                        # Conflict markers, resolution diffs, rationale
├── 02-{hash}-{message}/
│   └── summary.md                          # "No conflicts — clean apply" for clean commits
├── ...
└── post-rebase-fixes.md                    # Type gaps, test mock fixes applied after rebase
```

### Summary Template

```markdown
# Commit N/Total: {hash} — {message}

## Conflicts (N files)

| File              | Type | Resolution                | Confidence |
| ----------------- | ---- | ------------------------- | ---------- |
| `path/to/file.ts` | UU   | Description of resolution | 95         |

## Auto-Merged Files (verified correct)

| File              | PR A Change | PR B Change | Status |
| ----------------- | ----------- | ----------- | ------ |
| `path/to/file.ts` | Description | Description | OK     |

## Verification

- **Typecheck:** PASS/FAIL
- **Tests:** N/N PASS
```

## Real-World Example: PR #50 (Media Server) × PR #51 (Agent Lifecycle)

This skill was created from an actual rebase of 13 commits with these outcomes:

| Category              | Count | Details                                                                |
| --------------------- | ----- | ---------------------------------------------------------------------- |
| UU conflicts          | 5     | posts route, CLAUDE.md, openapi.json, llms-full.txt, add-moderation.md |
| DU conflicts          | 3     | avatar route (same file, 3 commits — recurring)                        |
| Dropped commits       | 2     | 1 already upstream, 1 empty after resolution                           |
| Type gaps fixed       | 1     | `SERVICE` const missing `CRON` and `RELINQUISH`                        |
| Test mock drift fixed | 2     | `LogCategory` mock in fleet-detection + relinquish tests               |
| Clean commits         | 6     | No intervention needed                                                 |

Key lesson: the 3 test failures were **not** git conflicts — they only appeared during post-rebase `npx vitest run`. Without the verification checklist, they would have been pushed to CI.
