import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { loadPersonas } from '@/personas/index';
import { InstaMoltClient } from '@/services/instamolt-api';
import { generatePost } from '@/services/instamolt-mcp';
import { answerChallenge } from '@/services/llm';
import type { AgentsIndex, GeneratedAgent, GeneratedPost } from '@/types';

interface PublishOptions {
  agent?: string;
  limit?: number;
  skipFollowGraph?: boolean;
}

/**
 * Publish generated agents and posts to live InstaMolt.
 * Reads from output/ directory. Resumable -- tracks what's been published.
 */
export async function publish(options: PublishOptions = {}): Promise<void> {
  ui.intro('Publish');
  const personas = await loadPersonas();

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
  let errorCount = 0;

  ui.section(`Phase A/B — register & post (${agents.length} agents)`);

  for (const agent of agents) {
    // Skip agents with empty or too-short names
    if (!agent.agentname || agent.agentname.trim().length < 3) {
      log(
        'warn',
        `Agent has empty or short name "${agent.agentname}", skipping. Run scripts/fix-agents.ts first.`,
      );
      continue;
    }

    const agentDir = join(config.agentsDir, agent.agentname);
    const agentJsonPath = join(agentDir, 'agent.json');
    const persona = personas.get(agent.personaId);

    if (!persona) {
      log('warn', `Persona ${agent.personaId} not found, skipping ${agent.agentname}`);
      continue;
    }

    // --- Phase A: Register if needed ---

    let agentData: GeneratedAgent;
    try {
      agentData = JSON.parse(await readFile(agentJsonPath, 'utf-8'));
    } catch {
      log('error', `Can't read ${agentJsonPath}, skipping`);
      continue;
    }

    // Also validate the name from the actual agent.json on disk
    if (!agentData.agentname || agentData.agentname.trim().length < 3) {
      log(
        'warn',
        `Agent file ${agentJsonPath} has empty/short name, skipping. Run scripts/fix-agents.ts first.`,
      );
      continue;
    }

    const sp = ui.spinner();
    sp.start(`@${agent.agentname} — preparing`);

    if (!agentData.apiKey) {
      sp.message(`@${agent.agentname} — registering`);
      try {
        const client = new InstaMoltClient();

        const description = agentData.bio;

        // Start challenge
        const challenge = await client.startChallenge(agent.agentname, description);

        // Answer challenge via LLM
        const answer = await answerChallenge(persona, challenge.challenge);

        // Complete registration
        const reg = await client.completeChallenge(challenge.request_id, answer);

        if (!reg.agent?.api_key) {
          log('error', `  Registration response missing agent.api_key: ${JSON.stringify(reg)}`);
          throw new Error('Registration returned no API key');
        }

        // Save API key to disk IMMEDIATELY so a later failure can't brick the agent.
        // (See AUDIT.md finding #11.)
        agentData.apiKey = reg.agent.api_key;
        agentData.registeredAt = new Date().toISOString();
        await writeFile(agentJsonPath, JSON.stringify(agentData, null, 2));

        registeredCount++;
        sp.message(`@${agent.agentname} — registered`);
      } catch (err) {
        sp.stop(`@${agent.agentname} — registration failed: ${err}`, 1);
        errorCount++;
        continue;
      }

      // updateProfile is a best-effort follow-up. Failure here does NOT invalidate
      // the registration — the API key is already persisted above.
      try {
        const authedClient = new InstaMoltClient(agentData.apiKey!);
        await authedClient.updateProfile(agentData.bio);
      } catch (err) {
        log(
          'warn',
          `  updateProfile failed for ${agent.agentname} (agent is still registered): ${err}`,
        );
      }

      await sleep(config.registrationDelay);
    }

    // --- Phase B: Publish posts ---

    const files = await readdir(agentDir);
    const postFiles = files.filter((f) => f.startsWith('post-') && f.endsWith('.json')).sort();

    let postsPublished = 0;
    const postLimit = options.limit ?? Infinity;

    for (const postFile of postFiles) {
      if (postsPublished >= postLimit) break;

      const postPath = join(agentDir, postFile);
      const post: GeneratedPost = JSON.parse(await readFile(postPath, 'utf-8'));

      // Skip already published
      if (post.published) continue;

      try {
        const result = await generatePost(agentData.apiKey!, {
          prompt: post.imagePrompt,
          caption: post.caption,
          aspect_ratio: post.aspectRatio,
        });

        if (result.success) {
          post.published = true;
          post.publishedAt = new Date().toISOString();
          post.instamoltPostId = result.postId;
          await writeFile(postPath, JSON.stringify(post, null, 2));

          postsPublished++;
          postedCount++;
          sp.message(
            `@${agent.agentname} — posted ${postsPublished}/${postFiles.length} (${postFile})`,
          );
        } else {
          log('error', `${agent.agentname}: ${postFile} failed -- ${result.error}`);
          errorCount++;
        }

        await sleep(config.postDelay);
      } catch (err) {
        log('error', `${agent.agentname}: ${postFile} error -- ${err}`);
        errorCount++;
      }
    }

    sp.stop(`@${agent.agentname} — done (${postsPublished} posts this run)`);
    await sleep(config.agentDelay);
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
      // Estimate total edges (avg of 5..10 = 7.5) so the bar tracks something
      // close to the real workload. The actual count is <= this since
      // candidates may be smaller for tiny agent pools.
      const estimatedEdges = registered.length * Math.min(8, registered.length - 1);
      const bar = ui.progress(estimatedEdges);

      for (const follower of registered) {
        const candidates = registered.filter((a) => a.agentname !== follower.agentname);
        const targetCount = Math.min(randomInt(5, 10), candidates.length);

        // Fisher-Yates shuffle a copy and take the first targetCount entries
        const shuffled = [...candidates];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const targets = shuffled.slice(0, targetCount);

        const client = new InstaMoltClient(follower.apiKey!);
        for (const target of targets) {
          try {
            await client.followAgent(target.agentname);
            followEdgesCreated++;
            bar.tick(`@${follower.agentname} ${ui.symbol.arrow} @${target.agentname}`);
          } catch (err) {
            log(
              'warn',
              `follow failed ${follower.agentname} ${ui.symbol.arrow} ${target.agentname}: ${err}`,
            );
          }
          await sleep(randomInt(2000, 5000));
        }
      }
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

  ui.note(
    'Publish complete',
    ui.summaryLine([
      { label: 'registered', value: registeredCount, tone: 'ok' },
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

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
