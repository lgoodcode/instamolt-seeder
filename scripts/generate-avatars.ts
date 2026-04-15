/**
 * Backfill avatars for drafted / registered agents.
 *
 * Two passes, both idempotent:
 *   Pass 1 — ensure every agent.json has an `avatarPrompt` (baked via Gemini).
 *   Pass 2 — for every agent with an `apiKey` and no `avatarUrl`, call
 *            `POST /agents/me/avatar/generate` and persist the returned
 *            `avatar_url` / `generation_seed` / `avatarGeneratedAt`.
 *
 * Re-running is a no-op once every agent has both. Respects the platform's
 * 5-lifetime cap per agent — a 403 AVATAR_GENERATION_LIMIT_REACHED is logged
 * and the agent is skipped.
 *
 * Flags:
 *   --agent <name>    Scope to a single agent by agentname.
 *   --limit <N>       Cap each pass to the first N agents (sorted by name).
 *   --regenerate      Force a fresh platform call even when `avatarUrl` is
 *                     already set — burns another lifetime slot.
 *
 * Example:
 *   pnpm avatars                                      # backfill everything
 *   pnpm avatars --agent pixel_dreamer                # one agent
 *   pnpm avatars --regenerate --agent pixel_dreamer   # redo one agent
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@/config';
import { mapWithConcurrency } from '@/lib/concurrency';
import { drainWrites, flushStats, initEventLogger, logEvent } from '@/lib/event-logger';
import { log } from '@/lib/logger';
import { loadPersonas } from '@/personas';
import { InstaMoltApiError, InstaMoltClient, parseErrorCode } from '@/services/instamolt-api';
import { generateAvatarPrompt } from '@/services/llm';
import type { GeneratedAgent, Persona } from '@/types';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_DIR = join(REPO_ROOT, 'output', 'agents');

interface CliFlags {
  agent?: string;
  limit?: number;
  regenerate: boolean;
}

const USAGE = 'Usage: pnpm avatars [--agent <name>] [--limit <positive-integer>] [--regenerate]';

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}. ${USAGE}`);
  }
  return value;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { regenerate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agent') {
      out.agent = readFlagValue(argv, i, '--agent');
      i++;
    } else if (arg === '--limit') {
      const raw = readFlagValue(argv, i, '--limit');
      const n = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== raw) {
        throw new Error(`Invalid value for --limit: ${raw}. Expected a positive integer. ${USAGE}`);
      }
      out.limit = n;
      i++;
    } else if (arg === '--regenerate') {
      out.regenerate = true;
    } else {
      throw new Error(`Unknown flag: ${arg}. ${USAGE}`);
    }
  }
  return out;
}

interface LoadedAgent {
  data: GeneratedAgent;
  path: string;
  persona: Persona;
}

async function loadAgents(flags: CliFlags, personas: Map<string, Persona>): Promise<LoadedAgent[]> {
  let dirs: string[];
  try {
    dirs = await readdir(AGENTS_DIR);
  } catch {
    return [];
  }
  const sorted = dirs.sort();
  const loaded: LoadedAgent[] = [];
  for (const dir of sorted) {
    if (flags.agent && dir !== flags.agent) continue;
    const path = join(AGENTS_DIR, dir, 'agent.json');
    try {
      const data = JSON.parse(await readFile(path, 'utf-8')) as GeneratedAgent;
      const persona = personas.get(data.personaId);
      if (!persona) {
        log('warn', `@${data.agentname}: persona ${data.personaId} not found, skipping`);
        continue;
      }
      loaded.push({ data, path, persona });
    } catch {
      // Unreadable — skip silently; the operator has a real way to spot
      // corrupted agent.json files via `pnpm status`.
    }
  }
  if (flags.limit !== undefined) return loaded.slice(0, flags.limit);
  return loaded;
}

async function pass1_draftPrompts(agents: LoadedAgent[]): Promise<number> {
  const needsPrompt = agents.filter((a) => !a.data.avatarPrompt);
  if (needsPrompt.length === 0) return 0;
  log('info', `Pass 1: drafting ${needsPrompt.length} avatar prompts...`);
  let drafted = 0;
  await mapWithConcurrency(
    needsPrompt,
    config.avatarConcurrency,
    async ({ data, path, persona }) => {
      const startedAt = Date.now();
      try {
        const prompt = await generateAvatarPrompt(persona, data);
        data.avatarPrompt = prompt;
        await writeFile(path, JSON.stringify(data, null, 2));
        drafted++;
        logEvent({
          eventType: 'avatar_prompt_drafted',
          agentname: data.agentname,
          persona: data.personaId,
          success: true,
          durationMs: Date.now() - startedAt,
          details: { promptLength: prompt.length, source: 'backfill-script' },
        });
        log('success', `  @${data.agentname} — prompt ready (${prompt.length} chars)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', `  @${data.agentname} — prompt draft failed: ${msg}`);
        logEvent({
          eventType: 'avatar_prompt_drafted',
          agentname: data.agentname,
          persona: data.personaId,
          success: false,
          durationMs: Date.now() - startedAt,
          error: msg,
        });
      }
    },
  );
  return drafted;
}

async function pass2_generateAvatars(agents: LoadedAgent[], regenerate: boolean): Promise<number> {
  const needsAvatar = agents.filter(
    (a) => a.data.apiKey && a.data.avatarPrompt && (regenerate || !a.data.avatarUrl),
  );
  if (needsAvatar.length === 0) return 0;
  log('info', `Pass 2: generating ${needsAvatar.length} avatars...`);
  let generated = 0;
  await mapWithConcurrency(needsAvatar, config.avatarConcurrency, async ({ data, path }) => {
    const startedAt = Date.now();
    const logSkipped = (reason: string, details: Record<string, unknown> = {}): void => {
      logEvent({
        eventType: 'avatar_skipped',
        agentname: data.agentname,
        persona: data.personaId,
        success: false,
        durationMs: Date.now() - startedAt,
        details:
          reason === 'error' ? { reason, ...details } : { skipped: true, reason, ...details },
      });
    };
    try {
      const client = new InstaMoltClient(data.apiKey);
      const res = await client.generateAvatar(data.avatarPrompt as string);
      data.avatarUrl = res.avatar_url;
      data.avatarGenerationSeed = res.generation_seed ?? undefined;
      data.avatarGeneratedAt = new Date().toISOString();
      await writeFile(path, JSON.stringify(data, null, 2));
      generated++;
      logEvent({
        eventType: 'avatar_generated',
        agentname: data.agentname,
        persona: data.personaId,
        success: true,
        durationMs: Date.now() - startedAt,
        details: {
          generationsUsed: res.generations_used,
          generationsRemaining: res.generations_remaining,
          generationSeed: res.generation_seed ?? null,
          source: 'backfill-script',
        },
      });
      log(
        'success',
        `  @${data.agentname} — avatar set (${res.generations_remaining}/5 remaining)`,
      );
    } catch (err) {
      if (err instanceof InstaMoltApiError && err.status === 403) {
        const code = parseErrorCode(err.body) ?? 'forbidden';
        if (code === 'AVATAR_GENERATION_LIMIT_REACHED') {
          log('warn', `  @${data.agentname} — cap reached (5/5), skipping`);
          logSkipped('cap_reached', { errorCode: code });
          return;
        }
        if (code === 'CONTENT_BLOCKED') {
          log('warn', `  @${data.agentname} — prompt blocked by moderation, skipping`);
          logSkipped('prompt_blocked', { errorCode: code });
          return;
        }
        log('warn', `  @${data.agentname} — 403 ${code}, skipping`);
        logSkipped('forbidden', { errorCode: code });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `  @${data.agentname} — avatar generation failed: ${msg}`);
      logSkipped('error', { error: msg });
    }
  });
  return generated;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  initEventLogger();
  // Avatar backfill should not silently bootstrap a fresh persona set if
  // output/personas/ is missing — that would spend Gemini budget for an
  // operation the operator didn't ask for. Fail fast instead.
  const personas = await loadPersonas({ autoSeed: false });
  const agents = await loadAgents(flags, personas);

  if (agents.length === 0) {
    log('info', flags.agent ? `No agent "${flags.agent}" found.` : 'No agents on disk.');
    return;
  }
  log('info', `Scanning ${agents.length} agents${flags.regenerate ? ' (--regenerate)' : ''}...`);

  const drafted = await pass1_draftPrompts(agents);

  // Reload after pass 1 so pass 2 sees the freshly-drafted prompts.
  const reloaded = await loadAgents(flags, personas);
  const generated = await pass2_generateAvatars(reloaded, flags.regenerate);

  log(
    'info',
    `Done. ${drafted} prompt${drafted === 1 ? '' : 's'} drafted, ${generated} avatar${generated === 1 ? '' : 's'} generated.`,
  );

  await drainWrites();
  flushStats();
}

main().catch((err) => {
  log('error', `Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
