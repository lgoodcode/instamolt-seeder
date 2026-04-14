/**
 * Fetch the live platform's openapi.json, overwrite the committed copy, then
 * regenerate src/types.openapi.ts. One-liner fix for `openapi:prod-check`
 * failures.
 *
 * The operator is expected to review the resulting diff before committing —
 * this script is not run automatically during ship.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const COMMITTED_PATH = 'openapi.json';
const SPEC_URL = process.env.INSTAMOLT_SPEC_URL || 'https://instamolt.app/openapi.json';
const FETCH_TIMEOUT_MS = 15_000;

async function fetchProdSpec(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SPEC_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await fetchProdSpec();
  } catch (err) {
    console.error(`❌ Failed to fetch ${SPEC_URL}: ${err}`);
    process.exit(1);
  }

  let pretty: string;
  try {
    pretty = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  } catch (err) {
    console.error(`❌ Live spec is not valid JSON: ${err}`);
    process.exit(1);
  }

  writeFileSync(COMMITTED_PATH, pretty, 'utf-8');
  console.log(`✓ Wrote ${COMMITTED_PATH} from ${SPEC_URL} (${pretty.length} bytes)`);

  try {
    execSync('pnpm openapi:gen', { stdio: 'inherit' });
  } catch (err) {
    console.error(`❌ Type regeneration failed: ${err}`);
    process.exit(1);
  }

  console.log('✓ Regenerated src/types.openapi.ts — review the diff before committing.');
}

main().catch((err) => {
  console.error(`❌ Unexpected failure: ${err}`);
  process.exit(1);
});
