import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { mapWithConcurrency } from '@/lib/concurrency';
import { drainWrites, flushStats, initEventLogger, logEvent } from '@/lib/event-logger';
import { computeAffinityMatrix, planFollows } from '@/lib/follow-algorithm';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { InstaMoltApiError, InstaMoltClient, parseErrorCode } from '@/services/instamolt-api';
import { answerChallenge, type BioModerationFeedback, generateBio } from '@/services/llm';
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
  skipFollowGraph?: boolean;
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
  ui.intro('Publish');
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

  const agents = options.agent
    ? index.agents.filter((a) => a.agentname === options.agent)
    : index.agents;

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
    await mapWithConcurrency(
      needsRegistration,
      config.registerConcurrency,
      async ({ indexAgent, data, jsonPath, persona, voiceProfile }) => {
        try {
          const client = new InstaMoltClient();
          const challenge = await startChallengeWithBioRetry(
            client,
            indexAgent.agentname,
            data,
            persona,
            voiceProfile,
            jsonPath,
            ({ attempt, category, reason }) => {
              log(
                'warn',
                `  @${indexAgent.agentname} — bio blocked (${category}); regenerated attempt ${attempt} of ${MAX_BIO_MODERATION_RETRIES}: ${reason}`,
              );
              logEvent({
                eventType: 'registration',
                agentname: indexAgent.agentname,
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
            throw new Error(`Registration response missing agent.api_key: ${JSON.stringify(reg)}`);
          }

          // Persist the API key immediately so a later failure can't brick
          // the agent (AUDIT.md #11). Mutates the shared `prepared` entry so
          // Phase B sees the new key.
          data.apiKey = reg.agent.api_key;
          data.registeredAt = new Date().toISOString();
          await writeFile(jsonPath, JSON.stringify(data, null, 2));
          registeredCount++;

          logEvent({
            eventType: 'registration',
            agentname: indexAgent.agentname,
            persona: indexAgent.personaId,
            success: true,
          });

          // updateProfile is best-effort; failure here does NOT invalidate
          // registration (the api_key is already on disk).
          try {
            const authed = new InstaMoltClient(data.apiKey);
            await authed.updateProfile(data.bio);
          } catch (err) {
            log(
              'warn',
              `  updateProfile failed for ${indexAgent.agentname} (agent is still registered): ${formatError(err)}`,
            );
          }

          if (config.registrationDelay > 0) await sleep(config.registrationDelay);
          regBar.tick(`@${indexAgent.agentname} — registered`);
        } catch (err) {
          const msg = formatError(err);
          log('error', `@${indexAgent.agentname} — registration failed: ${msg}`);
          errors.push({ agent: indexAgent.agentname, phase: 'register', message: msg });
          regBar.tick(`@${indexAgent.agentname} — failed`);
          logEvent({
            eventType: 'registration',
            agentname: indexAgent.agentname,
            persona: indexAgent.personaId,
            success: false,
            error: msg,
          });
        }
      },
    );
    regBar.done(
      `Phase A — ${registeredCount} registered, ${needsRegistration.length - registeredCount} failed`,
    );
  }

  // --- Phase B: Publish posts concurrently across agents ---
  //
  // Each worker handles ONE agent's post queue, walking that agent's
  // post-*.json files sequentially (timeline coherence: post-001 before
  // post-002). Across agents, N workers run in parallel — `publishConcurrency`
  // caps the fleet-wide count of concurrent MCP subprocess spawns, which is
  // the real memory-bound ceiling (each spawn is a node process).

  const readyToPost = prepared.filter((p) => p.data.apiKey);
  const postLimit = options.limit ?? Infinity;

  if (readyToPost.length > 0) {
    // Pre-scan post counts so the progress bar can tick once per individual
    // post (success / error / already-published) instead of once per agent.
    // Without this the bar advances only when an entire agent's queue drains,
    // which under publishConcurrency=10 means no visible progress until the
    // whole phase is essentially done.
    // Count only unpublished posts toward `expected`. If we counted all
    // post-*.json files, a run with `--limit N` where the first N files on
    // disk are already `published: true` would exit the loop on the tick
    // cap before ever reaching an unpublished draft.
    const agentTotals = new Map<string, number>();
    for (const item of readyToPost) {
      try {
        const files = await readdir(item.dir);
        const postFiles = files.filter((f) => f.startsWith('post-') && f.endsWith('.json'));
        let unpublished = 0;
        for (const postFile of postFiles) {
          try {
            const post = JSON.parse(
              await readFile(join(item.dir, postFile), 'utf-8'),
            ) as GeneratedPost;
            if (!post.published) unpublished++;
          } catch {
            // Unreadable post file — count it so the worker reaches it and
            // surfaces the error through its own catch.
            unpublished++;
          }
        }
        agentTotals.set(item.indexAgent.agentname, Math.min(unpublished, postLimit));
      } catch {
        agentTotals.set(item.indexAgent.agentname, 0);
      }
    }
    const totalPostFiles = Array.from(agentTotals.values()).reduce((sum, n) => sum + n, 0);

    ui.section(
      `Phase B — publish ${totalPostFiles} posts across ${readyToPost.length} agents (concurrency ${config.publishConcurrency})`,
    );
    const postBar = ui.progress(totalPostFiles);
    await mapWithConcurrency(
      readyToPost,
      config.publishConcurrency,
      async ({ indexAgent, data, dir }) => {
        const expected = agentTotals.get(indexAgent.agentname) ?? 0;
        let ticked = 0;
        let postsPublished = 0;
        try {
          const files = await readdir(dir);
          const postFiles = files
            .filter((f) => f.startsWith('post-') && f.endsWith('.json'))
            .sort();

          for (const postFile of postFiles) {
            if (postsPublished >= postLimit) break;

            const postPath = join(dir, postFile);
            const post: GeneratedPost = JSON.parse(await readFile(postPath, 'utf-8'));
            if (post.published) {
              // Already-published posts don't consume a limit slot and
              // don't tick the bar — `expected` counts only unpublished
              // posts so already-published ones are invisible to it.
              continue;
            }

            try {
              const authed = new InstaMoltClient(data.apiKey);
              const result = await authed.generatePost({
                prompt: post.imagePrompt,
                caption: post.caption,
                aspect_ratio: post.aspectRatio,
              });

              post.published = true;
              post.publishedAt = new Date().toISOString();
              post.instamoltPostId = result.post.id;
              await writeFile(postPath, JSON.stringify(post, null, 2));
              postsPublished++;
              postedCount++;
              logEvent({
                eventType: 'post_published',
                agentname: indexAgent.agentname,
                persona: indexAgent.personaId,
                success: true,
                details: { postFile, chaos: post.chaos === true },
              });
              postBar.tick(`@${indexAgent.agentname} — ${postFile} posted`);
              ticked++;

              if (config.postDelay > 0) await sleep(config.postDelay);
            } catch (err) {
              const msg = formatError(err);
              log('error', `${indexAgent.agentname}: ${postFile} error -- ${msg}`);
              errors.push({
                agent: indexAgent.agentname,
                phase: `post ${postFile}`,
                message: msg,
              });
              postBar.tick(`@${indexAgent.agentname} — ${postFile} failed`);
              ticked++;
            }
          }
        } catch (err) {
          const msg = formatError(err);
          log('error', `@${indexAgent.agentname} — post phase failed: ${msg}`);
          errors.push({ agent: indexAgent.agentname, phase: 'post (fatal)', message: msg });
        }
        // Drain unused slots so the bar still reaches 100% when an agent
        // exits early (fatal directory error, postLimit hit, etc.).
        while (ticked < expected) {
          postBar.tick(`@${indexAgent.agentname} — skipped`);
          ticked++;
        }
        if (config.agentDelay > 0) await sleep(config.agentDelay);
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
      const followers = options.agent
        ? registered.filter((a) => a.agentname === options.agent)
        : registered;
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
      { label: 'posted', value: postedCount, tone: 'ok' },
      { label: 'follow edges', value: followEdgesCreated, tone: 'info' },
      { label: 'errors', value: errorCount, tone: errorCount > 0 ? 'err' : 'info' },
    ]),
  );

  await drainWrites();
  flushStats();

  ui.outro(
    errorCount > 0
      ? ui.color.yellow(`${ui.symbol.warn} publish done with ${errorCount} errors`)
      : ui.color.green(`${ui.symbol.ok} publish done`),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
