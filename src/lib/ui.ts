/**
 * Terminal UI facade.
 *
 * Single import surface for everything color/spinner/box-shaped. Wraps
 * @clack/prompts + picocolors so commands stay decoupled from the underlying
 * libraries — swap implementations here without touching the rest of src/.
 *
 * TTY-aware: every helper degrades gracefully when stdout isn't a terminal
 * (CI, piped output, `docker compose run -T`). Spinners turn into single
 * log lines, the progress bar prints periodic milestones instead of
 * redrawing in place.
 */

import * as clack from '@clack/prompts';
import pc from 'picocolors';

export const color = pc;

export const symbol = {
  ok: '\u2714',
  warn: '\u26A0',
  err: '\u2718',
  dot: '\u2022',
  arrow: '\u2192',
  bullet: '\u25CF',
} as const;

/** True iff stdout is an interactive terminal. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY);
}

/** Top-of-command banner. */
export function intro(title: string): void {
  clack.intro(pc.bgCyan(pc.black(` ${title} `)));
}

/** Bottom-of-command banner. */
export function outro(message: string): void {
  clack.outro(message);
}

/** Cyan section header — use for phases inside a command. */
export function section(title: string): void {
  // Blank line + bold cyan rule for visual separation. clack.log.step gives
  // us the ◇ glyph hooked into the running outline so it stays consistent
  // with intro/outro framing.
  clack.log.step(pc.bold(pc.cyan(title)));
}

/** Boxed multi-line note (used for end-of-command summaries). */
export function note(title: string, body: string): void {
  clack.note(body, title);
}

/** Spinner passthrough. clack handles TTY detection internally. */
export function spinner(): ReturnType<typeof clack.spinner> {
  return clack.spinner();
}

export interface Progress {
  /** Advance the bar by one step. Optional label is shown on the right. */
  tick(label?: string): void;
  /** Stop the bar with a final message. */
  done(message?: string): void;
}

/**
 * Hand-rolled progress bar layered on top of clack's spinner. Renders as
 *   `[████████░░░░░░░░] 12/30 — current label`
 * under TTY, and as periodic milestone log lines under non-TTY.
 */
export function progress(total: number, initialLabel = ''): Progress {
  if (total <= 0) {
    return {
      tick: () => {},
      done: (msg) => {
        if (msg) clack.log.success(msg);
      },
    };
  }

  let current = 0;

  // Non-TTY path: just emit a milestone every ~10% so log scrapers see steady
  // progress without 1000-line spam.
  if (!isInteractive()) {
    const stride = Math.max(1, Math.floor(total / 10));
    return {
      tick(label) {
        current++;
        if (current === total || current % stride === 0) {
          clack.log.info(`${current}/${total}${label ? ` — ${label}` : ''}`);
        }
      },
      done(msg) {
        if (msg) clack.log.success(msg);
      },
    };
  }

  const sp = clack.spinner();
  sp.start(render(current, total, initialLabel));

  return {
    tick(label) {
      current = Math.min(total, current + 1);
      sp.message(render(current, total, label ?? initialLabel));
    },
    done(msg) {
      sp.stop(msg ?? render(current, total, ''));
    },
  };
}

const BAR_WIDTH = 24;

function render(current: number, total: number, label: string): string {
  const ratio = total === 0 ? 1 : current / total;
  const filled = Math.round(ratio * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = pc.cyan('█'.repeat(filled)) + pc.gray('░'.repeat(empty));
  const count = pc.dim(`${current}/${total}`);
  return label ? `${bar} ${count} ${pc.dim('—')} ${label}` : `${bar} ${count}`;
}

/**
 * Render a "k of n" colored summary line, e.g. for end-of-command totals
 * outside of a note() box.
 */
export function summaryLine(
  parts: Array<{ label: string; value: number; tone?: 'ok' | 'warn' | 'err' | 'info' }>,
): string {
  return parts
    .map(({ label, value, tone = 'info' }) => {
      const colored =
        tone === 'ok'
          ? pc.green(String(value))
          : tone === 'warn'
            ? pc.yellow(String(value))
            : tone === 'err'
              ? pc.red(String(value))
              : pc.cyan(String(value));
      return `${pc.dim(label)} ${colored}`;
    })
    .join(pc.dim('  |  '));
}
