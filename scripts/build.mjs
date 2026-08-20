/**
 * SilentScribe — Package Builder
 * ============================================================================
 *
 *   node scripts/build.mjs        (or: npm run build)
 *
 * Regenerates dist/ from source and zips it for a release.
 *
 * This exists because dist/ used to be a hand copy, and a hand copy drifts.
 * The v1.1.1 release shipped a dist/ that still contained the offscreen
 * chrome.storage crash after the source was fixed — `npm run check` passed,
 * because it skips dist/, while every person who downloaded the zip got an
 * extension that could not record. Building from source removes the chance.
 *
 * The gate runs first on purpose: a build that cannot pass its own checks is
 * not a build worth shipping.
 *
 * @module scripts/build
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');

/** Everything the extension needs at runtime, and nothing else. */
const INCLUDE = [
  'manifest.json',
  'background',
  'content',
  'offscreen',
  'sidepanel',
  'storage',
  'transcription',
  'utils',
  'assets',
  'lib',
  'config.sample.json',
  'README.md',
  'package.json',
  'setup.sh',
];

/** Never packaged, wherever it turns up. A key must not reach a release. */
const EXCLUDE = new Set(['managed-config.js', '.DS_Store']);

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

// Clear the old package before checking. checkPackagedBuild() fails on a stale
// dist/, which is the whole point of it — but that must not block the very
// command whose job is to replace it.
rmSync(OUT, { recursive: true, force: true });

console.log('Checking before building...\n');
run(process.execPath, [join(ROOT, 'scripts/check.mjs')]);
run(process.execPath, [join(ROOT, 'scripts/test.mjs')]);

const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

if (version !== pkgVersion) {
  console.error(`\nmanifest.json says ${version} but package.json says ${pkgVersion}. Make them agree.`);
  process.exit(1);
}

const stage = join(OUT, 'silentscribe');
mkdirSync(stage, { recursive: true });

for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) {
    console.error(`\nMissing: ${entry}. Run ./setup.sh first.`);
    process.exit(1);
  }
  cpSync(from, join(stage, entry), {
    recursive: true,
    filter: (src) => !EXCLUDE.has(src.split('/').pop()),
  });
}

const zipName = `silentscribe-${version}.zip`;
// Zip from inside dist/ so the archive root is silentscribe/, not dist/silentscribe/.
run('zip', ['-q', '-r', zipName, 'silentscribe', '-x', '*.DS_Store'], OUT);

console.log(`\nBuilt dist/silentscribe and dist/${zipName} from source at version ${version}.`);
