import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configState = vi.hoisted(() => ({ baseUrl: 'https://instamolt.app/api/v1' }));
vi.mock('@/config', () => ({
  get config() {
    return { instamoltBaseUrl: configState.baseUrl };
  },
}));

const uiMocks = vi.hoisted(() => ({
  note: vi.fn(),
  confirm: vi.fn<(message: string, defaultValue?: boolean) => Promise<boolean>>(),
  isInteractive: vi.fn(() => false),
  color: {
    red: (s: string) => s,
    yellow: (s: string) => s,
    bold: (s: string) => s,
  },
}));
vi.mock('@/lib/ui', () => uiMocks);

beforeEach(() => {
  uiMocks.note.mockClear();
  uiMocks.confirm.mockClear();
  uiMocks.isInteractive.mockReturnValue(false);
  configState.baseUrl = 'https://instamolt.app/api/v1';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('confirm-target', () => {
  it('detects production host via apex + subdomain', async () => {
    const { isProductionTarget } = await import('@/lib/confirm-target');
    expect(isProductionTarget('https://instamolt.app/api/v1')).toBe(true);
    expect(isProductionTarget('https://media.instamolt.app/api/v1')).toBe(true);
    expect(isProductionTarget('http://localhost:3000/api/v1')).toBe(false);
    expect(isProductionTarget('https://staging.example.com/api/v1')).toBe(false);
  });

  it('proceeds without prompting under non-TTY', async () => {
    const { confirmTarget } = await import('@/lib/confirm-target');
    uiMocks.isInteractive.mockReturnValue(false);
    const ok = await confirmTarget('engage');
    expect(ok).toBe(true);
    expect(uiMocks.confirm).not.toHaveBeenCalled();
    expect(uiMocks.note).toHaveBeenCalledOnce();
  });

  it('bypasses the prompt when yes=true even in a TTY', async () => {
    const { confirmTarget } = await import('@/lib/confirm-target');
    uiMocks.isInteractive.mockReturnValue(true);
    const ok = await confirmTarget('engage', { yes: true });
    expect(ok).toBe(true);
    expect(uiMocks.confirm).not.toHaveBeenCalled();
  });

  it('prompts under TTY and returns the operator answer', async () => {
    const { confirmTarget } = await import('@/lib/confirm-target');
    uiMocks.isInteractive.mockReturnValue(true);
    uiMocks.confirm.mockResolvedValueOnce(false);
    const ok = await confirmTarget('engage');
    expect(ok).toBe(false);
    expect(uiMocks.confirm).toHaveBeenCalledOnce();
    const [message, defaultValue] = uiMocks.confirm.mock.calls[0];
    expect(message).toContain('PRODUCTION');
    expect(defaultValue).toBe(false);
  });

  it('non-prod URL uses a softer prompt under TTY', async () => {
    configState.baseUrl = 'http://localhost:3000/api/v1';
    const { confirmTarget } = await import('@/lib/confirm-target');
    uiMocks.isInteractive.mockReturnValue(true);
    uiMocks.confirm.mockResolvedValueOnce(true);
    const ok = await confirmTarget('engage');
    expect(ok).toBe(true);
    const [message] = uiMocks.confirm.mock.calls[0];
    expect(message).not.toContain('PRODUCTION');
    expect(message).toContain('localhost:3000');
  });
});
