# Unpublished Agent Renaming

One-shot plan for regenerating agentnames on the unpublished portion of the local agent pool after the [agentname overhaul](../C:/Users/Lawrence/.claude/plans/happy-singing-meadow.md). Renaming is for unpublished drafts only — published agents are stuck with their existing handles because the platform has no rename endpoint, and renaming locally would desync from prod.

## Context

After the overhaul, [src/services/llm.ts](../src/services/llm.ts) `generateAgentName` consumes `voiceProfile.usernameStyle` (pattern + examples + per-profile guidance + `preserveCase`) and produces handles that span 17 distinct structural patterns instead of one generic concept-art compound. New agents created via `pnpm generate` already use the new generator. Existing agents on disk still carry the old names (`abyssloom`, `verdictanvil`, `gospelcircuit`, …).

Of the 203 agents on disk:

- **132 are published** — they have an `apiKey` field, are registered on instamolt.app, and have followers / posts / engagement history tied to their current handle. The platform exposes no rename endpoint. Renaming them locally would desync local state from the platform; replacing them would mean delete + re-register, losing identity. **Out of scope.**
- **71 are unpublished drafts** — no `apiKey`, no platform footprint. Safe to rename.

## Approach

A standalone repair script — `scripts/rename-unpublished-drafts.ts` — that mirrors the shape of [scripts/fix-agents.ts](../scripts/fix-agents.ts) (run via `pnpm tsx`). Two-phase, dry-run by default:

```bash
pnpm tsx scripts/rename-unpublished-drafts.ts            # dry-run (default)
pnpm tsx scripts/rename-unpublished-drafts.ts --apply    # actually rename
pnpm tsx scripts/rename-unpublished-drafts.ts --apply --limit 10   # bite-sized
```

The dry-run prints the full old → new mapping table grouped by persona (with bio previews) so the operator eyeballs proposals before any disk writes.

## Per-agent rename — what changes

For each old agentname `X` getting a new name `Y`:

| Path | Action |
|---|---|
| `output/agents/X/` | Atomic `rename` to `output/agents/Y/`. |
| `output/agents/Y/agent.json` | Patch `agentname` field. |
| `output/agents/Y/comments.json` (if present) | Patch top-level `agentname` field. Per-sample `sourceAuthor` / `parentAuthor` reference OTHER agents and stay. |
| `output/agents/Y/runtime-comments.json` (if present) | Same patch shape. Won't exist for unpublished agents (engage hasn't run on them) but defensively handled. |
| `output/agents/Y/activity.jsonl` | **Leave as-is.** Append-only event log — rewriting it would falsify the historical record. New events after the rename will tag the new name; older entries keep the old. |
| `output/agents.json` | Update the master index entry for this agent. |
| `output/dedup-index.json` | Update `personas[personaId].agents[*].agentname`. Bio + post embeddings stay valid (content-keyed, not name-keyed). |
| `output/agents/Y/post-NNN.json` | No change — post files have zero agentname references (verified). |

## Name generation

For each unpublished agent:

1. Load persona from `output/personas/<personaId>.json`.
2. Load voice profile via [`loadVoiceProfiles()`](../src/voice-profiles/index.ts).
3. Call [`generateAgentName(persona, voiceProfile, takenNames, rejectedThisRun)`](../src/services/llm.ts) — same retry loop as [src/commands/generate.ts](../src/commands/generate.ts), `MAX_AGENTNAME_ATTEMPTS = 8`.
4. `takenNames` is the union of:
   - All 203 current on-disk agentnames (so a new name doesn't collide with a published or with a peer also being renamed this run).
   - Every new name accepted earlier in this script run.
   - Any name returned `false` by `isAgentnameAvailable` on the platform (catches names taken by other seed runs).
5. Reject any candidate that is empty, `< 3` chars, in the union set, or fails `isAgentnameAvailable`. Accept the first that clears.
6. If 8 attempts exhaust for one agent, log a warning and skip it; the rest of the run continues.

The script imports the production generator and API client directly — `scripts/fix-agents.ts`'s no-`src/`-imports rule is for bare-bones recovery utilities; this script is closer to a real seeder phase and benefits from the same retry loop, sanitizer, and platform probe.

## Two-phase flow

### Phase 1 — Discover and propose (always runs)

1. Walk `output/agents/*/agent.json`. Partition into `published` (has `apiKey`) and `unpublished`.
2. Build `takenNames = Set(all 203 agentnames)`.
3. For each unpublished agent:
   - Load persona + voice profile.
   - Run the retry loop. Live platform probes happen here.
   - Record either `{ old, new, personaId, voiceProfileId, bioPreview }` on success or `{ old, error }` on failure.
4. Print:
   - Mapping table grouped by persona (`old → new`, with 60-char bio preview).
   - Summary line: `proposed: N, failed: M, would skip published: P`.

### Phase 2 — Apply (only with `--apply`)

For each successful proposal, in order:

1. Read `agent.json` + `comments.json` from the OLD dir into memory.
2. Patch the in-memory copies (`agentname` field).
3. Atomic `rename(oldDir, newDir)` via `node:fs/promises`.
4. Write the patched JSON files into the NEW dir.
5. Update the running in-memory copies of `agents.json` and `dedup-index.json`.

After all per-agent steps complete, write the updated `agents.json` and `dedup-index.json` back to disk in one shot.

## Crash safety

- The per-agent step is "rename + 2 small writes." If the script crashes between rename and write, `agent.json` on disk has the OLD name field while the directory has the new name — recoverable by re-running (dry-run will detect the mismatch and either fix it or skip with a warning).
- The two top-level indices are written last, so a crash mid-run leaves them describing the pre-rename world; the next dry-run shows what's drifted.
- Atomic `fs.rename` on the same filesystem is the safest primitive — no partial-state directory exists at any point.

## Edge cases

| Case | Handling |
|---|---|
| Agent's `personaId` no longer in `output/personas/` | Skip with warning (persona was deleted via `pnpm reset --persona`). Don't fabricate a fallback. |
| Agent's `voiceProfileId` not in the catalog | Skip with warning. Same reasoning. |
| `comments.json` missing or empty | Fine — only patch if present and has an `agentname` field. |
| Target directory already exists | Should be impossible given `takenNames`, but guard: skip with warning. |
| Platform probe fails (network) | Treat candidate as taken (defensive); retry loop moves on. |
| Platform probe rate | 71 × ~1 attempt ≈ 71 unauthenticated `GET /agents/{name}` calls. Below any limit; sequential is fine — no `mapWithConcurrency` needed. |

## Out of scope

- **Renaming published agents.** Platform has no rename endpoint. Delete-and-re-register would lose platform identity, follower graph, and post history.
- **Updating `activity.jsonl`.** Append-only history; rewriting it would falsify the record.
- **Updating `feed-cache.json`.** Cache of platform-side content; refreshes naturally on next engage cycle.
- **Touching post content.** Posts have no agentname references; image prompts and captions stay verbatim.
- **Re-rolling voice profile assignment.** The script keeps each agent's existing `personaId` + `voiceProfileId` and only regenerates the name from those.

## Verification

Default dry-run prints the proposed map and exits with code `0` — operator inspects it.

After `--apply`:

- `ls output/agents/` shows the new directory names.
- `jq '.agents[].agentname' output/agents.json` reflects the new names.
- `jq '.personas[].agents[].agentname' output/dedup-index.json` reflects the new names.
- `pnpm status` runs cleanly (per-persona breakdown still adds up to the same totals).
- Each renamed agent's `agent.json` shows the new name; `comments.json` (if present) shows the new name in its top-level field.
- All 132 published agents are untouched — `apiKey` still present, dir name unchanged, no entries flipped in either index.

## Files to create

- `scripts/rename-unpublished-drafts.ts` — the script.

## Files to update

- None permanent. This is a one-shot migration with no code or doc changes outside this file and the new script.
- (Optional) Add a one-line entry to [docs/SEEDING.md](./SEEDING.md) recovery table:
  > Rename unpublished drafts after a voice-profile change → `pnpm tsx scripts/rename-unpublished-drafts.ts`

  Worth doing only if we expect to re-run this pattern after future voice-profile changes.

## Open questions for the operator

1. **Run scope** — start with `--limit 10` to validate the dry-run output, then a full run? Or run a full dry-run straight away (still mutates nothing)?
2. **Persona-bound** — keep each agent's existing `personaId` + `voiceProfileId` (just regenerate the name)? The plan assumes yes; flag if you also want to re-roll the voice profile.
3. **SEEDING.md note** — add the one-line recovery entry, or treat this as a true one-off and skip the doc edit?
