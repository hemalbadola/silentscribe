/**
 * SilentScribe — Diagnostics and Error Explanations
 * ============================================================================
 *
 * Two jobs, both aimed at removing ambiguity from what the user sees.
 *
 * 1. explainError() turns a raw failure into a cause and a next action. Raw
 *    messages from a WebAssembly runtime or an HTTP client are accurate and
 *    useless: "Failed to execute 'importScripts' on 'WorkerGlobalScope'" tells
 *    the user nothing about what to do. Every signature below was chosen from
 *    a failure that actually happened, not from guesswork.
 *
 * 2. collectDiagnostics() reports the real state of every part that can fail,
 *    so a fault can be identified from one screen instead of the console.
 *
 * @module diagnostics
 */

import { PROVIDERS, checkBuiltinAi, getLlmConfig } from './llm.js';
import { getBundledConfig, getConfigUrl, getRemoteConfig, isRemoteConfigured } from './remote-config.js';
import { WHISPER_CONFIG, STORAGE_CONFIG } from './constants.js';

const LOG_PREFIX = '[SilentScribe Diagnostics]';

/**
 * Known failure signatures, most specific first.
 *
 * `match` is tested against the raw message. `cause` says what went wrong in
 * plain terms. `action` is the single next step the user should take.
 */
const ERROR_SIGNATURES = [
  {
    match: /importScripts|WorkerGlobalScope|blob:chrome-extension/i,
    title: 'The transcription engine could not start',
    cause:
      'ONNX Runtime tried to start a helper thread from a blob: URL, which the '
      + "extension's content security policy blocks.",
    action:
      'This is fixed by pinning the runtime to one thread. Reload the extension at '
      + 'chrome://extensions. If it persists, run ./setup.sh again to refresh lib/.',
  },
  {
    match: /Transcription library not found|library not available|Failed to resolve module/i,
    title: 'The transcription library is missing',
    cause: 'lib/transformers.min.js was not found, so Whisper cannot load.',
    action: 'Run ./setup.sh in the extension folder, then reload the extension.',
  },
  {
    match: /ort-wasm|\.wasm|WebAssembly/i,
    title: 'The speech model runtime failed to load',
    cause: 'The WebAssembly binaries in lib/ are missing or damaged.',
    action: 'Run ./setup.sh to copy them again, then reload the extension.',
  },
  {
    match: /Failed to load model|Failed to load Whisper|Could not resolve model/i,
    title: 'The speech model could not be downloaded',
    cause:
      `The first run downloads ${WHISPER_CONFIG.MODEL_ID} from Hugging Face. `
      + 'That download did not complete.',
    action: 'Check the network connection and try again. The download resumes from cache.',
  },
  {
    match: /decodeAudioData|Unable to decode|EncodingError/i,
    title: 'The recording could not be decoded',
    cause: 'The saved audio file is truncated or was written in an unexpected format.',
    action:
      'This usually means the recording was cut short. The video may still play, '
      + 'but transcription cannot run on it.',
  },
  {
    match: /No audio was found|No audio data/i,
    title: 'This recording has no audio',
    cause: 'No audio was captured, so there is nothing to transcribe.',
    action:
      'Check that the meeting tab was actually producing sound, and that you picked '
      + 'the right tab when recording started.',
  },
  {
    match: /Extension has not been invoked|activeTab/i,
    title: 'Chrome would not allow tab capture',
    cause:
      'Tab capture only works when the recording is started by a click on the '
      + 'extension, on the tab being recorded.',
    action: 'Focus the meeting tab, then press Start Recording in the side panel.',
  },
  {
    match: /Permission denied|NotAllowedError|microphone/i,
    title: 'Microphone access was refused',
    cause: 'Chrome has not granted this extension permission to use the microphone.',
    action:
      'Open the site settings icon in the address bar and allow the microphone, '
      + 'or record without the microphone using the toggle.',
  },
  {
    match: /\b401\b|key was rejected|Incorrect API key|invalid_api_key/i,
    title: 'The API key was rejected',
    cause: 'The provider did not accept the key that is configured.',
    action: 'Open Settings and press Test connection to see which key is in use.',
  },
  {
    match: /\b429\b|rate limit|quota exceeded/i,
    title: 'The provider is rate limiting this key',
    cause: 'Too many requests, or the account has run out of credit.',
    action: 'Wait and try again, or set your own key in Settings to use instead.',
  },
  {
    match: /\b404\b|No such endpoint|model not found/i,
    title: 'The model or endpoint does not exist',
    cause: 'The base URL or the model id does not match anything at this provider.',
    action: 'Open Settings and press Load models to pick one the key can reach.',
  },
  {
    match: /Could not reach|Failed to fetch|NetworkError|ERR_/i,
    title: 'The provider could not be reached',
    cause: 'The request never got a response. The network, the URL, or the host is at fault.',
    action: 'Check the connection, then check the base URL in Settings.',
  },
  {
    // The worst failure in the product: the audio did not reach the disk. It
    // must never read as a generic problem, because the recording is the one
    // thing that cannot be redone.
    match: /Could not save the .* audio|recording could not be saved/i,
    title: 'The recording could not be saved',
    cause: 'Audio was captured, but writing it to disk failed partway through, so the file is incomplete.',
    action: 'Free up disk space, then record again. Check Settings → Diagnostics for storage usage. Any earlier recordings are unaffected.',
  },
  {
    // Last, and deliberately narrow. An earlier version matched the bare word
    // "quota", which made every provider 429 read as a full disk.
    match: /QuotaExceededError|storage quota|disk is full|out of disk|exceeded the quota/i,
    title: 'Storage is full',
    cause: 'The browser refused to write more data for this extension.',
    action: 'Delete some past recordings to free space, then try again.',
  },
  {
    // The shape of a JavaScript fault inside the extension itself. Saying so
    // plainly is the point: the user who saw "Cannot read properties of
    // undefined (reading 'local')" had no way to know it was our bug and not
    // their microphone, their key or their machine, so they had nothing to try.
    // Kept last, so a specific signature always wins over this one.
    match: /Cannot read propert|is not a function|is not defined|(undefined|null) is not an object/i,
    title: 'SilentScribe hit a bug in its own code',
    cause: 'A part of the extension called something that was not there. This is a fault in SilentScribe, not in your setup or your recording.',
    action: 'Reload the extension at chrome://extensions. If it happens again, run Diagnostics, press Copy report, and open an issue with it — the report includes the detail below.',
  },
];


/**
 * Turn a raw error into something the user can act on.
 *
 * Always returns a result. An unrecognised error keeps its original message
 * rather than being replaced by a vague one, because an exact unknown message
 * is more useful to report than an inexact known one.
 *
 * @param {Error|string} error - The failure.
 * @returns {{title: string, cause: string, action: string, raw: string, known: boolean}}
 */
export function explainError(error) {
  const raw = String(error?.message || error || '').trim();

  for (const signature of ERROR_SIGNATURES) {
    if (signature.match.test(raw)) {
      return { ...signature, match: undefined, raw, known: true };
    }
  }

  return {
    title: 'Something went wrong',
    cause: raw || 'No details were reported.',
    action: 'Open Settings and run Diagnostics to see which part is failing.',
    raw,
    known: false,
  };
}


/**
 * Check every part that can fail and report its real state.
 *
 * Never throws: a check that cannot run reports itself as unknown, because a
 * diagnostics screen that crashes is worse than one with a gap in it.
 *
 * @returns {Promise<{checks: Object[], summary: {ok: number, warn: number, fail: number}}>}
 */
export async function collectDiagnostics() {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // ── Extension ────────────────────────────────────────────────────────────
  try {
    const manifest = chrome.runtime.getManifest();
    add('Extension', 'ok', `${manifest.name} ${manifest.version}`);
  } catch (err) {
    add('Extension', 'fail', `Manifest unreadable: ${err.message}`);
  }

  // ── Keyboard shortcut ────────────────────────────────────────────────────
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((c) => c.name === 'toggle-recording')?.shortcut;
    add(
      'Keyboard shortcut',
      shortcut ? 'ok' : 'warn',
      shortcut || 'Not assigned. Another extension has claimed the combination.',
    );
  } catch (err) {
    add('Keyboard shortcut', 'warn', `Could not read: ${err.message}`);
  }

  // ── Microphone ───────────────────────────────────────────────────────────
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    add(
      'Microphone permission',
      status.state === 'granted' ? 'ok' : 'warn',
      status.state === 'granted'
        ? 'Granted'
        : `${status.state}. Only meeting audio will be captured, with no "Me" speaker split.`,
    );
  } catch {
    add('Microphone permission', 'warn', 'Could not be checked in this context.');
  }

  // ── Transcription engine ─────────────────────────────────────────────────
  try {
    const stored = await chrome.storage.local.get('modelSize');
    add('Speech model', 'ok', stored.modelSize || WHISPER_CONFIG.MODEL_ID);
  } catch (err) {
    add('Speech model', 'warn', `Setting unreadable: ${err.message}`);
  }

  for (const file of ['lib/transformers.min.js', 'lib/ort-wasm-simd.wasm']) {
    // eslint-disable-next-line no-await-in-loop
    add(...(await checkExtensionFile(file)));
  }

  // ── Notes provider ───────────────────────────────────────────────────────
  try {
    const config = await getLlmConfig();
    const label = PROVIDERS[config.provider]?.label || config.provider;

    if (config.provider === 'builtin') {
      const { available, state } = await checkBuiltinAi();
      add(
        'Notes provider',
        available ? 'ok' : 'warn',
        available
          ? 'Chrome on-device model, ready'
          : `Chrome on-device model unavailable (${state}). Set a key in Settings.`,
      );
    } else {
      const ready = Boolean(config.apiKey) && Boolean(config.baseUrl) && Boolean(config.model);
      add(
        'Notes provider',
        ready ? 'ok' : 'fail',
        `${label} · ${config.model || 'no model'} · key from ${describeSource(config.source)}`
        + (ready ? '' : ' · incomplete, finish setup in Settings'),
      );
    }
  } catch (err) {
    add('Notes provider', 'fail', `Could not resolve: ${err.message}`);
  }

  // ── Managed config ───────────────────────────────────────────────────────
  try {
    if (!(await isRemoteConfigured())) {
      const bundled = await getBundledConfig();
      add(
        'Managed config',
        'warn',
        bundled
          ? 'Bundled key in use. No config URL set, so the key cannot be updated remotely.'
          : 'Not configured. Run node scripts/build-config.mjs to bundle a key.',
      );
    } else {
      const remote = await getRemoteConfig();
      const url = await getConfigUrl();
      if (!remote) {
        add('Managed config', 'warn', `Never fetched from ${hostOf(url)}. Check the URL.`);
      } else {
        const minutes = Math.round((Date.now() - remote.fetchedAt) / 60000);
        add(
          'Managed config',
          remote.stale ? 'warn' : 'ok',
          `${hostOf(url)} · updated ${minutes} min ago${remote.stale ? ' · last refresh failed' : ''}`,
        );
      }
    }
  } catch (err) {
    add('Managed config', 'warn', `Check failed: ${err.message}`);
  }

  // ── Storage ──────────────────────────────────────────────────────────────
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const pct = quota ? Math.round((usage / quota) * 100) : 0;
    add(
      'Storage',
      pct > 90 ? 'fail' : pct > 75 ? 'warn' : 'ok',
      `${formatBytes(usage)} of ${formatBytes(quota)} used (${pct}%) · database ${STORAGE_CONFIG.DB_NAME} v${STORAGE_CONFIG.DB_VERSION}`,
    );
  } catch (err) {
    add('Storage', 'warn', `Could not be measured: ${err.message}`);
  }

  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };

  console.log(LOG_PREFIX, summary, checks);
  return { checks, summary };
}


/**
 * Confirm a file shipped inside the extension is actually present.
 *
 * A HEAD request against the extension's own URL is cheap and does not read
 * the body, which matters for the 10 MB WebAssembly binary.
 *
 * @param {string} path - Path relative to the extension root.
 * @returns {Promise<[string, string, string]>} Arguments for the checks list.
 */
async function checkExtensionFile(path) {
  const name = path.split('/').pop();
  try {
    const response = await fetch(chrome.runtime.getURL(path), { method: 'HEAD' });
    if (!response.ok) {
      return [name, 'fail', 'Missing from lib/. Run ./setup.sh, then reload the extension.'];
    }
    const size = Number(response.headers.get('content-length') || 0);
    return [name, 'ok', size ? formatBytes(size) : 'present'];
  } catch {
    return [name, 'fail', 'Missing from lib/. Run ./setup.sh, then reload the extension.'];
  }
}


/**
 * Describe where a config value came from, in words rather than a code.
 *
 * @param {string} source
 * @returns {string}
 */
function describeSource(source) {
  return {
    user: 'your own settings',
    remote: 'the published team config',
    bundled: '.claude/.env at build time',
    default: 'the built-in default',
  }[source] || source;
}


/**
 * Host part of a URL, so a diagnostics line never prints a query string that
 * might contain a token.
 *
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'an invalid URL';
  }
}


/**
 * Format a byte count for display.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
