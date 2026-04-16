/**
 * Continuous engagement scheduler — `pnpm engage-continuous`.
 *
 * Runs a priority-queue-driven loop where ONE action fires per agent-tick
 * across the whole registered population. Each tick:
 *
 *   1. Pop the soonest-due agent from the scheduler.
 *   2. Wait until that tick's timestamp arrives (if in the future).
 *   3. Enforce a global minimum gap between any two actions.
 *   4. Lazy-refresh the feed cache if stale.
 *   5. Re-scan the agents directory for newly-created agents (every 5 min).
 *   6. Load the agent's quota file; roll over stale history.
 *   7. Pick a weighted-random action kind (or skip if everything is capped).
 *   8. Dispatch the action via the shared executors.
 *   9. Reschedule the agent.
 *
 * Agents are enrolled on startup from the full set of registered agents
 * (those with `apiKey` in `agent.json`). New agents are auto-enrolled via
 * periodic directory rescans so `generate` + `publish` can run alongside
 * a long-lived `engage-continuous` process.
 *
 * Graceful shutdown: SIGINT sets `stopRequested = true` → the current tick
 * finishes → the loop exits → `ui.outro`.
 */

import { spawn } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACTION_BASE_WEIGHTS,
  ACTION_WEIGHT_TIER_MULTIPLIERS,
  ACTIVITY_REPLY_PROBABILITY,
  AGENT_RESCAN_INTERVAL_MS,
  config,
  FEED_CACHE_DEFAULT_LIMIT,
  FEED_CACHE_DEFAULT_PAGES,
  FEED_CACHE_MAX_AGE_MS,
  GLOBAL_MAX_GAP_MS,
  GLOBAL_MIN_GAP_MS,
  getCurrentHour,
} from '@/config';
import { ActionScheduler } from '@/lib/action-scheduler';
import { confirmTarget } from '@/lib/confirm-target';
import { dispatchAction, type EngageContext } from '@/lib/engage-actions';
import {
  drainWrites,
  flushStats,
  initEventLogger,
  logEvent,
  updateAgentCounts,
} from '@/lib/event-logger';
import {
  createLiveFeedCache,
  evictStale,
  type LiveFeedCache,
  loadFeedCache,
  refreshFeedCache,
} from '@/lib/feed-cache';
import { pickBurstTargets } from '@/lib/follow-burst';
import {
  computeBatchSize,
  formatGrowthStatus,
  GROWTH_DEFAULTS,
  type GrowthConfig,
} from '@/lib/growth';
import { log } from '@/lib/logger';
import {
  checkAvailability,
  consume,
  loadOrInitQuota,
  maxPostsThisHour,
  persistQuota,
  postsInLastHour,
  quotaFilePath,
  usedInWindow,
} from '@/lib/quota';
import * as ui from '@/lib/ui';
import { lurkFeedSlice } from '@/lib/views';
import { loadPersonas } from '@/personas/index';
import { InstaMoltClient } from '@/services/instamolt-api';
import type { ActionKind, AgentQuota, GeneratedAgent, Persona, SeederEventType } from '@/types';
import { ACTION_KINDS } from '@/types';
import { loadVoiceProfiles } from '@/voice-profiles/index';

export interface ContinuousOptions {
  feedCacheMaxAgeMs?: number;
  feedCachePages?: number;
  feedCacheLimit?: number;
  globalMinGapMs?: number;
  globalMaxGapMs?: number;
  agentRescanIntervalMs?: number;
  dryRun?: boolean;
  maxActions?: number;
  /** Population ceiling. Growth stops here. Default 200. */
  maxAgents?: number;
  /** Logarithmic growth rate multiplier. Higher = faster early growth. Default 3. */
  growthRate?: number;
  /** Hours between growth ticks. Default 4. */
  growthIntervalHours?: number;
  /**
   * Minimum posts generated per new agent during growth. Default 10.
   * When `postsMax` is also set and greater, each growth-born agent rolls a
   * random post count in `[postsMin, postsMax]` so population variance looks
   * organic rather than batch-flat.
   */
  postsMin?: number;
  /** Maximum posts generated per new agent during growth. Defaults to `postsMin`. */
  postsMax?: number;
  /** Disable growth entirely (engage only, no new agents). */
  noGrowth?: boolean;
  /** Log every event to stdout in addition to events.jsonl. */
  verbose?: boolean;
  /**
   * Skip the interactive "confirm target URL" prompt. Under non-TTY the
   * prompt is already skipped so unattended runs (cron, Docker) don't hang;
   * this flag is for TTY-scripted runs where the operator has pre-confirmed.
   */
  yes?: boolean;
}

/**
 * Per-machine random offset (0-30 min) added to every growth-interval check.
 * Computed ONCE per process so the offset stays stable across ticks. With
 * 6 machines each rolling their own offset, coincidental growth ticks spread
 * across a 30-min window, keeping the Together AI fleet RPM below the 1,800
 * RPM Tier 2 ceiling. Irrelevant when running a single seeder instance.
 */
const GROWTH_OFFSET_MS = Math.random() * 30 * 60 * 1000;

/**
 * Spawn the `pnpm growth-tick` command as a detached child process. Engage
 * loop returns immediately; the child writes new agent files to disk, which
 * the next 5-min rescan auto-enrolls. Child crash does not affect the parent.
 *
 * stdout/stderr are captured and tee'd to `logEvent` so operator visibility
 * is preserved despite process decoupling. `child.unref()` lets the parent
 * exit cleanly even if the child is still running.
 */
function spawnGrowthTick(targetTotal: number, minPosts: number, maxPosts: number): void {
  const child = spawn(
    'pnpm',
    [
      'growth-tick',
      '--target',
      String(targetTotal),
      '--min-posts',
      String(minPosts),
      '--max-posts',
      String(maxPosts),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, GROWTH_TICK_CHILD: '1' },
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    logEvent({
      eventType: 'growth_child_stdout',
      success: true,
      details: { text: chunk.toString('utf8').trim(), targetTotal },
    });
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logEvent({
      eventType: 'growth_child_stderr',
      success: false,
      details: { text: chunk.toString('utf8').trim(), targetTotal },
    });
  });
  child.on('exit', (code) => {
    logEvent({
      eventType: 'growth_child_exit',
      success: code === 0,
      details: { code, targetTotal },
    });
  });

  child.unref();
}

/**
 * Load all registered agents from disk — same pattern as engage.ts's
 * `loadRegisteredAgents`. Does NOT throw on per-agent read failures.
 */
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
 * Minimum activity-curve weight below which `post` actions are suppressed.
 * Off-peak activity should be lightweight (likes, comment-likes) — the
 * phone-check-at-2am pattern where you scroll and maybe like something
 * but you don't create original content.
 */
/** Map ActionKind → SeederEventType. `post` → `post_published`, `commentLike` → `comment_like`. */
function actionToEventType(kind: ActionKind): SeederEventType {
  if (kind === 'post') return 'post_published';
  if (kind === 'commentLike') return 'comment_like';
  return kind;
}

const POST_SUPPRESSION_THRESHOLD = 0.15;

/**
 * Weighted-random action picker. Returns null when every kind is either
 * exhausted or on cooldown. Uses `usedInWindow` (sliding-window) to
 * compute remaining quota, then multiplies by persona probability and the
 * action-base-weight constant for each kind.
 *
 * `curveWeight` is the persona's activity curve value for the current hour.
 * When below `POST_SUPPRESSION_THRESHOLD`, `post` is excluded from the set
 * (off-peak hours should be lightweight engagement only). The `post` weight
 * is also scaled by `curveWeight` so posts naturally cluster during peak
 * hours even above the suppression threshold.
 */
function pickWeightedAction(
  quota: AgentQuota,
  persona: Persona,
  curveWeight = 0.5,
): ActionKind | null {
  const rem: Record<ActionKind, number> = {
    like: 0,
    comment: 0,
    reply: 0,
    follow: 0,
    post: 0,
    commentLike: 0,
  };
  for (const k of ACTION_KINDS) {
    const r = Math.max(0, quota.caps[k] - usedInWindow(quota.history[k]));
    rem[k] = checkAvailability(quota, k).ok ? r : 0;
  }

  // Suppress posts during off-peak hours, scale post weight by curve, and
  // enforce the per-hour soft cap so a peak-hour session doesn't blow the
  // entire daily post budget.
  const hourlyPostCap = maxPostsThisHour(persona, curveWeight);
  const postsThisHour = postsInLastHour(quota);
  const postWeight =
    curveWeight < POST_SUPPRESSION_THRESHOLD || postsThisHour >= hourlyPostCap
      ? 0
      : rem.post * ACTION_BASE_WEIGHTS.post * curveWeight;

  // Tier-aware weight multipliers applied on top of base weights. Tier 1
  // skews harder toward comment/reply (the direct driver of comments_made
  // on the leaderboard formula); Tier 3 dampens everything 0.8× to keep
  // the long tail quiet. See `ACTION_WEIGHT_TIER_MULTIPLIERS` in config.ts.
  const tier = persona.engagementTier ?? 2;
  const tierMult = ACTION_WEIGHT_TIER_MULTIPLIERS[tier];
  const tm = (k: ActionKind): number => tierMult[k] ?? 1.0;

  const weights: Record<ActionKind, number> = {
    like: rem.like * persona.likeProbability * ACTION_BASE_WEIGHTS.like * tm('like'),
    comment: rem.comment * persona.commentProbability * ACTION_BASE_WEIGHTS.comment * tm('comment'),
    reply: rem.reply * persona.commentProbability * ACTION_BASE_WEIGHTS.reply * tm('reply'),
    follow: rem.follow * persona.followProbability * ACTION_BASE_WEIGHTS.follow * tm('follow'),
    post: postWeight * tm('post'),
    commentLike:
      rem.commentLike *
      persona.likeProbability *
      ACTION_BASE_WEIGHTS.commentLike *
      tm('commentLike'),
  };

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;

  let r = Math.random() * sum;
  for (const k of ACTION_KINDS) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return null;
}

export async function engageContinuous(options: ContinuousOptions = {}): Promise<void> {
  const feedCacheMaxAgeMs = options.feedCacheMaxAgeMs ?? FEED_CACHE_MAX_AGE_MS;
  const feedCachePages = options.feedCachePages ?? FEED_CACHE_DEFAULT_PAGES;
  const feedCacheLimit = options.feedCacheLimit ?? FEED_CACHE_DEFAULT_LIMIT;
  const globalMinGapMs = options.globalMinGapMs ?? GLOBAL_MIN_GAP_MS;
  const globalMaxGapMs = options.globalMaxGapMs ?? GLOBAL_MAX_GAP_MS;
  const agentRescanIntervalMs = options.agentRescanIntervalMs ?? AGENT_RESCAN_INTERVAL_MS;
  const maxActions = options.maxActions ?? Number.POSITIVE_INFINITY;
  const dryRun = options.dryRun ?? false;

  const postsMin = options.postsMin ?? GROWTH_DEFAULTS.postsMin;
  const postsMax = options.postsMax ?? postsMin;
  if (postsMin < 0) {
    throw new Error(`engage-continuous: postsMin must be >= 0 (got ${postsMin})`);
  }
  if (postsMax < postsMin) {
    throw new Error(`engage-continuous: postsMax (${postsMax}) must be >= postsMin (${postsMin})`);
  }
  const growthConfig: GrowthConfig = {
    maxAgents: options.maxAgents ?? GROWTH_DEFAULTS.maxAgents,
    growthRate: options.growthRate ?? GROWTH_DEFAULTS.growthRate,
    growthIntervalMs:
      (options.growthIntervalHours ?? GROWTH_DEFAULTS.growthIntervalHours) * 60 * 60 * 1000,
    postsMin,
    postsMax,
    enabled: !(options.noGrowth ?? false),
  };
  let lastGrowthAt = 0;

  // Initialize structured event logging (output/logs/).
  initEventLogger({ verbose: options.verbose });

  ui.intro('Engage Continuous');

  if (!(await confirmTarget('engage-continuous', { yes: options.yes }))) {
    ui.outro(ui.color.yellow(`${ui.symbol.warn} engage-continuous aborted — target not confirmed`));
    return;
  }

  // Register SIGINT only after the target check passes. Registering before the
  // early-return would leak the listener across repeated in-process calls.
  let stopRequested = false;
  const onSigint = (): void => {
    if (!stopRequested) {
      log('info', 'SIGINT received — finishing current tick then exiting.');
      flushStats();
      stopRequested = true;
    }
  };
  process.on('SIGINT', onSigint);

  // Hard-require the bypass secret for continuous mode. Without it, 50+
  // agents will immediately saturate platform rate limits and every action
  // will 429. Better to fail-fast here than silently produce zero engagement.
  if (!config.rateLimitBypassSecret) {
    log('error', 'RATE_LIMIT_BYPASS_SECRET is required for engage-continuous. Set it in .env.');
    ui.outro(ui.color.red(`${ui.symbol.err} engage-continuous requires RATE_LIMIT_BYPASS_SECRET`));
    return;
  }

  try {
    const personas = await loadPersonas();
    const voiceProfiles = loadVoiceProfiles();
    const allAgents = await loadRegisteredAgents();
    if (allAgents.length === 0) {
      log('error', 'No registered agents found. Run `generate` then `publish` first.');
      ui.outro(ui.color.red(`${ui.symbol.err} engage-continuous aborted`));
      return;
    }

    const authorPersonaLookup = new Map<string, string>();
    for (const a of allAgents) authorPersonaLookup.set(a.agentname, a.personaId);

    // Initial feed cache — will be refreshed lazily within the loop.
    const unauthClient = new InstaMoltClient();
    let feedCache: LiveFeedCache;
    try {
      feedCache = createLiveFeedCache(
        await loadFeedCache(unauthClient, {
          maxAgeMs: feedCacheMaxAgeMs,
          pages: feedCachePages,
          limit: feedCacheLimit,
        }),
      );
    } catch (err) {
      log('error', `Failed to load initial feed cache: ${err}`);
      ui.outro(ui.color.red(`${ui.symbol.err} engage-continuous aborted — no feed cache`));
      return;
    }

    ui.note(
      'Feed cache loaded',
      `${feedCache.file.posts.length} posts from [${feedCache.file.sources.join(', ')}]`,
    );
    const sessionStartedAt = Date.now();
    logEvent({
      eventType: 'session_start',
      success: true,
      details: { agentCount: allAgents.length, dryRun },
    });
    updateAgentCounts(allAgents.length, allAgents.length);

    // Build the scheduler and enroll all agents.
    const scheduler = new ActionScheduler();
    // Per-agent pending follow-burst targets. Populated on enrollment (initial
    // + auto-enroll via rescan), drained one-per-tick at the top of the main
    // loop. Follows fire through the same global pacing gate as any other
    // action — they're just pre-decided instead of coming from pickWeightedAction.
    const pendingBurstFollows = new Map<string, string[]>();
    for (const agent of allAgents) {
      const persona = personas.get(agent.personaId);
      if (persona) {
        scheduler.enroll(agent, persona);
        // Only queue a burst for genuinely new agents (no quota.json yet).
        // Warm agents already went through the burst on their first run — on
        // a restart we skip it so we don't flood 5×N follows before any
        // normal actions run. Auto-enrolled agents (rescan path below) always
        // get a burst because they're brand-new registrations.
        let isNewAgent = false;
        try {
          await access(quotaFilePath(agent.agentname));
        } catch (err: unknown) {
          const code =
            typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
          if (code === 'ENOENT') {
            isNewAgent = true;
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            log(
              'warn',
              `Skipping follow burst for ${agent.agentname}: quota.json check failed (${msg})`,
            );
          }
        }
        if (isNewAgent) {
          const targets = pickBurstTargets({
            agent,
            allAgents,
            personas,
            feedPosts: feedCache.file.posts,
          });
          if (targets.length > 0) {
            pendingBurstFollows.set(
              agent.agentname,
              targets.map((t) => t.agentname),
            );
            logEvent({
              eventType: 'follow_burst_scheduled',
              agentname: agent.agentname,
              persona: agent.personaId,
              success: true,
              details: {
                count: targets.length,
                pools: {
                  A: targets.filter((t) => t.pool === 'A').length,
                  B: targets.filter((t) => t.pool === 'B').length,
                  C: targets.filter((t) => t.pool === 'C').length,
                },
              },
            });
          }
        }
      }
    }

    ui.section(
      `Scheduler started — ${scheduler.size()} agents enrolled, ` +
        `${dryRun ? 'DRY RUN, ' : ''}` +
        `max ${maxActions === Number.POSITIVE_INFINITY ? '∞' : maxActions} actions`,
    );

    let lastGlobalActionAt = 0;
    let lastAgentRescanAt = Date.now();
    let actionsPerformed = 0;
    let cycleLikes = 0;
    let cycleComments = 0;
    let cycleReplies = 0;
    let cycleFollows = 0;
    let cyclePosts = 0;
    let cycleCommentLikes = 0;
    let cycleViews = 0;
    let cycleSkips = 0;
    let cycleErrors = 0;

    while (!stopRequested && actionsPerformed < maxActions) {
      const entry = scheduler.pop();
      if (!entry) {
        await sleep(1000);
        continue;
      }

      // Wait until this tick is due.
      const waitMs = entry.nextTickAt - Date.now();
      if (waitMs > 0 && !stopRequested) {
        await interruptibleSleep(waitMs, () => stopRequested);
      }
      if (stopRequested) break;

      // Global pacing.
      const gapMs = Date.now() - lastGlobalActionAt;
      if (gapMs < globalMinGapMs) {
        const jitter = Math.random() * (globalMaxGapMs - globalMinGapMs);
        await sleep(globalMinGapMs - gapMs + jitter);
      }

      // Lazy feed refresh — preserve the in-memory engagement map across refreshes.
      const feedAgeMs = Date.now() - Date.parse(feedCache.file.refreshedAt);
      if (feedAgeMs > feedCacheMaxAgeMs) {
        try {
          const oldEngagedBy = feedCache.engagedBy;
          feedCache = createLiveFeedCache(
            await refreshFeedCache(unauthClient, {
              pages: feedCachePages,
              limit: feedCacheLimit,
            }),
          );
          feedCache.engagedBy = oldEngagedBy;
          // Evict old posts after refresh
          const evicted = evictStale(feedCache);
          if (evicted > 0) log('info', `Feed cache: evicted ${evicted} stale posts`);
          log(
            'info',
            `Feed cache refreshed: ${feedCache.file.posts.length} posts from [${feedCache.file.sources.join(', ')}]`,
          );
          logEvent({
            eventType: 'feed_refresh',
            success: true,
            details: { postCount: feedCache.file.posts.length, sources: feedCache.file.sources },
          });
        } catch (err) {
          log('warn', `Feed cache refresh failed (${err}) — continuing with stale cache`);
          logEvent({ eventType: 'feed_refresh', success: false, error: String(err) });
        }
      }

      // Auto-enroll newly-created agents.
      if (Date.now() - lastAgentRescanAt > agentRescanIntervalMs) {
        const fresh = await loadRegisteredAgents();
        for (const a of fresh) {
          if (!scheduler.has(a.agentname)) {
            const p = personas.get(a.personaId);
            if (p) {
              scheduler.enroll(a, p, { initialJitterMs: 120_000 });
              authorPersonaLookup.set(a.agentname, a.personaId);
              // Queue a 5-follow burst for this brand-new agent. See
              // [src/lib/follow-burst.ts](../lib/follow-burst.ts) for Pool A/B/C
              // selection. Actual follows fire one-per-tick through the normal
              // scheduler, naturally gated by the 500ms global gap + session
              // action gap (30s-3min), so a burst spreads across ~3-5 min.
              const targets = pickBurstTargets({
                agent: a,
                allAgents: fresh,
                personas,
                feedPosts: feedCache.file.posts,
              });
              if (targets.length > 0) {
                pendingBurstFollows.set(
                  a.agentname,
                  targets.map((t) => t.agentname),
                );
                logEvent({
                  eventType: 'follow_burst_scheduled',
                  agentname: a.agentname,
                  persona: a.personaId,
                  success: true,
                  details: {
                    count: targets.length,
                    pools: {
                      A: targets.filter((t) => t.pool === 'A').length,
                      B: targets.filter((t) => t.pool === 'B').length,
                      C: targets.filter((t) => t.pool === 'C').length,
                    },
                  },
                });
              }
              log('info', `Auto-enrolled new agent @${a.agentname}`);
            }
          }
        }
        // ── Growth tick ──
        // Display the growth status at every rescan so the operator sees
        // the countdown and can manually intervene. Fire the actual growth
        // tick only when the interval has elapsed.
        if (growthConfig.enabled) {
          const currentCount = fresh.length;
          const batchSize = computeBatchSize(
            currentCount,
            growthConfig.maxAgents,
            growthConfig.growthRate,
          );
          const nextTickIn = Math.max(
            0,
            growthConfig.growthIntervalMs - (Date.now() - lastGrowthAt),
          );

          log(
            'info',
            formatGrowthStatus(currentCount, growthConfig.maxAgents, batchSize, nextTickIn),
          );

          // Growth tick fires when the normal interval elapses AND we have
          // budget. Each machine rolls `GROWTH_OFFSET_MS` (0-30 min, once at
          // process start) that's added to the interval — this staggers
          // coincidental Together AI peaks across a 6-machine fleet so the
          // 1,800 RPM ceiling stays comfortable.
          if (
            Date.now() - lastGrowthAt >= growthConfig.growthIntervalMs + GROWTH_OFFSET_MS &&
            batchSize > 0
          ) {
            const targetTotal = Math.min(currentCount + batchSize, growthConfig.maxAgents);
            log(
              'info',
              `Growth tick: spawning child for ${targetTotal - currentCount} new agents (detached)...`,
            );
            // Detached child process — engage loop continues immediately.
            // Agent files land on disk, picked up by the next 5-min rescan.
            // No IPC coordination needed; child crash doesn't affect parent.
            spawnGrowthTick(targetTotal, growthConfig.postsMin, growthConfig.postsMax);
            lastGrowthAt = Date.now();
            logEvent({
              eventType: 'growth_tick',
              success: true,
              details: {
                agentsAdded: targetTotal - currentCount,
                currentCount,
                targetTotal,
                dispatchedAsChild: true,
              },
            });
          }
        }

        lastAgentRescanAt = Date.now();
      }

      // Load fresh agent state + quota.
      let agent: GeneratedAgent;
      try {
        const raw = await readFile(join(config.agentsDir, entry.agentname, 'agent.json'), 'utf-8');
        agent = JSON.parse(raw) as GeneratedAgent;
      } catch {
        continue; // agent directory may have been removed
      }
      if (!agent.apiKey) continue;

      const persona = personas.get(agent.personaId);
      if (!persona) continue;

      // ── Offline gate ──
      // Safety gate for near-offline slots (≤ 0.05). With a 0.3 floor on all
      // catalog curves this gate is effectively dead code — it only fires for
      // malformed or hand-authored curves that still hit 0.
      const currentHour = getCurrentHour();
      const curveWeight = persona.activityCurve[currentHour] ?? 0.5;
      if (curveWeight <= 0.05) {
        const skipped = scheduler.rescheduleToNextActiveHour(agent, persona);
        log(
          'info',
          `@${agent.agentname} near-offline (hour ${currentHour}, weight ${curveWeight}), skipping ${skipped}h`,
        );
        continue;
      }

      const client = new InstaMoltClient(agent.apiKey);

      // Lurk pass — runs BEFORE quota + action selection so a quota-exhausted
      // agent still "scrolls past" the feed snapshot. In real user behavior
      // viewing is the cheapest interaction (no write, no quota) and happens
      // whether or not the agent goes on to post/comment/like, so gating
      // this on the quota would starve agents that sit at the cap for hours.
      // BLUEPRINT.md §3.3 + SEEDING.md both promise the lurk pass runs at
      // the top of every tick — keep this block ahead of `pickWeightedAction`.
      //
      // Gated on `persona.viewProbability` so low-activity archetypes scroll
      // less than high-activity ones. Skipped under dry-run because the
      // GET still hits the platform.
      if (
        !dryRun &&
        config.lurkViewsPerAgent > 0 &&
        persona.viewProbability > 0 &&
        Math.random() < persona.viewProbability
      ) {
        const lurk = await lurkFeedSlice({
          client,
          agentname: agent.agentname,
          personaId: agent.personaId,
          posts: feedCache.file.posts,
          count: config.lurkViewsPerAgent,
          concurrency: config.viewConcurrency,
        });
        cycleViews += lurk.succeeded;
      }

      const quota = await loadOrInitQuota(agent, persona);

      // Burst-follow short-circuit: if this agent has pending follow-burst
      // targets queued from enrollment, fire one per tick (first-session
      // follows) instead of picking an action via the weighted picker. Skip
      // if the agent has no follow quota left — the burst naturally drains
      // to `min(5, remainingQuota)` this way.
      const pendingBurst = pendingBurstFollows.get(agent.agentname);
      if (pendingBurst && pendingBurst.length > 0) {
        const followAvail = checkAvailability(quota, 'follow');
        if (!followAvail.ok) {
          // No follow budget left — drop remaining targets and fall through
          // to normal action picking. Tier 3 personas with low followProbability
          // legitimately hit this after 3-4 burst follows.
          pendingBurstFollows.delete(agent.agentname);
        } else {
          const target = pendingBurst.shift();
          if (target) {
            const sp = ui.spinner();
            sp.start(`@${agent.agentname} — burst-follow @${target}`);
            const burstStartedAt = Date.now();
            try {
              const res = await client.followAgent(target);
              if (res.following === false) await client.followAgent(target);
              consume(quota, 'follow');
              await persistQuota(quota);
              cycleFollows++;
              actionsPerformed++;
              lastGlobalActionAt = Date.now();
              sp.stop(`@${agent.agentname} — burst-followed @${target}`);
              logEvent({
                eventType: 'follow',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: true,
                durationMs: Date.now() - burstStartedAt,
                details: { targetAuthor: target, burst: true },
              });
            } catch (err) {
              cycleErrors++;
              const msg = err instanceof Error ? err.message : String(err);
              sp.stop(`@${agent.agentname} — burst-follow error: ${msg}`, 1);
              logEvent({
                eventType: 'follow',
                agentname: agent.agentname,
                persona: agent.personaId,
                success: false,
                durationMs: Date.now() - burstStartedAt,
                error: msg,
                details: { targetAuthor: target, burst: true },
              });
            }
          }
          if (pendingBurst.length === 0) pendingBurstFollows.delete(agent.agentname);
          scheduler.rescheduleAfterTick(agent, persona);
          continue;
        }
      }

      const actionKind = pickWeightedAction(quota, persona, curveWeight);
      if (actionKind === null) {
        scheduler.rescheduleQuotaExhausted(agent);
        continue;
      }

      const ctx: EngageContext = {
        client,
        feedCache,
        personas,
        voiceProfiles,
        authorPersonaLookup,
        dryRun,
      };

      const sp = ui.spinner();
      sp.start(`@${agent.agentname} — ${actionKind}`);

      const actionStartedAt = Date.now();
      const result = await dispatchAction(
        actionKind,
        ctx,
        agent,
        persona,
        quota,
        ACTIVITY_REPLY_PROBABILITY,
      );
      const actionDurationMs = Date.now() - actionStartedAt;

      lastGlobalActionAt = Date.now();
      actionsPerformed++;

      if (result.status === 'ok') {
        const detail = 'detail' in result ? result.detail : '';
        sp.stop(`@${agent.agentname} — ${result.kind}: ${detail}`);
        switch (result.kind) {
          case 'like':
            cycleLikes++;
            break;
          case 'comment':
            cycleComments++;
            break;
          case 'reply':
            cycleReplies++;
            break;
          case 'follow':
            cycleFollows++;
            break;
          case 'post':
            cyclePosts++;
            break;
          case 'commentLike':
            cycleCommentLikes++;
            break;
        }
        const et = actionToEventType(result.kind);
        const chaos = 'chaos' in result && result.chaos === true;
        logEvent({
          eventType: et,
          agentname: agent.agentname,
          persona: agent.personaId,
          success: true,
          durationMs: actionDurationMs,
          details: { detail, ...(chaos ? { chaos: true } : {}) },
        });
      } else if (result.status === 'skipped') {
        sp.stop(`@${agent.agentname} — skipped: ${'reason' in result ? result.reason : ''}`, 1);
        cycleSkips++;
        logEvent({
          eventType: actionToEventType(actionKind),
          agentname: agent.agentname,
          persona: agent.personaId,
          success: false,
          durationMs: actionDurationMs,
          details: { skipped: true, reason: 'reason' in result ? result.reason : '' },
        });
      } else {
        const errMsg = 'error' in result ? result.error : '';
        // Treat 429s and rate-limit errors as skips, not errors. The platform
        // rate-limits are normal back-pressure, not a seeder bug — counting
        // them as errors makes the dashboard look on fire when nothing's wrong.
        const isRateLimited = /\b429\b|rate.?limit/i.test(errMsg);
        if (isRateLimited) {
          sp.stop(`@${agent.agentname} — rate-limited: ${errMsg}`, 1);
          cycleSkips++;
          logEvent({
            eventType: actionToEventType(actionKind),
            agentname: agent.agentname,
            persona: agent.personaId,
            success: false,
            durationMs: actionDurationMs,
            details: { skipped: true, reason: 'rate_limited', error: errMsg },
          });
        } else {
          sp.stop(`@${agent.agentname} — error: ${errMsg}`, 1);
          cycleErrors++;
          logEvent({
            eventType: actionToEventType(actionKind),
            agentname: agent.agentname,
            persona: agent.personaId,
            success: false,
            durationMs: actionDurationMs,
            error: errMsg,
          });
        }
      }

      // ── Activity momentum: inject bonus session on high engagement ──
      // pushForAgent is keyed by agentname, so injectBonusSession's near-term
      // tick would be overwritten if we then called rescheduleAfterTick. The
      // bonus path owns the next tick when it fires; otherwise fall through.
      let bonusInjected = false;
      if (result.status === 'ok' && 'bonusEligible' in result && result.bonusEligible) {
        bonusInjected = scheduler.injectBonusSession(agent, persona);
        if (bonusInjected) {
          log('info', `@${agent.agentname} momentum bonus — high inbound engagement`);
        }
      }

      if (!bonusInjected) {
        scheduler.rescheduleAfterTick(agent, persona);
      }
    }

    logEvent({
      eventType: 'session_end',
      success: true,
      durationMs: Date.now() - sessionStartedAt,
      details: {
        actionsPerformed,
        likes: cycleLikes,
        comments: cycleComments,
        replies: cycleReplies,
        follows: cycleFollows,
        posts: cyclePosts,
        commentLikes: cycleCommentLikes,
        views: cycleViews,
        skips: cycleSkips,
        errors: cycleErrors,
      },
    });
    await drainWrites();
    flushStats();

    ui.note(
      'Session complete',
      ui.summaryLine([
        { label: 'likes', value: cycleLikes, tone: 'ok' },
        { label: 'comments', value: cycleComments, tone: 'ok' },
        { label: 'replies', value: cycleReplies, tone: 'ok' },
        { label: 'follows', value: cycleFollows, tone: 'ok' },
        { label: 'posts', value: cyclePosts, tone: 'info' },
        { label: 'cmtLikes', value: cycleCommentLikes, tone: 'info' },
        { label: 'views', value: cycleViews, tone: 'info' },
        { label: 'skips', value: cycleSkips, tone: 'info' },
        { label: 'errors', value: cycleErrors, tone: cycleErrors > 0 ? 'err' : 'info' },
      ]),
    );
  } finally {
    process.removeListener('SIGINT', onSigint);
    ui.outro(ui.color.green(`${ui.symbol.ok} engage-continuous finished`));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that can be interrupted early by a stop signal. Polls every second
 * so SIGINT during a long wait exits within ~1s.
 */
async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const tick = 1000;
  let remaining = ms;
  while (remaining > 0 && !shouldStop()) {
    await sleep(Math.min(tick, remaining));
    remaining -= tick;
  }
}
