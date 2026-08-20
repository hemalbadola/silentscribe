/**
 * SilentScribe — Test Runner
 * ============================================================================
 *
 * Runs every suite in tests/ and reports one summary.
 *
 *   node scripts/test.mjs        (or: npm test)
 *
 * Each suite drives the real modules with `chrome.*` and `fetch` stubbed, and
 * exits non-zero when any assertion fails. There is no test framework and no
 * dependency: a Chrome extension has nothing to run a framework in, and these
 * suites need to keep working from a fresh clone with only Node installed.
 *
 * @module scripts/test
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');

/** Node prints this when a .mjs sits next to a package.json it did not expect. */
const NOISE = /MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|To eliminate this warning|trace-warnings/;

let totalPassed = 0;
let totalFailed = 0;
const broken = [];

const suites = readdirSync(TESTS).filter((name) => name.endsWith('.test.mjs')).sort();

for (const suite of suites) {
  let output = '';
  let crashed = false;

  try {
    output = execFileSync(process.execPath, [join(TESTS, suite)], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A failing suite exits non-zero; its output is still what we want to read.
    output = `${err.stdout || ''}${err.stderr || ''}`;
    crashed = !err.stdout;
  }

  const summary = output.trim().split('\n').reverse()
    .find((line) => /^\d+ passed, \d+ failed$/.test(line.trim()));

  if (!summary) {
    broken.push(suite);
    console.log(`  ${suite.padEnd(24)} could not run`);
    for (const line of output.split('\n').filter((l) => l.trim() && !NOISE.test(l)).slice(0, 4)) {
      console.log(`      ${line.trim()}`);
    }
    continue;
  }

  const [passed, failed] = summary.match(/\d+/g).map(Number);
  totalPassed += passed;
  totalFailed += failed;

  console.log(`  ${suite.padEnd(24)} ${String(passed).padStart(3)} passed, ${failed} failed`);

  if (failed || crashed) {
    for (const line of output.split('\n').filter((l) => l.includes('FAIL'))) {
      console.log(`      ${line.trim()}`);
    }
  }
}

console.log(`\n${suites.length} suites, ${totalPassed} passed, ${totalFailed} failed`);

if (totalFailed || broken.length) {
  if (broken.length) console.log(`Could not run: ${broken.join(', ')}`);
  process.exit(1);
}
