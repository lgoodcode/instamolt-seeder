/**
 * Bulk-regenerate agentnames for the unpublished portion of the local agent
 * pool using the current `voiceProfile.usernameStyle` generator. Designed
 * for the moment after a voice-profile-catalog change when you want every
 * unpublished draft's handle to reflect the new style without losing its
 * already-baked bio, posts, and comment samples.
 *
 * Why "unpublished only": agents with an `apiKey` field are registered on
 * instamolt.app and have followers / posts / engagement tied to their
 * current handle. The platform exposes no rename endpoint, so renaming
 * them locally would desync from prod. To re-handle a published agent,
 * use `pnpm reset --agent <name>` (loses platform identity) and republish.
 *
 * Compared to `pnpm reset --agent <name> && pnpm generate`, this script:
 *   - keeps every agent's existing personaId, voiceProfileId, bio, posts,
 *     and comment samples intact — only the agentname changes
 *   - operates in bulk across all unpublished agents in one pass
 *   - does NOT call Gemini for bios or posts (cheap)
 *
 * Two-phase, dry-run by default:
 *
 *   pnpm rename-drafts                # dry-run (no writes)
 *   pnpm rename-drafts --apply        # mutate disk
 *   pnpm rename-drafts --apply --limit 10
 *
 * The dry-run is non-destructive but DOES call Gemini once per agent and
 * probes the platform with `isAgentnameAvailable` for each candidate, so
 * it incurs LLM + network cost. Use --limit during initial validation.
 *
 * Required env: `GEMINI_API_KEY`, `RATE_LIMIT_BYPASS_SECRET`,
 * `INSTAMOLT_API_URL` (must point at the same platform as your published
 * agents — defaults to `http://localhost:3000/api/v1`, which will fail
 * with "fetch failed" if no local platform is running).
 *
 * Per-rename, the script atomically renames the agent dir and patches:
 *   - agent.json `agentname` field
 *   - comments.json + runtime-comments.json (top-level `agentname` field, if present)
 *   - output/agents.json master index entry
 *   - output/dedup-index.json persona bucket entry
 * activity.jsonl is left as-is (append-only history).
 *
 * Recovery note: each rename does `rename(oldDir → newDir)` and THEN patches
 * the moved files. A crash between the two leaves `newName/agent.json` still
 * containing `oldName`, and the top-level indices may be partially updated
 * on the next run. If that happens, run `scripts/fix-agents.ts` and re-run
 * this script; the probe-first flow will no-op on already-renamed agents.
 * Fully transactional rename (journal + resume) is tracked as a follow-up.
 *
 * Operator-facing entry point: the "Handles all read like generic AI
 * compound words" row in docs/SEEDING.md's "Iteration moves" table.
 */

import 'dotenv/config';
import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '@/config';
import { pickDiverseAndRecent } from '@/lib/similarity';
import { loadPersonas } from '@/personas';
import { InstaMoltClient } from '@/services/instamolt-api';
import { generateAgentName } from '@/services/llm';
import type { Persona, VoiceProfile } from '@/types';
import { loadVoiceProfiles } from '@/voice-profiles';

// Resolve the top-level indices relative to the script file so this works
// from any CWD (matches scripts/fix-agents.ts). The agents dir itself comes
// from `config.agentsDir` because callers can override it via env.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_INDEX_PATH = join(REPO_ROOT, 'output', 'agents.json');
const DEDUP_INDEX_PATH = join(REPO_ROOT, 'output', 'dedup-index.json');

const MAX_AGENTNAME_ATTEMPTS = 8;
const AGENTNAME_PROMPT_SAMPLE_K = 20;

interface AgentOnDisk {
  agentname: string;
  personaId: string;
  voiceProfileId: string;
  bio: string;
  apiKey?: string;
}

interface Proposal {
  oldName: string;
  newName: string;
  personaId: string;
  voiceProfileId: string;
  bioPreview: string;
}

interface FailedProposal {
  oldName: string;
  personaId: string;
  voiceProfileId?: string;
  error: string;
}

interface CliFlags {
  apply: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { apply: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--limit') {
      const next = argv[++i];
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0)
        throw new Error(`--limit needs a positive integer, got "${next}"`);
      flags.limit = Math.floor(n);
    } else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadAgentsFromDisk(): Promise<{
  published: AgentOnDisk[];
  unpublished: AgentOnDisk[];
}> {
  const dirs = await readdir(config.agentsDir);
  const published: AgentOnDisk[] = [];
  const unpublished: AgentOnDisk[] = [];
  for (const dir of dirs) {
    const path = join(config.agentsDir, dir, 'agent.json');
    try {
      const raw = await readFile(path, 'utf-8');
      const a = JSON.parse(raw) as AgentOnDisk;
      if (a.apiKey) published.push(a);
      else unpublished.push(a);
    } catch {
      // not a valid agent dir, skip
    }
  }
  return { published, unpublished };
}

async function proposeNewName(
  persona: Persona,
  voiceProfile: VoiceProfile,
  taken: Set<string>,
  client: InstaMoltClient,
): Promise<string> {
  const rejected: string[] = [];
  for (let attempt = 0; attempt < MAX_AGENTNAME_ATTEMPTS; attempt++) {
    // Bound the avoid-list so prompt size stays flat as the agent pool grows.
    // The real uniqueness gates are the local `taken.has(candidate)` check
    // and the platform `isAgentnameAvailable` probe below; the prompt sample
    // just nudges Gemini toward fresh word roots.
    const existing = pickDiverseAndRecent(Array.from(taken), (n) => n, AGENTNAME_PROMPT_SAMPLE_K);
    const candidate = await generateAgentName(persona, voiceProfile, existing, rejected);
    if (!candidate || candidate.length < 3) {
      rejected.push(candidate || '<empty>');
      continue;
    }
    if (taken.has(candidate)) {
      rejected.push(candidate);
      continue;
    }
    let available: boolean;
    try {
      available = await client.isAgentnameAvailable(candidate);
    } catch {
      // Treat probe failures as "taken" — defensive; keeps the run progressing.
      available = false;
    }
    if (!available) {
      rejected.push(candidate);
      taken.add(candidate);
      continue;
    }
    return candidate;
  }
  throw new Error(
    `exhausted ${MAX_AGENTNAME_ATTEMPTS} attempts (rejected: ${rejected.join(', ')})`,
  );
}

async function patchJsonField(
  path: string,
  field: string,
  oldVal: string,
  newVal: string,
): Promise<void> {
  if (!(await fileExists(path))) return;
  const raw = await readFile(path, 'utf-8');
  const obj = JSON.parse(raw) as Record<string, unknown>;
  if (obj[field] === oldVal) {
    obj[field] = newVal;
    await writeFile(path, JSON.stringify(obj, null, 2));
  }
}

async function applyRename(
  proposal: Proposal,
  agentsIndex: {
    agents: AgentOnDisk[];
    totalAgents: number;
    generatedAt?: string;
    totalPosts?: number;
  },
  dedupIndex: {
    personas: Record<
      string,
      { agents: Array<{ agentname: string; bio: string; bioEmbedding: unknown; posts: unknown[] }> }
    >;
  },
): Promise<void> {
  const { oldName, newName, personaId } = proposal;
  const oldDir = join(config.agentsDir, oldName);
  const newDir = join(config.agentsDir, newName);

  if (await fileExists(newDir)) {
    throw new Error(`target dir ${newDir} already exists`);
  }

  // Atomic dir rename first — single-fs `rename` is the safest primitive.
  await rename(oldDir, newDir);

  // Patch per-agent files in the new dir.
  await patchJsonField(join(newDir, 'agent.json'), 'agentname', oldName, newName);
  await patchJsonField(join(newDir, 'comments.json'), 'agentname', oldName, newName);
  await patchJsonField(join(newDir, 'runtime-comments.json'), 'agentname', oldName, newName);

  // Update in-memory copies of the top-level indices; written to disk by caller.
  for (const a of agentsIndex.agents) {
    if (a.agentname === oldName) a.agentname = newName;
  }
  const personaBucket = dedupIndex.personas[personaId];
  if (personaBucket) {
    for (const a of personaBucket.agents) {
      if (a.agentname === oldName) a.agentname = newName;
    }
  }
}

function summary(label: string, items: Proposal[]): void {
  if (items.length === 0) return;
  const grouped = new Map<string, Proposal[]>();
  for (const p of items) {
    const arr = grouped.get(p.personaId) ?? [];
    arr.push(p);
    grouped.set(p.personaId, arr);
  }
  console.log(`\n${label}:`);
  for (const [persona, group] of grouped) {
    console.log(`  ${persona}:`);
    for (const p of group) {
      const bio = p.bioPreview.length > 60 ? `${p.bioPreview.slice(0, 57)}…` : p.bioPreview;
      console.log(
        `    ${p.oldName.padEnd(22)} → ${p.newName.padEnd(22)} [${p.voiceProfileId}] "${bio}"`,
      );
    }
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  console.log(`Mode: ${flags.apply ? 'APPLY (will mutate disk)' : 'dry-run (no writes)'}`);
  if (flags.limit !== null) console.log(`Limit: ${flags.limit}`);

  const { published, unpublished } = await loadAgentsFromDisk();
  console.log(
    `\nDiscovered ${published.length + unpublished.length} agents (${published.length} published, ${unpublished.length} unpublished).`,
  );

  let targets = unpublished;
  if (flags.limit !== null) targets = targets.slice(0, flags.limit);

  const personas = await loadPersonas();
  const voiceProfiles = loadVoiceProfiles();
  const client = new InstaMoltClient();

  // Universe of names that must NOT collide with the new picks.
  const taken = new Set<string>([
    ...published.map((a) => a.agentname),
    ...unpublished.map((a) => a.agentname),
  ]);

  const proposals: Proposal[] = [];
  const failures: FailedProposal[] = [];

  console.log(
    `\nGenerating proposals for ${targets.length} agents (this calls Gemini + the platform per agent)...`,
  );
  for (let i = 0; i < targets.length; i++) {
    const agent = targets[i];
    const persona = personas.get(agent.personaId);
    const voiceProfile = voiceProfiles.get(agent.voiceProfileId);
    if (!persona) {
      failures.push({
        oldName: agent.agentname,
        personaId: agent.personaId,
        voiceProfileId: agent.voiceProfileId,
        error: `unknown personaId: ${agent.personaId}`,
      });
      continue;
    }
    if (!voiceProfile) {
      failures.push({
        oldName: agent.agentname,
        personaId: agent.personaId,
        voiceProfileId: agent.voiceProfileId,
        error: `unknown voiceProfileId: ${agent.voiceProfileId}`,
      });
      continue;
    }
    process.stdout.write(
      `  [${i + 1}/${targets.length}] @${agent.agentname} (${agent.personaId} / ${agent.voiceProfileId})... `,
    );
    try {
      const newName = await proposeNewName(persona, voiceProfile, taken, client);
      // Reserve the new name + drop the old one so peers don't collide.
      taken.add(newName);
      taken.delete(agent.agentname);
      proposals.push({
        oldName: agent.agentname,
        newName,
        personaId: agent.personaId,
        voiceProfileId: agent.voiceProfileId,
        bioPreview: agent.bio ?? '',
      });
      console.log(`→ @${newName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({
        oldName: agent.agentname,
        personaId: agent.personaId,
        voiceProfileId: agent.voiceProfileId,
        error: msg,
      });
      console.log(`FAIL (${msg})`);
    }
  }

  summary('Proposed renames', proposals);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  @${f.oldName} (${f.personaId}/${f.voiceProfileId ?? '?'}) — ${f.error}`);
    }
  }

  console.log(
    `\nSummary: proposed=${proposals.length}, failed=${failures.length}, would-skip-published=${published.length}`,
  );

  if (!flags.apply) {
    console.log('\nDry-run complete. Re-run with --apply to mutate disk.');
    return;
  }

  console.log('\nApplying renames...');
  const agentsIndexRaw = await readFile(AGENTS_INDEX_PATH, 'utf-8');
  const agentsIndex = JSON.parse(agentsIndexRaw);
  const dedupIndexRaw = await readFile(DEDUP_INDEX_PATH, 'utf-8');
  const dedupIndex = JSON.parse(dedupIndexRaw);

  let applied = 0;
  const applyFailures: Array<{ oldName: string; error: string }> = [];
  for (const p of proposals) {
    try {
      await applyRename(p, agentsIndex, dedupIndex);
      applied++;
      console.log(`  ✓ ${p.oldName} → ${p.newName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      applyFailures.push({ oldName: p.oldName, error: msg });
      console.log(`  ✗ ${p.oldName} → ${p.newName} — ${msg}`);
    }
  }

  // Refresh the bookkeeping fields and write indices back.
  agentsIndex.generatedAt = new Date().toISOString();
  dedupIndex.updatedAt = new Date().toISOString();
  await writeFile(AGENTS_INDEX_PATH, JSON.stringify(agentsIndex, null, 2));
  await writeFile(DEDUP_INDEX_PATH, JSON.stringify(dedupIndex, null, 2));

  console.log(
    `\nDone. Applied ${applied}/${proposals.length} renames; ${applyFailures.length} failed at apply time.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
