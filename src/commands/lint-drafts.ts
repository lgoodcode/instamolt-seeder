import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { jaccard } from '@/lib/similarity';
import * as ui from '@/lib/ui';
import type { GeneratedAgent, GeneratedPost } from '@/types';

// ── Options ──────────────────────────────────────────────────────────────

export interface LintDraftsOptions {
  captionThreshold: number;
  promptThreshold: number;
  crossThreshold: number;
  agent?: string;
  json: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_CAPTION_THRESHOLD = 0.6;
const DEFAULT_PROMPT_THRESHOLD = 0.5;
const DEFAULT_CROSS_THRESHOLD = 0.5;
/** Flag an agent if more than 25% of its posts appear in at least one similar pair. */
const AGENT_FLAG_RATIO = 0.25;

// ── Internal report types ────────────────────────────────────────────────

interface SimilarPair {
  postA: string;
  postB: string;
  similarity: number;
  preview?: string;
}

interface AgentFlag {
  agentname: string;
  personaId: string;
  totalPosts: number;
  flaggedPosts: number;
  flagRatio: number;
  pairs: SimilarPair[];
}

interface CrossAgentPair {
  agentA: string;
  postA: string;
  agentB: string;
  postB: string;
  similarity: number;
}

interface CrossPersonaFlag {
  personaId: string;
  pairs: CrossAgentPair[];
}

interface LintReport {
  captionFlags: AgentFlag[];
  promptFlags: AgentFlag[];
  crossAgentFlags: CrossPersonaFlag[];
  summary: {
    agentsScanned: number;
    postsScanned: number;
    captionFlagged: number;
    promptFlagged: number;
    crossPersonaFlagged: number;
  };
}

// ── Defaults helper ──────────────────────────────────────────────────────

export { DEFAULT_CAPTION_THRESHOLD, DEFAULT_CROSS_THRESHOLD, DEFAULT_PROMPT_THRESHOLD };

// ── Helpers ──────────────────────────────────────────────────────────────

interface AgentData {
  personaId: string;
  posts: GeneratedPost[];
}

/**
 * Load agent + post data from the output directory. Returns a map keyed by
 * agentname. Skips agents/posts whose JSON is unreadable (with a warning).
 */
async function loadAgentPosts(
  agentFilter?: string,
  quiet = false,
): Promise<Map<string, AgentData>> {
  // `quiet` suppresses ui.note warnings so --json mode emits ONLY the
  // JSON report on stdout (interleaved human-facing warnings would make
  // the output unparseable for consumers).
  const warn = quiet ? () => {} : (title: string, body: string) => ui.note(title, body);
  const result = new Map<string, AgentData>();

  let agentNames: string[];
  try {
    agentNames = await readdir(config.agentsDir);
  } catch {
    return result;
  }

  if (agentFilter) {
    agentNames = agentNames.filter((n) => n === agentFilter);
  }

  for (const name of agentNames) {
    const agentDir = join(config.agentsDir, name);

    // Read agent.json
    let personaId: string;
    try {
      const raw = await readFile(join(agentDir, 'agent.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'personaId' in parsed &&
        typeof (parsed as Record<string, unknown>).personaId === 'string'
      ) {
        personaId = (parsed as GeneratedAgent).personaId;
      } else {
        warn('Warning', `Skipping ${name}: agent.json missing personaId`);
        continue;
      }
    } catch {
      warn('Warning', `Skipping ${name}: unreadable agent.json`);
      continue;
    }

    // Read directory listing to find post-*.json files
    let entries: string[];
    try {
      entries = await readdir(agentDir);
    } catch {
      warn('Warning', `Skipping ${name}: unreadable directory`);
      continue;
    }

    const postFiles = entries.filter((e) => e.startsWith('post-') && e.endsWith('.json'));
    const posts: GeneratedPost[] = [];

    for (const pf of postFiles) {
      try {
        const raw = await readFile(join(agentDir, pf), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'id' in parsed &&
          'caption' in parsed
        ) {
          posts.push(parsed as GeneratedPost);
        }
      } catch {
        // Skip unreadable post files silently
      }
    }

    result.set(name, { personaId, posts });
  }

  return result;
}

/**
 * Compute pairwise similarity flags for a single agent's posts.
 * Returns the flagged pairs and the set of post IDs that appear in them.
 */
function computePairwiseFlags(
  posts: GeneratedPost[],
  threshold: number,
  field: 'caption' | 'imagePrompt',
): { pairs: SimilarPair[]; flaggedIds: Set<string> } {
  const pairs: SimilarPair[] = [];
  const flaggedIds = new Set<string>();

  for (let i = 0; i < posts.length; i++) {
    const textA = posts[i]![field];
    if (!textA) continue;

    for (let j = i + 1; j < posts.length; j++) {
      const textB = posts[j]![field];
      if (!textB) continue;

      const sim = jaccard(textA, textB);
      if (sim > threshold) {
        pairs.push({
          postA: posts[i]!.id,
          postB: posts[j]!.id,
          similarity: sim,
          preview: textA.slice(0, 80),
        });
        flaggedIds.add(posts[i]!.id);
        flaggedIds.add(posts[j]!.id);
      }
    }
  }

  return { pairs, flaggedIds };
}

/**
 * Build an AgentFlag from the pairwise results, or null if the agent
 * doesn't meet the AGENT_FLAG_RATIO threshold.
 */
function buildAgentFlag(
  agentname: string,
  personaId: string,
  totalPosts: number,
  pairs: SimilarPair[],
  flaggedIds: Set<string>,
): AgentFlag | null {
  if (pairs.length === 0) return null;

  const flagRatio = totalPosts > 0 ? flaggedIds.size / totalPosts : 0;
  if (flagRatio <= AGENT_FLAG_RATIO) return null;

  return {
    agentname,
    personaId,
    totalPosts,
    flaggedPosts: flaggedIds.size,
    flagRatio,
    pairs,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function lintDrafts(opts: LintDraftsOptions): Promise<void> {
  if (!opts.json) {
    ui.intro('Draft Lint');
  }

  const agentMap = await loadAgentPosts(opts.agent, opts.json);

  if (agentMap.size === 0) {
    if (opts.json) {
      console.log(
        JSON.stringify({
          captionFlags: [],
          promptFlags: [],
          crossAgentFlags: [],
          summary: {
            agentsScanned: 0,
            postsScanned: 0,
            captionFlagged: 0,
            promptFlagged: 0,
            crossPersonaFlagged: 0,
          },
        }),
      );
    } else {
      ui.outro('No agents found');
    }
    return;
  }

  let totalPosts = 0;
  for (const data of agentMap.values()) {
    totalPosts += data.posts.length;
  }

  // ── Pass 1: Per-agent caption similarity ──────────────────────────

  const captionFlags: AgentFlag[] = [];

  for (const [agentname, data] of agentMap) {
    const { pairs, flaggedIds } = computePairwiseFlags(
      data.posts,
      opts.captionThreshold,
      'caption',
    );
    const flag = buildAgentFlag(agentname, data.personaId, data.posts.length, pairs, flaggedIds);
    if (flag) captionFlags.push(flag);
  }

  // ── Pass 2: Per-agent image prompt similarity ─────────────────────

  const promptFlags: AgentFlag[] = [];

  for (const [agentname, data] of agentMap) {
    const { pairs, flaggedIds } = computePairwiseFlags(
      data.posts,
      opts.promptThreshold,
      'imagePrompt',
    );
    const flag = buildAgentFlag(agentname, data.personaId, data.posts.length, pairs, flaggedIds);
    if (flag) promptFlags.push(flag);
  }

  // ── Pass 3: Cross-agent same-persona similarity ───────────────────

  const crossAgentFlags: CrossPersonaFlag[] = [];

  // Group agents by persona
  const personaGroups = new Map<string, Array<{ agentname: string; posts: GeneratedPost[] }>>();
  for (const [agentname, data] of agentMap) {
    const group = personaGroups.get(data.personaId) ?? [];
    group.push({ agentname, posts: data.posts });
    personaGroups.set(data.personaId, group);
  }

  for (const [personaId, agents] of personaGroups) {
    if (agents.length < 2) continue;

    const pairs: CrossAgentPair[] = [];

    for (let a = 0; a < agents.length; a++) {
      for (let b = a + 1; b < agents.length; b++) {
        const agentA = agents[a]!;
        const agentB = agents[b]!;

        for (const postA of agentA.posts) {
          if (!postA.caption) continue;
          for (const postB of agentB.posts) {
            if (!postB.caption) continue;

            const sim = jaccard(postA.caption, postB.caption);
            if (sim > opts.crossThreshold) {
              pairs.push({
                agentA: agentA.agentname,
                postA: postA.id,
                agentB: agentB.agentname,
                postB: postB.id,
                similarity: sim,
              });
            }
          }
        }
      }
    }

    if (pairs.length > 0) {
      crossAgentFlags.push({ personaId, pairs });
    }
  }

  // ── Build report ──────────────────────────────────────────────────

  const report: LintReport = {
    captionFlags,
    promptFlags,
    crossAgentFlags,
    summary: {
      agentsScanned: agentMap.size,
      postsScanned: totalPosts,
      captionFlagged: captionFlags.length,
      promptFlagged: promptFlags.length,
      crossPersonaFlagged: crossAgentFlags.length,
    },
  };

  // ── Output ────────────────────────────────────────────────────────

  if (opts.json) {
    console.log(JSON.stringify(report));
    return;
  }

  // Pass 1 output
  ui.section('Per-Agent Caption Similarity');
  if (captionFlags.length === 0) {
    ui.note('Captions', `${ui.symbol.ok} All agents clean`);
  } else {
    for (const flag of captionFlags) {
      const pct = Math.round(flag.flagRatio * 100);
      const header = `${ui.symbol.warn} @${flag.agentname} (persona: ${flag.personaId}) — ${flag.flaggedPosts}/${flag.totalPosts} posts flagged (${pct}%)`;
      const lines = flag.pairs.map(
        (p) => `  ${p.postA} ${ui.symbol.arrow} ${p.postB} (${p.similarity.toFixed(2)})`,
      );
      ui.note(header, lines.join('\n'));
    }
  }

  // Pass 2 output
  ui.section('Per-Agent Image Prompt Similarity');
  if (promptFlags.length === 0) {
    ui.note('Image Prompts', `${ui.symbol.ok} All agents clean`);
  } else {
    for (const flag of promptFlags) {
      const pct = Math.round(flag.flagRatio * 100);
      const header = `${ui.symbol.warn} @${flag.agentname} (persona: ${flag.personaId}) — ${flag.flaggedPosts}/${flag.totalPosts} posts flagged (${pct}%)`;
      const lines = flag.pairs.map(
        (p) => `  ${p.postA} ${ui.symbol.arrow} ${p.postB} (${p.similarity.toFixed(2)})`,
      );
      ui.note(header, lines.join('\n'));
    }
  }

  // Pass 3 output
  ui.section('Cross-Agent Same-Persona Similarity');
  if (crossAgentFlags.length === 0) {
    ui.note('Cross-Agent', `${ui.symbol.ok} All persona groups clean`);
  } else {
    for (const flag of crossAgentFlags) {
      const header = `Persona: ${flag.personaId}`;
      const lines = flag.pairs.map(
        (p) =>
          `  @${p.agentA}/${p.postA} ${ui.symbol.arrow} @${p.agentB}/${p.postB} (${p.similarity.toFixed(2)})`,
      );
      ui.note(header, lines.join('\n'));
    }
  }

  // Summary
  ui.section('Summary');
  const totalFlagged =
    report.summary.captionFlagged +
    report.summary.promptFlagged +
    report.summary.crossPersonaFlagged;

  const summaryBody = [
    `Agents scanned: ${report.summary.agentsScanned}`,
    `Posts scanned:  ${report.summary.postsScanned}`,
    `Caption flags:  ${report.summary.captionFlagged}`,
    `Prompt flags:   ${report.summary.promptFlagged}`,
    `Cross-persona:  ${report.summary.crossPersonaFlagged}`,
  ].join('\n');
  ui.note('Results', summaryBody);

  if (totalFlagged === 0) {
    ui.outro(`${ui.color.green(ui.symbol.ok)} All drafts clean`);
  } else {
    ui.outro(`${ui.color.yellow(ui.symbol.warn)} ${totalFlagged} issue(s) found`);
  }
}
