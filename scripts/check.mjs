/**
 * SilentScribe — Static Checks
 * ============================================================================
 *
 * The checks a browser only reports at runtime, run from the terminal in about
 * a second. A Chrome extension has no compiler and no type checker: a typo in
 * an element id, an import of a function that was renamed, or a CSS variable
 * that was never defined all fail silently at load time, often in a context
 * whose console nobody has open.
 *
 * Run before loading the extension:
 *
 *   node scripts/check.mjs        (or: npm run check)
 *
 * Exits non-zero when anything fails, so it can gate a commit or a package.
 * No dependencies: everything here uses only the Node standard library.
 *
 * @module scripts/check
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that are not our source. */
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git', 'dist', '.claude']);

const failures = [];
const warnings = [];

const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const warn = (check, detail) => warnings.push(`${check}: ${detail}`);


/**
 * Every JavaScript file that belongs to the extension.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} [found] - Accumulator.
 * @returns {string[]} Absolute paths.
 */
function sourceFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;

    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.m?js$/.test(entry) && !entry.startsWith('managed-config')) {
      found.push(path);
    }
  }
  return found;
}


/**
 * Every module parses as an ES module.
 *
 * A syntax error in any of these stops the whole extension from loading, and
 * Chrome reports it in a context the user rarely has open.
 */
function checkSyntax(files) {
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: readFileSync(file),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const detail = String(err.stderr || err.message).split('\n').slice(0, 3).join(' ').trim();
      fail('syntax', `${relative(ROOT, file)} — ${detail}`);
    }
  }
}


/**
 * Every named import resolves to a real export.
 *
 * Renaming an exported function and missing one caller is invisible until the
 * module that imports it is loaded, which may be days later.
 */
function checkImports(files) {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const base = dirname(file);

    for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
      // Only relative specifiers are ours to verify. A bare specifier is a
      // built-in module or a package, and resolving it against the file's
      // directory would always miss.
      if (!match[2].startsWith('.')) continue;

      const target = resolve(base, match[2]);

      // A dynamic optional dependency; remote-config.js handles it being absent.
      if (target.endsWith('managed-config.js')) continue;

      if (!existsSync(target)) {
        fail('imports', `${relative(ROOT, file)} imports missing module ${match[2]}`);
        continue;
      }

      const targetSource = readFileSync(target, 'utf8');
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        const exported = new RegExp(
          `^export\\s+(async\\s+)?(function|class|const|let|var)\\s+${name}\\b`, 'm',
        );
        if (!exported.test(targetSource)) {
          fail('imports', `${relative(ROOT, file)} imports "${name}", not exported by ${match[2]}`);
        }
      }
    }
  }
}


/**
 * Every element the side panel looks up exists in its HTML.
 *
 * A missing id yields null, and the first property access on it throws inside
 * setupEventListeners, which stops the whole panel from initialising.
 */
function checkDomReferences() {
  const html = readFileSync(join(ROOT, 'sidepanel/panel.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const duplicates = [...html.matchAll(/\sid="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicates.length) {
    fail('html', `duplicate ids: ${[...new Set(duplicates)].join(', ')}`);
  }

  for (const file of ['sidepanel/panel.js', 'sidepanel/shortcut-setup.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8');

    for (const match of source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
      if (!ids.has(match[1])) fail('dom', `${file} looks up missing id "${match[1]}"`);
    }
    for (const match of source.matchAll(/querySelector\(['"]#([a-zA-Z0-9_-]+)/g)) {
      if (!ids.has(match[1])) fail('dom', `${file} queries missing id "${match[1]}"`);
    }
  }

  // Elements referenced by list= or for= must exist too.
  for (const match of html.matchAll(/\s(?:list|for)="([^"]+)"/g)) {
    if (!ids.has(match[1])) fail('html', `attribute references missing id "${match[1]}"`);
  }
}


/**
 * Every CSS custom property used is defined, and braces balance.
 *
 * An undefined custom property makes its whole declaration invalid, so the
 * style silently does not apply — which is how the playback highlight bar was
 * missing for as long as it was.
 */
function checkStyles() {
  const css = readFileSync(join(ROOT, 'sidepanel/panel.css'), 'utf8');

  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  if (open !== close) fail('css', `unbalanced braces: ${open} open, ${close} close`);

  const used = new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
  for (const token of used) {
    if (!new RegExp(`^\\s*${token}\\s*:`, 'm').test(css)) {
      fail('css', `--${token.slice(2)} is used but never defined`);
    }
  }
}


/**
 * The manifest is valid and points at files that exist.
 */
function checkManifest() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

  const referenced = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...(manifest.content_scripts?.flatMap((entry) => entry.js) || []),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ].filter(Boolean);

  for (const path of referenced) {
    if (!existsSync(join(ROOT, path))) fail('manifest', `references missing file ${path}`);
  }

  // Permissions the code relies on.
  for (const [permission, why] of [
    ['alarms', 'the managed config refresh'],
    ['storage', 'settings and session state'],
    ['offscreen', 'audio capture'],
  ]) {
    if (!manifest.permissions?.includes(permission)) {
      fail('manifest', `missing "${permission}" permission, needed for ${why}`);
    }
  }
}


/**
 * The runtime pieces transcription needs are actually present.
 *
 * Without these the extension installs cleanly and then fails at the moment a
 * recording finishes, which is the worst possible time to find out.
 */
function checkRuntimeAssets() {
  const required = [
    ['lib/transformers.min.js', 'the transcription library'],
    ['lib/ort-wasm-simd.wasm', 'the WebAssembly runtime'],
  ];

  for (const [path, what] of required) {
    if (!existsSync(join(ROOT, path))) {
      fail('assets', `${path} is missing (${what}). Run ./setup.sh`);
    }
  }

  // The extension deliberately ships without a key, so this file should NOT
  // exist. If a stale build left one behind it would be packaged into the
  // release, which is the exact thing we decided not to do.
  if (existsSync(join(ROOT, 'utils/managed-config.js'))) {
    fail('secrets', 'utils/managed-config.js exists — delete it. The extension must ship no API key.');
  }
}


/**
 * No module calls a chrome API that its execution context does not have.
 *
 * This is the check that would have caught the worst runtime bug in this
 * extension. `offscreen/offscreen.js` called `chrome.storage.local.get()` on
 * the first line of capture. An offscreen document is given `chrome.runtime`
 * and essentially nothing else, so `chrome.storage` was undefined and every
 * recording died with "Cannot read properties of undefined (reading 'local')"
 * before a sample was written. Nothing static caught it, because the code is
 * perfectly valid JavaScript — it is only wrong in the place it runs.
 *
 * The graph walk matters as much as the rule. A util shared by the side panel
 * and the offscreen document has to obey the offscreen limit, and a file that
 * only arrives through `await import(...)` is just as loaded as a static one.
 */
function checkContextApis() {
  const CONTEXTS = [
    { entry: 'offscreen/offscreen.js', name: 'offscreen document', allowed: ['runtime'] },
    { entry: 'transcription/transcription-worker.js', name: 'web worker', allowed: [] },
    { entry: 'content/content.js', name: 'content script', allowed: ['runtime', 'storage', 'i18n'] },
  ];

  // Comments talk about these APIs constantly, and a comment cannot throw.
  // Block comments and whole-line comments go; a trailing `//` goes only when
  // it is not the `//` of a URL.
  // Blanking rather than deleting keeps every line number identical to the
  // real file, so a reported file:line can be opened and read.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/(^|[^:])\/\/.*$/, '$1')))
    .join('\n');

  // Both import forms, because both load the module.
  const importsOf = (src, fromFile) => {
    const specs = [...src.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)]
      .concat([...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)])
      .map((m) => m[1])
      .filter((spec) => spec.startsWith('.'));
    return specs.map((spec) => relative(ROOT, resolve(dirname(join(ROOT, fromFile)), spec)));
  };

  for (const { entry, name, allowed } of CONTEXTS) {
    if (!existsSync(join(ROOT, entry))) {
      fail('context', `${entry} is missing but is a declared entry point`);
      continue;
    }

    // Walk the whole reachable graph, not just the entry file.
    const seen = new Set();
    const queue = [entry];

    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file) || !existsSync(join(ROOT, file))) continue;
      seen.add(file);

      const source = readFileSync(join(ROOT, file), 'utf8');
      const code = stripComments(source);

      for (const match of code.matchAll(/\bchrome\.([a-zA-Z]+)/g)) {
        const api = match[1];
        if (allowed.includes(api)) continue;

        const line = code.slice(0, match.index).split('\n').length;
        const reach = file === entry ? '' : ` (reached from ${entry})`;
        const has = allowed.length ? `only ${allowed.map((a) => `chrome.${a}`).join(', ')}` : 'no chrome APIs at all';
        fail('context', `${file}:${line} uses chrome.${api}, but the ${name}${reach} has ${has}. Relay it through the service worker.`);
      }

      queue.push(...importsOf(code, file));
    }
  }
}


/**
 * The packaged build in dist/ matches the source it was built from.
 *
 * dist/ used to be a hand copy, and the v1.1.1 release proved what that costs:
 * the offscreen chrome.storage crash was fixed in source, dist/ kept the broken
 * copy, and this script reported "All checks passed" because it skips dist/.
 * Everyone who downloaded that zip got an extension that could not record.
 *
 * A stale package is worse than no package, so this fails rather than warns.
 * Fix it with `npm run build`, which regenerates dist/ from source.
 */
function checkPackagedBuild() {
  const stage = join(ROOT, 'dist', 'silentscribe');
  if (!existsSync(stage)) return;  // Nothing packaged yet is fine.

  const stale = [];
  const missing = [];

  const walk = (dir = '') => {
    for (const entry of readdirSync(join(stage, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // lib/ is generated by setup.sh and is identical by construction.
      if (rel === 'lib' || entry.name === '.DS_Store') continue;
      if (entry.isDirectory()) { walk(rel); continue; }

      const source = join(ROOT, rel);
      if (!existsSync(source)) { missing.push(rel); continue; }
      if (readFileSync(join(stage, rel), 'utf8') !== readFileSync(source, 'utf8')) stale.push(rel);
    }
  };

  walk();

  for (const rel of stale) {
    fail('package', `dist/silentscribe/${rel} does not match ${rel}. Run npm run build.`);
  }
  for (const rel of missing) {
    fail('package', `dist/silentscribe/${rel} has no source file. Run npm run build.`);
  }
}


/**
 * Nothing that looks like a credential is sitting in a tracked source file.
 *
 * The generated config is excluded because holding the key is its purpose; it
 * is listed in .gitignore for that reason.
 */
function checkNoLeakedSecrets(files) {
  const patterns = [
    /\bnvapi-[A-Za-z0-9_-]{20,}/,
    /\bsk-(?!ant-)[A-Za-z0-9]{20,}/,
    /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    /\bAIza[0-9A-Za-z_-]{35}/,
    /\bgsk_[A-Za-z0-9]{20,}/,
  ];

  // Everything that would end up in a release, not just source modules.
  const packaged = [
    ...files,
    join(ROOT, 'config.sample.json'),
    join(ROOT, 'manifest.json'),
    join(ROOT, 'README.md'),
    join(ROOT, 'utils/managed-config.js'),
    join(ROOT, '.env'),
  ];

  for (const file of packaged) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        fail('secrets', `${relative(ROOT, file)} contains something shaped like an API key`);
        break;
      }
    }
  }

  // .gitignore must actually cover the two files that hold the key.
  const ignorePath = join(ROOT, '.gitignore');
  if (!existsSync(ignorePath)) {
    fail('secrets', '.gitignore is missing, so the key files are unprotected');
    return;
  }
  const ignore = readFileSync(ignorePath, 'utf8');
  for (const entry of ['.env', 'utils/managed-config.js', '.claude/']) {
    if (!ignore.includes(entry)) fail('secrets', `.gitignore does not cover ${entry}`);
  }
}


// ============================================================================
// RUN
// ============================================================================

const files = sourceFiles();

checkSyntax(files);
checkImports(files);
checkDomReferences();
checkStyles();
checkManifest();
checkRuntimeAssets();
checkContextApis();
checkPackagedBuild();
checkNoLeakedSecrets(files);

console.log(`Checked ${files.length} modules.`);

for (const warning of warnings) console.log(`  warn  ${warning}`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);

if (failures.length) {
  console.log(`\n${failures.length} problem${failures.length === 1 ? '' : 's'} found.`);
  process.exit(1);
}

console.log(warnings.length ? `\nOK, with ${warnings.length} warning(s).` : '\nAll checks passed.');
