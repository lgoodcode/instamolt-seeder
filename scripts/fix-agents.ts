/**
 * Scans output/agents/ and fixes:
 *   1. Duplicate agentnames — appends a random 2-digit suffix
 *   2. Empty agentnames — generates a stub from the personaId + digits
 *   3. Short bios (< 3 words) — takes first sentence of persona personality
 *
 * Also updates agents.json master index to match.
 *
 * Usage: pnpm tsx scripts/fix-agents.ts
 */

import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to the script file so this works from any CWD
// (e.g. `tsx scripts/fix-agents.ts` run from a subdir).
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_DIR = join(REPO_ROOT, 'output', 'agents');
const INDEX_PATH = join(REPO_ROOT, 'output', 'agents.json');

// Minimal persona loader — reads the runtime-installed personas in
// `output/personas/*.json`. Only `personality` is used (for short-bio
// fallback); empty-name fallback uses the personaId itself as the stub seed.
async function loadPersonaMap(): Promise<Map<string, { personality: string }>> {
  const personasDir = join(REPO_ROOT, 'output', 'personas');
  const map = new Map<string, { personality: string }>();
  let files: string[];
  try {
    files = await readdir(personasDir);
  } catch {
    return map;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(personasDir, file), 'utf-8');
      const p = JSON.parse(raw);
      if (p?.id) map.set(p.id, { personality: p.personality ?? '' });
    } catch {}
  }
  return map;
}

interface AgentJson {
  agentname: string;
  personaId: string;
  bio: string;
  avatarPrompt: string;
  apiKey?: string;
  registeredAt?: string;
}

function randomDigits(): string {
  return String(Math.floor(Math.random() * 90) + 10); // 10-99
}

function generateStubName(seed: string): string {
  // Strip non-alphanumeric, ensure 5-15 chars. Seed is normally the personaId,
  // which gives a deterministic, persona-tied stub the operator can rename.
  const base = (seed || 'agent').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'agent';
  return (base.slice(0, 13) + randomDigits()).slice(0, 15);
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  return (match ? match[0] : text).trim().slice(0, 150);
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const personas = await loadPersonaMap();

  // Read all agent directories
  let dirs: string[];
  try {
    dirs = await readdir(AGENTS_DIR);
  } catch {
    console.log('No output/agents/ directory found. Nothing to fix.');
    return;
  }

  // Load all agent.json files
  const agents: Array<{ dir: string; path: string; data: AgentJson }> = [];
  for (const dir of dirs) {
    const agentJsonPath = join(AGENTS_DIR, dir, 'agent.json');
    try {
      const raw = await readFile(agentJsonPath, 'utf-8');
      agents.push({ dir, path: agentJsonPath, data: JSON.parse(raw) });
    } catch {}
  }

  console.log(`Found ${agents.length} agents to scan.\n`);

  const usedNames = new Set<string>();
  let fixedDuplicates = 0;
  let fixedEmpty = 0;
  let fixedBios = 0;
  const renames: Array<{ oldDir: string; newDir: string }> = [];

  // --- Pass 1: Fix empty names ---
  for (const agent of agents) {
    if (!agent.data.agentname || agent.data.agentname.trim().length === 0) {
      let newName: string;
      do {
        newName = generateStubName(agent.data.personaId);
      } while (usedNames.has(newName));

      console.log(`EMPTY NAME: folder "${agent.dir}" -> "${newName}"`);
      agent.data.agentname = newName;
      fixedEmpty++;

      if (agent.dir !== newName) {
        renames.push({ oldDir: agent.dir, newDir: newName });
        agent.dir = newName;
      }
    }
    usedNames.add(agent.data.agentname);
  }

  // --- Pass 2: Fix duplicates ---
  // Reset and re-scan since pass 1 may have added names
  const nameCounts = new Map<string, typeof agents>();
  for (const agent of agents) {
    const arr = nameCounts.get(agent.data.agentname) ?? [];
    arr.push(agent);
    nameCounts.set(agent.data.agentname, arr);
  }

  const finalNames = new Set<string>();
  for (const [name, group] of nameCounts) {
    if (group.length <= 1) {
      finalNames.add(name);
      continue;
    }

    // Keep the first one, rename the rest
    finalNames.add(group[0].data.agentname);
    for (let i = 1; i < group.length; i++) {
      const agent = group[i];
      let newName: string;
      do {
        newName = name.slice(0, 18) + randomDigits();
      } while (finalNames.has(newName));

      console.log(`DUPLICATE: "${name}" (folder "${agent.dir}") -> "${newName}"`);
      finalNames.add(newName);
      agent.data.agentname = newName;
      fixedDuplicates++;

      if (agent.dir !== newName) {
        renames.push({ oldDir: agent.dir, newDir: newName });
        agent.dir = newName;
      }
    }
  }

  // --- Pass 3: Fix short bios ---
  for (const agent of agents) {
    if (wordCount(agent.data.bio) < 3) {
      const persona = personas.get(agent.data.personaId);
      const newBio = persona
        ? firstSentence(persona.personality)
        : 'An AI agent exploring the digital world.';
      console.log(`SHORT BIO: @${agent.data.agentname} "${agent.data.bio}" -> "${newBio}"`);
      agent.data.bio = newBio;
      fixedBios++;
    }
  }

  // --- Apply renames and write files ---
  for (const { oldDir, newDir } of renames) {
    const oldPath = join(AGENTS_DIR, oldDir);
    const newPath = join(AGENTS_DIR, newDir);
    if ((await dirExists(oldPath)) && oldPath !== newPath) {
      await rename(oldPath, newPath);
    }
  }

  // Write updated agent.json files
  for (const agent of agents) {
    const agentJsonPath = join(AGENTS_DIR, agent.dir, 'agent.json');
    await writeFile(agentJsonPath, JSON.stringify(agent.data, null, 2));
  }

  // --- Update master index ---
  try {
    const raw = await readFile(INDEX_PATH, 'utf-8');
    const index = JSON.parse(raw);
    index.agents = agents.map((a) => a.data);
    index.totalAgents = agents.length;
    await writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
    console.log(`\nUpdated ${INDEX_PATH}`);
  } catch {
    console.log(`\nWarning: Could not update ${INDEX_PATH}`);
  }

  console.log(
    `\nDone. Fixed ${fixedEmpty} empty names, ${fixedDuplicates} duplicates, ${fixedBios} short bios.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
