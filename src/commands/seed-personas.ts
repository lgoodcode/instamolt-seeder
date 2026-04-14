import { rm } from 'node:fs/promises';
import { config } from '@/config';
import { drainWrites, flushStats, initEventLogger, logEvent } from '@/lib/event-logger';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { _resetPersonaCache, PERSONA_CATALOG, type SeedMode, seedPersonas } from '@/personas/index';

export interface SeedPersonasOptions {
  /** Total number of personas to seed. Default 30. */
  count?: number;
  /** Wipe existing output/personas/ before generating. Default false. */
  force?: boolean;
  /**
   * Seed mode:
   *   - `'gemini'` (default) — pure Gemini invention.
   *   - `'catalog'` — copy the hand-authored 36-persona catalog. Deterministic.
   *   - `'hybrid'` — install the catalog first, then top up via Gemini.
   */
  mode?: SeedMode;
}

/**
 * Seed personas into `output/personas/`. Defaults to pure Gemini invention
 * for backward compatibility with the original CLI; pass `mode: 'catalog'`
 * for a deterministic install of the canonical 36-persona reference set,
 * or `mode: 'hybrid'` to install the catalog and then top up via Gemini.
 *
 * Idempotent by default: skips persona ids already on disk. Pass `--force`
 * to wipe and regenerate.
 */
export async function seedPersonasCommand(options: SeedPersonasOptions = {}): Promise<void> {
  const mode = options.mode ?? 'gemini';
  // In catalog mode, the count is implicitly the catalog size — ignore
  // whatever the user passed since the catalog is fixed.
  const count = mode === 'catalog' ? PERSONA_CATALOG.length : (options.count ?? 30);
  const force = options.force ?? false;

  ui.intro(`Seed personas — ${mode} mode`);

  initEventLogger();
  logEvent({
    eventType: 'session_start',
    success: true,
    details: { command: 'seed-personas', mode, count, force },
  });

  if (force) {
    log('warn', `--force: wiping ${config.personasDir} before regenerating`);
    await rm(config.personasDir, { recursive: true, force: true });
    _resetPersonaCache();
  }

  const sp = ui.spinner();
  const target =
    mode === 'catalog'
      ? `the canonical ${PERSONA_CATALOG.length}-persona catalog`
      : mode === 'hybrid'
        ? `${PERSONA_CATALOG.length} catalog + Gemini top-up to ${count}`
        : `${count} personas via Gemini`;
  sp.start(`Seeding ${target} into ${config.personasDir}`);
  let created: Awaited<ReturnType<typeof seedPersonas>> = [];
  try {
    created = await seedPersonas(count, mode);
    sp.stop(`Seeded ${created.length} personas`);
  } catch (err) {
    sp.stop(`seed-personas failed: ${err}`, 1);
    logEvent({
      eventType: 'session_end',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      details: { command: 'seed-personas', mode },
    });
    await drainWrites();
    flushStats();
    throw err;
  }

  for (const persona of created) {
    logEvent({
      eventType: 'persona_installed',
      persona: persona.id,
      success: true,
      details: { source: mode, tagline: persona.tagline },
    });
  }

  ui.note(
    `seed-personas complete (${mode} mode)`,
    ui.summaryLine([
      { label: 'new personas', value: created.length, tone: 'ok' },
      { label: 'requested', value: count, tone: 'info' },
    ]),
  );

  logEvent({
    eventType: 'session_end',
    success: true,
    details: { command: 'seed-personas', mode, installed: created.length },
  });
  await drainWrites();
  flushStats();

  ui.outro(ui.color.green(`${ui.symbol.ok} seed-personas done`));
}
