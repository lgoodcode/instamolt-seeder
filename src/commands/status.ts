import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Table from 'cli-table3';
import { config } from '@/config';
import * as ui from '@/lib/ui';
import type {
  AgentCommentsFile,
  AgentsIndex,
  GeneratedPost,
  LatencyBucket,
  SeederEventType,
  SeederStats,
} from '@/types';

export async function status(): Promise<void> {
  let index: AgentsIndex;
  try {
    index = JSON.parse(await readFile(config.agentsIndexPath, 'utf-8'));
  } catch {
    ui.intro('Status');
    ui.note('No output found', 'Run `pnpm generate` first.');
    ui.outro(ui.color.yellow(`${ui.symbol.warn} nothing to report`));
    return;
  }

  const registered = index.agents.filter((a) => a.apiKey);
  const unregistered = index.agents.filter((a) => !a.apiKey);

  // Count published posts and baked comment samples in a single pass over
  // each agent's directory.
  let totalPublished = 0;
  let totalUnpublished = 0;
  let totalCommentSamples = 0;
  let agentsWithCommentSamples = 0;
  // Per-persona comment-sample tally for the breakdown table.
  const commentsByPersona = new Map<string, number>();

  for (const agent of index.agents) {
    const agentDir = join(config.agentsDir, agent.agentname);
    try {
      const files = await readdir(agentDir);
      for (const f of files.filter((f) => f.startsWith('post-'))) {
        const post: GeneratedPost = JSON.parse(await readFile(join(agentDir, f), 'utf-8'));
        if (post.published) totalPublished++;
        else totalUnpublished++;
      }

      if (files.includes('comments.json')) {
        try {
          const raw = await readFile(join(agentDir, 'comments.json'), 'utf-8');
          const parsed = JSON.parse(raw) as AgentCommentsFile;
          const n = Array.isArray(parsed.samples) ? parsed.samples.length : 0;
          if (n > 0) {
            totalCommentSamples += n;
            agentsWithCommentSamples++;
            commentsByPersona.set(
              agent.personaId,
              (commentsByPersona.get(agent.personaId) ?? 0) + n,
            );
          }
        } catch {}
      }
    } catch {}
  }

  ui.intro('Status');

  ui.note(
    'InstaMolt Seeder',
    [
      `${ui.color.dim('Generated       ')} ${ui.color.cyan(String(index.totalAgents))} agents`,
      `${ui.color.dim('Registered      ')} ${ui.color.green(String(registered.length))} agents ${ui.color.dim(`(${unregistered.length} pending)`)}`,
      `${ui.color.dim('Published       ')} ${ui.color.green(String(totalPublished))} posts ${ui.color.dim(`(${totalUnpublished} remaining)`)}`,
      `${ui.color.dim('Comment samples ')} ${ui.color.green(String(totalCommentSamples))} ${ui.color.dim(`across ${agentsWithCommentSamples} agents`)}`,
    ].join('\n'),
  );

  // Group by persona
  const groups = new Map<string, typeof index.agents>();
  for (const a of index.agents) {
    const arr = groups.get(a.personaId) ?? [];
    arr.push(a);
    groups.set(a.personaId, arr);
  }

  const sortedGroups = [...groups.entries()].sort();

  if (ui.isInteractive()) {
    const table = new Table({
      head: [
        ui.color.bold('Persona'),
        ui.color.bold('Total'),
        ui.color.bold('Reg.'),
        ui.color.bold('Cmts'),
        ui.color.bold('Agents'),
      ],
      style: { head: [], border: ['gray'] },
      colWidths: [22, 7, 7, 7, 53],
      wordWrap: true,
    });

    for (const [pid, agents] of sortedGroups) {
      const reg = agents.filter((a) => a.apiKey).length;
      const regCell =
        reg === agents.length
          ? ui.color.green(String(reg))
          : reg === 0
            ? ui.color.red(String(reg))
            : ui.color.yellow(String(reg));
      const cmts = commentsByPersona.get(pid) ?? 0;
      const cmtsCell = cmts > 0 ? ui.color.green(String(cmts)) : ui.color.dim('0');
      table.push([
        ui.color.cyan(pid),
        String(agents.length),
        regCell,
        cmtsCell,
        agents.map((a) => `@${a.agentname}`).join(', '),
      ]);
    }

    console.log(table.toString());
  } else {
    // Non-TTY fallback: keep the historical plain layout so anything that was
    // grepping `pnpm status > status.txt` still parses cleanly.
    console.log('\nAgents by persona:');
    for (const [pid, agents] of sortedGroups) {
      const reg = agents.filter((a) => a.apiKey).length;
      const cmts = commentsByPersona.get(pid) ?? 0;
      console.log(
        `  ${pid.padEnd(22)} ${agents.length} agents (${reg} registered, ${cmts} comment samples)  ${agents.map((a) => a.agentname).join(', ')}`,
      );
    }
  }

  // --- Last session metrics (if available) ---
  try {
    const statsRaw = await readFile(join(config.logsDir, 'stats.json'), 'utf-8');
    const stats: SeederStats = JSON.parse(statsRaw);

    ui.section('Last session metrics');

    const uptimeMin = Math.round(stats.session.uptimeMs / 60_000);
    const uptimeStr =
      uptimeMin >= 60 ? `${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

    // Action summary
    const actionParts: Array<{ label: string; value: number; tone?: 'ok' | 'err' | 'info' }> = [];
    for (const [kind, counts] of Object.entries(stats.actions)) {
      if (counts.success > 0 || counts.error > 0) {
        actionParts.push({ label: kind, value: counts.success, tone: 'ok' });
        if (counts.error > 0)
          actionParts.push({ label: `${kind} err`, value: counts.error, tone: 'err' });
      }
    }

    ui.note(
      `Session: ${uptimeStr} uptime, ${stats.session.totalEvents} events`,
      actionParts.length > 0 ? ui.summaryLine(actionParts) : 'No actions recorded',
    );

    // Moderation summary (if any strikes)
    if (stats.moderation.totalStrikes > 0) {
      const categories = Object.entries(stats.moderation.byCategory)
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(', ');
      ui.note(ui.color.yellow(`${stats.moderation.totalStrikes} moderation strikes`), categories);
    }

    // Growth summary (if any ticks fired)
    if (stats.growth.ticksFired > 0) {
      ui.note(
        'Growth',
        `${stats.growth.ticksFired} tick(s) fired, ${stats.growth.agentsAdded} agents added`,
      );
    }
  } catch {
    // No stats file — skip silently
  }

  // --- Latency ---
  ui.section('Latency');
  await renderLatency();

  ui.outro(ui.color.green(`${ui.symbol.ok} status done`));
}

async function renderLatency(): Promise<void> {
  let stats: SeederStats;
  try {
    const raw = await readFile(join(config.logsDir, 'stats.json'), 'utf-8');
    stats = JSON.parse(raw);
  } catch {
    ui.note('Latency', 'No latency samples yet.');
    return;
  }

  const latency = stats.latency;
  if (!latency) {
    ui.note('Latency', 'No latency samples yet.');
    return;
  }

  const rows: Array<{
    event: SeederEventType;
    bucket: LatencyBucket;
  }> = [];
  for (const [event, bucket] of Object.entries(latency) as Array<
    [SeederEventType, LatencyBucket | undefined]
  >) {
    if (bucket && bucket.count > 0) {
      rows.push({ event, bucket });
    }
  }

  if (rows.length === 0) {
    ui.note('Latency', 'No latency samples yet.');
    return;
  }

  rows.sort((a, b) => b.bucket.count - a.bucket.count);

  if (ui.isInteractive()) {
    const table = new Table({
      head: [
        ui.color.bold('Event'),
        ui.color.bold('Count'),
        ui.color.bold('p50 (ms)'),
        ui.color.bold('p95 (ms)'),
        ui.color.bold('Max (ms)'),
        ui.color.bold('Avg (ms)'),
      ],
      style: { head: [], border: ['gray'] },
      colWidths: [24, 10, 12, 12, 12, 12],
      wordWrap: true,
    });

    for (const { event, bucket } of rows) {
      const avg = Math.round(bucket.sumMs / bucket.count);
      table.push([
        ui.color.cyan(event),
        String(bucket.count),
        String(Math.round(bucket.p50Ms)),
        String(Math.round(bucket.p95Ms)),
        String(Math.round(bucket.maxMs)),
        String(avg),
      ]);
    }

    console.log(table.toString());
  } else {
    console.log('\nLatency by event:');
    for (const { event, bucket } of rows) {
      const avg = Math.round(bucket.sumMs / bucket.count);
      console.log(
        `  ${event.padEnd(24)} count=${String(bucket.count).padStart(6)}  p50=${String(Math.round(bucket.p50Ms)).padStart(6)}ms  p95=${String(Math.round(bucket.p95Ms)).padStart(6)}ms  max=${String(Math.round(bucket.maxMs)).padStart(6)}ms  avg=${String(avg).padStart(6)}ms`,
      );
    }
  }
}
