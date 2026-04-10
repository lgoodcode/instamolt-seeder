import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// geminiApiKey is a lazy getter — it reads process.env on each access, so
// tests can stub/unstub without resetting the module registry.

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when GEMINI_API_KEY is missing', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const mod = await import('@/config');
    expect(() => mod.config.geminiApiKey).toThrow(/GEMINI_API_KEY/);
  });

  it('loads successfully when only GEMINI_API_KEY is set', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL', undefined as unknown as string);
    vi.stubEnv('INSTAMOLT_API_URL', undefined as unknown as string);
    vi.stubEnv('INSTAMOLT_MEDIA_URL', undefined as unknown as string);
    const mod = await import('@/config');
    expect(mod.config.geminiApiKey).toBe('test-key');
  });

  it('defaults geminiModel to gemini-3.1-flash-lite-preview when GEMINI_MODEL is unset', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL', undefined as unknown as string);
    const mod = await import('@/config');
    expect(mod.config.geminiModel).toBe('gemini-3.1-flash-lite-preview');
  });

  it('allows GEMINI_MODEL env var to override the default model', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL', 'gemini-foo');
    const mod = await import('@/config');
    expect(mod.config.geminiModel).toBe('gemini-foo');
  });

  it('defaults instamoltBaseUrl to the production URL when INSTAMOLT_API_URL is unset', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('INSTAMOLT_API_URL', undefined as unknown as string);
    const mod = await import('@/config');
    expect(mod.config.instamoltBaseUrl).toBe('https://instamolt.app/api/v1');
  });

  it('allows INSTAMOLT_API_URL env var to override instamoltBaseUrl', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('INSTAMOLT_API_URL', 'http://localhost:3000/api/v1');
    const mod = await import('@/config');
    expect(mod.config.instamoltBaseUrl).toBe('http://localhost:3000/api/v1');
  });

  it('defaults instamoltMediaUrl to the production URL when INSTAMOLT_MEDIA_URL is unset', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('INSTAMOLT_MEDIA_URL', undefined as unknown as string);
    const mod = await import('@/config');
    expect(mod.config.instamoltMediaUrl).toBe('https://media.instamolt.app/api/v1');
  });

  it('allows INSTAMOLT_MEDIA_URL env var to override instamoltMediaUrl', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('INSTAMOLT_MEDIA_URL', 'http://localhost:4000/api/v1');
    const mod = await import('@/config');
    expect(mod.config.instamoltMediaUrl).toBe('http://localhost:4000/api/v1');
  });

  it('pins postDelay to 65 seconds (AUDIT.md #4 regression guard)', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const mod = await import('@/config');
    expect(mod.config.postDelay).toBe(65_000);
  });

  it('pins registrationDelay to 6 minutes (AUDIT.md #5 regression guard)', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const mod = await import('@/config');
    expect(mod.config.registrationDelay).toBe(360_000);
  });

  it('pins mcpArgs to @instamolt/mcp@0.1.0', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const mod = await import('@/config');
    expect(mod.config.mcpArgs).toContain('@instamolt/mcp@0.1.0');
  });
});
