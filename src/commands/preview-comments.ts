import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import {
  bakeAgentComments,
  buildCaptionsPoolFromDisk,
  pickPeerCaptions,
  type SampleCaption,
} from '@/lib/comment-samples';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { InstaMoltClient } from '@/services/instamolt-api';
import type { GeneratedAgent } from '@/types';

export interface PreviewCommentsOptions {
  /** Limit to one persona by id. */
  persona?: string;
  /** Limit to one agent by name. */
  agent?: string;
  /** How many sample comments to generate per agent. Default 3. */
  count?: number;
  /**
   * Pull captions from the live explore feed instead of from synthetic
   * on-disk post drafts. Requires at least one registered agent (its
   * apiKey is passed to `InstaMoltClient` but explore is unauthenticated
   * — the key is not sent). Honest input distribution but slower and
   * online-only.
   */
  fromFeed?: boolean;
}

const DEFAULT_COUNT = 3;
const MAX_AGENTS_PREVIEWED = 12;

/**
 * Read-only command. Generates `count` sample comments per agent against
 * either synthetic peer captions (default) or live explore-feed captions
 * (`--from-feed`), and prints the result to the terminal grouped by agent.
 *
 * Writes nothing to disk. Safe to spam during persona/prompt curation.
 */
export async function previewComments(options: PreviewCommentsOptions = {}): Promise<void> {
  const count = options.count ?? DEFAULT_COUNT;

  ui.intro('Preview comments');

  // 1. Load personas (do not auto-seed — preview is an iteration tool, not
  //    a setup step; if no personas exist, fail loudly).
  const personas = await loadPersonas({ autoSeed: false }).catch((err) => {
    log('error', `${err}`);
    return null;
  });
  if (!personas || personas.size === 0) {
    ui.outro(ui.color.red(`${ui.symbol.err} preview-comments aborted (no personas)`));
    return;
  }

  // 2. Load agents from agents.json (or fall back to walking the agents dir).
  let allAgents: GeneratedAgent[];
  try {
    allAgents = await loadAllAgents();
  } catch (err) {
    log('error', `Failed to load agents: ${err}`);
    ui.outro(ui.color.red(`${ui.symbol.err} preview-comments aborted (no agents)`));
    return;
  }

  if (allAgents.length === 0) {
    ui.note('No agents found', 'Run `npm run generate` first.');
    ui.outro(ui.color.yellow(`${ui.symbol.warn} nothing to preview`));
    return;
  }

  // 3. Apply filters.
  let selected = allAgents;
  if (options.agent) {
    selected = selected.filter((a) => a.agentname === options.agent);
    if (selected.length === 0) {
      log('error', `Agent @${options.agent} not found`);
      ui.outro(ui.color.red(`${ui.symbol.err} preview-comments aborted`));
      return;
    }
  }
  if (options.persona) {
    selected = selected.filter((a) => a.personaId === options.persona);
    if (selected.length === 0) {
      log('error', `No agents in persona ${options.persona}`);
      ui.outro(ui.color.red(`${ui.symbol.err} preview-comments aborted`));
      return;
    }
  }

  // Cap how many agents we preview in one run so the operator isn't waiting
  // 5 minutes for the entire population. Filtered explicitly above can still
  // exceed this — only the unfiltered "preview everyone" path is capped.
  if (!options.agent && !options.persona && selected.length > MAX_AGENTS_PREVIEWED) {
    log(
      'info',
      `Capping preview to ${MAX_AGENTS_PREVIEWED} of ${selected.length} agents (use --persona or --agent to target).`,
    );
    selected = shuffle(selected).slice(0, MAX_AGENTS_PREVIEWED);
  }

  // 4. Build the captions pool.
  ui.section(
    options.fromFeed
      ? 'Captions — pulling from live explore feed'
      : 'Captions — sampling from on-disk post drafts',
  );

  const captionsPool = options.fromFeed
    ? await buildCaptionsPoolFromFeed(allAgents)
    : await buildCaptionsPoolFromDisk(allAgents);

  if (captionsPool.length < 2) {
    log(
      'warn',
      'Captions pool too small (need at least 2). Run `generate` first or pass --from-feed.',
    );
    ui.outro(ui.color.yellow(`${ui.symbol.warn} preview-comments aborted`));
    return;
  }

  log('info', `Captions pool: ${captionsPool.length} captions across ${selected.length} agents`);

  // 5. Generate + print samples per agent.
  ui.section(`Generating ${count} sample comments per agent`);

  for (const agent of selected) {
    const persona = personas.get(agent.personaId);
    if (!persona) {
      log('warn', `Skipping @${agent.agentname} — persona ${agent.personaId} not loaded`);
      continue;
    }

    const sources = pickPeerCaptions(captionsPool, agent.agentname, count);
    if (sources.length === 0) {
      log('warn', `Skipping @${agent.agentname} — no peer captions available`);
      continue;
    }

    const sp = ui.spinner();
    sp.start(`@${agent.agentname} (${persona.id}) — generating ${sources.length} comments`);

    try {
      const samples = await bakeAgentComments(persona, agent, sources);
      sp.stop(`@${agent.agentname} (${persona.id})`);

      // Render the bio + each sample inline so the operator can read voice
      // and reply side by side.
      console.log(`  ${ui.color.dim('bio:')} ${ui.color.cyan(agent.bio)}`);
      for (const s of samples) {
        const sourceLabel = `${ui.color.dim('on @')}${s.sourceAuthor}${ui.color.dim(':')} ${ui.color.dim(`"${truncate(s.sourceCaption, 80)}"`)}`;
        console.log(`  ${sourceLabel}`);
        console.log(`    ${ui.symbol.arrow} ${s.text}`);
      }
      console.log('');
    } catch (err) {
      sp.stop(`@${agent.agentname} — failed: ${err}`, 1);
    }
  }

  ui.outro(ui.color.green(`${ui.symbol.ok} preview-comments done`));
}

// --- Helpers ---

async function loadAllAgents(): Promise<GeneratedAgent[]> {
  // Prefer the master index. Fall back to walking the agents dir for
  // robustness against missing/corrupt index files (matches engage.ts's
  // resilient pattern).
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as { agents: GeneratedAgent[] };
    if (Array.isArray(parsed.agents) && parsed.agents.length > 0) return parsed.agents;
  } catch {}

  const agents: GeneratedAgent[] = [];
  try {
    const dirs = await readdir(config.agentsDir);
    for (const dir of dirs) {
      try {
        const raw = await readFile(join(config.agentsDir, dir, 'agent.json'), 'utf-8');
        agents.push(JSON.parse(raw) as GeneratedAgent);
      } catch {}
    }
  } catch {}
  return agents;
}

/**
 * Pull recent explore-feed captions to use as preview source. Honest input
 * distribution — the captions are real platform content, not synthetic.
 *
 * Uses the first registered agent's apiKey if available, but `getExplore`
 * is unauthenticated so this works even with no registered agents.
 */
async function buildCaptionsPoolFromFeed(allAgents: GeneratedAgent[]): Promise<SampleCaption[]> {
  const registered = allAgents.find((a) => a.apiKey);
  const client = new InstaMoltClient(registered?.apiKey);
  try {
    const feed = await client.getExplore(50);
    const pool: SampleCaption[] = [];
    for (const post of feed.posts ?? []) {
      if (post.caption && post.caption.trim().length > 0) {
        pool.push({
          author: post.agentname,
          caption: post.caption,
        });
      }
    }
    return pool;
  } catch (err) {
    log('error', `Failed to pull explore feed: ${err}`);
    return [];
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
