import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';
import { loadPersonas } from '../personas/index';
import { InstaMoltClient } from '../instamolt-api';
import { generatePost } from '../instamolt-mcp';
import { generateComment, generatePostContent } from '../llm';
import { log } from '../logger';
import type { GeneratedAgent, Post } from '../types';

interface EngageOptions {
  agents?: number;
  limit?: number;
}

export async function engage(options: EngageOptions = {}): Promise<void> {
  const maxAgents = options.agents ?? 10;
  const actionsLimit = options.limit ?? 5;
  const personas = await loadPersonas();

  // Load all registered agents
  const allAgents = await loadRegisteredAgents();
  if (allAgents.length === 0) {
    log('error', 'No registered agents found. Run `generate` then `publish` first.');
    return;
  }

  // Pick a random subset
  const shuffled = allAgents.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(maxAgents, shuffled.length));

  log('info', `Engage cycle: ${selected.length} agents, up to ${actionsLimit} actions each`);

  for (let i = 0; i < selected.length; i++) {
    const agent = selected[i];
    const persona = personas.get(agent.personaId);
    if (!persona) {
      log('warn', `Persona ${agent.personaId} not found, skipping ${agent.agentname}`);
      continue;
    }

    log('info', `\n--- @${agent.agentname} (${persona.id}) ---`);

    const client = new InstaMoltClient(agent.apiKey);
    let actionsUsed = 0;

    try {
      // 1. Browse explore feed
      const feed = await client.getExplore(30);
      const posts = feed.posts ?? [];
      if (posts.length === 0) {
        log('warn', `  No posts in explore feed, skipping`);
        continue;
      }
      log('info', `  Browsed explore: ${posts.length} posts`);

      // Shuffle posts so each agent sees a different order
      const shuffledPosts = posts.sort(() => Math.random() - 0.5);

      // Filter out agent's own posts
      const otherPosts = shuffledPosts.filter(p => p.agentname !== agent.agentname);

      // 2. Like posts
      const likesTarget = randomInt(2, 4);
      let liked = 0;
      for (const post of otherPosts) {
        if (liked >= likesTarget || actionsUsed >= actionsLimit) break;
        if (Math.random() > persona.likeProbability) continue;

        try {
          await client.likePost(post.id);
          liked++;
          actionsUsed++;
          log('info', `  Liked @${post.agentname}'s post ${post.id}`);
          await sleep(randomInt(3000, 10000));
        } catch (err) {
          log('warn', `  Like failed: ${err}`);
        }
      }

      // 3. Comment on posts
      const commentsTarget = randomInt(1, 2);
      let commented = 0;
      for (const post of otherPosts) {
        if (commented >= commentsTarget || actionsUsed >= actionsLimit) break;
        if (!post.caption) continue;

        try {
          const comment = await generateComment(persona, post.caption, post.agentname);
          await client.commentOnPost(post.id, comment);
          commented++;
          actionsUsed++;
          log('info', `  Commented on @${post.agentname}'s post: "${comment.slice(0, 60)}..."`);
          await sleep(randomInt(10000, 30000));
        } catch (err) {
          log('warn', `  Comment failed: ${err}`);
        }
      }

      // 4. Follow agents
      const followsTarget = randomInt(1, 2);
      let followed = 0;
      const seenAgents = new Set<string>();
      for (const post of otherPosts) {
        if (followed >= followsTarget || actionsUsed >= actionsLimit) break;
        if (seenAgents.has(post.agentname)) continue;
        seenAgents.add(post.agentname);

        if (Math.random() > persona.followProbability) continue;

        try {
          await client.followAgent(post.agentname);
          followed++;
          actionsUsed++;
          log('info', `  Followed @${post.agentname}`);
          await sleep(randomInt(5000, 15000));
        } catch (err) {
          log('warn', `  Follow failed: ${err}`);
        }
      }

      // 5. Optionally create a new post
      if (actionsUsed < actionsLimit) {
        // Roll against postsPerDay frequency: higher frequency = higher chance
        const [minPosts, maxPosts] = persona.postsPerDay;
        const avgPostsPerDay = (minPosts + maxPosts) / 2;
        // Assume ~24 cycles per day, so chance per cycle = avgPostsPerDay / 24
        const postChance = avgPostsPerDay / 24;

        if (Math.random() < postChance) {
          try {
            log('info', `  Generating a fresh post...`);
            const content = await generatePostContent(persona, 1, 1);
            const result = await generatePost(agent.apiKey!, {
              prompt: content.imagePrompt,
              caption: content.caption,
              aspect_ratio: content.aspectRatio,
            });

            if (result.success) {
              actionsUsed++;
              log('info', `  Posted! ${result.postId ?? '(id unknown)'}`);
            } else {
              log('warn', `  Post failed: ${result.error}`);
            }
          } catch (err) {
            log('warn', `  Post creation failed: ${err}`);
          }
        }
      }

      log('info', `  Done: ${actionsUsed} actions (${liked} likes, ${commented} comments, ${followed} follows)`);

    } catch (err) {
      log('error', `  Agent cycle failed: ${err}`);
    }

    // Stagger between agents: 30-60 seconds
    if (i < selected.length - 1) {
      const gap = randomInt(30000, 60000);
      log('info', `  Waiting ${(gap / 1000).toFixed(0)}s before next agent...`);
      await sleep(gap);
    }
  }

  log('info', `\nEngage cycle complete.`);
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

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
