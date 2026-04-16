import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, FEED_CACHE_MAX_AGE_MS } from '@/config';
import { confirmTarget } from '@/lib/confirm-target';
import {
  drainWrites,
  flushStats,
  initEventLogger,
  logEvent,
  logMentions,
  logSkippedAction,
  updateAgentCounts,
} from '@/lib/event-logger';
import { FeedCacheEmptyError, loadFeedCacheStrict } from '@/lib/feed-cache';
import { log } from '@/lib/logger';
import {
  buildCommentCandidates,
  parseResolvedMentions,
  resolveRelatedAgentnames,
  shouldIncludeMentionCandidates,
} from '@/lib/mentions';
import { rollTrendingHashtags } from '@/lib/trending-pool';
import * as ui from '@/lib/ui';
import { lurkFeedSlice } from '@/lib/views';
import { loadPersonas } from '@/personas/index';
import { InstaMoltApiError, InstaMoltClient } from '@/services/instamolt-api';
import { generateComment, generatePostContent, rollChaos } from '@/services/llm';
import type {
  AgentCommentsFile,
  CommentRegister,
  GeneratedAgent,
  Persona,
  RemotePost,
} from '@/types';
import { loadVoiceProfiles, resolveVoiceProfile } from '@/voice-profiles/index';

interface EngageOptions {
  agents?: number;
  actionsLimit?: number;
  loop?: boolean;
  /**
   * Debug-only: deterministically pick the first N agents by agentname
   * (ascending) instead of a random shuffle. Mirrors `publish-drafts
   * --limit-agents` so both phases hit the same subset across runs — designed
   * for the publish → engage --cycle-delay → reset --post-generate loop.
   */
  limitAgents?: number;
  /**
   * Debug-only: force a fixed inter-cycle sleep (in milliseconds) instead of
   * the default `randomInt(5min, 15min)`. Lets operators run a tight feedback
   * loop to eyeball agent behavior before committing to an overnight run.
   * Production seeding should leave this unset.
   */
  cycleDelayMs?: number;
  /**
   * Skip the interactive "confirm target URL" prompt. Under non-TTY the
   * prompt is already skipped so unattended runs don't hang; this flag is
   * for TTY-scripted runs where the operator has already eyeballed the
   * target and doesn't want to hand-confirm each invocation.
   */
  yes?: boolean;
}

const COMMENT_COOLDOWN_MS = 65_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Wall-clock post cadence gate. Returns true when the agent is due to post
 * based on `persona.postsPerDay` and its `lastPostedAt` timestamp.
 *
 * Posts are the one engage action NOT subject to `actionsLimit` — they fire
 * on persona cadence regardless of how many likes/comments/follows the agent
 * already performed this cycle. Previously the post step lived at the end of
 * the per-agent action loop gated by `actionsUsed < actionsLimit`, so the
 * 2-4 likes + 1-2 comments + 1-2 follows would routinely saturate the limit
 * (max demand 8 vs budget 5) and the post step never ran — even when the
 * persona's `postsPerDay` rolled a hit. The fix: split posts out as their
 * own cadence-gated channel, independent of the reactive engagement budget.
 *
 * The gate uses the average of the persona's postsPerDay range to derive a
 * base gap (24h / avg), then jitters ±20% per check so agents with identical
 * cadences don't synchronize their posting. First post (no `lastPostedAt`)
 * is always eligible. Personas with `postsPerDay = [0, 0]` never post.
 */
export function shouldPostThisCycle(
  lastPostedAt: string | undefined,
  postsPerDay: readonly [number, number],
  now: number = Date.now(),
  random: () => number = Math.random,
): boolean {
  const [minPerDay, maxPerDay] = postsPerDay;
  const avgPerDay = (minPerDay + maxPerDay) / 2;
  if (avgPerDay <= 0) return false;
  if (!lastPostedAt) return true;

  const lastMs = Date.parse(lastPostedAt);
  if (Number.isNaN(lastMs)) return true;

  const baseGapMs = MS_PER_DAY / avgPerDay;
  const jitter = 0.8 + random() * 0.4;
  const targetGapMs = baseGapMs * jitter;
  return now - lastMs >= targetGapMs;
}

/**
 * Flatten an unknown error into the detail shape the event logger uses to
 * build its `errors.jsonl` rows. Preserves HTTP status + retry-after when
 * the error came from the platform API client, so 429s and server-side
 * failures are distinguishable from LLM / network / logic errors.
 */
function errorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof InstaMoltApiError) {
    return {
      httpStatus: err.status,
      retryAfterMs: err.retryAfterMs,
      requestContext: { method: err.method, path: err.path },
    };
  }
  if (err instanceof Error && err.stack) return { stack: err.stack };
  return {};
}

/**
 * Engagement-probability multiplier applied when the post author's persona is
 * in one of the commenting persona's relationship buckets. Higher = more
 * likely to engage with that author. The numbers are gentle enough that an
 * unrelated post still gets engagement (multiplier 1.0) but rivals/targets
 * pull the dice meaningfully toward action.
 */
const RELATIONSHIP_WEIGHT: Record<keyof Persona['relationships'], number> = {
  targets: 2.0, // strongest signal — picks fights
  amplifies: 1.8, // boosts the same authors repeatedly
  rivals: 1.5, // arguments
  allies: 1.2, // mutual love
};

/**
 * Look up which relationship bucket (if any) the post author's persona id
 * falls into, from the perspective of the commenting persona. Returns
 * `undefined` when there's no relationship — callers default to neutral
 * weight 1.0 and an unset register hint in that case.
 */
function relationshipBucket(
  commenterPersona: Persona,
  postAuthorPersonaId: string | undefined,
): keyof Persona['relationships'] | undefined {
  if (!postAuthorPersonaId) return undefined;
  const r = commenterPersona.relationships;
  // Order matters when an id appears in multiple buckets — `targets` is the
  // strongest signal so it wins, then amplifies, rivals, allies.
  if (r.targets.includes(postAuthorPersonaId)) return 'targets';
  if (r.amplifies.includes(postAuthorPersonaId)) return 'amplifies';
  if (r.rivals.includes(postAuthorPersonaId)) return 'rivals';
  if (r.allies.includes(postAuthorPersonaId)) return 'allies';
  return undefined;
}

/**
 * Engagement-probability multiplier for a (commenter, postAuthor) pair.
 * Returns 1.0 when there's no relationship.
 */
function relationshipMultiplier(
  commenterPersona: Persona,
  postAuthorPersonaId: string | undefined,
): number {
  const bucket = relationshipBucket(commenterPersona, postAuthorPersonaId);
  return bucket ? RELATIONSHIP_WEIGHT[bucket] : 1.0;
}

/**
 * Pick a `CommentRegister` for `generateComment` based on the relationship
 * between the commenting persona and the post author's persona. Returns
 * `undefined` when there's no relationship — Gemini then picks freely from
 * all 5 example registers.
 *
 * Two buckets (`targets`, `allies`) randomize between two options because the
 * action they describe is ambiguous: targeting can be either disagreement or
 * a leading question, and allyship can be either a love-react or an
 * affirming reply. The other buckets pick a single register deterministically.
 */
function pickRegisterHint(
  commenterPersona: Persona,
  postAuthorPersonaId: string | undefined,
): CommentRegister | undefined {
  const bucket = relationshipBucket(commenterPersona, postAuthorPersonaId);
  if (!bucket) return undefined;
  switch (bucket) {
    case 'targets':
      return Math.random() < 0.6 ? 'disagree' : 'conversational';
    case 'rivals':
      return 'disagree';
    case 'amplifies':
      return 'love';
    case 'allies':
      return Math.random() < 0.5 ? 'love' : 'reply';
  }
}

/**
 * Maximum runtime comments retained in `runtime-comments.json` per agent.
 * Keeps the avoid-list bounded so an agent that has been engaging for weeks
 * doesn't snowball into a multi-MB file or a multi-thousand-token prompt
 * (the inner `slice(-6)` inside `generateComment` would still cap that, but
 * a tight on-disk cap keeps the file readable and the load fast).
 */
const RUNTIME_COMMENTS_MAX = 50;

/**
 * Sibling file to `comments.json` that holds the rolling tail of comments
 * an agent has actually posted during `engage` cycles. Loaded on cycle
 * start (alongside the bake-time samples) so the avoid-list reflects what
 * the agent has been saying lately, not just what it said at bake time.
 *
 * Kept separate from `comments.json` so the bake-time artifact remains
 * pristine and editable for curation — `runtime-comments.json` is purely
 * a runtime cache.
 */
interface RuntimeCommentsFile {
  agentname: string;
  comments: Array<{
    text: string;
    generatedAt: string;
    againstPostId?: string;
    againstAuthor?: string;
  }>;
}

export async function engage(options: EngageOptions = {}): Promise<void> {
  const maxAgents = options.agents ?? 10;
  const actionsLimit = options.actionsLimit ?? 5;
  const loopEnabled = options.loop ?? false;
  const limitAgents = options.limitAgents;
  const cycleDelayMs = options.cycleDelayMs;
  const personas = await loadPersonas();
  const voiceProfiles = loadVoiceProfiles();

  // Structured event logging (output/logs/). Tolerates a prior session
  // within 24h — counters resume instead of zeroing, so an overnight
  // `--loop` that spans multiple process starts produces a single
  // continuous stats.json.
  initEventLogger();

  let cycleNumber = 0;

  ui.intro('Engage');

  if (!(await confirmTarget('engage', { yes: options.yes }))) {
    ui.outro(ui.color.yellow(`${ui.symbol.warn} engage aborted — target not confirmed`));
    return;
  }

  // SIGINT handling for graceful shutdown of the outer --loop. Registered
  // after the target check so a declined confirmation doesn't leak the
  // listener across repeated in-process calls.
  let stopRequested = false;
  const onSigint = () => {
    if (!stopRequested) {
      log('info', 'SIGINT received — finishing current cycle then exiting loop.');
      stopRequested = true;
    }
  };
  if (loopEnabled) {
    process.on('SIGINT', onSigint);
  }

  try {
    do {
      // Load all registered agents
      const allAgents = await loadRegisteredAgents();
      if (allAgents.length === 0) {
        log('error', 'No registered agents found. Run `generate` then `publish` first.');
        ui.outro(ui.color.red(`${ui.symbol.err} engage aborted`));
        return;
      }

      // Pick the active subset for this cycle.
      // - Default: random shuffle, take `maxAgents`.
      // - Debug: `--limit-agents N` deterministically takes the first N
      //   agents by agentname (ascending) so repeat invocations hit the same
      //   subset. Mirrors `publish-drafts --limit-agents`.
      // Non-positive `limitAgents` values (0 or negative) are already rejected
      // by the flag parser, but defensively normalize here so the selector
      // only activates on a real positive integer.
      const normalizedLimitAgents =
        limitAgents !== undefined && limitAgents > 0 ? limitAgents : undefined;
      const ordered =
        normalizedLimitAgents !== undefined
          ? [...allAgents].sort((a, b) => a.agentname.localeCompare(b.agentname))
          : shuffle(allAgents);
      const subsetCap =
        normalizedLimitAgents !== undefined
          ? Math.min(normalizedLimitAgents, maxAgents)
          : maxAgents;
      const selected = ordered.slice(0, Math.min(subsetCap, ordered.length));
      cycleNumber++;
      const cycleStartedAt = Date.now();
      updateAgentCounts(allAgents.length, selected.length);
      logEvent({
        eventType: 'session_start',
        success: true,
        details: {
          command: 'engage',
          cycleNumber,
          agentsTargeted: selected.length,
          totalRegistered: allAgents.length,
          actionsLimit,
          loopEnabled,
        },
      });

      // Build a global agentname → personaId lookup so the like/comment/follow
      // loops can resolve a post author's persona without re-reading the
      // agent.json files. Built from `allAgents` (not just the selected
      // subset) because the explore feed will surface posts from any
      // registered agent, not just the ones acting this cycle.
      const agentnameToPersonaId = new Map<string, string>();
      const personaToAgentnames = new Map<string, string[]>();
      const knownAgentnames = new Set<string>();
      for (const a of allAgents) {
        agentnameToPersonaId.set(a.agentname, a.personaId);
        knownAgentnames.add(a.agentname);
        const list = personaToAgentnames.get(a.personaId) ?? [];
        list.push(a.agentname);
        personaToAgentnames.set(a.personaId, list);
      }

      // Load the shared feed cache ONCE per cycle — every agent below reads
      // from this snapshot instead of hitting /feed/explore per-agent. The
      // strict loader throws on empty/refresh-failure; we let it propagate
      // because the cycle has nothing legitimate to do with no live content.
      // Any apiKey works (cache reads are unauthenticated); we borrow one
      // from the first registered agent.
      const feedClient = new InstaMoltClient(allAgents[0]?.apiKey);
      let feedCache: { posts: RemotePost[] };
      try {
        feedCache = await loadFeedCacheStrict(feedClient, { maxAgeMs: FEED_CACHE_MAX_AGE_MS });
        logEvent({
          eventType: 'feed_refresh',
          success: true,
          details: { postCount: feedCache.posts.length },
        });
      } catch (err) {
        if (err instanceof FeedCacheEmptyError) {
          log('error', `Live feed is empty — aborting cycle. ${err.message}`);
        } else {
          log('error', `Feed cache load failed: ${err}`);
        }
        logEvent({
          eventType: 'feed_refresh',
          success: false,
          error: err instanceof Error ? err.message : String(err),
          details: errorDetails(err),
        });
        throw err;
      }
      const feedPosts = feedCache.posts;

      ui.section(`Cycle — ${selected.length} agents, up to ${actionsLimit} actions each`);

      let cycleLikes = 0;
      let cycleComments = 0;
      let cycleFollows = 0;
      let cyclePosts = 0;
      let cycleViews = 0;
      let cycleErrors = 0;

      for (let i = 0; i < selected.length; i++) {
        const agent = selected[i];
        const persona = personas.get(agent.personaId);
        if (!persona) {
          log('warn', `Persona ${agent.personaId} not found, skipping ${agent.agentname}`);
          continue;
        }

        const sp = ui.spinner();
        sp.start(`@${agent.agentname} (${persona.id}) — starting`);

        // Re-read agent.json so we pick up cross-run state (e.g. lastCommentedAt
        // written by a previous engage cycle in --loop mode).
        const agentJsonPath = join(config.agentsDir, agent.agentname, 'agent.json');
        let agentData: GeneratedAgent;
        try {
          const raw = await readFile(agentJsonPath, 'utf-8');
          agentData = JSON.parse(raw) as GeneratedAgent;
        } catch {
          agentData = { ...agent } as GeneratedAgent;
        }
        let agentDataDirty = false;

        // Load baked comment samples (if any) so generateComment has voice
        // anchors to avoid repeating. Missing file is fine — agents created
        // before the comment-baking phase shipped will just start with an
        // empty avoid list.
        const priorCommentTexts: string[] = await loadPriorComments(agent.agentname);

        const client = new InstaMoltClient(agent.apiKey);
        let actionsUsed = 0;

        try {
          // 1. Read the shared feed snapshot loaded at cycle start. Every
          // agent sees the same live content — shuffle for per-agent order
          // variety, then filter out the agent's own posts.
          sp.message(`@${agent.agentname} — scanning live feed (${feedPosts.length} posts)`);
          const shuffledPosts = shuffle(feedPosts);
          const otherPosts = shuffledPosts.filter((p) => p.author.agentname !== agent.agentname);

          // 1a. Lurk pass — the agent reads the top N posts in its sliced
          // feed window with its own bearer token, registering as a viewer
          // server-side. This is the "scrolling past most posts without
          // engaging" behavior that produces views >> engagement events
          // and keeps the platform's view-to-like / view-to-comment ratios
          // in a believable range. Server-side dedup means re-running
          // within 24h is a no-op per (viewer, post) pair.
          //
          // Gated on `persona.viewProbability` so low-activity archetypes
          // (observers, near-dormant) scroll less than high-activity ones
          // (engagement-maxxing chronic scrollers). Uniform per-agent
          // lurking across the fleet violates CLAUDE.md's heterogeneity
          // rule for new engagement behaviors.
          if (
            config.lurkViewsPerAgent > 0 &&
            persona.viewProbability > 0 &&
            Math.random() < persona.viewProbability
          ) {
            sp.message(`@${agent.agentname} — lurking ${config.lurkViewsPerAgent} posts`);
            const lurk = await lurkFeedSlice({
              client,
              agentname: agent.agentname,
              personaId: agent.personaId,
              posts: otherPosts,
              count: config.lurkViewsPerAgent,
              concurrency: config.viewConcurrency,
            });
            cycleViews += lurk.succeeded;
          }

          // 2. Like posts
          const likesTarget = randomInt(2, 4);
          let liked = 0;
          for (const post of otherPosts) {
            if (liked >= likesTarget || actionsUsed >= actionsLimit) break;
            // Apply relationship multiplier so an agent is more likely to
            // like posts from personas it has a typed relationship with.
            // Unrelated authors get the persona's base likeProbability.
            const authorPid = agentnameToPersonaId.get(post.author.agentname);
            const likeMult = relationshipMultiplier(persona, authorPid);
            const adjustedLikeProb = Math.min(1, persona.likeProbability * likeMult);
            if (Math.random() > adjustedLikeProb) continue;

            const likeStartedAt = Date.now();
            try {
              const res = await client.likePost(post.id);
              // Re-toggle if the first call un-liked (server toggle semantics).
              if (res.liked === false) await client.likePost(post.id);
              liked++;
              actionsUsed++;
              cycleLikes++;
              sp.message(
                `@${agent.agentname} — liked @${post.author.agentname} (${liked}/${likesTarget})`,
              );
              logEvent({
                eventType: 'like',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: true,
                durationMs: Date.now() - likeStartedAt,
                details: { postId: post.id, targetAuthor: post.author.agentname },
              });
              await sleep(randomInt(3000, 10000));
            } catch (err) {
              cycleErrors++;
              log('warn', `Like failed: ${err}`);
              logEvent({
                eventType: 'like',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: false,
                durationMs: Date.now() - likeStartedAt,
                error: err instanceof Error ? err.message : String(err),
                details: {
                  postId: post.id,
                  targetAuthor: post.author.agentname,
                  ...errorDetails(err),
                },
              });
            }
          }

          // 3. Comment on posts (subject to per-agent 60s cooldown)
          // Reorder otherPosts so relationship-relevant authors come first.
          // This makes the registerHint pathway hit more often without
          // changing the rest of the iteration semantics — comments still
          // walk top-to-bottom until commentsTarget is hit. Unrelated posts
          // remain in shuffled order at the tail.
          const commentablePosts = [...otherPosts]
            .map((post) => {
              const pid = agentnameToPersonaId.get(post.author.agentname);
              const bucket = relationshipBucket(persona, pid);
              const score = bucket ? RELATIONSHIP_WEIGHT[bucket] : 1.0;
              return { post, score };
            })
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.post);

          let commented = 0;
          const lastCommentedAt = agentData.lastCommentedAt
            ? Date.parse(agentData.lastCommentedAt)
            : 0;
          const sinceLastComment = Date.now() - lastCommentedAt;
          if (lastCommentedAt && sinceLastComment < COMMENT_COOLDOWN_MS) {
            sp.message(`@${agent.agentname} — comment cooldown active, skipping`);
            logSkippedAction(
              'comment',
              agent.agentname,
              agent.personaId,
              `cooldown: ${Math.round((COMMENT_COOLDOWN_MS - sinceLastComment) / 1000)}s remaining`,
            );
          } else {
            const commentsTarget = randomInt(1, 2);
            for (const post of commentablePosts) {
              if (commented >= commentsTarget || actionsUsed >= actionsLimit) break;
              if (!post.caption) continue;

              // Gate on the persona's commentProbability, scaled by the
              // relationship multiplier — mirrors the like-loop pattern so
              // low-comment lurkers stay quiet and high-comment reply-guys
              // stay chatty. Without this, every persona was guaranteed 1–2
              // comment attempts per cycle once cooldown cleared, which made
              // persona.commentProbability dead weight.
              const authorPid = agentnameToPersonaId.get(post.author.agentname);
              const commentMult = relationshipMultiplier(persona, authorPid);
              const adjustedCommentProb = Math.min(1, persona.commentProbability * commentMult);
              if (Math.random() > adjustedCommentProb) continue;

              const commentStartedAt = Date.now();
              try {
                // Pick a comment register hint based on the relationship
                // between this agent's persona and the post author's persona.
                // Returns undefined for unrelated posts — generateComment then
                // lets Gemini pick freely from all 5 example registers.
                const registerHint = pickRegisterHint(persona, authorPid);
                sp.message(`@${agent.agentname} — writing comment for @${post.author.agentname}`);

                // Mention candidate surfacing — roll the persona's mention
                // probability (rare by default). On a hit, pull up to 2
                // related agentnames from the allies/amplifies/rivals
                // graph and add the post author. Empty list on a failed
                // roll skips the prompt block entirely.
                const mentionCandidates = shouldIncludeMentionCandidates(
                  persona.mentionProbability,
                  'comment',
                )
                  ? buildCommentCandidates({
                      selfAgentname: agentData.agentname,
                      postAuthor: post.author.agentname,
                      relatedAgentnames: resolveRelatedAgentnames(
                        persona,
                        personaToAgentnames,
                        agentData.agentname,
                      ),
                    })
                  : [];

                // Snapshot the avoid list at call time (matches the pattern in
                // generate.ts) so post-call mutations of `priorCommentTexts`
                // don't retroactively change what was passed for an earlier
                // call — important for tests that inspect mock call args.
                const comment = await generateComment(
                  persona,
                  { agentname: agentData.agentname, bio: agentData.bio },
                  post.caption,
                  post.author.agentname,
                  [...priorCommentTexts],
                  registerHint,
                  rollChaos(persona),
                  mentionCandidates,
                );
                const commentRes = await client.commentOnPost(post.id, comment);
                commented++;
                actionsUsed++;
                cycleComments++;
                agentData.lastCommentedAt = new Date().toISOString();
                agentDataDirty = true;
                // Append to the in-memory avoid list so a second comment in
                // the same cycle won't repeat the first one's opening.
                priorCommentTexts.push(comment);
                // Persist to runtime-comments.json so the avoid-list survives
                // across cycles. Without this, an agent running in --loop for
                // weeks would only ever see its 3 baked samples and would
                // visibly drift into repetition.
                await appendRuntimeComment(agentData.agentname, {
                  text: comment,
                  againstPostId: post.id,
                  againstAuthor: post.author.agentname,
                });
                sp.message(
                  `@${agent.agentname} — commented on @${post.author.agentname}: "${comment.slice(0, 40)}..."`,
                );
                logEvent({
                  eventType: 'comment',
                  agentname: agent.agentname,
                  persona: agent.personaId,
                  success: true,
                  durationMs: Date.now() - commentStartedAt,
                  details: {
                    postId: post.id,
                    targetAuthor: post.author.agentname,
                    registerHint,
                    preview: comment.slice(0, 80),
                  },
                });
                // Emit one `mention` event per resolved target. Runs AFTER
                // the `comment` event so the events.jsonl order is
                // `comment → mention...` and `stats.mentions` is only
                // credited when the underlying comment succeeded. Short-
                // circuit on `!includes('@')` — the overwhelming majority
                // of comments have no mention so we skip the regex walk.
                if (comment.includes('@')) {
                  const resolvedMentions = parseResolvedMentions(
                    comment,
                    agentData.agentname,
                    knownAgentnames,
                    // Live post author isn't necessarily seeder-managed —
                    // union into the per-call resolution set so mentions
                    // of real platform users aren't silently dropped.
                    [post.author.agentname],
                  );
                  if (resolvedMentions.length > 0) {
                    logMentions({
                      agentname: agent.agentname,
                      persona: agent.personaId,
                      targets: resolvedMentions,
                      context: 'comment',
                      phase: 'runtime',
                      postId: post.id,
                      sourceCommentId: commentRes.comment.id,
                    });
                  }
                }
                await sleep(randomInt(10000, 30000));
              } catch (err) {
                cycleErrors++;
                log('warn', `Comment failed: ${err}`);
                logEvent({
                  eventType: 'comment',
                  agentname: agent.agentname,
                  persona: agent.personaId,
                  success: false,
                  durationMs: Date.now() - commentStartedAt,
                  error: err instanceof Error ? err.message : String(err),
                  details: {
                    postId: post.id,
                    targetAuthor: post.author.agentname,
                    ...errorDetails(err),
                  },
                });
              }
            }
          }

          // 4. Follow agents
          const followsTarget = randomInt(1, 2);
          let followed = 0;
          const seenAgents = new Set<string>();
          for (const post of otherPosts) {
            if (followed >= followsTarget || actionsUsed >= actionsLimit) break;
            if (seenAgents.has(post.author.agentname)) continue;
            seenAgents.add(post.author.agentname);

            // Same relationship multiplier pattern as the like loop — agents
            // are more likely to follow personas they have a typed link with.
            const followAuthorPid = agentnameToPersonaId.get(post.author.agentname);
            const followMult = relationshipMultiplier(persona, followAuthorPid);
            const adjustedFollowProb = Math.min(1, persona.followProbability * followMult);
            if (Math.random() > adjustedFollowProb) continue;

            const followStartedAt = Date.now();
            try {
              const res = await client.followAgent(post.author.agentname);
              // Re-toggle if the first call unfollowed (server toggle semantics).
              if (res.following === false) await client.followAgent(post.author.agentname);
              followed++;
              actionsUsed++;
              cycleFollows++;
              sp.message(`@${agent.agentname} — followed @${post.author.agentname}`);
              logEvent({
                eventType: 'follow',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: true,
                durationMs: Date.now() - followStartedAt,
                details: { targetAuthor: post.author.agentname },
              });
              await sleep(randomInt(5000, 15000));
            } catch (err) {
              cycleErrors++;
              log('warn', `Follow failed: ${err}`);
              logEvent({
                eventType: 'follow',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: false,
                durationMs: Date.now() - followStartedAt,
                error: err instanceof Error ? err.message : String(err),
                details: {
                  targetAuthor: post.author.agentname,
                  ...errorDetails(err),
                },
              });
            }
          }

          // 5. Optionally create a new post.
          //
          // Posts are NOT subject to `actionsLimit` — they fire on wall-clock
          // persona cadence (`postsPerDay`) via `shouldPostThisCycle`, not on
          // the reactive-engagement budget. See the helper's docblock for the
          // history of why the old actionsLimit-gated path was broken.
          if (shouldPostThisCycle(agentData.lastPostedAt, persona.postsPerDay)) {
            const resolved = resolveVoiceProfile(voiceProfiles, agent);
            if ('error' in resolved) {
              cycleErrors++;
              log('warn', `${resolved.error}, skipping post`);
              logEvent({
                eventType: 'post_published',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: false,
                error: resolved.error,
                details: { voiceProfileId: agent.voiceProfileId },
              });
            } else {
              const voiceProfile = resolved.profile;
              const postStartedAt = Date.now();
              try {
                sp.message(`@${agent.agentname} — generating a fresh post`);
                const trendingHashtags = await rollTrendingHashtags(persona);
                const content = await generatePostContent(
                  persona,
                  voiceProfile,
                  1,
                  1,
                  [],
                  [],
                  rollChaos(persona),
                  trendingHashtags,
                );
                const postClient = new InstaMoltClient(agent.apiKey);
                const result = await postClient.generatePost({
                  prompt: content.imagePrompt,
                  caption: content.caption,
                  aspect_ratio: content.aspectRatio,
                });

                cyclePosts++;
                agentData.lastPostedAt = new Date().toISOString();
                agentDataDirty = true;
                sp.message(`@${agent.agentname} — posted ${result.post.id}`);
                logEvent({
                  eventType: 'post_published',
                  agentname: agent.agentname,
                  persona: agent.personaId,
                  success: true,
                  durationMs: Date.now() - postStartedAt,
                  details: {
                    postId: result.post.id,
                    caption: content.caption.slice(0, 80),
                  },
                });
              } catch (err) {
                cycleErrors++;
                log('warn', `Post creation failed: ${err}`);
                logEvent({
                  eventType: 'post_published',
                  agentname: agent.agentname,
                  persona: agent.personaId,
                  success: false,
                  durationMs: Date.now() - postStartedAt,
                  error: err instanceof Error ? err.message : String(err),
                  details: errorDetails(err),
                });
              }
            }
          }

          sp.stop(
            `@${agent.agentname} — ${actionsUsed} actions (${liked} likes, ${commented} comments, ${followed} follows)`,
          );
        } catch (err) {
          cycleErrors++;
          sp.stop(`@${agent.agentname} — cycle failed: ${err}`, 1);
        }

        // Persist any per-agent state changes (e.g. lastCommentedAt) before moving on.
        if (agentDataDirty) {
          try {
            await writeFile(agentJsonPath, JSON.stringify(agentData, null, 2), 'utf-8');
          } catch (err) {
            log('warn', `  Failed to persist agent.json for @${agent.agentname}: ${err}`);
          }
        }

        // Stagger between agents: 30-60 seconds by default, or a fixed
        // cycleDelayMs for debug/speed-run previews (same knob as the
        // inter-cycle sleep).
        if (i < selected.length - 1) {
          const gap = cycleDelayMs ?? randomInt(30000, 60000);
          await staggerSleep(gap);
        }
      }

      ui.note(
        'Cycle complete',
        ui.summaryLine([
          { label: 'likes', value: cycleLikes, tone: 'ok' },
          { label: 'comments', value: cycleComments, tone: 'ok' },
          { label: 'follows', value: cycleFollows, tone: 'ok' },
          { label: 'posts', value: cyclePosts, tone: 'info' },
          { label: 'views', value: cycleViews, tone: 'info' },
          { label: 'errors', value: cycleErrors, tone: cycleErrors > 0 ? 'err' : 'info' },
        ]),
      );

      logEvent({
        eventType: 'session_end',
        success: true,
        durationMs: Date.now() - cycleStartedAt,
        details: {
          cycleNumber,
          likes: cycleLikes,
          comments: cycleComments,
          follows: cycleFollows,
          posts: cyclePosts,
          views: cycleViews,
          errors: cycleErrors,
        },
      });
      await drainWrites();
      flushStats();

      if (loopEnabled && !stopRequested) {
        const wait = cycleDelayMs ?? randomInt(5 * 60 * 1000, 15 * 60 * 1000);
        await loopSleep(wait, () => stopRequested);
      }
    } while (loopEnabled && !stopRequested);
  } finally {
    if (loopEnabled) {
      process.removeListener('SIGINT', onSigint);
    }
    flushStats();
    ui.outro(ui.color.green(`${ui.symbol.ok} engage finished`));
  }
}

/**
 * Inter-agent delay. Under TTY, render a live countdown spinner so the
 * operator sees progress; under non-TTY, emit a single log line so Docker
 * journals don't fill up with redraw noise.
 */
async function staggerSleep(ms: number): Promise<void> {
  if (!ui.isInteractive()) {
    log('info', `Waiting ${(ms / 1000).toFixed(0)}s before next agent...`);
    await sleep(ms);
    return;
  }
  const sp = ui.spinner();
  const end = Date.now() + ms;
  sp.start(`waiting ${(ms / 1000).toFixed(0)}s before next agent`);
  while (Date.now() < end) {
    const remaining = Math.max(0, Math.round((end - Date.now()) / 1000));
    sp.message(`waiting ${remaining}s before next agent`);
    await sleep(Math.min(1000, end - Date.now()));
  }
  sp.stop('next agent');
}

/**
 * Loop-mode inter-cycle sleep. Same TTY-aware split as staggerSleep.
 * Polls `shouldStop()` every second so SIGINT during the wait exits cleanly.
 */
async function loopSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  if (!ui.isInteractive()) {
    log('info', `Loop mode: sleeping ${(ms / 1000).toFixed(0)}s before next cycle...`);
    const tick = 1000;
    let remaining = ms;
    while (remaining > 0 && !shouldStop()) {
      await sleep(Math.min(tick, remaining));
      remaining -= tick;
    }
    return;
  }
  const sp = ui.spinner();
  const end = Date.now() + ms;
  sp.start(`sleeping ${(ms / 1000).toFixed(0)}s before next cycle`);
  while (Date.now() < end && !shouldStop()) {
    const remaining = Math.max(0, Math.round((end - Date.now()) / 1000));
    sp.message(`sleeping ${remaining}s before next cycle (Ctrl+C to stop)`);
    await sleep(Math.min(1000, end - Date.now()));
  }
  sp.stop(shouldStop() ? 'stop requested' : 'starting next cycle');
}

// --- Helpers ---

async function loadRegisteredAgents(): Promise<GeneratedAgent[]> {
  const agents: GeneratedAgent[] = [];
  try {
    const dirs = await readdir(config.agentsDir);
    for (const dir of dirs) {
      try {
        const raw = await readFile(join(config.agentsDir, dir, 'agent.json'), 'utf-8');
        const agent: GeneratedAgent = JSON.parse(raw);
        if (agent.apiKey) agents.push(agent);
      } catch {}
    }
  } catch {}
  return agents;
}

/**
 * Load the agent's baked comment samples (if any) PLUS the rolling tail of
 * runtime comments persisted by previous engage cycles, returning a combined
 * avoid-list ready to pass into `generateComment`.
 *
 * The two halves come from different files:
 *   - `comments.json` is the bake-time artifact written by `generate` (kept
 *     pristine for curation — never appended to at runtime).
 *   - `runtime-comments.json` is a sibling file maintained by `engage`
 *     itself: each successful comment is appended (capped at the last
 *     `RUNTIME_COMMENTS_MAX`) so the avoid-list reflects what the agent
 *     has been saying lately, not just what it said at bake time.
 *
 * Without the runtime tail, an agent running in `engage --loop` for days
 * would still see only its 3 baked samples as the avoid list and would
 * visibly drift into repetition. Both files missing is silently treated as
 * "no prior comments" so populations created before this shipped still
 * work without a backfill migration.
 */
async function loadPriorComments(agentname: string): Promise<string[]> {
  const out: string[] = [];

  // Bake-time samples (persona/voice anchors). Read first so the runtime
  // tail appears AFTER them in the avoid list — `generateComment` slices
  // to the last 6, so the most-recent-runtime entries always make the cut.
  try {
    const raw = await readFile(join(config.agentsDir, agentname, 'comments.json'), 'utf-8');
    const parsed = JSON.parse(raw) as AgentCommentsFile;
    if (Array.isArray(parsed.samples)) {
      for (const s of parsed.samples) {
        if (typeof s.text === 'string' && s.text.length > 0) out.push(s.text);
      }
    }
  } catch {}

  // Runtime tail (last RUNTIME_COMMENTS_MAX comments this agent has posted).
  try {
    const raw = await readFile(join(config.agentsDir, agentname, 'runtime-comments.json'), 'utf-8');
    const parsed = JSON.parse(raw) as RuntimeCommentsFile;
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (c && typeof c.text === 'string' && c.text.length > 0) out.push(c.text);
      }
    }
  } catch {}

  return out;
}

/**
 * Append a freshly-generated comment to the agent's `runtime-comments.json`
 * file, trimming to the last `RUNTIME_COMMENTS_MAX` entries. Failure is
 * logged but does not block the engage cycle — the avoid-list will simply
 * be shorter on the next cycle.
 */
async function appendRuntimeComment(
  agentname: string,
  entry: { text: string; againstPostId?: string; againstAuthor?: string },
): Promise<void> {
  const path = join(config.agentsDir, agentname, 'runtime-comments.json');

  // Read-modify-write. Concurrent engage instances against the same agent
  // would race here, but `engage` is single-process and processes agents
  // sequentially within a cycle, so a race is not possible today.
  let existing: RuntimeCommentsFile;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as RuntimeCommentsFile;
    existing = {
      agentname,
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    };
  } catch {
    existing = { agentname, comments: [] };
  }

  existing.comments.push({
    text: entry.text,
    generatedAt: new Date().toISOString(),
    againstPostId: entry.againstPostId,
    againstAuthor: entry.againstAuthor,
  });

  // Trim to the last RUNTIME_COMMENTS_MAX entries.
  if (existing.comments.length > RUNTIME_COMMENTS_MAX) {
    existing.comments = existing.comments.slice(-RUNTIME_COMMENTS_MAX);
  }

  try {
    await writeFile(path, JSON.stringify(existing, null, 2), 'utf-8');
  } catch (err) {
    log('warn', `  Failed to append runtime comment for @${agentname}: ${err}`);
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
