import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import * as ui from '@/lib/ui';
import type { SeederEvent } from '@/types';

export async function graphStats(): Promise<void> {
  ui.intro('Follow Graph Stats');

  const eventsPath = join(config.logsDir, 'events.jsonl');
  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf-8');
  } catch {
    ui.note(
      'No events log found',
      'Run `publish` or `engage-continuous` first to generate events.',
    );
    ui.outro(ui.color.yellow(`${ui.symbol.warn} no data`));
    return;
  }

  // Parse follow events from JSONL
  const following = new Map<string, Set<string>>(); // follower -> set of followed
  const followers = new Map<string, Set<string>>(); // followed -> set of followers
  const tierCounts = { 1: 0, 2: 0, 3: 0, unknown: 0 };
  let totalEdges = 0;
  const agentnames = new Set<string>();

  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as SeederEvent;
      if (event.eventType === 'follow' && event.success && event.agentname) {
        const target = (event.details?.target as string) ?? '';
        if (!target) continue;

        agentnames.add(event.agentname);
        agentnames.add(target);

        if (!following.has(event.agentname)) following.set(event.agentname, new Set());
        if (!followers.has(target)) followers.set(target, new Set());
        following.get(event.agentname)!.add(target);
        followers.get(target)!.add(event.agentname);
        totalEdges++;

        const tier = (event.details?.tier as number) ?? 0;
        if (tier === 1 || tier === 2 || tier === 3) tierCounts[tier]++;
        else tierCounts.unknown++;
      }
    } catch {
      // skip malformed lines
    }
  }

  if (totalEdges === 0) {
    ui.note(
      'No follow events found',
      'Follow events are logged during `publish` Phase C and `engage-continuous`.',
    );
    ui.outro(ui.color.yellow(`${ui.symbol.warn} no follow data`));
    return;
  }

  const totalAgents = agentnames.size;
  const avgFollowing = totalAgents > 0 ? Math.round((totalEdges / totalAgents) * 10) / 10 : 0;

  // Reciprocity: mutual follows
  let mutualCount = 0;
  for (const [a, followSet] of following) {
    for (const b of followSet) {
      if (following.get(b)?.has(a)) mutualCount++;
    }
  }
  const reciprocityPct = totalEdges > 0 ? Math.round((mutualCount / totalEdges) * 1000) / 10 : 0;

  // Isolated agents (0 followers)
  const isolated = [...agentnames].filter((a) => !followers.has(a) || followers.get(a)!.size === 0);

  // Most followed
  const byFollowers = [...followers.entries()]
    .map(([name, set]) => ({ name, count: set.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Output
  ui.section('Overview');
  ui.note(
    'Follow Graph',
    ui.summaryLine([
      { label: 'agents', value: totalAgents, tone: 'info' },
      { label: 'edges', value: totalEdges, tone: 'ok' },
      { label: 'avg following', value: avgFollowing, tone: 'info' },
      { label: 'reciprocity %', value: reciprocityPct, tone: 'info' },
    ]),
  );

  ui.section('Tier Breakdown');
  const tierTotal = tierCounts[1] + tierCounts[2] + tierCounts[3] + tierCounts.unknown;
  const pct = (n: number): string => (tierTotal > 0 ? ((n / tierTotal) * 100).toFixed(0) : '0');
  ui.note(
    'Follow Sources',
    [
      `Tier 1 (relationship): ${tierCounts[1]} (${pct(tierCounts[1])}%)`,
      `Tier 2 (affinity):     ${tierCounts[2]} (${pct(tierCounts[2])}%)`,
      `Tier 3 (discovery):    ${tierCounts[3]} (${pct(tierCounts[3])}%)`,
      tierCounts.unknown > 0 ? `Unknown:               ${tierCounts.unknown}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (byFollowers.length > 0) {
    ui.section('Most Followed');
    ui.note(
      'Top 10',
      byFollowers.map((e, i) => `  ${i + 1}. @${e.name} — ${e.count} followers`).join('\n'),
    );
  }

  if (isolated.length > 0) {
    ui.section('Isolated Agents');
    ui.note(
      `${isolated.length} agents with 0 followers`,
      isolated
        .slice(0, 20)
        .map((a) => `  @${a}`)
        .join('\n') + (isolated.length > 20 ? `\n  ... and ${isolated.length - 20} more` : ''),
    );
  }

  ui.outro(ui.color.green(`${ui.symbol.ok} graph-stats done`));
}
