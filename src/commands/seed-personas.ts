import { rm } from 'node:fs/promises';
import { config } from '@/config';
import { log } from '@/lib/logger';
import * as ui from '@/lib/ui';
import { _resetPersonaCache, seedPersonas } from '@/personas/index';

export interface SeedPersonasOptions {
  /** Total number of personas to seed. Default 30. */
  count?: number;
  /** Wipe existing output/personas/ before generating. Default false. */
  force?: boolean;
}

/**
 * Generate fresh personas via Gemini and write them to `output/personas/`.
 *
 * Idempotent by default: skips persona ids already on disk and only fills
 * in the gap up to `count`. Pass `--force` to wipe and regenerate.
 */
export async function seedPersonasCommand(options: SeedPersonasOptions = {}): Promise<void> {
  const count = options.count ?? 30;
  const force = options.force ?? false;

  ui.intro('Seed personas');

  if (force) {
    log('warn', `--force: wiping ${config.personasDir} before regenerating`);
    await rm(config.personasDir, { recursive: true, force: true });
    _resetPersonaCache();
  }

  const sp = ui.spinner();
  sp.start(`Seeding ${count} personas into ${config.personasDir}`);
  let created: Awaited<ReturnType<typeof seedPersonas>> = [];
  try {
    created = await seedPersonas(count);
    sp.stop(`Seeded ${created.length} personas`);
  } catch (err) {
    sp.stop(`seed-personas failed: ${err}`, 1);
    throw err;
  }

  ui.note(
    'seed-personas complete',
    ui.summaryLine([
      { label: 'new personas', value: created.length, tone: 'ok' },
      { label: 'requested', value: count, tone: 'info' },
    ]),
  );
  ui.outro(ui.color.green(`${ui.symbol.ok} seed-personas done`));
}
