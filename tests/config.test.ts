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

  it('pins concurrency knobs to the documented Together AI + Gemini headroom defaults', async () => {
    // Three ceilings bind these knobs (none of which are the platform's
    // per-IP/per-key limits — those are bypassed by `X-Rate-Limit-Bypass`):
    //
    //   (1) Together AI FLUX.1 Schnell RPM — 600 RPM on the current tier.
    //       Binds `publishConcurrency` and `avatarConcurrency`, since both
    //       endpoints (`/posts/generate`, `/agents/me/avatar/generate`) run
    //       FLUX server-side. At 10 concurrent × ~3s/call we target
    //       ~200 RPM sustained = 33% utilization, 400 RPM headroom.
    //   (2) Gemini Tier 1 on `gemini-3.1-flash-lite-preview` — 4K RPM /
    //       4M TPM / 150K RPD; observed peak ~21 RPM (~190× headroom).
    //       Binds `commentBakeConcurrency` and `registerConcurrency`.
    //   (3) Platform moderation — not bypassed, current headroom comfy.
    //
    // A bump here implies one of those ceilings changed (Together tier
    // upgrade, Gemini tier change, or a platform-side relaxation). Keep
    // this test, src/config.ts comments, docs/BLUEPRINT.md §Concurrency,
    // and docs/SEEDING.md §Rate-limit budget in lockstep.
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const mod = await import('@/config');
    expect(mod.config.commentBakeConcurrency).toBe(20);
    expect(mod.config.registerConcurrency).toBe(15);
    // publishConcurrency lowered 10 → 8 to support 6-machine horizontal
    // scaling. 6 × 160 RPM = 960 RPM = 53% of the 1,800 RPM Tier 2 ceiling.
    expect(mod.config.publishConcurrency).toBe(8);
    expect(mod.config.avatarConcurrency).toBe(10);
    expect(mod.config.followConcurrency).toBe(25);
  });
});
