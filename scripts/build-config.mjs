/**
 * SilentScribe — Managed Config Builder
 * ============================================================================
 *
 * A Chrome extension cannot read a .env file at runtime: there is no build
 * step and no filesystem access. This script bridges that gap. It reads
 * `.claude/.env` and writes `utils/managed-config.js`, a plain ES module the
 * extension imports.
 *
 * Run it after any change to `.claude/.env`:
 *
 *   node scripts/build-config.mjs
 *
 * NO KEY IS WRITTEN. An earlier version bundled one, which was a mistake: a key
 * inside an extension is readable by anyone who installs it and shows in the
 * network panel of every machine that runs it. Each user enters their own in
 * Settings. This script only saves them picking a provider and model.
 *
 * `.claude/.env` and the generated file both stay in .gitignore.
 *
 * Recognised variables in .claude/.env:
 *   NVIDIA_API_KEY | SILENTSCRIBE_API_KEY | API_KEY   the key to bundle
 *   SILENTSCRIBE_PROVIDER                             provider id (default: inferred)
 *   SILENTSCRIBE_MODEL                                model id
 *   SILENTSCRIBE_CONFIG_URL                           remote config JSON URL
 *
 * A .env holding nothing but a bare token is also accepted, and the provider
 * is inferred from the token prefix.
 *
 * @module scripts/build-config
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.claude', '.env');
const OUT_PATH = join(ROOT, 'utils', 'managed-config.js');

/** Token prefix → provider id in utils/llm.js. */
const PREFIX_TO_PROVIDER = [
  ['nvapi-',    'nvidia'],
  ['sk-ant-',   'anthropic'],
  ['sk-or-v1-', 'openrouter'],
  ['gsk_',      'groq'],
  ['xai-',      'xai'],
  ['AIza',      'google'],
  ['sk-',       'openai'],
];

/** Default model per provider, used when .env names none. */
const DEFAULT_MODEL = {
  nvidia:     'meta/llama-3.1-8b-instruct',
  anthropic:  'claude-opus-5',
  openai:     'gpt-4.1-mini',
  google:     'gemini-2.5-flash',
  groq:       'llama-3.3-70b-versatile',
  openrouter: 'anthropic/claude-sonnet-4.5',
  xai:        'grok-3',
};

/**
 * A line holding a bare API token rather than a KEY=value pair.
 *
 * The second alternative covers base64-style tokens whose `=` padding makes
 * them look like an empty assignment. It leaves out `_` on purpose, so a
 * genuinely empty assignment such as `SILENTSCRIBE_CONFIG_URL=` still parses
 * as a key.
 */
const BARE_TOKEN = /^(?:[A-Za-z0-9_.+\/\-]{16,}|[A-Za-z0-9.+\/\-]{16,}={1,2})$/;


/**
 * Parse a .env file into a plain object.
 *
 * Accepts `KEY=value` lines with optional `export ` and optional quotes, plus
 * the degenerate case of a file containing only a bare token.
 *
 * @param {string} text - Raw file contents.
 * @returns {Object<string, string>}
 */
function parseEnv(text) {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // A line that is just a token: treat it as the API key. Tested before the
    // KEY=value rule, because a padded base64 token such as `Zm9v…==` also
    // matches that rule and would otherwise become a key of its own.
    if (BARE_TOKEN.test(line)) {
      if (!env.API_KEY) env.API_KEY = line;
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) env[match[1]] = parseValue(match[2]);
  }

  return env;
}


/**
 * Read the value half of a `KEY=value` line.
 *
 * A quoted value runs to its LAST matching quote, so both a `#` and a nested
 * quote survive intact. An unquoted value stops at a `#`, because .env files
 * use it for trailing comments. A quote that is never closed is a typo, so the
 * stray character is dropped rather than shipped as part of an API key.
 *
 * @param {string} raw - Everything after the `=`.
 * @returns {string}
 */
function parseValue(raw) {
  let value = raw.trim();

  const quote = value.match(/^['"]/);
  if (quote) {
    const close = value.lastIndexOf(quote[0]);
    if (close > 0) return value.slice(1, close);
    value = value.slice(1);
  }

  // `#` opens a comment only after whitespace or at the start of the value, so
  // a key that legitimately contains `#` is never truncated.
  return value.replace(/(?:^|\s)#.*$/, '').trim();
}


/**
 * Infer the provider id from a key's prefix.
 *
 * @param {string} apiKey
 * @returns {string} Provider id, or 'custom' when the prefix is unknown.
 */
function inferProvider(apiKey) {
  for (const [prefix, provider] of PREFIX_TO_PROVIDER) {
    if (apiKey.startsWith(prefix)) return provider;
  }
  return 'custom';
}


/**
 * Show a key as its first and last few characters only, so build output and
 * logs never carry the whole secret.
 *
 * @param {string} apiKey
 * @returns {string}
 */
function mask(apiKey) {
  if (apiKey.length <= 12) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)} (${apiKey.length} chars)`;
}




function main() {
  if (!existsSync(ENV_PATH)) {
    console.error(`No .env found at ${ENV_PATH}`);
    console.error('Create it with a line such as:  NVIDIA_API_KEY=nvapi-…');
    process.exit(1);
  }

  const env = parseEnv(readFileSync(ENV_PATH, 'utf8'));
  const apiKey = env.NVIDIA_API_KEY || env.SILENTSCRIBE_API_KEY || env.API_KEY || '';

  if (!apiKey) {
    console.error('No API key found in .claude/.env.');
    console.error('Expected NVIDIA_API_KEY, SILENTSCRIBE_API_KEY, API_KEY, or a bare token.');
    process.exit(1);
  }

  const provider = env.SILENTSCRIBE_PROVIDER || inferProvider(apiKey);
  const model = env.SILENTSCRIBE_MODEL || DEFAULT_MODEL[provider] || '';
  const configUrl = env.SILENTSCRIBE_CONFIG_URL || '';

  const generated = `/**
 * SilentScribe — Local Defaults (GENERATED — DO NOT EDIT)
 * ============================================================================
 *
 * Written by scripts/build-config.mjs from .claude/.env.
 *
 * THIS FILE HOLDS NO CREDENTIAL, and the build refuses to put one here. A key
 * inside an extension is readable by anyone who installs it, and it appears in
 * the network panel of every machine that runs it, so there is no way to ship
 * one and keep it secret. Each user enters their own key in Settings.
 *
 * What this does carry is the provider and model your team uses, so a new
 * install has everything filled in except the key itself.
 *
 * @module managed-config
 */

export const MANAGED_CONFIG = Object.freeze({
  provider:  ${JSON.stringify(provider)},
  model:     ${JSON.stringify(model)},
  configUrl: ${JSON.stringify(configUrl)},
  builtAt:   ${JSON.stringify(new Date().toISOString())},
});
`;

  writeFileSync(OUT_PATH, generated, 'utf8');

  console.log('Wrote utils/managed-config.js');
  console.log(`  provider   ${provider}`);
  console.log(`  model      ${model || '(none — set SILENTSCRIBE_MODEL)'}`);
  console.log(`  config URL ${configUrl || '(none — set SILENTSCRIBE_CONFIG_URL to enable push updates)'}`);
  console.log('');
  console.log(`  The key in .claude/.env (${mask(apiKey)}) was NOT written.`);
  console.log('  Keys are entered per user in Settings; none ships with the extension.');
}

main();
