/**
 * Pre-flight "are you sure you want to hit this target?" gate for the engage
 * commands. Every engage action is a real write against a live platform —
 * under a TTY we stop and ask the operator to confirm the target URL, and
 * under non-TTY (Docker, CI, cron) we print the target for the log and
 * proceed so unattended runs don't hang.
 *
 * Pass `{ yes: true }` (wired to the `--yes` / `-y` flag) to skip the prompt
 * in a TTY — useful for scripted runs where the operator has already
 * eyeballed the target elsewhere.
 */

import { config } from '@/config';
import * as ui from './ui';

export function isProductionTarget(baseUrl: string = config.instamoltBaseUrl): boolean {
  return baseUrl.includes('instamolt.app');
}

export async function confirmTarget(
  commandLabel: string,
  opts: { yes?: boolean } = {},
): Promise<boolean> {
  const url = config.instamoltBaseUrl;
  const prod = isProductionTarget(url);
  const badge = prod
    ? ui.color.red(ui.color.bold(' PRODUCTION '))
    : ui.color.yellow(ui.color.bold(' non-prod '));
  ui.note(`${commandLabel} target`, `${badge} ${ui.color.bold(url)}`);

  if (opts.yes) return true;
  if (!ui.isInteractive()) return true;

  const question = prod
    ? `Hit ${ui.color.red('PRODUCTION')} at ${url}? Real likes/comments/follows will be sent.`
    : `Proceed against ${url}?`;
  return ui.confirm(question, false);
}
