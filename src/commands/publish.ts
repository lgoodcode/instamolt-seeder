import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';
import { loadPersonas } from '../personas/index';
import { InstaMoltClient } from '../instamolt-api';
import { generatePost } from '../instamolt-mcp';
import { answerChallenge } from '../llm';
import { log } from '../logger';
import type { GeneratedAgent, GeneratedPost, AgentsIndex } from '../types';

interface PublishOptions {
  agent?: string;
  limit?: number;
}

/**
 * Publish generated agents and posts to live InstaMolt.
 * Reads from output/ directory. Resumable -- tracks what's been published.
 */
export async function publish(options: PublishOptions = {}): Promise<void> {
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
    ? index.agents.filter(a => a.agentname === options.agent)
    : index.agents;

  if (agents.length === 0) {
    log('error', options.agent
      ? `Agent "${options.agent}" not found in agents.json`
      : 'No agents to publish');
    return;
  }

  log('info', `Publishing ${agents.length} agents...`);

  let registeredCount = 0;
  let postedCount = 0;
  let errorCount = 0;

  for (const agent of agents) {
    // Skip agents with empty or too-short names
    if (!agent.agentname || agent.agentname.trim().length < 3) {
      log('warn', `Agent has empty or short name "${agent.agentname}", skipping. Run scripts/fix-agents.ts first.`);
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
      log('warn', `Agent file ${agentJsonPath} has empty/short name, skipping. Run scripts/fix-agents.ts first.`);
      continue;
    }

    if (!agentData.apiKey) {
      log('info', `Registering ${agent.agentname}...`);
      try {
        const client = new InstaMoltClient();

        // Use bio as description, but substitute if too short for InstaMolt's 3-word minimum
        let description = agentData.bio;
        if (description.trim().split(/\s+/).filter(Boolean).length < 3) {
          const firstSentence = persona.personality.match(/^[^.!?]+[.!?]/);
          description = (firstSentence ? firstSentence[0] : persona.personality).trim().slice(0, 150);
          log('warn', `  Bio too short, using persona description: "${description}"`);
        }

        // Start challenge
        const challenge = await client.startChallenge(agent.agentname, description);

        // Answer challenge via LLM
        const answer = await answerChallenge(persona, challenge.challenge);

        // Complete registration
        const reg = await client.completeChallenge(challenge.request_id, answer);

        if (!reg.api_key) {
          log('error', `  Registration response missing api_key: ${JSON.stringify(reg)}`);
          throw new Error('Registration returned no API key');
        }

        // Save API key back to agent.json
        agentData.apiKey = reg.api_key;
        agentData.registeredAt = new Date().toISOString();
        await writeFile(agentJsonPath, JSON.stringify(agentData, null, 2));

        // Update bio
        const authedClient = new InstaMoltClient(reg.api_key);
        await authedClient.updateProfile(agentData.bio);

        registeredCount++;
        log('info', `  \u2705 Registered ${agent.agentname}`);
        await sleep(config.registrationDelay);

      } catch (err) {
        log('error', `  \u274C Registration failed for ${agent.agentname}: ${err}`);
        errorCount++;
        continue;
      }
    }

    // --- Phase B: Publish posts ---

    const files = await readdir(agentDir);
    const postFiles = files
      .filter(f => f.startsWith('post-') && f.endsWith('.json'))
      .sort();

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
          log('info', `  \u{1F4F8} ${agent.agentname}: ${postFile} published`);
        } else {
          log('error', `  \u274C ${agent.agentname}: ${postFile} failed -- ${result.error}`);
          errorCount++;
        }

        await sleep(config.postDelay);

      } catch (err) {
        log('error', `  \u274C ${agent.agentname}: ${postFile} error -- ${err}`);
        errorCount++;
      }
    }

    log('info', `  ${agent.agentname}: ${postsPublished} posts published this run`);
    await sleep(config.agentDelay);
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

  log('info', `\n\u{1F389} Publish complete: ${registeredCount} registered, ${postedCount} posted, ${errorCount} errors`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
