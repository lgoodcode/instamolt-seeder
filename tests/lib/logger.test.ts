import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';

// Same icons defined in logger.ts. Kept here verbatim (with the same unicode
// escapes) so the tests fail loudly if logger.ts ever changes them.
const ICON_INFO = '\u{1F4DD}';
const ICON_WARN = '\u26A0\uFE0F';
const ICON_ERROR = '\u274C';
const ICON_SUCCESS = '\u2705';

// Strip ANSI escape codes so substring assertions don't trip on the colors
// added by picocolors. Test environments may or may not have colors enabled
// depending on whether stdout is a TTY, so we normalize either way.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: unknown): string =>
  typeof s === 'string' ? s.replace(ANSI_RE, '') : String(s);

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('log', () => {
  it('calls console.log exactly once with a string containing the message', () => {
    log('info', 'hello world');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const firstArg = logSpy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe('string');
    expect(stripAnsi(firstArg)).toContain('hello world');
  });

  it('prefixes the message with an HH:MM:SS timestamp', () => {
    log('info', 'timestamped');
    const firstArg = logSpy.mock.calls[0]?.[0] as string;
    expect(stripAnsi(firstArg)).toMatch(/^\d{2}:\d{2}:\d{2}/);
  });

  it('includes the info level icon', () => {
    log('info', 'info message');
    const firstArg = logSpy.mock.calls[0]?.[0] as string;
    expect(stripAnsi(firstArg)).toContain(ICON_INFO);
  });

  it('includes the warn level icon', () => {
    log('warn', 'warn message');
    const firstArg = logSpy.mock.calls[0]?.[0] as string;
    expect(stripAnsi(firstArg)).toContain(ICON_WARN);
  });

  it('includes the error level icon', () => {
    log('error', 'error message');
    const firstArg = logSpy.mock.calls[0]?.[0] as string;
    expect(stripAnsi(firstArg)).toContain(ICON_ERROR);
  });

  it('includes the success level icon', () => {
    log('success', 'success message');
    const firstArg = logSpy.mock.calls[0]?.[0] as string;
    expect(stripAnsi(firstArg)).toContain(ICON_SUCCESS);
    expect(stripAnsi(firstArg)).toContain('success message');
  });

  it('passes the data argument through as the second console.log arg', () => {
    log('info', 'with data', { foo: 42 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const call = logSpy.mock.calls[0];
    expect(stripAnsi(call?.[0])).toContain('with data');
    expect(call?.[1]).toEqual({ foo: 42 });
  });

  it('uses an empty-string second arg when data is omitted', () => {
    log('info', 'no data');
    const call = logSpy.mock.calls[0];
    // The implementation passes `data ?? ''` so undefined collapses to ''.
    expect(call?.[1]).toBe('');
  });
});
