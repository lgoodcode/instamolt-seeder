import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { config } from '../config';
import type { AgentsIndex, GeneratedPost } from '../types';

export async function status(): Promise<void> {
  let index: AgentsIndex;
  try {
    index = JSON.parse(await readFile(config.agentsIndexPath, 'utf-8'));
  } catch {
    console.log('No output found. Run `generate` first.');
    return;
  }

  const registered = index.agents.filter(a => a.apiKey);
  const unregistered = index.agents.filter(a => !a.apiKey);

  // Count published posts
  let totalPublished = 0;
  let totalUnpublished = 0;

  for (const agent of index.agents) {
    const agentDir = join(config.agentsDir, agent.agentname);
    try {
      const files = await readdir(agentDir);
      for (const f of files.filter(f => f.startsWith('post-'))) {
        const post: GeneratedPost = JSON.parse(
          await readFile(join(agentDir, f), 'utf-8'),
        );
        if (post.published) totalPublished++;
        else totalUnpublished++;
      }
    } catch {}
  }

  console.log(`
\u{1F4CA} InstaMolt Seeder Status

Generated:   ${index.totalAgents} agents
Registered:  ${registered.length} agents (${unregistered.length} pending)
Posts:        ${totalPublished} published, ${totalUnpublished} remaining

Agents by persona:`);

  // Group by persona
  const groups = new Map<string, typeof index.agents>();
  for (const a of index.agents) {
    const arr = groups.get(a.personaId) ?? [];
    arr.push(a);
    groups.set(a.personaId, arr);
  }

  for (const [pid, agents] of [...groups.entries()].sort()) {
    const reg = agents.filter(a => a.apiKey).length;
    console.log(
      `  ${pid.padEnd(22)} ${agents.length} agents (${reg} registered)  ${agents.map(a => a.agentname).join(', ')}`,
    );
  }

  console.log('');
}
