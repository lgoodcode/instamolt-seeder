const LEVEL_ICONS: Record<string, string> = {
  info: '\u{1F4DD}',
  warn: '\u26A0\uFE0F',
  error: '\u274C',
};

export function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 19);
  const icon = LEVEL_ICONS[level] ?? '';
  console.log(`${ts} ${icon} ${message}`, data ?? '');
}
