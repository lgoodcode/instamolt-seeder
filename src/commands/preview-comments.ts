import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, FEED_CACHE_MAX_AGE_MS } from '@/config';
import {
  bakeAgentComments,
  bakeAgentReplies,
  buildCaptionsPoolFromFeedCache,
  computeSampleCounts,
  pickPeerCaptions,
  pickPostsWithComments,
  REPLY_COUNT_MIN,
} from '@/lib/comment-samples';
import { FeedCacheEmptyError, loadFeedCacheStrict } from '@/lib/feed-cache';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { InstaMoltClient } from '@/services/instamolt-api';
import type { GeneratedAgent } from '@/types';
import { loadVoiceProfiles } from '@/voice-profiles/index';

export interface PreviewCommentsOptions {
  /** Limit to one persona by id. */
  persona?: string;
  /** Limit to one agent by name. */
  agent?: string;
  /**
   * Explicit override for how many comment samples to generate per agent.
   * When omitted, counts are computed per-agent from persona chattiness +
   * voice verbosity via `computeSampleCounts`. Operators pass `--count` to
   * force a uniform count for targeted curation work.
   */
  count?: number;
}

const MAX_AGENTS_PREVIEWED = 12;

/**
 * Read-only command. Generates `count` sample comments per agent against
 * either synthetic peer captions (default) or live explore-feed captions
 * (`--from-feed`), and prints the result to the terminal grouped by agent.
 *
 * Writes nothing to disk. Safe to spam during persona/prompt curation.
 */
export async function previewComments(options: PreviewCommentsOptions = {}): Promise<void> {
  ui.intro('Preview comments');

  const voiceProfiles = loadVoiceProfiles();

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
    ui.note('No agents found', 'Run `pnpm generate` first.');
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

  // 4. Build the captions pool from the shared live feed cache. Preview
  // always targets real platform content — no synthetic fallback. An empty
  // feed aborts the command with a clear error (same rule as `generate`
  // and `engage`).
  ui.section('Captions — pulling from shared feed cache');

  const registered = allAgents.find((a) => a.apiKey);
  const client = new InstaMoltClient(registered?.apiKey);
  let captionsPool: ReturnType<typeof buildCaptionsPoolFromFeedCache>;
  let feed: Awaited<ReturnType<typeof loadFeedCacheStrict>>;
  try {
    feed = await loadFeedCacheStrict(client, { maxAgeMs: FEED_CACHE_MAX_AGE_MS });
    captionsPool = buildCaptionsPoolFromFeedCache(feed);
  } catch (err) {
    if (err instanceof FeedCacheEmptyError) {
      log('error', `Live feed is empty — ${err.message}`);
    } else {
      log('error', `Feed cache load failed: ${err}`);
    }
    ui.outro(ui.color.red(`${ui.symbol.err} preview-comments aborted (no live feed)`));
    return;
  }
  const replyEligibleCount = feed.posts.filter(
    (p) => p.comment_count >= 1 && p.caption && p.caption.trim().length > 0,
  ).length;
  const replyPreviewEnabled = replyEligibleCount >= REPLY_COUNT_MIN;

  if (captionsPool.length < 2) {
    log(
      'warn',
      `Live feed returned only ${captionsPool.length} usable captions — need at least 2.`,
    );
    ui.outro(ui.color.yellow(`${ui.symbol.warn} preview-comments aborted`));
    return;
  }

  log('info', `Captions pool: ${captionsPool.length} captions across ${selected.length} agents`);

  // 5. Generate + print samples per agent. Counts are per-agent by default
  // (persona chattiness + voice verbosity); `--count N` forces a uniform
  // comment count for targeted curation.
  ui.section(
    options.count !== undefined
      ? replyPreviewEnabled
        ? `Generating ${options.count} comments + per-agent replies (override: --count ${options.count})`
        : `Generating ${options.count} comments per agent (reply preview disabled — feed has <${REPLY_COUNT_MIN} posts with comments)`
      : replyPreviewEnabled
        ? 'Generating per-agent comments + replies (scaled by persona chattiness + voice verbosity)'
        : `Generating per-agent comments (reply preview disabled — feed has <${REPLY_COUNT_MIN} posts with comments)`,
  );

  for (const agent of selected) {
    const persona = personas.get(agent.personaId);
    if (!persona) {
      log('warn', `Skipping @${agent.agentname} — persona ${agent.personaId} not loaded`);
      continue;
    }
    const voiceProfile = voiceProfiles.get(agent.voiceProfileId);
    if (!voiceProfile) {
      log(
        'warn',
        `Skipping @${agent.agentname} — voice profile ${agent.voiceProfileId} not loaded`,
      );
      continue;
    }

    const plan = computeSampleCounts(persona, voiceProfile, agent.agentname);
    const commentCount = options.count ?? plan.comments;

    const sources = pickPeerCaptions(captionsPool, agent.agentname, commentCount);
    if (sources.length === 0) {
      log('warn', `Skipping @${agent.agentname} — no peer captions available`);
      continue;
    }

    const sp = ui.spinner();
    sp.start(`@${agent.agentname} (${persona.id}) — generating ${sources.length} comments`);

    try {
      const commentSamples = await bakeAgentComments(persona, voiceProfile, agent, sources);

      let replySamples: typeof commentSamples = [];
      if (replyPreviewEnabled && plan.replies > 0) {
        sp.message(`@${agent.agentname} (${persona.id}) — generating thread-aware replies`);
        const replyPosts = pickPostsWithComments(feed, plan.replies, agent.agentname);
        if (replyPosts.length > 0) {
          const depthTargets = plan.depthTargets.slice(0, replyPosts.length);
          replySamples = await bakeAgentReplies(
            persona,
            voiceProfile,
            agent,
            client,
            replyPosts,
            depthTargets,
            commentSamples.map((s) => s.text),
          );
        }
      }

      sp.stop(`@${agent.agentname} (${persona.id})`);

      // Render the bio + each sample inline so the operator can read voice
      // and reply side by side.
      console.log(`  ${ui.color.dim('bio:')} ${ui.color.cyan(agent.bio)}`);
      for (const s of commentSamples) {
        const sourceLabel = `${ui.color.dim('[comment] on @')}${s.sourceAuthor}${ui.color.dim(':')} ${ui.color.dim(`"${truncate(s.sourceCaption, 80)}"`)}`;
        console.log(`  ${sourceLabel}`);
        console.log(`    ${ui.symbol.arrow} ${s.text}`);
      }
      for (const s of replySamples) {
        const parentLabel = `${ui.color.dim(`[reply d${s.parentDepth}] on post by @`)}${s.sourceAuthor}${ui.color.dim(', reply to @')}${s.parentAuthor}${ui.color.dim(':')} ${ui.color.dim(`"${truncate(s.parentText ?? '', 80)}"`)}`;
        console.log(`  ${parentLabel}`);
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
