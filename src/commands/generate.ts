import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';
import { loadPersonas } from '../personas/index';
import { getDistribution } from '../personas/registry';
import {
  generateAgentName, generateBio, generateAvatarPrompt, generatePostContent,
} from '../llm';
import { log } from '../logger';
import type { GeneratedAgent, GeneratedPost, AgentsIndex } from '../types';

/**
 * Generate N agents with M posts each.
 * Writes everything to output/ as JSON files.
 */
export async function generate(agentCount: number, postsPerAgent: number): Promise<void> {
  const personas = await loadPersonas();
  const distribution = getDistribution(agentCount, personas);

  log('info', `Generating ${agentCount} agents with ${postsPerAgent} posts each`);
  log('info', `Total posts: ${agentCount * postsPerAgent}`);

  // Load existing agents if any (for idempotency)
  const existing = await loadExistingAgents();
  const existingNames = existing.map(a => a.agentname);
  const allAgents: GeneratedAgent[] = [...existing];

  let created = 0;

  for (const { persona, count } of distribution) {
    const existingForPersona = existing.filter(a => a.personaId === persona.id).length;
    const toCreate = count - existingForPersona;

    if (toCreate <= 0) {
      log('info', `${persona.id}: already have ${existingForPersona}/${count}, skipping`);
      continue;
    }

    log('info', `${persona.id}: creating ${toCreate} agents`);

    for (let i = 0; i < toCreate; i++) {
      try {
        // Generate agent identity
        const agentname = await generateAgentName(persona, existingNames);
        const bio = await generateBio(persona);
        const avatarPrompt = await generateAvatarPrompt(persona);

        const agent: GeneratedAgent = {
          agentname,
          personaId: persona.id,
          bio,
          avatarPrompt,
        };

        // Create agent directory
        const agentDir = join(config.agentsDir, agentname);
        await mkdir(agentDir, { recursive: true });

        // Write agent.json
        await writeFile(
          join(agentDir, 'agent.json'),
          JSON.stringify(agent, null, 2),
        );

        // Generate posts
        log('info', `  ${agentname}: generating ${postsPerAgent} posts...`);
        for (let p = 1; p <= postsPerAgent; p++) {
          const content = await generatePostContent(persona, p, postsPerAgent);

          const post: GeneratedPost = {
            id: `post-${String(p).padStart(3, '0')}`,
            imagePrompt: content.imagePrompt,
            caption: content.caption,
            aspectRatio: content.aspectRatio,
          };

          await writeFile(
            join(agentDir, `${post.id}.json`),
            JSON.stringify(post, null, 2),
          );

          // Small delay to avoid Gemini rate limits
          await sleep(500);
        }

        allAgents.push(agent);
        existingNames.push(agentname);
        created++;
        log('info', `  \u2705 ${agentname} -- ${bio.slice(0, 60)}...`);

      } catch (err) {
        log('error', `  Failed to create agent: ${err}`);
      }
    }
  }

  // Write master index
  const index: AgentsIndex = {
    generatedAt: new Date().toISOString(),
    totalAgents: allAgents.length,
    totalPosts: allAgents.length * postsPerAgent,
    agents: allAgents,
  };

  await mkdir(config.outputDir, { recursive: true });
  await writeFile(config.agentsIndexPath, JSON.stringify(index, null, 2));

  log('info', `\n\u{1F389} Generation complete: ${created} new agents, ${allAgents.length} total`);
  log('info', `Output: ${config.outputDir}/`);
  log('info', `Review the files, then run: publish`);
}

// --- Helpers ---

async function loadExistingAgents(): Promise<GeneratedAgent[]> {
  try {
    const raw = await readFile(config.agentsIndexPath, 'utf-8');
    const index = JSON.parse(raw) as AgentsIndex;
    return index.agents;
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
