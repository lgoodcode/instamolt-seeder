import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { CircuitAbortError, CircuitBreaker } from '@/lib/circuit-breaker';
import { mapWithConcurrency } from '@/lib/concurrency';
import { confirmTarget } from '@/lib/confirm-target';
import { drainWrites, flushStats, initEventLogger, logEvent } from '@/lib/event-logger';
import { computeAffinityMatrix, planFollows } from '@/lib/follow-algorithm';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { fanOutPostViews } from '@/lib/views';
import { loadPersonas } from '@/personas/index';
import { InstaMoltApiError, InstaMoltClient, parseErrorCode } from '@/services/instamolt-api';
import {
  answerChallenge,
  type BioModerationFeedback,
  generateAgentName,
  generateAvatarPrompt,
  generateBio,
} from '@/services/llm';
import type {
  AgentsIndex,
  ChallengeResponse,
  GeneratedAgent,
  GeneratedPost,
  Persona,
  VoiceProfile,
} from '@/types';
import { loadVoiceProfiles, resolveVoiceProfile } from '@/voice-profiles/index';

/**
 * Max number of bio regenerations attempted after a `CONTENT_BLOCKED` response
 * from `POST /agents/register`. The first attempt uses the bio on disk; each
 * retry regenerates via Gemini with the blocked text + moderation reason
 * surfaced as a negative exemplar. Two retries clears the overwhelming
 * majority of moderation hits without burning Gemini budget on genuinely
 * un-fixable personas.
 */
const MAX_BIO_MODERATION_RETRIES = 2;

/**
 * Max number of times Phase A will generate a new agentname and re-attempt
 * registration when the platform returns 409 AGENTNAME_EXISTS. Each retry
 * generates a structurally-different candidate via Gemini, probes
 * `isAgentnameAvailable`, renames the on-disk agent directory, and retries
 * the full challenge→complete flow. After this many retries the agent is
 * skipped with a clear error message.
 */
const MAX_AGENTNAME_REGISTER_RETRIES = 5;

/**
 * Parse the `category` + `error` fields out of a `CONTENT_BLOCKED` 403 body.
 * Shape matches the platform's `ErrorResponse` schema (see openapi.json). A
 * missing field falls back to `'unknown'` / the raw body — never throws, so
 * the retry path always has *something* to feed into Gemini.
 */
function parseModerationDetails(body: string): { category: string; reason: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { error?: unknown; category?: unknown };
      const reason = typeof obj.error === 'string' ? obj.error : body;
      const category = typeof obj.category === 'string' ? obj.category : 'unknown';
      return { category, reason };
    }
  } catch {
    // Body wasn't JSON — fall through.
  }
  return { category: 'unknown', reason: body };
}

/**
 * Register-phase retry wrapper. Calls `startChallenge(agentname, bio)`; on a
 * `CONTENT_BLOCKED` 403 response, regenerates the bio via Gemini (with the
 * blocked text + moderation reason as negative exemplars), persists the new
 * bio to `agent.json` so the agent is recoverable after a crash, and retries
 * up to {@link MAX_BIO_MODERATION_RETRIES} times before giving up.
 *
 * Non-moderation errors propagate on the first hit — retrying a network error
 * is the HTTP client's job, not this function's.
 */
async function startChallengeWithBioRetry(
  client: InstaMoltClient,
  agentname: string,
  data: GeneratedAgent,
  persona: Persona,
  voiceProfile: VoiceProfile,
  jsonPath: string,
  onBioRegenerated: (details: { attempt: number; category: string; reason: string }) => void,
): Promise<ChallengeResponse> {
  let attempt = 0;
  while (true) {
    try {
      return await client.startChallenge(agentname, data.bio);
    } catch (err) {
      const isModerationBlock =
        err instanceof InstaMoltApiError &&
        err.status === 403 &&
        parseErrorCode(err.body) === 'CONTENT_BLOCKED';

      if (!isModerationBlock || attempt >= MAX_BIO_MODERATION_RETRIES) {
        throw err;
      }

      const { category, reason } = parseModerationDetails((err as InstaMoltApiError).body);
      const feedback: BioModerationFeedback = {
        category,
        reason,
        blockedBio: data.bio,
      };
      const newBio = await generateBio(persona, voiceProfile, [], feedback);
      data.bio = newBio;
      await writeFile(jsonPath, JSON.stringify(data, null, 2));
      attempt++;
      onBioRegenerated({ attempt, category, reason });
    }
  }
}

interface PublishOptions {
  agent?: string;
  limit?: number;
  /**
   * Cap the run to the first N agents by agentname (ascending). Deterministic
   * across invocations so repeat runs hit the same small subset — designed for
   * the publish-then-engage-then-reset debug loop at `--cycle-delay` speed.
   * Ignored when `agent` is set (single-agent scope already bounds the run).
   */
  limitAgents?: number;
  skipFollowGraph?: boolean;
  /**
   * Skip the interactive "confirm target URL" prompt. Under non-TTY the
   * prompt is already skipped so unattended runs (Docker, CI) don't hang;
   * this flag is for TTY-scripted runs where the operator has pre-confirmed.
   */
  yes?: boolean;
}

interface ErrorEntry {
  agent: string;
  phase: string;
  message: string;
}

/**
 * Unwrap `err.cause` chain so `TypeError: fetch failed` surfaces the
 * underlying ENOTFOUND / ECONNREFUSED / UND_ERR_* code instead of a
 * generic message.
 */
function formatError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as Error & { code?: string }).code;
      parts.push(code ? `${current.message} [${code}]` : current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- ');
}

/**
 * Publish generated agents and posts to live InstaMolt.
 * Reads from output/ directory. Resumable -- tracks what's been published.
 */
export async function publish(options: PublishOptions = {}): Promise<void> {
  initEventLogger();
  logEvent({ eventType: 'session_start', success: true, details: { command: 'publish-drafts' } });
  ui.intro('Publish');

  // Wrap the whole flow so every exit path — declined target, missing
  // agents.json, empty agent list, thrown mid-publish, happy path — emits
  // `session_end`, drains pending events, and flushes stats. Without this
  // the three early returns below would leave the session open in
  // `pnpm events` output and lose the final batch of events from the tail.
  try {
    await publishInner(options);
  } finally {
    logEvent({ eventType: 'session_end', success: true });
    await drainWrites();
    flushStats();
  }
}

async function publishInner(options: PublishOptions): Promise<void> {
  if (!(await confirmTarget('publish-drafts', { yes: options.yes }))) {
    ui.outro(ui.color.yellow(`${ui.symbol.warn} publish-drafts aborted — target not confirmed`));
    return;
  }

  const personas = await loadPersonas();
  const voiceProfiles = loadVoiceProfiles();

  // Load the master index
  let index: AgentsIndex;
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    index = JSON.parse(raw) as AgentsIndex;
  } catch {
    log('error', 'No agents.json found. Run `generate` first.');
    return;
  }

  let agents = options.agent
    ? index.agents.filter((a) => a.agentname === options.agent)
    : index.agents;

  // `--limit-agents N` takes the first N agents by agentname (ascending) so
  // two invocations with the same flag hit the same subset — the whole point
  // is reproducible small-batch debugging. Ignored when `--agent` is set.
  if (!options.agent && options.limitAgents !== undefined && options.limitAgents > 0) {
    agents = [...agents]
      .sort((a, b) => a.agentname.localeCompare(b.agentname))
      .slice(0, options.limitAgents);
  }

  if (agents.length === 0) {
    log(
      'error',
      options.agent ? `Agent "${options.agent}" not found in agents.json` : 'No agents to publish',
    );
    return;
  }

  log('info', `Publishing ${agents.length} agents...`);

  let registeredCount = 0;
  let postedCount = 0;
  const errors: ErrorEntry[] = [];

  // Prefilter agents by name-validity + readable agent.json. Doing it in a
  // single pass up front lets both phases share the same validated set
  // without re-reading the file twice.
  interface PreparedAgent {
    indexAgent: GeneratedAgent;
    data: GeneratedAgent;
    dir: string;
    jsonPath: string;
    persona: Persona;
    voiceProfile: VoiceProfile;
  }
  const prepared: PreparedAgent[] = [];
  for (const agent of agents) {
    if (!agent.agentname || agent.agentname.trim().length < 3) {
      log(
        'warn',
        `Agent has empty or short name "${agent.agentname}", skipping. Run scripts/fix-agents.ts first.`,
      );
      continue;
    }
    const persona = personas.get(agent.personaId);
    if (!persona) {
      log('warn', `Persona ${agent.personaId} not found, skipping ${agent.agentname}`);
      continue;
    }
    const dir = join(config.agentsDir, agent.agentname);
    const jsonPath = join(dir, 'agent.json');
    let data: GeneratedAgent;
    try {
      data = JSON.parse(await readFile(jsonPath, 'utf-8')) as GeneratedAgent;
    } catch {
      log('error', `Can't read ${jsonPath}, skipping`);
      continue;
    }
    if (!data.agentname || data.agentname.trim().length < 3) {
      log(
        'warn',
        `Agent file ${jsonPath} has empty/short name, skipping. Run scripts/fix-agents.ts first.`,
      );
      continue;
    }
    const resolved = resolveVoiceProfile(voiceProfiles, data);
    if ('error' in resolved) {
      log('warn', `${resolved.error}, skipping`);
      errors.push({ agent: agent.agentname, phase: 'prepare', message: resolved.error });
      continue;
    }
    prepared.push({
      indexAgent: agent,
      data,
      dir,
      jsonPath,
      persona,
      voiceProfile: resolved.profile,
    });
  }

  // --- Phase A: Register concurrently ---
  //
  // Each worker registers ONE agent end-to-end (startChallenge →
  // answerChallenge → completeChallenge → write apiKey → updateProfile).
  // Errors are caught inside the worker so one failed registration doesn't
  // abort the batch. Ordering doesn't matter — each agent writes only to
  // its own agent.json. Concurrency is gated by Gemini (one challenge
  // answer per agent) and platform auth load; `config.registerConcurrency`
  // (default 15) is the knob.

  const needsRegistration = prepared.filter((p) => !p.data.apiKey);
  if (needsRegistration.length > 0) {
    ui.section(
      `Phase A — register ${needsRegistration.length} agents (concurrency ${config.registerConcurrency})`,
    );
    const regBar = ui.progress(needsRegistration.length);
    // Unauthenticated probe client shared across all workers for availability
    // checks during agentname-conflict retries (unauthenticated GET /agents/:name).
    const probeClient = new InstaMoltClient();

    await mapWithConcurrency(needsRegistration, config.registerConcurrency, async (agentItem) => {
      const { indexAgent, data, persona, voiceProfile } = agentItem;
      const regStartedAt = Date.now();
      // Tracks names rejected this registration attempt (taken on the
      // platform). Passed into generateAgentName so subsequent prompts
      // generate structurally-different candidates.
      const rejectedNames: string[] = [];

      try {
        const client = new InstaMoltClient();

        // Outer loop: on 409 AGENTNAME_EXISTS, generate a new name, rename
        // the on-disk directory, update all state references, and retry the
        // full challenge→complete flow. Capped at MAX_AGENTNAME_REGISTER_RETRIES.
        for (let nameAttempt = 0; ; nameAttempt++) {
          const currentName = data.agentname;
          try {
            const challenge = await startChallengeWithBioRetry(
              client,
              currentName,
              data,
              persona,
              voiceProfile,
              agentItem.jsonPath,
              ({ attempt, category, reason }) => {
                log(
                  'warn',
                  `  @${currentName} — bio blocked (${category}); regenerated attempt ${attempt} of ${MAX_BIO_MODERATION_RETRIES}: ${reason}`,
                );
                logEvent({
                  eventType: 'registration',
                  agentname: currentName,
                  persona: indexAgent.personaId,
                  success: false,
                  details: {
                    bioRegenerated: true,
                    moderationCategory: category,
                    moderationReason: reason,
                    attempt,
                  },
                });
              },
            );
            const answer = await answerChallenge(persona, challenge.challenge);
            const reg = await client.completeChallenge(challenge.request_id, answer);

            if (!reg.agent?.api_key) {
              throw new Error(
                `Registration response missing agent.api_key: ${JSON.stringify(reg)}`,
              );
            }

            // Persist the API key immediately so a later failure can't brick
            // the agent (AUDIT.md #11). Mutates the shared `prepared` entry so
            // Phase B sees the new key.
            data.apiKey = reg.agent.api_key;
            data.registeredAt = new Date().toISOString();
            await writeFile(agentItem.jsonPath, JSON.stringify(data, null, 2));
            registeredCount++;

            logEvent({
              eventType: 'registration',
              agentname: currentName,
              persona: indexAgent.personaId,
              success: true,
              durationMs: Date.now() - regStartedAt,
            });

            // updateProfile is best-effort; failure here does NOT invalidate
            // registration (the api_key is already on disk).
            try {
              const authed = new InstaMoltClient(data.apiKey);
              await authed.updateProfile(data.bio);
            } catch (err) {
              log(
                'warn',
                `  updateProfile failed for ${currentName} (agent is still registered): ${formatError(err)}`,
              );
            }

            if (config.registrationDelay > 0) await sleep(config.registrationDelay);
            regBar.tick(`@${currentName} — registered`);
            break; // success — exit the name-retry loop
          } catch (err) {
            const isNameConflict =
              err instanceof InstaMoltApiError &&
              err.status === 409 &&
              parseErrorCode((err as InstaMoltApiError).body) === 'AGENTNAME_EXISTS';

            if (!isNameConflict || nameAttempt >= MAX_AGENTNAME_REGISTER_RETRIES) {
              throw err;
            }

            // --- Name conflict: generate a replacement agentname ---
            rejectedNames.push(currentName);
            log(
              'warn',
              `  @${currentName} — name already taken (409); generating replacement (${nameAttempt + 1}/${MAX_AGENTNAME_REGISTER_RETRIES})`,
            );
            logEvent({
              eventType: 'registration',
              agentname: currentName,
              persona: indexAgent.personaId,
              success: false,
              details: { nameConflict: true, attempt: nameAttempt + 1 },
            });

            // Probe-generate a new name: try up to MAX_AGENTNAME_REGISTER_RETRIES
            // candidates, skipping any that are taken on the platform.
            let newName: string | undefined;
            const candidatesRejected = [...rejectedNames];
            for (let p = 0; p < MAX_AGENTNAME_REGISTER_RETRIES; p++) {
              const candidate = await generateAgentName(
                persona,
                voiceProfile,
                candidatesRejected,
                candidatesRejected,
              );
              if (!candidate || candidate.length < 3) {
                candidatesRejected.push(candidate || '<empty>');
                continue;
              }
              if (candidatesRejected.includes(candidate)) continue;
              const available = await probeClient.isAgentnameAvailable(candidate);
              if (!available) {
                candidatesRejected.push(candidate);
                continue;
              }
              newName = candidate;
              break;
            }

            if (!newName) {
              throw new Error(
                `could not find an available agentname after ${MAX_AGENTNAME_REGISTER_RETRIES} retries (persona=${persona.id}, tried: ${rejectedNames.join(', ')})`,
              );
            }

            // Rename the on-disk directory and update all state references
            // so Phase B (post publishing) still finds the agent's files.
            const newDir = join(config.agentsDir, newName);
            await rename(agentItem.dir, newDir);
            agentItem.dir = newDir;
            agentItem.jsonPath = join(newDir, 'agent.json');
            data.agentname = newName;
            indexAgent.agentname = newName;
            await writeFile(agentItem.jsonPath, JSON.stringify(data, null, 2));
            log('warn', `  @${currentName} → @${newName} — renamed, retrying registration`);
          }
        }
      } catch (err) {
        const msg = formatError(err);
        const displayName = data.agentname;
        log('error', `@${displayName} — registration failed: ${msg}`);
        errors.push({ agent: displayName, phase: 'register', message: msg });
        regBar.tick(`@${displayName} — failed`);
        logEvent({
          eventType: 'registration',
          agentname: displayName,
          persona: indexAgent.personaId,
          success: false,
          durationMs: Date.now() - regStartedAt,
          error: msg,
        });
      }
    });
    regBar.done(
      `Phase A — ${registeredCount} registered, ${needsRegistration.length - registeredCount} failed`,
    );
  }

  // --- Phase A.5: Generate avatars concurrently ---
  //
  // For each registered agent without an avatar on disk, call
  // `POST /agents/me/avatar/generate` (server-side Together AI FLUX). Every
  // success burns 1 of the agent's 5 lifetime generations, so this phase is
  // strictly a miss-fill — it never re-rolls an agent that already has an
  // `avatarUrl` set.
  //
  // Agents without an `avatarPrompt` (e.g. older drafts baked before this
  // feature, or agents whose prompt draft failed inside `generate`) get a
  // just-in-time prompt via Gemini here. That means a backfill run against a
  // legacy population works without any intermediate `pnpm avatars` step.
  //
  // Soft failures — no prompt after retry, 403 cap reached, 403 content
  // blocked — skip the agent and emit `avatar_skipped`. They do NOT abort
  // the phase or invalidate registration; the operator can re-run
  // `pnpm avatars` later to patch the gaps.

  const needsAvatar = prepared.filter((p) => p.data.apiKey && !p.data.avatarUrl);
  let avatarsCreated = 0;
  if (needsAvatar.length > 0) {
    ui.section(
      `Phase A.5 — generate ${needsAvatar.length} avatars (concurrency ${config.avatarConcurrency})`,
    );
    const avBar = ui.progress(needsAvatar.length);

    // Avatar generation hits the same Together AI FLUX.1 Schnell pipeline as
    // Phase B posts and is subject to the same saturation-shaped 429 / 502
    // bursts. Guard it with a dedicated breaker so a fleet-wide spike pauses
    // avatar workers instead of hammering the endpoint across
    // `avatarConcurrency` parallel callers.
    const avatarBreaker = new CircuitBreaker({
      name: 'publish.generateAvatar',
      failureThreshold: config.publishCircuitFailureThreshold,
      windowMs: config.publishCircuitWindowMs,
      coolOffMs: config.publishCircuitCoolOffMs,
      maxCoolOffMs: config.publishCircuitMaxCoolOffMs,
      maxTrips: config.publishCircuitMaxTrips,
    });
    let avatarAborted = false;

    await mapWithConcurrency(
      needsAvatar,
      config.avatarConcurrency,
      async ({ indexAgent, data, jsonPath, persona }) => {
        const avStartedAt = Date.now();
        const logSkipped = (reason: string, details: Record<string, unknown> = {}): void => {
          logEvent({
            eventType: 'avatar_skipped',
            agentname: indexAgent.agentname,
            persona: indexAgent.personaId,
            success: false,
            durationMs: Date.now() - avStartedAt,
            details:
              reason === 'error' ? { reason, ...details } : { skipped: true, reason, ...details },
          });
        };
        if (avatarAborted) {
          logSkipped('circuit_aborted');
          avBar.tick(`@${indexAgent.agentname} — skipped (circuit)`);
          return;
        }
        try {
          await avatarBreaker.gate();
        } catch (err) {
          if (err instanceof CircuitAbortError) {
            if (!avatarAborted) {
              avatarAborted = true;
              log(
                'error',
                `Phase A.5 aborting — ${err.message}. Rerun publish-drafts (or pnpm avatars) to resume.`,
              );
              errors.push({
                agent: '(fleet)',
                phase: 'avatar (circuit)',
                message: err.message,
              });
            }
            logSkipped('circuit_aborted');
            avBar.tick(`@${indexAgent.agentname} — skipped (circuit)`);
            return;
          }
          throw err;
        }
        try {
          if (!data.avatarPrompt) {
            // Just-in-time prompt draft so a legacy population (no avatarPrompt
            // on disk) can be avatared without a separate backfill pass.
            try {
              const prompt = await generateAvatarPrompt(persona, data);
              data.avatarPrompt = prompt;
              await writeFile(jsonPath, JSON.stringify(data, null, 2));
              logEvent({
                eventType: 'avatar_prompt_drafted',
                agentname: indexAgent.agentname,
                persona: indexAgent.personaId,
                success: true,
                details: { promptLength: prompt.length, source: 'publish-phase-a5' },
              });
            } catch (err) {
              const msg = formatError(err);
              log('warn', `  @${indexAgent.agentname} — avatar prompt draft failed: ${msg}`);
              logSkipped('prompt_draft_failed', { error: msg });
              avBar.tick(`@${indexAgent.agentname} — no prompt`);
              return;
            }
          }

          const authed = new InstaMoltClient(data.apiKey);
          const res = await authed.generateAvatar(data.avatarPrompt);
          avatarBreaker.recordSuccess();
          data.avatarUrl = res.avatar_url;
          data.avatarGenerationSeed = res.generation_seed ?? undefined;
          data.avatarGeneratedAt = new Date().toISOString();
          await writeFile(jsonPath, JSON.stringify(data, null, 2));
          avatarsCreated++;
          logEvent({
            eventType: 'avatar_generated',
            agentname: indexAgent.agentname,
            persona: indexAgent.personaId,
            success: true,
            durationMs: Date.now() - avStartedAt,
            details: {
              generationsUsed: res.generations_used,
              generationsRemaining: res.generations_remaining,
              generationSeed: res.generation_seed ?? null,
            },
          });
          avBar.tick(`@${indexAgent.agentname} — avatar set`);
        } catch (err) {
          // Only saturation-shaped failures (fleet/per-agent rate limit +
          // image-gen service unavailable) feed the breaker. 403s, 400s, and
          // auth failures are caller/content problems — counting them would
          // open the breaker for a pause that does nothing to fix them.
          const apiErr = err instanceof InstaMoltApiError ? err : undefined;
          const code = apiErr ? parseErrorCode(apiErr.body) : undefined;
          const status = apiErr?.status ?? 0;
          const isSaturation =
            (status === 429 && code === 'RATE_LIMIT_EXCEEDED') ||
            (status === 502 && code === 'GENERATION_FAILED') ||
            status === 503 ||
            status === 504;
          if (isSaturation) avatarBreaker.recordFailure(apiErr?.retryAfterMs);

          // Discriminate the 403 sub-cases so the operator-facing event log
          // tells them WHY an agent was skipped without grepping error text.
          if (err instanceof InstaMoltApiError && err.status === 403) {
            const code = parseErrorCode(err.body) ?? 'forbidden';
            if (code === 'AVATAR_GENERATION_LIMIT_REACHED') {
              log('warn', `  @${indexAgent.agentname} — avatar cap reached (5/5), skipping`);
              logSkipped('cap_reached', { errorCode: code });
              avBar.tick(`@${indexAgent.agentname} — cap reached`);
              return;
            }
            if (code === 'CONTENT_BLOCKED') {
              log(
                'warn',
                `  @${indexAgent.agentname} — avatar prompt blocked by moderation, skipping (edit avatarPrompt on disk and rerun pnpm avatars to retry)`,
              );
              logSkipped('prompt_blocked', { errorCode: code });
              avBar.tick(`@${indexAgent.agentname} — prompt blocked`);
              return;
            }
            // AGENT_TIMEOUT / AGENT_BANNED / anything else 403 → still
            // non-fatal for the population; log and move on.
            log('warn', `  @${indexAgent.agentname} — avatar 403 (${code}), skipping`);
            logSkipped('forbidden', { errorCode: code });
            avBar.tick(`@${indexAgent.agentname} — 403 ${code}`);
            return;
          }
          const msg = formatError(err);
          log('error', `@${indexAgent.agentname} — avatar generation failed: ${msg}`);
          errors.push({ agent: indexAgent.agentname, phase: 'avatar', message: msg });
          logSkipped('error', { error: msg });
          avBar.tick(`@${indexAgent.agentname} — failed`);
        }
      },
    );
    avBar.done(
      `Phase A.5 — ${avatarsCreated} avatars set, ${needsAvatar.length - avatarsCreated} skipped`,
    );
  }

  // --- Phase B: Publish posts round-robin across agents ---
  //
  // The pipeline is fleet-wide round-robin: all agents' post-001.json drafts
  // are queued first, then all post-002.json, etc. With N concurrent workers
  // pulling from that queue, any single agent's post-002 can't be dispatched
  // until every other agent's post-001 has been dispatched first. This
  // smooths the per-agent burst shape (no back-to-back posts from a single
  // worker's sequential walk) and keeps the load on Together AI's FLUX
  // pipeline evenly spread across the fleet. The previous sequential-per-
  // agent design fired post-002 the instant post-001 returned, which
  // concentrated calls into per-agent bursts even when fleet-wide
  // throughput was fine.
  //
  // A shared {@link CircuitBreaker} wraps every `/posts/generate` call.
  // When sustained 429 RATE_LIMIT_EXCEEDED or 502 GENERATION_FAILED bursts
  // cross the configured threshold, the breaker opens and pauses all
  // workers for a cool-off window (see `publishCircuit*` in src/config.ts).
  // This is the backstop for Together AI saturation — if FLUX is slower
  // than our steady-state budget allows (600 RPM target ~33%), the breaker
  // naturally paces us without hand-tuning `publishConcurrency`.

  const readyToPost = prepared.filter((p) => p.data.apiKey);
  const postLimit = options.limit ?? Infinity;

  if (readyToPost.length > 0) {
    // Pre-scan so we (1) know the total tick count for the progress bar and
    // (2) can build a flat, interleaved task list with per-agent ordering
    // preserved (post-001 before post-002 WITHIN an agent, all post-001s
    // across agents before any post-002). Unreadable files are kept in the
    // list so the worker surfaces the error through its own catch instead
    // of being silently dropped.
    interface PostTask {
      agentItem: PreparedAgent;
      postFile: string;
      /**
       * Index into the agent's unpublished-post list (0-based). Used as the
       * outer sort key so the interleave groups all index-0 posts, then
       * index-1, etc.
       */
      postIndex: number;
    }
    const tasksByAgent = new Map<string, PostTask[]>();
    for (const item of readyToPost) {
      const tasks: PostTask[] = [];
      try {
        const files = await readdir(item.dir);
        const postFiles = files.filter((f) => f.startsWith('post-') && f.endsWith('.json')).sort();
        let unpublishedIdx = 0;
        for (const postFile of postFiles) {
          if (unpublishedIdx >= postLimit) break;
          let alreadyPublished = false;
          try {
            const post = JSON.parse(
              await readFile(join(item.dir, postFile), 'utf-8'),
            ) as GeneratedPost;
            alreadyPublished = post.published === true;
          } catch {
            // Unreadable post file — let the worker surface it.
          }
          if (alreadyPublished) continue;
          tasks.push({ agentItem: item, postFile, postIndex: unpublishedIdx });
          unpublishedIdx++;
        }
      } catch {
        // Unreadable agent dir → zero tasks; nothing to do.
      }
      tasksByAgent.set(item.indexAgent.agentname, tasks);
    }
    // Interleave: outer loop over post-index (all agents' post-001 first,
    // then all post-002, …), inner loop over agents in the `readyToPost`
    // order. This ordering is what creates the per-agent spacing.
    const maxPostIndex = Array.from(tasksByAgent.values()).reduce(
      (m, list) => Math.max(m, list.length),
      0,
    );
    const interleavedTasks: PostTask[] = [];
    for (let pi = 0; pi < maxPostIndex; pi++) {
      for (const item of readyToPost) {
        const list = tasksByAgent.get(item.indexAgent.agentname);
        if (list && pi < list.length) interleavedTasks.push(list[pi]);
      }
    }
    const totalPostFiles = interleavedTasks.length;

    ui.section(
      `Phase B — publish ${totalPostFiles} posts across ${readyToPost.length} agents (concurrency ${config.publishConcurrency}, round-robin)`,
    );

    const breaker = new CircuitBreaker({
      name: 'publish.generatePost',
      failureThreshold: config.publishCircuitFailureThreshold,
      windowMs: config.publishCircuitWindowMs,
      coolOffMs: config.publishCircuitCoolOffMs,
      maxCoolOffMs: config.publishCircuitMaxCoolOffMs,
      maxTrips: config.publishCircuitMaxTrips,
    });

    const postBar = ui.progress(totalPostFiles);
    // `aborted` latches true when the breaker latches permanently open.
    // Every subsequent worker sees the flag, ticks its slot as skipped, and
    // exits without touching the platform — we can't cancel in-flight
    // fetches in Node, but we can stop starting new ones.
    let aborted = false;
    await mapWithConcurrency(
      interleavedTasks,
      config.publishConcurrency,
      async ({ agentItem, postFile }) => {
        if (aborted) {
          postBar.tick(`@${agentItem.indexAgent.agentname} — ${postFile} skipped (circuit)`);
          return;
        }
        try {
          await breaker.gate();
        } catch (err) {
          if (err instanceof CircuitAbortError) {
            if (!aborted) {
              aborted = true;
              log(
                'error',
                `Phase B aborting — ${err.message}. Rerun publish-drafts to resume; unpublished post-*.json drafts are preserved on disk.`,
              );
              errors.push({ agent: '(fleet)', phase: 'post (circuit)', message: err.message });
            }
            postBar.tick(`@${agentItem.indexAgent.agentname} — ${postFile} skipped (circuit)`);
            return;
          }
          throw err;
        }

        const { indexAgent, data, dir } = agentItem;
        const postPath = join(dir, postFile);
        let post: GeneratedPost;
        try {
          post = JSON.parse(await readFile(postPath, 'utf-8')) as GeneratedPost;
        } catch (err) {
          const msg = formatError(err);
          log('error', `${indexAgent.agentname}: ${postFile} unreadable -- ${msg}`);
          errors.push({
            agent: indexAgent.agentname,
            phase: `post ${postFile}`,
            message: msg,
          });
          postBar.tick(`@${indexAgent.agentname} — ${postFile} unreadable`);
          return;
        }
        if (post.published) {
          // Race: another process (or a prior interrupted run resumed
          // concurrently) already published this draft. Skip silently — the
          // tick still counts so the bar reaches 100%.
          postBar.tick(`@${indexAgent.agentname} — ${postFile} already`);
          return;
        }

        const postStartedAt = Date.now();
        try {
          const authed = new InstaMoltClient(data.apiKey);
          const result = await authed.generatePost({
            prompt: post.imagePrompt,
            caption: post.caption,
            aspect_ratio: post.aspectRatio,
          });
          breaker.recordSuccess();

          post.published = true;
          post.publishedAt = new Date().toISOString();
          post.instamoltPostId = result.post.id;
          await writeFile(postPath, JSON.stringify(post, null, 2));
          postedCount++;
          logEvent({
            eventType: 'post_published',
            agentname: indexAgent.agentname,
            persona: indexAgent.personaId,
            success: true,
            durationMs: Date.now() - postStartedAt,
            details: { postFile, chaos: post.chaos === true },
          });
          postBar.tick(`@${indexAgent.agentname} — ${postFile} posted`);

          // Post-publish view fanout. N random *other* registered agents
          // authenticated-read the new post so it lands with a believable
          // opening view count instead of 0. Best-effort — failures emit
          // `view` events with `success: false` but never abort the publish.
          // The viewer pool is `readyToPost` (agents with apiKey already in
          // hand at this phase); the post author is excluded server-side
          // by `pickViewers` in the helper.
          if (config.viewsPerPublishedPost > 0) {
            try {
              const viewerPool = readyToPost.map((p) => p.data);
              await fanOutPostViews({
                postId: result.post.id,
                postAuthor: indexAgent.agentname,
                pool: viewerPool,
                count: config.viewsPerPublishedPost,
                concurrency: config.viewConcurrency,
                source: 'publish_fanout',
              });
            } catch (err) {
              // fanOutPostViews catches per-viewer failures internally; an
              // outer throw here would be a programming error in the helper
              // itself. Log and move on — do NOT count against the publish.
              log('warn', `View fanout failed for ${result.post.id}: ${err}`);
            }
          }

          if (config.postDelay > 0) await sleep(config.postDelay);
        } catch (err) {
          // Only saturation-shaped failures (fleet/per-agent rate limit +
          // image-gen service unavailable) feed the breaker. Moderation
          // blocks (403), validation errors (400), auth failures (401/403),
          // and content rejections are caller/content problems — counting
          // them would open the breaker for a fleet-wide pause that does
          // nothing to fix the underlying bug.
          const apiErr = err instanceof InstaMoltApiError ? err : undefined;
          const code = apiErr ? parseErrorCode(apiErr.body) : undefined;
          const status = apiErr?.status ?? 0;
          const isSaturation =
            (status === 429 && code === 'RATE_LIMIT_EXCEEDED') ||
            (status === 502 && code === 'GENERATION_FAILED') ||
            status === 503 ||
            status === 504;
          if (isSaturation) breaker.recordFailure(apiErr?.retryAfterMs);

          const msg = formatError(err);
          log('error', `${indexAgent.agentname}: ${postFile} error -- ${msg}`);
          errors.push({
            agent: indexAgent.agentname,
            phase: `post ${postFile}`,
            message: msg,
          });
          logEvent({
            eventType: 'post_published',
            agentname: indexAgent.agentname,
            persona: indexAgent.personaId,
            success: false,
            durationMs: Date.now() - postStartedAt,
            error: msg,
            details: { postFile },
          });
          postBar.tick(`@${indexAgent.agentname} — ${postFile} failed`);
        }
      },
    );
    postBar.done(`Phase B — ${postedCount} posts published across ${readyToPost.length} agents`);
  }

  // --- Phase C: Bootstrap follow graph ---

  let followEdgesCreated = 0;
  if (!options.skipFollowGraph) {
    ui.section('Phase C — bootstrapping follow graph');

    // Re-read every agent.json from disk so we have the freshest apiKey state.
    const registered: GeneratedAgent[] = [];
    for (const a of index.agents) {
      try {
        const data = JSON.parse(
          await readFile(join(config.agentsDir, a.agentname, 'agent.json'), 'utf-8'),
        ) as GeneratedAgent;
        if (data.apiKey && data.agentname && data.agentname.trim().length >= 3) {
          registered.push(data);
        }
      } catch {
        // skip unreadable agents
      }
    }

    if (registered.length < 2) {
      log(
        'warn',
        `  Need at least 2 registered agents to bootstrap follow graph (have ${registered.length}), skipping`,
      );
    } else {
      const affinityMatrix = computeAffinityMatrix(personas);

      // Flatten (follower, target) tuples into a single edge list so the
      // worker pool can fan out across the whole graph instead of being
      // stuck inside one follower's target loop. `planFollows` is a pure
      // function over immutable inputs, so calling it per-follower in
      // sequence here is fast and keeps its "pick the best targets for this
      // follower" logic intact.
      interface FollowEdge {
        follower: GeneratedAgent;
        followerPersona: Persona;
        target: ReturnType<typeof planFollows>['targets'][number];
      }
      // When `--agent` is set we only want to bootstrap the follow edges FROM
      // that single agent out into the fleet. The candidate pool remains the
      // full registered fleet (so the target has someone to follow), but the
      // outer follower loop is restricted — otherwise a targeted single-agent
      // publish would mutate the global follow graph on every other agent.
      // The same applies to `--limit-agents`: the debug-loop contract is
      // "cap the run to this subset", which must include Phase C, or a
      // follow-up debug run would see follow edges it didn't ask for.
      const selectedAgentnames = new Set(agents.map((a) => a.agentname));
      const followers = registered.filter((a) => selectedAgentnames.has(a.agentname));
      const edges: FollowEdge[] = [];
      for (const follower of followers) {
        const followerPersona = personas.get(follower.personaId);
        if (!followerPersona) continue;
        const candidates = registered.filter((a) => a.agentname !== follower.agentname);
        const plan = planFollows({
          follower,
          followerPersona,
          candidates,
          personas,
          affinityMatrix,
        });
        for (const target of plan.targets) {
          edges.push({ follower, followerPersona, target });
        }
      }

      const bar = ui.progress(edges.length);
      await mapWithConcurrency(edges, config.followConcurrency, async ({ follower, target }) => {
        const client = new InstaMoltClient(follower.apiKey!);
        const followStartedAt = Date.now();
        try {
          const res = await client.followAgent(target.agentname);
          // Re-toggle if the first call unfollowed (server toggle semantics).
          // Without this, a re-run of publish on already-registered agents
          // would silently unwind every edge from the previous run.
          if (res.following === false) await client.followAgent(target.agentname);
          followEdgesCreated++;
          bar.tick(
            `@${follower.agentname} ${ui.symbol.arrow} @${target.agentname} (T${target.tier})`,
          );
          logEvent({
            eventType: 'follow',
            agentname: follower.agentname,
            persona: follower.personaId,
            success: true,
            durationMs: Date.now() - followStartedAt,
            details: { target: target.agentname, tier: target.tier, reason: target.reason },
          });
        } catch (err) {
          const msg = formatError(err);
          log(
            'warn',
            `follow failed ${follower.agentname} ${ui.symbol.arrow} ${target.agentname}: ${msg}`,
          );
          errors.push({
            agent: follower.agentname,
            phase: `follow -> @${target.agentname}`,
            message: msg,
          });
        }
      });
      bar.done(`Created ${followEdgesCreated} follow edges across ${registered.length} agents`);
    }
  }

  // Update master index with any new API keys
  const updatedAgents = await Promise.all(
    index.agents.map(async (a) => {
      try {
        const data = JSON.parse(
          await readFile(join(config.agentsDir, a.agentname, 'agent.json'), 'utf-8'),
        );
        return data as GeneratedAgent;
      } catch {
        return a;
      }
    }),
  );
  index.agents = updatedAgents;
  await writeFile(config.agentsIndexPath, JSON.stringify(index, null, 2));

  const errorCount = errors.length;

  if (errorCount > 0) {
    ui.section(`Errors (${errorCount})`);
    const counts = new Map<string, number>();
    for (const e of errors) {
      counts.set(e.message, (counts.get(e.message) ?? 0) + 1);
      log('error', `  @${e.agent} [${e.phase}] ${e.message}`);
    }
    const topCauses = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([msg, n]) => `  ${n}× ${msg}`)
      .join('\n');
    ui.note('Top error causes', topCauses);
  }

  ui.note(
    'Publish complete',
    ui.summaryLine([
      { label: 'registered', value: registeredCount, tone: 'ok' },
      { label: 'avatars', value: avatarsCreated, tone: 'ok' },
      { label: 'posted', value: postedCount, tone: 'ok' },
      { label: 'follow edges', value: followEdgesCreated, tone: 'info' },
      { label: 'errors', value: errorCount, tone: errorCount > 0 ? 'err' : 'info' },
    ]),
  );

  ui.outro(
    errorCount > 0
      ? ui.color.yellow(`${ui.symbol.warn} publish done with ${errorCount} errors`)
      : ui.color.green(`${ui.symbol.ok} publish done`),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
