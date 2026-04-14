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

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACTION_BASE_WEIGHTS,
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
  refreshOpenApiCache,
} from '@/lib/feed-cache';
import {
  computeBatchSize,
  formatGrowthStatus,
  GROWTH_DEFAULTS,
  type GrowthConfig,
} from '@/lib/growth';
import { log } from '@/lib/logger';
import {
  checkAvailability,
  loadOrInitQuota,
  maxPostsThisHour,
  postsInLastHour,
  usedInWindow,
} from '@/lib/quota';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { InstaMoltClient } from '@/services/instamolt-api';
import type { ActionKind, AgentQuota, GeneratedAgent, Persona, SeederEventType } from '@/types';
import { ACTION_KINDS } from '@/types';

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
  /** Posts generated per new agent during growth. Default 10. */
  postsPerNewAgent?: number;
  /** Disable growth entirely (engage only, no new agents). */
  noGrowth?: boolean;
  /** Log every event to stdout in addition to events.jsonl. */
  verbose?: boolean;
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

  const weights: Record<ActionKind, number> = {
    like: rem.like * persona.likeProbability * ACTION_BASE_WEIGHTS.like,
    comment: rem.comment * persona.commentProbability * ACTION_BASE_WEIGHTS.comment,
    reply: rem.reply * persona.commentProbability * ACTION_BASE_WEIGHTS.reply,
    follow: rem.follow * persona.followProbability * ACTION_BASE_WEIGHTS.follow,
    post: postWeight,
    commentLike: rem.commentLike * persona.likeProbability * ACTION_BASE_WEIGHTS.commentLike,
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

  const growthConfig: GrowthConfig = {
    maxAgents: options.maxAgents ?? GROWTH_DEFAULTS.maxAgents,
    growthRate: options.growthRate ?? GROWTH_DEFAULTS.growthRate,
    growthIntervalMs:
      (options.growthIntervalHours ?? GROWTH_DEFAULTS.growthIntervalHours) * 60 * 60 * 1000,
    postsPerNewAgent: options.postsPerNewAgent ?? GROWTH_DEFAULTS.postsPerNewAgent,
    enabled: !(options.noGrowth ?? false),
  };
  let lastGrowthAt = 0;

  // Initialize structured event logging (output/logs/).
  initEventLogger({ verbose: options.verbose });

  let stopRequested = false;
  const onSigint = (): void => {
    if (!stopRequested) {
      log('info', 'SIGINT received — finishing current tick then exiting.');
      flushStats();
      stopRequested = true;
    }
  };
  process.on('SIGINT', onSigint);

  ui.intro('Engage Continuous');

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
    logEvent({
      eventType: 'session_start',
      success: true,
      details: { agentCount: allAgents.length, dryRun },
    });
    updateAgentCounts(allAgents.length, allAgents.length);

    // Cache the latest OpenAPI spec for reference (best-effort).
    refreshOpenApiCache().catch(() => {});

    // Build the scheduler and enroll all agents.
    const scheduler = new ActionScheduler();
    for (const agent of allAgents) {
      const persona = personas.get(agent.personaId);
      if (persona) scheduler.enroll(agent, persona);
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
          // Best-effort: cache the latest OpenAPI spec alongside the feed
          // so we always have a recent copy of the API contract on disk.
          refreshOpenApiCache().catch(() => {});
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

          if (Date.now() - lastGrowthAt >= growthConfig.growthIntervalMs && batchSize > 0) {
            const targetTotal = Math.min(currentCount + batchSize, growthConfig.maxAgents);
            log('info', `Growth tick: generating ${targetTotal - currentCount} new agents...`);
            try {
              // Dynamic import to avoid circular deps — generate and publish
              // are CLI command modules, not library code, so they're only
              // loaded when growth actually fires.
              const { generate } = await import('@/commands/generate');
              const { publish } = await import('@/commands/publish');
              await generate(targetTotal, growthConfig.postsPerNewAgent);
              await publish({ limit: growthConfig.postsPerNewAgent });
              lastGrowthAt = Date.now();
              log(
                'info',
                `Growth tick complete: +${targetTotal - currentCount} agents (${currentCount} → ${targetTotal} / ${growthConfig.maxAgents})`,
              );
              logEvent({
                eventType: 'growth_tick',
                success: true,
                details: { agentsAdded: targetTotal - currentCount, currentCount, targetTotal },
              });
            } catch (err) {
              log('warn', `Growth tick failed: ${err}`);
              logEvent({ eventType: 'growth_tick', success: false, error: String(err) });
              // Don't update lastGrowthAt — retry next interval
            }
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
      // If the persona's activity curve is 0 for the current hour, skip this
      // agent entirely and reschedule to the next active hour. Guarantees zero
      // activity during defined offline windows.
      const currentHour = getCurrentHour();
      const curveWeight = persona.activityCurve[currentHour] ?? 0.5;
      if (curveWeight === 0) {
        const skipped = scheduler.rescheduleToNextActiveHour(agent, persona);
        log('info', `@${agent.agentname} offline (hour ${currentHour}), skipping ${skipped}h`);
        continue;
      }

      const quota = await loadOrInitQuota(agent, persona);
      const actionKind = pickWeightedAction(quota, persona, curveWeight);
      if (actionKind === null) {
        scheduler.rescheduleQuotaExhausted(agent);
        continue;
      }

      const ctx: EngageContext = {
        client: new InstaMoltClient(agent.apiKey),
        feedCache,
        personas,
        authorPersonaLookup,
        dryRun,
      };

      const sp = ui.spinner();
      sp.start(`@${agent.agentname} — ${actionKind}`);

      const result = await dispatchAction(
        actionKind,
        ctx,
        agent,
        persona,
        quota,
        ACTIVITY_REPLY_PROBABILITY,
      );

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
        bonusInjected = scheduler.injectBonusSession(agent);
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
      details: {
        actionsPerformed,
        likes: cycleLikes,
        comments: cycleComments,
        replies: cycleReplies,
        follows: cycleFollows,
        posts: cyclePosts,
        commentLikes: cycleCommentLikes,
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
