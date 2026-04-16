import { generate } from '@/commands/generate';
import { publish } from '@/commands/publish';
import { drainWrites, flushStats, initEventLogger, logEvent } from '@/lib/event-logger';
import * as ui from '@/lib/ui';

export interface GrowthTickOptions {
  /** Target total agent count after this tick. Passed through to `generate`. */
  target: number;
  /** Minimum posts per new agent (inclusive). */
  minPosts: number;
  /** Maximum posts per new agent (inclusive). */
  maxPosts: number;
  /**
   * When true (set by parent engage-continuous process via env), skip the
   * ui.intro/confirm prompts and run headlessly.
   */
  child?: boolean;
}

/**
 * One-shot growth tick: generates drafts for new agents up to `target`, then
 * publishes those drafts. Exits when done. Meant to run as a detached child
 * process spawned from `engage-continuous`, or standalone for manual growth.
 *
 * Exit codes (when invoked via the CLI entry):
 *   0 = success
 *   1 = fatal error (logged via event logger before exit)
 */
export async function growthTick(options: GrowthTickOptions): Promise<void> {
  // Init the same event logger as other commands so events land in the shared
  // events.jsonl. Running as a child process means we share output/ with the
  // parent but write our own events; readers see interleaved output.
  initEventLogger();

  if (!options.child) {
    ui.intro('Growth Tick');
  }

  const startedAt = Date.now();
  logEvent({
    eventType: 'session_start',
    success: true,
    details: {
      command: 'growth-tick',
      target: options.target,
      minPosts: options.minPosts,
      maxPosts: options.maxPosts,
      child: Boolean(options.child),
    },
  });

  try {
    await generate(options.target, options.minPosts, options.maxPosts);
    // Only bypass the resolved-target confirmation when running as the
    // detached child process spawned by engage-continuous (no TTY, upstream
    // already confirmed). Manual `pnpm growth-tick` runs keep the prompt as
    // a last prod-safety check before publishing live posts.
    await publish({
      limit: options.maxPosts * options.target,
      yes: Boolean(options.child),
    });
    logEvent({
      eventType: 'session_end',
      success: true,
      durationMs: Date.now() - startedAt,
      details: { command: 'growth-tick', target: options.target },
    });
  } catch (err) {
    logEvent({
      eventType: 'session_end',
      success: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      details: { command: 'growth-tick', target: options.target },
    });
    await drainWrites();
    flushStats();
    if (!options.child) {
      ui.outro(ui.color.red(`${ui.symbol.err} growth-tick failed`));
    }
    throw err;
  }

  await drainWrites();
  flushStats();
  if (!options.child) {
    ui.outro(ui.color.green(`${ui.symbol.ok} growth-tick complete`));
  }
}
