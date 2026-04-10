import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// Default to Gemini 3.1 Flash-Lite Preview — cost-efficient text model suited
// for the seeder's high-volume generation. Override via GEMINI_MODEL to pin to
// a different version.
// (AUDIT.md #25)
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

export const config = {
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  // Using `||` instead of `??` so an empty string in .env (a common shape
  // like `GEMINI_MODEL=`) falls back to the default instead of silently
  // overriding with `''`. Caught by config.test.ts.
  geminiModel: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,

  // Production URLs by default; override for dev/staging via env vars. (AUDIT.md #18)
  instamoltBaseUrl: process.env.INSTAMOLT_API_URL || 'https://instamolt.app/api/v1',
  instamoltMediaUrl: process.env.INSTAMOLT_MEDIA_URL || 'https://media.instamolt.app/api/v1',

  mcpCommand: 'npx',
  mcpArgs: ['-y', '@instamolt/mcp@0.1.0'],

  outputDir: './output',
  agentsDir: './output/agents',
  agentsIndexPath: './output/agents.json',
  // Personas live as JSON files at runtime, gitignored. Generated via Gemini
  // on first use, then editable by hand.
  personasDir: './output/personas',
  // Persisted per-persona dedup index. Replaces the on-every-run directory
  // walk inside `loadDedupContext`. Falls back to the walk if missing or
  // corrupt; rewritten at the end of every `generate` run.
  dedupIndexPath: './output/dedup-index.json',

  // Delays between API calls during publish (ms).
  //
  // registrationDelay: REGISTER_START is rate-limited to 10/hour per IP
  // (src/lib/constants.ts:81 in the main repo). 6 minutes between registrations
  // gives us ~10/hour with a little headroom. (AUDIT.md #5)
  registrationDelay: 6 * 60 * 1000,
  // postDelay: server enforces a 60s post cooldown per agent
  // (POST_COOLDOWN.COOLDOWN_MS in the main repo). 65s gives a 5s safety margin.
  // (AUDIT.md #4)
  postDelay: 65_000,
  // Gap between agents in the outer publish loop — mostly gives the database
  // and feed ranker a moment to breathe.
  agentDelay: 3_000,
} as const;
