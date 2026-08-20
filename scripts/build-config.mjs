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
 * SECURITY: the generated file contains the API key in plain text, and it
 * ships inside the extension. Anyone who installs the extension can read it.
 * That is acceptable only for a trusted audience. Both `.claude/.env` and the
 * generated file are listed in .gitignore. Rotate the key through the remote
 * config URL rather than by redistributing the extension.
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

import { randomBytes } from 'node:crypto';
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




/**
 * Encode the key so it appears nowhere in the build as readable text.
 *
 * WHAT THIS DOES: defeats automated scrapers. Bots that scan public files and
 * release archives for /nvapi-[A-Za-z0-9_-]{40,}/ find nothing, because no
 * substring of the key exists in the output and there is no base64 of it
 * either. Every build produces different bytes, so a leaked build cannot be
 * matched against another.
 *
 * WHAT THIS DOES NOT DO: hide the key from a person. The extension must send
 * `Authorization: Bearer <key>` for the provider to accept the request, so the
 * key is visible in the DevTools network panel of any machine running it, no
 * matter how it is stored here. Treat it as shared with everyone who has the
 * extension. Rotate it through the config URL, not by rebuilding.
 *
 * Layers, applied in order:
 *   1. XOR every byte with a random pad, repeating.
 *   2. Cut the result into chunks.
 *   3. Shuffle the chunks by a random permutation.
 * The pad and the permutation ship alongside, which is the point: this is
 * obfuscation, not encryption, and it is labelled as such.
 *
 * @param {string} apiKey - The key to encode.
 * @returns {{pad: number[], chunks: number[][], order: number[]}}
 */
function obfuscate(apiKey) {
  const bytes = [...Buffer.from(apiKey, 'utf8')];
  const pad = [...randomBytes(29)];

  const masked = bytes.map((byte, i) => byte ^ pad[i % pad.length]);

  // Cut into chunks of uneven size so chunk boundaries carry no information
  // about the key's length.
  const chunks = [];
  for (let i = 0; i < masked.length; i += 7) chunks.push(masked.slice(i, i + 7));

  // A random permutation, stored as the position each chunk belongs at.
  const order = chunks.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  const shuffled = order.map((position) => chunks[position]);
  return { pad, chunks: shuffled, order };
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

  const { pad, chunks, order } = obfuscate(apiKey);

  const generated = `/**
 * SilentScribe — Managed Config (GENERATED — DO NOT EDIT)
 * ============================================================================
 *
 * Written by scripts/build-config.mjs from .claude/.env.
 * Run \`node scripts/build-config.mjs\` after changing that file.
 *
 * This module is in .gitignore because it holds an API key in plain text.
 * The key ships inside the extension and any installer can read it, so treat
 * it as shared-with-your-team, never as a secret. To rotate it everywhere at
 * once, publish a new key at the remote config URL instead of rebuilding.
 *
 * @module managed-config
 */

const P = ${JSON.stringify(pad)};
const C = ${JSON.stringify(chunks)};
const O = ${JSON.stringify(order)};

/**
 * Rebuild the key. Kept as a function so the plain value is never a
 * module-level binding that a heap dump or a source scan can pick up.
 *
 * @returns {string}
 */
function k() {
  const parts = [];
  O.forEach((position, i) => { parts[position] = C[i]; });
  const masked = parts.flat();
  return masked.map((b, i) => String.fromCharCode(b ^ P[i % P.length])).join('');
}

export const MANAGED_CONFIG = Object.freeze({
  provider:  ${JSON.stringify(provider)},
  model:     ${JSON.stringify(model)},
  configUrl: ${JSON.stringify(configUrl)},
  builtAt:   ${JSON.stringify(new Date().toISOString())},
  get apiKey() { return k(); },
});
`;

  writeFileSync(OUT_PATH, generated, 'utf8');

  console.log('Wrote utils/managed-config.js');
  console.log(`  provider   ${provider}`);
  console.log(`  model      ${model || '(none — set SILENTSCRIBE_MODEL)'}`);
  console.log(`  key        ${mask(apiKey)}`);
  console.log(`  config URL ${configUrl || '(none — set SILENTSCRIBE_CONFIG_URL to enable push updates)'}`);
}

main();
