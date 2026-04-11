import pc from 'picocolors';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

const LEVEL_ICONS: Record<LogLevel, string> = {
  info: '\u{1F4DD}',
  warn: '\u26A0\uFE0F',
  error: '\u274C',
  success: '\u2705',
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  info: pc.cyan,
  warn: pc.yellow,
  error: pc.red,
  success: pc.green,
};

export function log(level: LogLevel, message: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 19);
  const icon = LEVEL_ICONS[level] ?? '';
  const colored = LEVEL_COLORS[level] ?? ((s: string) => s);
  console.log(`${pc.dim(ts)} ${icon} ${colored(message)}`, data ?? '');
}
