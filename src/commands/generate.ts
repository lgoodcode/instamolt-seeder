import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, FEED_CACHE_MAX_AGE_MS } from '@/config';
import {
  bakeAgentComments,
  bakeAgentReplies,
  buildCaptionsPoolFromFeedCache,
  COMMENT_COUNT_MAX,
  COMMENT_COUNT_MIN,
  computeSampleCounts,
  type MentionBakeContext,
  pickPeerCaptions,
  pickPostsWithComments,
  REPLY_COUNT_MAX,
  REPLY_COUNT_MIN,
} from '@/lib/comment-samples';
import { mapWithConcurrency } from '@/lib/concurrency';
import {
  appendAgentToIndex,
  type DedupIndex,
  emptyIndex,
  projectIndexToContext,
  readDedupIndex,
  writeDedupIndex,
} from '@/lib/dedup-index';
import {
  drainWrites,
  flushStats,
  initEventLogger,
  logEvent,
  logMentions,
} from '@/lib/event-logger';
import { FeedCacheEmptyError, loadFeedCacheStrict } from '@/lib/feed-cache';
import { log } from '@/lib/logger';
import { maxSimilarity, pickDiverseAndRecent } from '@/lib/similarity';
import { rollTrendingHashtags } from '@/lib/trending-pool';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { type AgentAssignment, getAgentAssignments } from '@/personas/registry';
import { InstaMoltClient } from '@/services/instamolt-api';
import {
  generateAgentName,
  generateAvatarPrompt,
  generateBio,
  generatePostContent,
  type PostContent,
  rollChaos,
} from '@/services/llm';
import type {
  AgentCommentsFile,
  AgentsIndex,
  GeneratedAgent,
  GeneratedPost,
  Persona,
  VoiceProfile,
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

const MIN_BIO_WORD_COUNT = 3;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

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
 * How many same-persona agentnames to splice into the name prompt as an
 * avoid-list. Small and curated (via `pickDiverseAndRecent`) so Gemini isn't
 * anchored to the existing lexical space — the platform availability check
 * below is the real uniqueness guarantee.
 */
const AGENTNAME_PROMPT_SAMPLE_K = 8;

/**
 * Maximum LLM + availability attempts per agentname before we give up on a
 * slot. In practice the loop should succeed on attempt 0 or 1; the budget is
 * generous so a string of unlucky collisions against a heavily-populated
 * platform doesn't crash the whole run.
 */
const MAX_AGENTNAME_ATTEMPTS = 8;

/**
 * Inclusive random integer in [min, max]. Used to roll a per-agent post count
 * when `generate` is invoked with a range.
 */
function randIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate N agents, each with a randomly chosen post count in [postsMin, postsMax].
 * Writes everything to output/ as JSON files.
 *
 * When `postsMin === postsMax` (including the default where `postsMax` falls
 * through to `postsMin`), every agent gets exactly that many posts — identical
 * to the historical fixed-count behaviour.
 *
 * Per-persona de-duplication context is built up at startup from existing
 * agents on disk and grows as new content is created within the run, so:
 *   - new bios are told what other bios in the same persona already say
 *   - new posts are told what other posts (this agent + same-persona peers) already say
 *   - a Jaccard similarity gate retries once if the model collides anyway
 */
export async function generate(
  agentCount: number,
  postsMin: number,
  postsMax: number = postsMin,
): Promise<void> {
  if (postsMin < 0) {
    throw new Error(`generate: postsMin must be >= 0 (got ${postsMin})`);
  }
  if (postsMax < postsMin) {
    throw new Error(`generate: postsMax (${postsMax}) must be >= postsMin (${postsMin})`);
  }

  ui.intro('Generate');
  const startedAt = Date.now();

  initEventLogger();
  logEvent({
    eventType: 'session_start',
    success: true,
    details: { command: 'generate', agentCount, postsMin, postsMax },
  });

  const personas = await loadPersonas();
  const voiceProfiles = loadVoiceProfiles();
  const assignments = getAgentAssignments(agentCount, personas, voiceProfiles);

  logCoverageSummary(assignments, personas.size, voiceProfiles.size);

  const postsDesc = postsMin === postsMax ? `${postsMin}` : `${postsMin}-${postsMax}`;
  log('info', `Generating ${agentCount} agents with ${postsDesc} posts each`);

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
  let postsCreated = 0;

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

    // Roll a post count per agent up front so the progress bar total is
    // accurate. Tier 1 personas get `max(postsMin, 1)` as the floor so they
    // never land at 0 posts — Tier 1 agents are the leaderboard drivers and
    // should always have content when discovered. Tier 2/3 use the passed
    // `postsMin` unchanged (0-post lurkers are realistic for the long tail).
    // Clamp the floor at `postsMax` so an explicit 0..0 range stays 0 for
    // every tier (otherwise `randIntInclusive(1, 0)` returns 1 and Tier 1s
    // would silently draft a post on a zero-post run).
    const tier = persona.engagementTier ?? 2;
    const tieredPostsMin = tier === 1 ? Math.min(postsMax, Math.max(postsMin, 1)) : postsMin;
    const postCounts = specsToCreate.map(() => randIntInclusive(tieredPostsMin, postsMax));
    const totalPostsInBlock = postCounts.reduce((sum, n) => sum + n, 0);

    ui.section(`${personaId} — creating ${toCreate} agents`);

    // Each agent costs (1 name + 1 bio + N posts) Gemini calls. The bar
    // ticks once per Gemini call so the operator gets fine-grained progress
    // even when a single persona block takes a few minutes.
    const bar = ui.progress(2 * toCreate + totalPostsInBlock, 'preparing...');

    // Unauthenticated probe client for `isAgentnameAvailable`. The live
    // availability check is the real uniqueness guarantee — the on-disk
    // existing-names set only covers agents this working copy has touched,
    // not agents sitting in the platform's database from prior seed runs.
    const probeClient = new InstaMoltClient();
    const localTaken = new Set(existingNames);

    for (let i = 0; i < specsToCreate.length; i++) {
      const spec = specsToCreate[i];
      const postsForAgent = postCounts[i];
      const agentStartedAt = Date.now();
      try {
        // --- Identity ---
        // Bounded retry loop: generate → local dedup → platform availability
        // check. Each retry passes `rejectedThisRun` into generateAgentName so
        // the next prompt knows which candidates were taken / collided and
        // swings to a structurally different shape within the same
        // voiceProfile.usernameStyle.
        const rejectedThisRun: string[] = [];
        let agentname: string | undefined;
        for (let attempt = 0; attempt < MAX_AGENTNAME_ATTEMPTS; attempt++) {
          bar.tick(`naming agent ${i + 1}/${toCreate}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

          const avoidSample = pickDiverseAndRecent(
            existingNames,
            (n) => n,
            AGENTNAME_PROMPT_SAMPLE_K,
          );
          const candidate = await generateAgentName(
            persona,
            spec.voiceProfile,
            avoidSample,
            rejectedThisRun,
          );

          if (!candidate || candidate.length < 3) {
            rejectedThisRun.push(candidate || '<empty>');
            continue;
          }
          if (localTaken.has(candidate)) {
            rejectedThisRun.push(candidate);
            continue;
          }

          const available = await probeClient.isAgentnameAvailable(candidate);
          if (!available) {
            rejectedThisRun.push(candidate);
            // Remember the platform's answer so we don't re-query the same
            // taken name if Gemini regenerates it later this run.
            localTaken.add(candidate);
            continue;
          }

          agentname = candidate;
          break;
        }

        if (!agentname) {
          throw new Error(
            `could not generate a unique agentname for persona=${persona.id} after ${MAX_AGENTNAME_ATTEMPTS} attempts (rejected: ${rejectedThisRun.join(', ')})`,
          );
        }

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
        // generateBio already retries once internally on sub-3-word output.
        // If the retry also returns a short bio, fall back to persona.personality.
        let bio = await generateBio(persona, spec.voiceProfile, personaBiosSnapshot);
        if (wordCount(bio) < MIN_BIO_WORD_COUNT) {
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

        // Bake the avatar prompt. Text-only Gemini call; publish Phase A.5
        // hands this verbatim to `POST /agents/me/avatar/generate` which
        // runs Together AI FLUX server-side. Soft-failure: a throw here
        // leaves `avatarPrompt` unset and the backfill script
        // (`pnpm avatars`) will fill it in later — one bad prompt draft
        // must not abort the whole persona block.
        const avatarPromptStartedAt = Date.now();
        try {
          const avatarPrompt = await generateAvatarPrompt(persona, agent);
          agent.avatarPrompt = avatarPrompt;
          logEvent({
            eventType: 'avatar_prompt_drafted',
            agentname,
            persona: persona.id,
            success: true,
            durationMs: Date.now() - avatarPromptStartedAt,
            details: {
              voiceProfileId: spec.voiceProfile.id,
              promptLength: avatarPrompt.length,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log('warn', `  @${agentname}: avatar prompt draft failed (${msg}); leaving unset`);
          logEvent({
            eventType: 'avatar_prompt_drafted',
            agentname,
            persona: persona.id,
            success: false,
            durationMs: Date.now() - avatarPromptStartedAt,
            error: msg,
          });
        }

        // Create agent directory + write agent.json before posts so a crash
        // mid-post-generation still leaves a usable identity on disk.
        const agentDir = join(config.agentsDir, agentname);
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, 'agent.json'), JSON.stringify(agent, null, 2));

        // --- Posts ---
        log('info', `  ${agentname}: generating ${postsForAgent} posts...`);

        // priorPosts is the running list of posts THIS agent has produced
        // in this loop. peerPosts is the same-persona pool that grows as
        // every agent in this persona block adds to it. agentPosts collects
        // the same items as priorPosts but in `GeneratedPost` shape (with
        // ids), so we can record them in the dedup index after the loop.
        const priorPosts: PostContent[] = [];
        const agentPosts: GeneratedPost[] = [];
        const peerPosts = postContext.get(persona.id) ?? [];

        for (let p = 1; p <= postsForAgent; p++) {
          bar.tick(`@${agentname}: post ${p}/${postsForAgent}`);
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
            spec.voiceProfile,
            p,
            postsForAgent,
            [...priorPosts],
            peerSnapshot,
          );

          const post: GeneratedPost = {
            id: `post-${String(p).padStart(3, '0')}`,
            imagePrompt: content.imagePrompt,
            caption: content.caption,
            aspectRatio: content.aspectRatio,
            ...(content.chaos ? { chaos: true } : {}),
          };

          await writeFile(join(agentDir, `${post.id}.json`), JSON.stringify(post, null, 2));
          postsCreated++;

          // Append to both contexts so the next post (this agent) and the
          // next agent (same persona) both see this content. agentPosts
          // tracks the same items in `GeneratedPost` shape (with ids) for
          // recording in the dedup index after the loop.
          priorPosts.push(content);
          peerPosts.push(content);
          agentPosts.push(post);
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
        localTaken.add(agentname);
        created++;
        log('success', `@${agentname} [${spec.voiceProfile.id}] — ${bio.slice(0, 60)}...`);
        const agentDurationMs = Date.now() - agentStartedAt;
        logEvent({
          eventType: 'agent_drafted',
          agentname,
          persona: persona.id,
          success: true,
          durationMs: agentDurationMs,
          details: {
            voiceProfileId: spec.voiceProfile.id,
            postsDrafted: agentPosts.length,
            bioPreview: bio.slice(0, 80),
          },
        });
        // Per-post timing isn't tracked in the inner loop (would require
        // restructuring to capture pre/post timestamps around the LLM call).
        // Approximate by spreading the agent's total wall-clock across posts —
        // good enough for p50/p95 trend tracking; precise per-post latency is
        // already captured by the underlying `llm_call` events of kind 'post'.
        const perPostMs =
          agentPosts.length > 0 ? Math.round(agentDurationMs / agentPosts.length) : 0;
        for (const post of agentPosts) {
          logEvent({
            eventType: 'post_drafted',
            agentname,
            persona: persona.id,
            success: true,
            durationMs: perPostMs,
            details: {
              postId: post.id,
              caption: post.caption.slice(0, 80),
              aspectRatio: post.aspectRatio,
              ...(post.chaos ? { chaos: true } : {}),
            },
          });
        }
      } catch (err) {
        failed++;
        log('error', `Failed to create agent: ${err}`);
        logEvent({
          eventType: 'agent_drafted',
          persona: persona.id,
          success: false,
          durationMs: Date.now() - agentStartedAt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    bar.done(`${personaId} — done (${toCreate} agents)`);
  }

  const agentsPhaseMs = Date.now() - startedAt;

  // Write master index + dedup index BEFORE the bake phase. The bake phase
  // can throw (e.g. `FeedCacheEmptyError` when the live feed is empty), and
  // if we deferred the index writes until after bake, a throw would leave
  // orphaned agent/post JSON on disk with no `agents.json` entry — the
  // resumability fast path in `loadExistingAgents` reads `agents.json`, so
  // those agents would be invisible to subsequent runs and re-generated.
  //
  // Baking only writes per-agent `comments.json` files, which are naturally
  // idempotent (the bake phase already skips agents that have one), so
  // persisting agents.json + dedup-index.json up-front costs nothing and
  // makes a bake-phase failure non-destructive.
  // Count actual post files per agent since post counts now vary when
  // invoked with a range. Existing agents may also have non-uniform counts
  // from earlier runs, so walking the disk is the only accurate source.
  let totalPostsOnDisk = 0;
  for (const a of allAgents) {
    try {
      const entries = await readdir(join(config.agentsDir, a.agentname));
      totalPostsOnDisk += entries.filter((f) => /^post-\d+\.json$/.test(f)).length;
    } catch {
      // Agent dir missing — skip; the agent record itself is already a
      // partial-write case that a resumed run will reconcile.
    }
  }

  const index: AgentsIndex = {
    generatedAt: new Date().toISOString(),
    totalAgents: allAgents.length,
    totalPosts: totalPostsOnDisk,
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
  const commentsPhaseStart = Date.now();
  const { commentsBaked, commentsSkipped, commentsFailed, repliesBaked } =
    await bakeCommentSamplesPhase(allAgents, personas);
  const commentsPhaseMs = Date.now() - commentsPhaseStart;

  const totalDurationMs = Date.now() - startedAt;
  const avgPerAgentMs = created > 0 ? Math.round(agentsPhaseMs / created) : 0;

  ui.note(
    'Generation complete',
    [
      ui.summaryLine([
        { label: 'agents created', value: created, tone: 'ok' },
        { label: 'total', value: allAgents.length, tone: 'info' },
        { label: 'failed', value: failed, tone: failed > 0 ? 'err' : 'info' },
      ]),
      ui.summaryLine([
        { label: 'posts written', value: postsCreated, tone: 'ok' },
        { label: 'comment samples', value: commentsBaked, tone: 'ok' },
        { label: 'reply samples', value: repliesBaked, tone: 'ok' },
        { label: 'skipped', value: commentsSkipped, tone: 'info' },
        { label: 'failed', value: commentsFailed, tone: commentsFailed > 0 ? 'err' : 'info' },
      ]),
      `${ui.color.dim('duration:')} ${formatDuration(totalDurationMs)} ${ui.color.dim(`(agents ${formatDuration(agentsPhaseMs)}, comments ${formatDuration(commentsPhaseMs)}${created > 0 ? `, ~${formatDuration(avgPerAgentMs)}/agent` : ''})`)}`,
      `${ui.color.dim('output:')} ${config.outputDir}/`,
      `${ui.color.dim('next:')}   pnpm publish-drafts`,
    ].join('\n'),
  );

  logEvent({
    eventType: 'session_end',
    success: true,
    details: {
      command: 'generate',
      agentsCreated: created,
      agentsFailed: failed,
      postsCreated,
      commentsBaked,
      commentsSkipped,
      commentsFailed,
      repliesBaked,
      totalDurationMs,
    },
  });
  await drainWrites();
  flushStats();

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
): Promise<{
  commentsBaked: number;
  commentsSkipped: number;
  commentsFailed: number;
  repliesBaked: number;
}> {
  // Mention candidate context — built once per bake phase from the full agent
  // roster. Same shape used by top-level comment and reply baking.
  const knownAgentnames = new Set<string>(allAgents.map((a) => a.agentname));
  const personaToAgentnames = new Map<string, string[]>();
  for (const a of allAgents) {
    const list = personaToAgentnames.get(a.personaId) ?? [];
    list.push(a.agentname);
    personaToAgentnames.set(a.personaId, list);
  }
  const mentionCtx: MentionBakeContext = { knownAgentnames, personaToAgentnames };

  ui.section(
    `Comment samples — baking ${COMMENT_COUNT_MIN}–${COMMENT_COUNT_MAX} comments + ${REPLY_COUNT_MIN}–${REPLY_COUNT_MAX} thread-aware replies per agent (scaled by persona chattiness + voice verbosity)`,
  );

  const voiceProfiles = loadVoiceProfiles();

  // Pull real live posts from the platform via the shared feed cache. The
  // strict loader throws on empty/refresh-failure so we never bake comments
  // against stale or synthetic content — the seeder's rule is that every
  // baked interaction targets real content. No apiKey is needed because
  // /feed/explore and /posts are unauthenticated.
  const client = new InstaMoltClient();
  const feed = await loadFeedCacheStrict(client, { maxAgeMs: FEED_CACHE_MAX_AGE_MS });
  const captionsPool = buildCaptionsPoolFromFeedCache(feed);

  if (captionsPool.length < 2) {
    // Live feed returned posts but none had usable captions. This is rare but
    // still a hard abort — we refuse to fall back to synthetic content, and a
    // captionless feed means agents would have nothing to react to.
    throw new FeedCacheEmptyError(
      `Live feed returned ${feed.posts.length} posts but only ${captionsPool.length} usable captions — cannot bake comments`,
    );
  }

  log(
    'info',
    `Comment bake using ${captionsPool.length} live captions (feed refreshed ${feed.refreshedAt})`,
  );

  // Reply bake requires posts that have at least one existing comment — it's
  // OK to have a smaller pool here than the comments pool (some posts have
  // no comments yet). We log a warning and skip ONLY the reply bake if the
  // platform is too quiet to produce thread-aware replies; the comment bake
  // still proceeds so the run isn't a total loss on a thread-poor platform.
  const replyEligibleCount = feed.posts.filter(
    (p) => p.comment_count >= 1 && p.caption && p.caption.trim().length > 0,
  ).length;
  // Gate against the worst-case per-agent reply count. If the platform is
  // even too quiet for `REPLY_COUNT_MAX` threaded posts, agents that compute
  // a smaller per-agent reply count can still bake — that case is handled
  // per-agent inside the loop by checking `replyPosts.length` against the
  // plan.
  const replyBakeEnabled = replyEligibleCount >= REPLY_COUNT_MIN;
  if (!replyBakeEnabled) {
    log(
      'warn',
      `Reply bake disabled — only ${replyEligibleCount} feed posts have comments (need ${REPLY_COUNT_MIN}+). Comment samples will still be baked.`,
    );
  } else {
    log('info', `Reply bake: ${replyEligibleCount} feed posts with comments eligible`);
  }

  const bar = ui.progress(allAgents.length, 'preparing...');
  let baked = 0;
  let skipped = 0;
  let failed = 0;
  let repliesBaked = 0;

  // Agents are baked in parallel because each job reads an immutable
  // `captionsPool` and writes only to its own `comments.json` — no shared
  // mutable state. Concurrency is bounded by Gemini's per-minute quota, not
  // CPU, so `config.commentBakeConcurrency` is the knob to tune. Per-agent
  // failures are caught inside the worker so one bad agent can't abort the
  // rest; counters are updated from the main event loop after each worker
  // returns (single-threaded, no atomicity concerns).
  await mapWithConcurrency(allAgents, config.commentBakeConcurrency, async (agent) => {
    const commentsPath = join(config.agentsDir, agent.agentname, 'comments.json');

    try {
      await readFile(commentsPath, 'utf-8');
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (exists)`);
      return;
    } catch {}

    const persona = personas.get(agent.personaId);
    if (!persona) {
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (missing persona)`);
      return;
    }

    const voiceProfile = voiceProfiles.get(agent.voiceProfileId);
    if (!voiceProfile) {
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (missing voice profile)`);
      return;
    }

    const plan = computeSampleCounts(persona, voiceProfile, agent.agentname);

    const sources = pickPeerCaptions(captionsPool, agent.agentname, plan.comments);
    if (sources.length === 0) {
      skipped++;
      bar.tick(`@${agent.agentname} — skipped (no peer captions)`);
      return;
    }

    const commentBakeStartedAt = Date.now();
    try {
      const commentSamples = await bakeAgentComments(
        persona,
        voiceProfile,
        agent,
        sources,
        mentionCtx,
      );
      const commentBakeDurationMs = Date.now() - commentBakeStartedAt;
      const commentSamplesTagged = commentSamples.map((s) => ({
        ...s,
        kind: 'comment' as const,
      }));

      let replySamples: typeof commentSamples = [];
      let replyBakeDurationMs = 0;
      if (replyBakeEnabled && plan.replies > 0) {
        const replyPosts = pickPostsWithComments(feed, plan.replies, agent.agentname);
        if (replyPosts.length > 0) {
          const priorTexts = commentSamples.map((s) => s.text);
          const depthTargets = plan.depthTargets.slice(0, replyPosts.length);
          const replyBakeStartedAt = Date.now();
          replySamples = await bakeAgentReplies(
            persona,
            voiceProfile,
            agent,
            client,
            replyPosts,
            depthTargets,
            priorTexts,
            mentionCtx,
          );
          replyBakeDurationMs = Date.now() - replyBakeStartedAt;
        }
      }

      const allSamples = [...commentSamplesTagged, ...replySamples];
      const file: AgentCommentsFile = {
        agentname: agent.agentname,
        generatedAt: new Date().toISOString(),
        samples: allSamples,
      };
      await writeFile(commentsPath, JSON.stringify(file, null, 2));
      baked++;
      repliesBaked += replySamples.length;
      bar.tick(
        `@${agent.agentname} — baked ${commentSamplesTagged.length} comments + ${replySamples.length} replies`,
      );
      logEvent({
        eventType: 'comment_baked',
        agentname: agent.agentname,
        persona: agent.personaId,
        success: true,
        durationMs: commentBakeDurationMs,
        details: { count: commentSamplesTagged.length },
      });
      // Mention fan-out — emitted AFTER `comment_baked` so events.jsonl
      // orders aggregate-then-per-target. Each sample's resolved mention
      // list was stamped during the bake by `parseResolvedMentions`.
      for (const sample of commentSamplesTagged) {
        if (!sample.mentions || sample.mentions.length === 0) continue;
        logMentions({
          agentname: agent.agentname,
          persona: agent.personaId,
          targets: sample.mentions,
          context: 'comment',
          phase: 'bake',
          postId: sample.sourcePostId,
        });
      }
      if (replySamples.length > 0) {
        logEvent({
          eventType: 'reply_baked',
          agentname: agent.agentname,
          persona: agent.personaId,
          success: true,
          durationMs: replyBakeDurationMs,
          details: { count: replySamples.length },
        });
        for (const sample of replySamples) {
          if (!sample.mentions || sample.mentions.length === 0) continue;
          logMentions({
            agentname: agent.agentname,
            persona: agent.personaId,
            targets: sample.mentions,
            context: 'reply',
            phase: 'bake',
            postId: sample.sourcePostId,
          });
        }
      }
    } catch (err) {
      failed++;
      log('error', `  failed to bake comments for @${agent.agentname}: ${err}`);
      bar.tick(`@${agent.agentname} — failed`);
      logEvent({
        eventType: 'comment_baked',
        agentname: agent.agentname,
        persona: agent.personaId,
        success: false,
        durationMs: Date.now() - commentBakeStartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bar.done(
    `comment samples — ${baked} agents baked (${repliesBaked} replies), ${skipped} skipped, ${failed} failed`,
  );
  return {
    commentsBaked: baked,
    commentsSkipped: skipped,
    commentsFailed: failed,
    repliesBaked,
  };
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
  voiceProfile: VoiceProfile,
  postNumber: number,
  totalPosts: number,
  priorPosts: PostContent[],
  peerPosts: PostContent[],
): Promise<PostContent & { chaos: boolean }> {
  // Roll chaos ONCE per post so retries stay in the same mode. Chaos posts
  // bypass the similarity gate entirely — off-register content is exactly
  // what we want, and running Jaccard against disciplined peers is noise.
  const chaos = rollChaos(persona);
  // Roll trending-hashtag injection ONCE per post (not per retry) so a single
  // post's identity stays stable across Jaccard-retry loops.
  const trendingHashtags = await rollTrendingHashtags(persona);
  if (chaos) {
    const candidate = await generatePostContent(
      persona,
      voiceProfile,
      postNumber,
      totalPosts,
      priorPosts,
      peerPosts,
      true,
      trendingHashtags,
    );
    return { ...candidate, chaos: true };
  }

  const corpus = [...priorPosts, ...peerPosts].map((p) => `${p.imagePrompt} ${p.caption}`);

  let best: PostContent | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < MAX_POST_ATTEMPTS; attempt++) {
    const candidate = await generatePostContent(
      persona,
      voiceProfile,
      postNumber,
      totalPosts,
      priorPosts,
      peerPosts,
      false,
      trendingHashtags,
    );

    if (corpus.length === 0) return { ...candidate, chaos: false };

    const candidateText = `${candidate.imagePrompt} ${candidate.caption}`;
    const score = maxSimilarity(candidateText, corpus);

    if (score < SIMILARITY_THRESHOLD) return { ...candidate, chaos: false };

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
  return { ...(best as PostContent), chaos: false };
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
    'Distribution',
    [
      `Agents: ${assignments.length}`,
      `Personas: ${personas.size}/${totalPersonas} covered`,
      `Voice profiles: ${voices.size}/${totalVoiceProfiles} covered`,
      `Top voices: ${top}`,
      `Rare voices: ${bottom}`,
    ].join('\n'),
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

/** Format a millisecond duration as `1h 02m 03s` / `2m 34s` / `4.2s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${String(remMin).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}
