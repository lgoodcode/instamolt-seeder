import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import {
  bakeAgentComments,
  buildCaptionsPoolFromDisk,
  COMMENT_SAMPLES_PER_AGENT,
  pickPeerCaptions,
} from '@/lib/comment-samples';
import {
  appendAgentToIndex,
  type DedupIndex,
  emptyIndex,
  projectIndexToContext,
  readDedupIndex,
  writeDedupIndex,
} from '@/lib/dedup-index';
import { log } from '@/lib/logger';
import { maxSimilarity, pickDiverseAndRecent } from '@/lib/similarity';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { type AgentAssignment, getAgentAssignments } from '@/personas/registry';
import {
  generateAgentName,
  generateBio,
  generatePostContent,
  type PostContent,
} from '@/services/llm';
import type {
  AgentCommentsFile,
  AgentsIndex,
  GeneratedAgent,
  GeneratedPost,
  Persona,
} from '@/types';
import { loadVoiceProfiles } from '@/voice-profiles/index';

/**
 * How many same-persona items get sampled into a prompt as the avoid-list.
 * Matches the historical caps inside `generateBio` / `generatePostContent`
 * (12 bios, 6 peer posts) so the existing inner `slice(-N)` defenses become
 * a no-op when fed a pre-curated input. The change isn't the size of the
 * sample — it's how it's PICKED (full corpus + farthest-point sampling
 * instead of `slice(-N)` of the most-recent batch).
 */
const BIO_PROMPT_SAMPLE_K = 12;
const PEER_POST_PROMPT_SAMPLE_K = 6;

/**
 * Similarity threshold above which a freshly-generated post is considered
 * too close to existing content for the same persona, and we ask Gemini for
 * one more attempt. 0.5 catches near-duplicate themes without being trigger-
 * happy on incidental word overlap. See `src/similarity.ts`.
 */
const SIMILARITY_THRESHOLD = 0.5;

/** Maximum LLM attempts per post inside the similarity gate. 1 retry max. */
const MAX_POST_ATTEMPTS = 2;

/**
 * Generate N agents with M posts each.
 * Writes everything to output/ as JSON files.
 *
 * Per-persona de-duplication context is built up at startup from existing
 * agents on disk and grows as new content is created within the run, so:
 *   - new bios are told what other bios in the same persona already say
 *   - new posts are told what other posts (this agent + same-persona peers) already say
 *   - a Jaccard similarity gate retries once if the model collides anyway
 */
export async function generate(agentCount: number, postsPerAgent: number): Promise<void> {
  ui.intro('Generate');

  const personas = await loadPersonas();
  const voiceProfiles = loadVoiceProfiles();
  const assignments = getAgentAssignments(agentCount, personas, voiceProfiles);

  logCoverageSummary(assignments, personas.size, voiceProfiles.size);

  log('info', `Generating ${agentCount} agents with ${postsPerAgent} posts each`);
  log('info', `Total posts: ${agentCount * postsPerAgent}`);

  // Load existing agents if any (for idempotency).
  const existing = await loadExistingAgents();
  const existingNames = existing.map((a) => a.agentname);
  const allAgents: GeneratedAgent[] = [...existing];

  // Build per-persona de-dup context maps from what's already on disk.
  // These maps are mutated as we generate new content within this run, so
  // later agents in the same persona block see everything earlier agents made.
  //
  // Source of truth is the persisted `output/dedup-index.json` (cheap, ~50ms
  // even at 1000 agents). If the file is missing or corrupt, we fall back to
  // walking `output/agents/` directly — same shape, just slower — and
  // rebuild the index from the walk results so the next run is fast again.
  // The fallback is logged at warn level but never hard-fails.
  const bioContext = new Map<string, string[]>();
  const postContext = new Map<string, PostContent[]>();
  const dedupIndex = await loadDedupContext(existing, bioContext, postContext);

  let created = 0;
  let failed = 0;

  // Group assignments by persona for progress-bar UX continuity — all
  // agents for the same persona are created together so the dedup context
  // maps grow coherently within each persona block.
  const grouped = groupAssignmentsByPersona(assignments);

  for (const [personaId, specs] of grouped) {
    const persona = personas.get(personaId)!;
    const existingForPersona = existing.filter((a) => a.personaId === personaId).length;
    const toCreate = specs.length - existingForPersona;

    if (toCreate <= 0) {
      log('info', `${personaId}: already have ${existingForPersona}/${specs.length}, skipping`);
      continue;
    }

    // Take only the specs we still need to create (existing agents are
    // assumed to occupy the first N slots).
    const specsToCreate = specs.slice(existingForPersona);

    ui.section(`${personaId} — creating ${toCreate} agents`);

    // Each agent costs (1 name + 1 bio + N posts) Gemini calls. The bar
    // ticks once per Gemini call so the operator gets fine-grained progress
    // even when a single persona block takes a few minutes.
    const stepsPerAgent = 2 + postsPerAgent;
    const bar = ui.progress(toCreate * stepsPerAgent, 'preparing...');

    for (let i = 0; i < specsToCreate.length; i++) {
      const spec = specsToCreate[i];
      try {
        // --- Identity ---
        bar.tick(`naming agent ${i + 1}/${toCreate}`);
        const agentname = await generateAgentName(persona, existingNames);
        bar.tick(`writing bio for @${agentname}`);

        // Pre-curate the avoid list with `pickDiverseAndRecent` over the
        // FULL persona corpus from the index — half most-recent (continuity)
        // + half farthest-point sampled (breadth). Same prompt budget as the
        // historical `slice(-12)`, but the picks span the persona's whole
        // breadth instead of just the most recent batch. Snapshot at call
        // time so post-call mutations of `bioContext` don't leak (matches
        // the snapshot pattern below for posts).
        const personaBiosFull = bioContext.get(persona.id) ?? [];
        const personaBiosSnapshot = pickDiverseAndRecent(
          personaBiosFull,
          (b) => b,
          BIO_PROMPT_SAMPLE_K,
        );
        let bio = await generateBio(persona, personaBiosSnapshot);

        // Guarantee bio has at least 3 words; retry once, then fall back to persona.personality.
        const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
        if (wordCount(bio) < 3) {
          bio = await generateBio(persona, personaBiosSnapshot);
        }
        if (wordCount(bio) < 3) {
          const match = persona.personality.match(/^[^.!?]+[.!?]/);
          const fallback = (match ? match[0] : persona.personality).trim().slice(0, 150);
          log('warn', `  ${agentname}: bio too short, using personality fallback`);
          bio = fallback;
        }

        const agent: GeneratedAgent = {
          agentname,
          personaId: persona.id,
          voiceProfileId: spec.voiceProfile.id,
          bio,
        };

        // Create agent directory + write agent.json before posts so a crash
        // mid-post-generation still leaves a usable identity on disk.
        const agentDir = join(config.agentsDir, agentname);
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, 'agent.json'), JSON.stringify(agent, null, 2));

        // --- Posts ---
        log('info', `  ${agentname}: generating ${postsPerAgent} posts...`);

        // priorPosts is the running list of posts THIS agent has produced
        // in this loop. peerPosts is the same-persona pool that grows as
        // every agent in this persona block adds to it. agentPosts collects
        // the same items as priorPosts but in `GeneratedPost` shape (with
        // ids), so we can record them in the dedup index after the loop.
        const priorPosts: PostContent[] = [];
        const agentPosts: GeneratedPost[] = [];
        const peerPosts = postContext.get(persona.id) ?? [];

        for (let p = 1; p <= postsPerAgent; p++) {
          bar.tick(`@${agentname}: post ${p}/${postsPerAgent}`);
          // priorPosts is the running list for THIS agent (small, M items
          // total) — pass as-is. peerPosts is the full persona corpus, so
          // pre-curate with `pickDiverseAndRecent` to give Gemini K_PEER
          // items that span the persona's full breadth instead of just the
          // most recent batch. Snapshot at call time (the maps mutate as we
          // append below).
          const peerSnapshot = pickDiverseAndRecent(
            peerPosts,
            (post) => `${post.imagePrompt} ${post.caption}`,
            PEER_POST_PROMPT_SAMPLE_K,
          );
          const content = await generatePostWithSimilarityGate(
            persona,
            p,
            postsPerAgent,
            [...priorPosts],
            peerSnapshot,
          );

          const post: GeneratedPost = {
            id: `post-${String(p).padStart(3, '0')}`,
            imagePrompt: content.imagePrompt,
            caption: content.caption,
            aspectRatio: content.aspectRatio,
          };

          await writeFile(join(agentDir, `${post.id}.json`), JSON.stringify(post, null, 2));

          // Append to both contexts so the next post (this agent) and the
          // next agent (same persona) both see this content. agentPosts
          // tracks the same items in `GeneratedPost` shape (with ids) for
          // recording in the dedup index after the loop.
          priorPosts.push(content);
          peerPosts.push(content);
          agentPosts.push(post);

          // Small delay to avoid Gemini rate limits.
          await sleep(500);
        }

        // Persist the persona pool back into the map (handles the case where
        // the entry didn't exist before — postContext.get returned a fresh array).
        postContext.set(persona.id, peerPosts);

        // Append the new bio so subsequent agents in this persona block see it.
        const updatedBios = bioContext.get(persona.id) ?? [];
        updatedBios.push(bio);
        bioContext.set(persona.id, updatedBios);

        // Record the finished agent in the dedup index. We do this per-agent
        // (rather than once at end-of-run) so a crash mid-run leaves a
        // valid-but-partial index after the next successful write.
        appendAgentToIndex(dedupIndex, persona.id, agent, agentPosts);

        allAgents.push(agent);
        existingNames.push(agentname);
        created++;
        log('success', `@${agentname} [${spec.voiceProfile.id}] — ${bio.slice(0, 60)}...`);
      } catch (err) {
        failed++;
        log('error', `Failed to create agent: ${err}`);
      }
    }

    bar.done(`${personaId} — done (${toCreate} agents)`);
  }

  // --- Phase: bake comment samples (Option A) ---
  //
  // Walks every agent and writes 3 sample comments per agent against random
  // peer captions drawn from the pool. The samples are persisted to
  // `output/agents/<name>/comments.json` and become both:
  //   1. an audit artifact the operator can eyeball during curation, and
  //   2. the day-1 voice anchor that `engage` loads as `priorComments` so
  //      runtime comments don't sound generic.
  //
  // Idempotent: skips agents that already have a `comments.json`.
  const { commentsBaked, commentsSkipped, commentsFailed } = await bakeCommentSamplesPhase(
    allAgents,
    personas,
  );

  // Write master index.
  const index: AgentsIndex = {
    generatedAt: new Date().toISOString(),
    totalAgents: allAgents.length,
    totalPosts: allAgents.length * postsPerAgent,
    agents: allAgents,
  };

  await mkdir(config.outputDir, { recursive: true });
  await writeFile(config.agentsIndexPath, JSON.stringify(index, null, 2));

  // Persist the dedup index so the next `generate` run can skip the disk
  // walk. Failure to write is logged but does NOT fail the run — the index
  // is a cache, and the fallback path can rebuild it from disk next time.
  try {
    await writeDedupIndex(config.dedupIndexPath, dedupIndex);
  } catch (err) {
    log(
      'warn',
      `Failed to write dedup index (${err instanceof Error ? err.message : String(err)}), next run will rebuild from walk`,
    );
  }

  ui.note(
    'Generation complete',
    [
      ui.summaryLine([
        { label: 'created', value: created, tone: 'ok' },
        { label: 'total', value: allAgents.length, tone: 'info' },
        { label: 'failed', value: failed, tone: failed > 0 ? 'err' : 'info' },
      ]),
      ui.summaryLine([
        { label: 'comment samples', value: commentsBaked, tone: 'ok' },
        { label: 'skipped', value: commentsSkipped, tone: 'info' },
        { label: 'failed', value: commentsFailed, tone: commentsFailed > 0 ? 'err' : 'info' },
      ]),
      `${ui.color.dim('output:')} ${config.outputDir}/`,
      `${ui.color.dim('next:')}   npm run publish`,
    ].join('\n'),
  );

  ui.outro(ui.color.green(`${ui.symbol.ok} generate done`));
}

/**
 * Walk every agent and bake `COMMENT_SAMPLES_PER_AGENT` sample comments
 * against random peer captions. Idempotent — agents with an existing
 * `comments.json` are skipped.
 *
 * Runs as a separate phase after all agents/posts have been written so the
 * captions pool is complete (every agent has potential peer captions, not
 * just the ones generated before it in the loop).
 */
async function bakeCommentSamplesPhase(
  allAgents: GeneratedAgent[],
  personas: Map<string, Persona>,
): Promise<{ commentsBaked: number; commentsSkipped: number; commentsFailed: number }> {
  ui.section(`Comment samples — baking up to ${COMMENT_SAMPLES_PER_AGENT} per agent`);

  const captionsPool = await buildCaptionsPoolFromDisk(allAgents);

  if (captionsPool.length < 2) {
    log('warn', 'Captions pool too small (need at least 2) — skipping comment bake');
    return { commentsBaked: 0, commentsSkipped: 0, commentsFailed: 0 };
  }

  const bar = ui.progress(allAgents.length, 'preparing...');
  let baked = 0;
  let skipped = 0;
  let failed = 0;

  for (const agent of allAgents) {
    const commentsPath = join(config.agentsDir, agent.agentname, 'comments.json');

    // Idempotency check: skip agents that already have a comments file.
    let existing = false;
    try {
      await readFile(commentsPath, 'utf-8');
      existing = true;
    } catch {}

    if (existing) {
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (exists)`);
      continue;
    }

    const persona = personas.get(agent.personaId);
    if (!persona) {
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (missing persona)`);
      continue;
    }

    const sources = pickPeerCaptions(captionsPool, agent.agentname, COMMENT_SAMPLES_PER_AGENT);
    if (sources.length === 0) {
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (no peer captions)`);
      continue;
    }

    try {
      const samples = await bakeAgentComments(persona, agent, sources);
      const file: AgentCommentsFile = {
        agentname: agent.agentname,
        generatedAt: new Date().toISOString(),
        samples,
      };
      await writeFile(commentsPath, JSON.stringify(file, null, 2));
      baked++;
      bar.tick(`@${agent.agentname} — baked ${samples.length} samples`);
    } catch (err) {
      failed++;
      log('error', `  failed to bake comments for @${agent.agentname}: ${err}`);
      bar.tick(`@${agent.agentname} — failed`);
    }

    // Same Gemini-rate-limit pacing as the post loop above.
    await sleep(500);
  }

  bar.done(`comment samples — ${baked} baked, ${skipped} skipped, ${failed} failed`);
  return { commentsBaked: baked, commentsSkipped: skipped, commentsFailed: failed };
}

// --- Helpers ---

/**
 * Generate a single post with up to MAX_POST_ATTEMPTS LLM calls. After each
 * attempt we score the candidate against everything we've already produced
 * for the same persona; if the score is above SIMILARITY_THRESHOLD we ask
 * Gemini for another try. If both attempts collide, we keep the lower-
 * similarity candidate rather than infinite-looping.
 */
async function generatePostWithSimilarityGate(
  persona: Persona,
  postNumber: number,
  totalPosts: number,
  priorPosts: PostContent[],
  peerPosts: PostContent[],
): Promise<PostContent> {
  const corpus = [...priorPosts, ...peerPosts].map((p) => `${p.imagePrompt} ${p.caption}`);

  let best: PostContent | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < MAX_POST_ATTEMPTS; attempt++) {
    const candidate = await generatePostContent(
      persona,
      postNumber,
      totalPosts,
      priorPosts,
      peerPosts,
    );

    if (corpus.length === 0) return candidate;

    const candidateText = `${candidate.imagePrompt} ${candidate.caption}`;
    const score = maxSimilarity(candidateText, corpus);

    if (score < SIMILARITY_THRESHOLD) return candidate;

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }

    if (attempt < MAX_POST_ATTEMPTS - 1) {
      log(
        'warn',
        `  post ${postNumber}: similarity ${score.toFixed(2)} >= ${SIMILARITY_THRESHOLD}, retrying`,
      );
    }
  }

  log(
    'warn',
    `  post ${postNumber}: kept best-of-${MAX_POST_ATTEMPTS} candidate at similarity ${bestScore.toFixed(2)}`,
  );
  // Non-null assertion safe: we always assign `best` on the first iteration
  // when corpus is non-empty (which is the only path that reaches here).
  return best as PostContent;
}

/**
 * Group a flat list of agent assignments by persona ID, preserving order
 * within each persona block. Returns a Map so the caller can iterate
 * persona-by-persona for progress-bar UX continuity.
 */
function groupAssignmentsByPersona(assignments: AgentAssignment[]): Map<string, AgentAssignment[]> {
  const grouped = new Map<string, AgentAssignment[]>();
  for (const a of assignments) {
    const list = grouped.get(a.persona.id) ?? [];
    list.push(a);
    grouped.set(a.persona.id, list);
  }
  return grouped;
}

/**
 * Log a coverage summary so the operator can verify distribution quality
 * before the expensive Gemini calls begin.
 */
function logCoverageSummary(
  assignments: AgentAssignment[],
  totalPersonas: number,
  totalVoiceProfiles: number,
): void {
  const personas = new Set<string>();
  const voices = new Set<string>();
  const voiceCounts = new Map<string, number>();

  for (const a of assignments) {
    personas.add(a.persona.id);
    voices.add(a.voiceProfile.id);
    voiceCounts.set(a.voiceProfile.id, (voiceCounts.get(a.voiceProfile.id) ?? 0) + 1);
  }

  const sorted = [...voiceCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted
    .slice(0, 3)
    .map(([id, n]) => `${id} (${n})`)
    .join(', ');
  const bottom = sorted
    .slice(-3)
    .map(([id, n]) => `${id} (${n})`)
    .join(', ');

  ui.note(
    [
      `Agents: ${assignments.length}`,
      `Personas: ${personas.size}/${totalPersonas} covered`,
      `Voice profiles: ${voices.size}/${totalVoiceProfiles} covered`,
      `Top voices: ${top}`,
      `Rare voices: ${bottom}`,
    ].join('\n'),
    'Distribution',
  );
}

async function loadExistingAgents(): Promise<GeneratedAgent[]> {
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const index = JSON.parse(raw) as AgentsIndex;
    return index.agents;
  } catch {
    return [];
  }
}

/**
 * Hydrate the per-persona bio + post context maps that the generation loop
 * uses as the same-persona avoid-list source. Returns the in-memory dedup
 * index that was used to populate them — the caller mutates this index as
 * new agents are written and persists it back to disk at the end of the run.
 *
 * Strategy:
 *   1. Try to read the persisted `output/dedup-index.json`. If it loads
 *      cleanly, project it into the maps and return it as-is.
 *   2. On any error (missing, parse failure, version mismatch, etc), log a
 *      warning and fall back to walking every agent directory under
 *      `output/agents/` — the same logic that lived here before the index
 *      shipped. The walked state is then snapshotted into a fresh index so
 *      the *next* run is fast.
 *
 * The fallback path is intentionally never fatal: a missing or corrupt
 * dedup index should never block a generate run, only slow it down.
 */
async function loadDedupContext(
  existing: GeneratedAgent[],
  bioContext: Map<string, string[]>,
  postContext: Map<string, PostContent[]>,
): Promise<DedupIndex> {
  // --- Fast path: persisted index ---
  try {
    const index = await readDedupIndex(config.dedupIndexPath);
    const currentNames = new Set(existing.map((a) => a.agentname));
    const { bios, posts } = projectIndexToContext(
      index,
      currentNames,
      bioContext,
      postContext as Map<
        string,
        { imagePrompt: string; caption: string; aspectRatio: PostContent['aspectRatio'] }[]
      >,
    );
    if (existing.length > 0) {
      log(
        'info',
        `Loaded de-dup context from index: ${bios} bios, ${posts} posts across ${bioContext.size} personas`,
      );
    }
    return index;
  } catch (err) {
    if (existing.length > 0) {
      log(
        'warn',
        `Dedup index missing or corrupt (${err instanceof Error ? err.message : String(err)}), falling back to disk walk`,
      );
    }
  }

  // --- Fallback path: walk output/agents/ ---
  const index = emptyIndex();
  let postsLoaded = 0;

  for (const agent of existing) {
    if (agent.bio) {
      const bios = bioContext.get(agent.personaId) ?? [];
      bios.push(agent.bio);
      bioContext.set(agent.personaId, bios);
    }

    const walkedPosts: GeneratedPost[] = [];
    let files: string[];
    try {
      files = await readdir(join(config.agentsDir, agent.agentname));
    } catch {
      // Agent dir missing — still record bio in the index so it survives
      // the rebuild, but skip the post walk.
      appendAgentToIndex(
        index,
        agent.personaId,
        { agentname: agent.agentname, bio: agent.bio },
        [],
      );
      continue;
    }

    for (const file of files) {
      if (!file.startsWith('post-') || !file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(config.agentsDir, agent.agentname, file), 'utf-8');
        const post = JSON.parse(raw) as GeneratedPost;
        const list = postContext.get(agent.personaId) ?? [];
        list.push({
          imagePrompt: post.imagePrompt,
          caption: post.caption,
          aspectRatio: post.aspectRatio,
        });
        postContext.set(agent.personaId, list);
        walkedPosts.push(post);
        postsLoaded++;
      } catch {}
    }

    appendAgentToIndex(
      index,
      agent.personaId,
      { agentname: agent.agentname, bio: agent.bio },
      walkedPosts,
    );
  }

  if (existing.length > 0) {
    log(
      'info',
      `Rebuilt de-dup context from walk: ${existing.length} bios, ${postsLoaded} posts across ${bioContext.size} personas`,
    );
  }

  return index;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
