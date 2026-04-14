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

  it('pins postDelay / registrationDelay / agentDelay to 0 (bypass-era regression guard)', async () => {
    // These delays were 65s / 6min / 3s defensive spacers against the
    // platform's per-IP, per-key, and post-cooldown rate limits. Those
    // limits are all relaxed by `X-Rate-Limit-Bypass` (see docs/CODEX.md §7
    // and the "Working conventions" bullet in CLAUDE.md), which every
    // seeder request attaches unconditionally. A non-zero value here is the
    // signal that someone added a defensive sleep for a limit that the
    // bypass no longer covers — if you're about to bump these, update the
    // CLAUDE.md rate-limit-bypass bullet in the same change and explain
    // what's newly NOT bypassed.
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const mod = await import('@/config');
    expect(mod.config.postDelay).toBe(0);
    expect(mod.config.registrationDelay).toBe(0);
    expect(mod.config.agentDelay).toBe(0);
  });

  it('pins concurrency knobs to the documented Gemini-headroom defaults', async () => {
    // Derived from observed Gemini Tier 1 allowance for
    // `gemini-3.1-flash-lite-preview` (4K RPM / 4M TPM / 150K RPD) and the
    // ~21 RPM peak seen in production; see BLUEPRINT.md "Concurrency" and
    // the config comment block. A bump here implies headroom has changed.
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const mod = await import('@/config');
    expect(mod.config.commentBakeConcurrency).toBe(20);
    expect(mod.config.registerConcurrency).toBe(15);
    expect(mod.config.publishConcurrency).toBe(10);
    expect(mod.config.followConcurrency).toBe(25);
  });
});
