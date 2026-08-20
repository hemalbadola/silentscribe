/**
 * SilentScribe — Managed Config and Update Checks
 * ============================================================================
 *
 * Gives every installed copy a way to receive new settings without a reinstall,
 * and to notice when a newer build exists.
 *
 * THREE LAYERS, most specific first:
 *   1. The user's own settings   — whatever they typed in the Settings screen.
 *   2. Remote config             — JSON fetched from the config URL, hourly.
 *   3. Built-in defaults         — the provider presets in utils/llm.js.
 *
 * NO KEYS TRAVEL THROUGH HERE. The extension ships without an API key and this
 * file cannot supply one. A key inside an extension is readable by anyone who
 * installs it, so each user enters their own in Settings. The published config
 * carries provider defaults, a version number and notices — nothing secret.
 *
 * WHAT THIS DOES NOT DO: it cannot update the extension's own code. Chrome
 * auto-updates only extensions installed from the Web Store or pushed as a
 * signed .crx by enterprise policy. An unpacked install never auto-updates. So
 * this module reports that a newer version exists and links to it; installing
 * it stays a manual step.
 *
 * @module remote-config
 */

const LOG_PREFIX = '[SilentScribe Config]';

/**
 * Where the config JSON lives.
 *
 * Point this at a raw GitHub file or Gist. Editing that file changes the
 * behaviour of every installed copy on its next refresh. A value in
 * `.claude/.env` under SILENTSCRIBE_CONFIG_URL overrides this constant.
 */
export const DEFAULT_CONFIG_URL =
  'https://raw.githubusercontent.com/hemalbadola/silentscribe/main/config.json';

/** chrome.storage.local key for the cached remote config. */
const CACHE_KEY = 'managedConfigCache';

/** How long a cached copy is served before a refresh is attempted (ms). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Ceiling on one config fetch (ms). Short: this must never delay startup. */
const FETCH_TIMEOUT_MS = 10_000;

/** Alarm name used by the service worker for the periodic refresh. */
export const REFRESH_ALARM = 'silentscribe-config-refresh';

/**
 * Fields this version understands in the config JSON. Anything else is
 * dropped, so the published file can grow without breaking older installs.
 *
 *   {
 *     "version":     "1.1.0",           latest published extension version
 *     "downloadUrl": "https://...",     where to get it
 *     "notes":       "What changed",    shown in the update banner
 *     "message":     "Any notice",      free-text banner, shown when present
 *     "llm": {                          suggested provider defaults, no key
 *       "provider": "nvidia",
 *       "baseUrl":  "https://integrate.api.nvidia.com/v1",
 *       "model":    "meta/llama-3.1-8b-instruct"
 *     }
 *   }
 */
const REMOTE_FIELDS = ['version', 'downloadUrl', 'notes', 'message', 'llm'];

/** Memoised import of the generated bundle. `undefined` means "not tried yet". */
let bundledCache;


// ============================================================================
// BUNDLED CONFIG
// ============================================================================

/**
 * Load utils/managed-config.js, the file generated from .claude/.env.
 *
 * The import is dynamic and guarded because the generated file is in
 * .gitignore. A fresh clone will not have it, and a static import would break
 * the whole module graph. Missing simply means "no bundled key".
 *
 * @returns {Promise<Object|null>}
 */
export async function getBundledConfig() {
  if (bundledCache !== undefined) return bundledCache;

  try {
    const module = await import('./managed-config.js');
    const config = module.MANAGED_CONFIG || null;

    // The file may survive from a build that predates the decision not to ship
    // keys. Take only the non-secret fields; ignore any key it carries.
    bundledCache = config
      ? { provider: config.provider, model: config.model, configUrl: config.configUrl }
      : null;
  } catch {
    // Expected. The extension ships without this file.
    bundledCache = null;
  }

  return bundledCache;
}


/**
 * The config URL actually in use: the one baked in from .env if present,
 * otherwise the constant above.
 *
 * @returns {Promise<string>}
 */
export async function getConfigUrl() {
  const bundled = await getBundledConfig();
  return bundled?.configUrl || DEFAULT_CONFIG_URL;
}


/**
 * Whether a real config URL has been set, as opposed to the placeholder.
 *
 * @returns {Promise<boolean>}
 */
export async function isRemoteConfigured() {
  const url = await getConfigUrl();
  return Boolean(url) && !url.includes('CHANGE-ME');
}


// ============================================================================
// REMOTE CONFIG
// ============================================================================

/**
 * Return the cached remote config, refreshing it first when it is stale.
 *
 * Never throws and never blocks on the network for long: a failed refresh
 * falls back to the last good copy, and then to the bundled config.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force] - Refresh even when the cache is fresh.
 * @returns {Promise<{data: Object, fetchedAt: number, stale: boolean}|null>}
 */
export async function getRemoteConfig({ force = false } = {}) {
  const cached = await readCache();
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;

  // A clock change or a doctored entry could park fetchedAt in the future and
  // pin the cache forever, which would make the key impossible to rotate.
  const fresh = age >= 0 && age < CACHE_TTL_MS;

  if (!force && cached && fresh) {
    // Re-sanitise on read. The entry was written by an older build, or by
    // something else with access to this profile's storage.
    return { ...cached, data: sanitize(cached.data) || {}, stale: false };
  }

  const refreshed = await fetchRemoteConfig();
  if (refreshed) return { ...refreshed, stale: false };

  // The network failed. A stale copy still beats nothing.
  return cached ? { ...cached, stale: true } : null;
}


/**
 * Read the cached entry, treating a storage failure as "no cache".
 *
 * chrome.storage can reject when the profile is being torn down or the quota
 * is exhausted. This module promises never to throw, so the failure is
 * absorbed here rather than surfacing in every caller.
 *
 * @returns {Promise<Object|null>}
 */
async function readCache() {
  try {
    return (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not read the config cache:', err.message);
    return null;
  }
}


/**
 * Fetch and cache the config JSON. Returns null on any failure.
 *
 * @returns {Promise<{data: Object, fetchedAt: number}|null>}
 */
export async function fetchRemoteConfig() {
  if (!(await isRemoteConfigured())) return null;

  const url = await getConfigUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // no-cache still revalidates, which matters on raw.githubusercontent where
    // a CDN copy can otherwise be served for minutes after an edit.
    const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) {
      console.warn(LOG_PREFIX, `Config fetch returned ${response.status}`);
      return null;
    }

    const data = sanitize(await response.json());
    if (!data || Object.keys(data).length === 0) {
      // Overwriting the cache here would discard a rotated key the moment the
      // published file was truncated or replaced with something unrelated.
      console.warn(LOG_PREFIX, 'Config JSON had nothing usable; keeping the cached copy.');
      return null;
    }

    const entry = { data, fetchedAt: Date.now() };
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: entry });
    } catch (err) {
      console.warn(LOG_PREFIX, 'Could not cache the config:', err.message);
    }
    console.log(LOG_PREFIX, 'Config refreshed.', data.version ? `version ${data.version}` : '');
    return entry;

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn(LOG_PREFIX, 'Config fetch failed:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Keep only the fields this version understands, and only when they are the
 * right type. A malformed or hostile config file must not be able to put
 * arbitrary values into the extension's settings.
 *
 * @param {*} parsed - Whatever JSON.parse produced.
 * @returns {Object|null} A safe object, or null if the input was not usable.
 */
function sanitize(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const clean = {};
  for (const field of REMOTE_FIELDS) {
    const value = parsed[field];
    if (value == null) continue;

    if (field === 'llm') {
      if (typeof value !== 'object' || Array.isArray(value)) continue;
      const llm = {};
      // Deliberately no apiKey. Keys are the user's own and are entered in
      // Settings; nothing published at a URL may set or replace one.
      for (const key of ['provider', 'baseUrl', 'model']) {
        // Cap every field. Only version/notes/message were capped before, so a
        // multi-megabyte apiKey went straight into storage.
        if (typeof value[key] === 'string' && value[key] && value[key].length <= 512) {
          llm[key] = value[key];
        }
      }
      // A base URL must be a real absolute http(s) URL, or the extension would
      // happily POST the API key at whatever string appeared in the file.
      if (llm.baseUrl && !isHttpUrl(llm.baseUrl)) {
        console.warn(LOG_PREFIX, 'Ignoring non-HTTP baseUrl in remote config.');
        delete llm.baseUrl;
      }
      if (Object.keys(llm).length) clean.llm = llm;
      continue;
    }

    if (field === 'downloadUrl') {
      if (typeof value === 'string' && isHttpUrl(value)) clean.downloadUrl = value;
      continue;
    }

    if (typeof value === 'string') clean[field] = value.slice(0, 2000);
  }

  return clean;
}


/**
 * True for an absolute http(s) URL.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);

    // Credentials in the URL are never legitimate here and are a classic way
    // to disguise the real host.
    if (url.username || url.password) return false;

    // A query string would be swallowed by the path we append to it, producing
    // a URL that goes somewhere other than it appears to.
    if (url.search || url.hash) return false;

    if (url.protocol === 'https:') return true;

    // Plain http only for a local model server, never for a remote host.
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}


// ============================================================================
// MERGED PROVIDER CONFIG
// ============================================================================

/**
 * Provider defaults suggested for this install, never a credential.
 *
 * The extension ships with no API key. A key shipped inside an extension is
 * readable by anyone who installs it and visible in the network panel of every
 * machine that runs it, so there is no version of bundling one that keeps it
 * secret. Each user supplies their own in Settings.
 *
 * What this still does is save them typing: the published config can name the
 * provider, base URL and model your team uses, so the only thing left to paste
 * is the key itself.
 *
 * @returns {Promise<{provider: string, model: string, baseUrl: string,
 *                    source: string}|null>}
 */
export async function getSuggestedLlmDefaults() {
  const remote = await getRemoteConfig();
  const llm = remote?.data?.llm;
  if (!llm?.provider && !llm?.model && !llm?.baseUrl) return null;

  return {
    provider: llm.provider || '',
    model:    llm.model    || '',
    baseUrl:  llm.baseUrl  || '',
    source:   'remote',
  };
}


/**
 * Kept so callers written against the previous contract keep working.
 *
 * Always null now: there is no managed credential to return. utils/llm.js
 * treats null as "no managed config", which is exactly right.
 *
 * @returns {Promise<null>}
 */
export async function getManagedLlmConfig() {
  return null;
}


// ============================================================================
// UPDATE CHECK
// ============================================================================

/**
 * Compare the running version to the published one.
 *
 * @returns {Promise<{
 *   updateAvailable: boolean, current: string, latest: string,
 *   downloadUrl: string, notes: string, message: string
 * }>}
 */
export async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  const remote = await getRemoteConfig();
  const data = remote?.data || {};

  return {
    updateAvailable: Boolean(data.version) && compareVersions(data.version, current) > 0,
    current,
    latest: data.version || current,
    downloadUrl: data.downloadUrl || '',
    notes: data.notes || '',
    message: data.message || '',
  };
}


/**
 * Compare two dotted version strings.
 *
 * Chrome versions are up to four dot-separated integers, so a numeric
 * comparison per part is correct. Non-numeric parts count as 0 rather than
 * NaN, which would make every comparison false.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a, b) {
  // A leading "v" is common in release tags and would otherwise parse as 0,
  // so a real update would never be announced.
  const pa = String(a).replace(/^v/i, '').split('.');
  const pb = String(b).replace(/^v/i, '').split('.');

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i], 10) || 0;
    const nb = Number.parseInt(pb[i], 10) || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
