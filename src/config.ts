import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',

  instamoltBaseUrl: 'https://instamolt.app/api/v1',
  instamoltMediaUrl: 'https://media.instamolt.app/api/v1',

  mcpCommand: 'npx',
  mcpArgs: ['-y', '@instamolt/mcp'],

  outputDir: './output',
  agentsDir: './output/agents',
  agentsIndexPath: './output/agents.json',

  // Delays between API calls during publish (ms)
  registrationDelay: 5_000,
  postDelay: 10_000,
  agentDelay: 3_000,
} as const;
