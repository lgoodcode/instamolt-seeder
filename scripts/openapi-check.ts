/**
 * OpenAPI drift check — verifies both ends of the chain:
 *
 *   live platform  →  openapi.json  →  src/types.openapi.ts
 *
 * 1. prod-vs-committed: fetch the live platform's openapi.json and normalize-
 *    compare against the committed copy. Catches "platform shipped a spec
 *    change and nobody copied it over."
 * 2. committed-vs-types: regenerate types into a temp file and byte-compare
 *    against the committed `src/types.openapi.ts`. Catches "edited
 *    openapi.json but forgot to re-run `pnpm openapi:gen`."
 *
 * Runs in both ship.md (pre-commit gate) and CI. Escape hatch for genuine
 * platform outages: `SKIP_OPENAPI_PROD_CHECK=1`.
 *
 * Cross-platform: avoids `diff` (not available natively on Windows) by doing
 * the comparison in Node.
 */

import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMMITTED_SPEC_PATH = 'openapi.json';
const COMMITTED_TYPES_PATH = 'src/types.openapi.ts';
const TMP_TYPES_PATH = join(tmpdir(), `instamolt-seeder-types.openapi.${process.pid}.ts`);
const SPEC_URL = process.env.INSTAMOLT_SPEC_URL || 'https://instamolt.app/openapi.json';
const FETCH_TIMEOUT_MS = 15_000;

async function fetchProdSpec(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SPEC_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${SPEC_URL}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(raw: string): string {
  return JSON.stringify(JSON.parse(raw));
}

async function checkProdDrift(): Promise<void> {
  if (process.env.SKIP_OPENAPI_PROD_CHECK === '1') {
    console.log('⚠ SKIP_OPENAPI_PROD_CHECK=1 set — skipping live spec comparison.');
    return;
  }

  let prodRaw: string;
  try {
    prodRaw = await fetchProdSpec();
  } catch (err) {
    console.error(`❌ Failed to fetch live spec from ${SPEC_URL}: ${err}`);
    console.error('   If the platform is genuinely down, rerun with SKIP_OPENAPI_PROD_CHECK=1.');
    process.exit(1);
  }

  let committedRaw: string;
  try {
    committedRaw = readFileSync(COMMITTED_SPEC_PATH, 'utf-8');
  } catch (err) {
    console.error(`❌ ${COMMITTED_SPEC_PATH} is missing: ${err}`);
    process.exit(1);
  }

  let prodNormalized: string;
  let committedNormalized: string;
  try {
    prodNormalized = normalize(prodRaw);
    committedNormalized = normalize(committedRaw);
  } catch (err) {
    console.error(`❌ Failed to parse a spec as JSON: ${err}`);
    process.exit(1);
  }

  if (prodNormalized !== committedNormalized) {
    console.error(
      `❌ ${COMMITTED_SPEC_PATH} is out of date with the live platform at ${SPEC_URL}.\n` +
        `   Run: pnpm openapi:pull\n` +
        `   Then review the diff and commit the updated spec + regenerated types.`,
    );
    process.exit(1);
  }

  console.log(`✓ ${COMMITTED_SPEC_PATH} matches live platform spec at ${SPEC_URL}`);
}

function checkTypesDrift(): void {
  try {
    execSync(`pnpm exec openapi-typescript openapi.json -o "${TMP_TYPES_PATH}"`, {
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`openapi-typescript failed: ${err}`);
    process.exit(1);
  }

  const fresh = readFileSync(TMP_TYPES_PATH, 'utf-8');
  const committed = (() => {
    try {
      return readFileSync(COMMITTED_TYPES_PATH, 'utf-8');
    } catch {
      return null;
    }
  })();

  rmSync(TMP_TYPES_PATH, { force: true });

  if (committed === null) {
    console.error(
      `❌ ${COMMITTED_TYPES_PATH} does not exist. Run \`pnpm openapi:gen\` and commit the result.`,
    );
    process.exit(1);
  }

  if (fresh !== committed) {
    console.error(
      `❌ ${COMMITTED_TYPES_PATH} is out of date with ${COMMITTED_SPEC_PATH}.\n` +
        `   Run: pnpm openapi:gen\n` +
        `   Then commit the regenerated file.`,
    );
    process.exit(1);
  }

  console.log(`✓ ${COMMITTED_TYPES_PATH} is in sync with ${COMMITTED_SPEC_PATH}`);
}

async function main(): Promise<void> {
  await checkProdDrift();
  checkTypesDrift();
}

main().catch((err) => {
  console.error(`❌ Unexpected failure: ${err}`);
  process.exit(1);
});
