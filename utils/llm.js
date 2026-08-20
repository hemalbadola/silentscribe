/**
 * SilentScribe — Bring-Your-Own-Key LLM Client
 * ============================================================================
 *
 * One provider-agnostic chat call for every hosted LLM the user might have a
 * key for. Three wire formats cover the whole market:
 *
 *   'openai'    — OpenAI, Groq, OpenRouter, Together, DeepSeek, Mistral, xAI,
 *                 Perplexity, Fireworks, Cerebras, Ollama, LM Studio, vLLM,
 *                 LiteLLM, and anything else that speaks /chat/completions.
 *   'anthropic' — Claude (POST /messages).
 *   'google'    — Gemini (POST /models/{id}:generateContent).
 *
 * Anything not listed uses the 'custom' preset: pick the wire format and type
 * a base URL. That is what makes this "compatible with all providers".
 *
 * WHY RAW fetch AND NOT A VENDOR SDK: this extension has no bundler. Every
 * file is loaded as a native ES module by Chrome. Adding an npm SDK would mean
 * adding a build step, and it would only cover one of the providers below.
 *
 * WHERE THE KEY LIVES: chrome.storage.local, which is per-profile and not
 * readable by web pages or other extensions. It is NOT encrypted at rest —
 * anyone with the user's unlocked profile directory can read it. Use a scoped
 * key with a spend limit. The UI states this.
 *
 * @module llm
 */

import { getManagedLlmConfig } from './remote-config.js';

const LOG_PREFIX = '[SilentScribe LLM]';

/** chrome.storage.local key holding the whole BYOK config. */
const CONFIG_KEY = 'llmConfig';

/** Wall-clock ceiling for one provider request (ms). */
const REQUEST_TIMEOUT_MS = 120_000;

/** Attempts per request, including the first. Only 429/5xx/network are retried. */
const MAX_ATTEMPTS = 3;

/** Ceiling on a provider-supplied Retry-After, in seconds. */
const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Bounds for the two numeric settings. JSON.stringify writes Infinity and NaN
 * as `null`, so an unclamped value left the extension as a null parameter and
 * came back as an opaque 400.
 */
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOKENS_CEILING = 128_000;
const DEFAULT_TEMPERATURE = 0.2;
const MAX_TEMPERATURE = 2;

/** Hosts allowed to use plain http, because the request never leaves the machine. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A 400 that blames the `temperature` parameter, rather than a body that
 * happens to contain the word. Matching the bare word also matched policy
 * refusals such as "your prompt mentions temperature control", and every one
 * of those cost the user a second, identical, billed request.
 */
const TEMPERATURE_COMPLAINT =
  /temperature[\s\S]{0,80}(?:support|invalid|parameter)|(?:unsupported|invalid|parameter)[\s\S]{0,80}temperature/i;


// ============================================================================
// PROVIDER REGISTRY
// ============================================================================

/**
 * Known providers. `format` selects the request builder; `baseUrl` and `model`
 * are only defaults — the settings UI lets the user override both, and the
 * "Load models" button replaces guesswork with the provider's own list.
 *
 * @type {Object<string, {
 *   label: string, format: string, baseUrl: string, model: string,
 *   needsKey: boolean, keysUrl?: string, note?: string
 * }>}
 */
export const PROVIDERS = Object.freeze(Object.assign(Object.create(null), {
  builtin: {
    label: 'Chrome built-in (Gemini Nano)',
    format: 'builtin',
    baseUrl: '',
    model: '',
    needsKey: false,
    note: 'Runs on-device. No key, no network, no cost. Requires Chrome 138+ with the model downloaded.',
  },
  nvidia: {
    label: 'NVIDIA NIM',
    format: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.1-8b-instruct',
    needsKey: true,
    keysUrl: 'https://build.nvidia.com',
    note: 'OpenAI-compatible. Notes generation is a map-reduce, so a small fast '
        + 'model beats a large one here. Use "Load models" to see what this key serves.',
  },
  openai: {
    label: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    needsKey: true,
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-5',
    needsKey: true,
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  google: {
    label: 'Google Gemini',
    format: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    needsKey: true,
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    keysUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    needsKey: true,
    keysUrl: 'https://openrouter.ai/keys',
  },
  mistral: {
    label: 'Mistral',
    format: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    needsKey: true,
    keysUrl: 'https://console.mistral.ai/api-keys',
  },
  deepseek: {
    label: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  xai: {
    label: 'xAI (Grok)',
    format: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-3',
    needsKey: true,
    keysUrl: 'https://console.x.ai',
  },
  together: {
    label: 'Together AI',
    format: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    needsKey: true,
    keysUrl: 'https://api.together.xyz/settings/api-keys',
  },
  ollama: {
    label: 'Ollama (local)',
    format: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    needsKey: false,
    note: 'Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so it accepts the extension.',
  },
  lmstudio: {
    label: 'LM Studio (local)',
    format: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    needsKey: false,
    note: 'Enable the local server in LM Studio, then load a model.',
  },
  custom: {
    label: 'Custom / other provider',
    format: 'openai',
    baseUrl: '',
    model: '',
    needsKey: true,
    note: 'Any OpenAI-compatible, Anthropic-compatible, or Gemini-compatible endpoint.',
  },
}));

/** Wire formats the user may pick for the 'custom' provider. */
export const WIRE_FORMATS = Object.freeze([
  { value: 'openai',    label: 'OpenAI-compatible (/chat/completions)' },
  { value: 'anthropic', label: 'Anthropic (/messages)' },
  { value: 'google',    label: 'Google Gemini (:generateContent)' },
]);


// ============================================================================
// CONFIG
// ============================================================================

/**
 * Read the stored BYOK config, filling in the selected provider's defaults for
 * anything the user has not overridden.
 *
 * @returns {Promise<{
 *   provider: string, format: string, baseUrl: string, model: string,
 *   apiKey: string, maxTokens: number, temperature: number
 * }>}
 */
export async function getLlmConfig() {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};

  // A provider the user picked themselves always wins. Otherwise fall back to
  // whatever the team config supplies, so a fresh install works with no setup.
  if (stored.provider && PROVIDERS[stored.provider]) {
    return buildConfig(stored.provider, stored, 'user');
  }

  const managed = await getManagedLlmConfig();
  if (managed && PROVIDERS[managed.provider]) {
    return buildConfig(managed.provider, { ...managed, ...stripEmpty(stored) }, managed.source);
  }

  return buildConfig('builtin', stored, 'default');
}


/**
 * Merge one settings layer over a provider preset.
 *
 * @param {string} provider - Provider id.
 * @param {Object} values - Layer values; blank fields fall through to the preset.
 * @param {string} source - Where the values came from: user, remote, bundled, default.
 * @returns {Object} A fully resolved config.
 */
function buildConfig(provider, values, source) {
  const preset = PROVIDERS[provider];

  return {
    provider,
    format:      values.format      || preset.format,
    baseUrl:     String(values.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
    model:       values.model       || preset.model,
    apiKey:      values.apiKey      || '',
    maxTokens:   clampTokens(values.maxTokens),
    temperature: clampTemperature(values.temperature),
    source,
  };
}


/**
 * A token budget that survives JSON.stringify: a whole number, at least one,
 * never above any provider's output ceiling.
 *
 * @param {*} value - Raw stored value; anything at all.
 * @returns {number}
 */
function clampTokens(value) {
  const tokens = Math.trunc(Number(value));
  if (!Number.isFinite(tokens) || tokens < 1) return DEFAULT_MAX_TOKENS;
  return Math.min(tokens, MAX_TOKENS_CEILING);
}


/**
 * A sampling temperature inside the range every provider accepts.
 *
 * @param {*} value - Raw stored value; anything at all.
 * @returns {number}
 */
function clampTemperature(value) {
  if (value == null || value === '') return DEFAULT_TEMPERATURE;
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) return DEFAULT_TEMPERATURE;
  return Math.min(Math.max(temperature, 0), MAX_TEMPERATURE);
}


/**
 * Drop blank fields, so an empty stored value never blanks out a managed one.
 *
 * @param {Object} object
 * @returns {Object}
 */
function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== '' && v != null));
}


/**
 * The user's own provider settings, when they have set any.
 *
 * Used as the fallback when the managed key is rejected or rate limited.
 *
 * @returns {Promise<Object|null>}
 */
export async function getUserLlmConfig() {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};
  if (!stored.provider || !PROVIDERS[stored.provider]) return null;
  return buildConfig(stored.provider, stored, 'user');
}


/**
 * Serialises stored-config writes.
 *
 * The settings UI saves per keystroke, so two patches are often in flight at
 * once. Both read the same pre-update object and the later write erased the
 * earlier one's field, which showed up as a key that would not save.
 */
let configWriteChain = Promise.resolve();


/**
 * Merge a partial update into the stored config.
 *
 * Switching provider clears the fields that belong to the old provider, so the
 * user never ends up posting an OpenAI key at Anthropic's base URL.
 *
 * @param {Object} patch - Fields to change.
 * @returns {Promise<Object>} The config after the update.
 */
export async function setLlmConfig(patch) {
  const write = configWriteChain.then(() => writeLlmConfig(patch), () => writeLlmConfig(patch));
  // One rejected write must not wedge every later save, so the chain itself
  // only tracks completion.
  configWriteChain = write.catch(() => {});

  await write;
  return getLlmConfig();
}


/**
 * Apply one patch to storage. Only the write chain calls this, so the read and
 * the write it belongs to are never interleaved with another patch.
 *
 * @param {Object} patch - Fields to change.
 * @returns {Promise<void>}
 */
async function writeLlmConfig(patch) {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};

  if (patch.provider && patch.provider !== stored.provider) {
    const preset = PROVIDERS[patch.provider] || PROVIDERS.custom;
    Object.assign(stored, {
      provider: patch.provider,
      format:   preset.format,
      baseUrl:  preset.baseUrl,
      model:    preset.model,
      apiKey:   '',
    });
  }

  await chrome.storage.local.set({ [CONFIG_KEY]: { ...stored, ...patch } });
}


/**
 * Whether the current config can actually reach a model.
 *
 * @param {Object} [config] - Config to check. Read from storage when omitted.
 * @returns {Promise<boolean>}
 */
export async function isConfigured(config) {
  const cfg = config || await getLlmConfig();
  if (cfg.provider === 'builtin') return true;
  if (!cfg.baseUrl || !cfg.model) return false;
  return !PROVIDERS[cfg.provider]?.needsKey || Boolean(cfg.apiKey);
}


// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Send one system+user turn to the configured provider and return the text.
 *
 * @param {Object} params
 * @param {string} params.system - System instruction.
 * @param {string} params.user - User message.
 * @param {Object} [params.config] - Override the stored config.
 * @param {AbortSignal} [params.signal] - Caller cancellation.
 * @returns {Promise<string>} The assistant's text.
 * @throws {LlmError} On a non-retryable provider error or exhausted retries.
 */
export async function chat({ system, user, config, signal }) {
  const cfg = config || await getLlmConfig();

  if (cfg.provider === 'builtin') {
    throw new LlmError('The built-in provider does not use this path.', 0);
  }
  if (!cfg.baseUrl) {
    throw new LlmError('No base URL is set. Open Settings and choose a provider.', 0);
  }
  if (!cfg.model) {
    throw new LlmError('No model is set. Open Settings and pick a model.', 0);
  }
  if (PROVIDERS[cfg.provider]?.needsKey && !cfg.apiKey) {
    throw new LlmError('No API key is set. Open Settings and paste your key.', 0);
  }

  try {
    return await withRetry(
      (attemptSignal) => sendChat(cfg, system, user, attemptSignal),
      signal,
    );
  } catch (err) {
    // The shared key can be revoked, exhausted, or rate limited for everyone
    // at once. If the user has their own key, use it rather than fail.
    if (config || !isCredentialFailure(err)) throw err;

    const fallback = await getFallbackConfig(cfg);
    if (!fallback) throw err;

    console.warn(
      LOG_PREFIX,
      `${cfg.source} config failed (${err.status}); retrying with the ${fallback.source} config.`,
    );

    return withRetry(
      (attemptSignal) => sendChat(fallback, system, user, attemptSignal),
      signal,
    );
  }
}


/**
 * Whether an error means "this key cannot be used", as opposed to a bad
 * request that a different key would fail on too.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isCredentialFailure(err) {
  return err instanceof LlmError && [401, 402, 403, 429].includes(err.status);
}


/**
 * The user's own config, when the managed one just failed.
 *
 * ONE DIRECTION ONLY. A managed key falling back to the user's own key is safe:
 * the user chose that provider and that key. The reverse is not. It resent the
 * whole meeting transcript to a vendor the user had never picked, with no
 * notice, and then reported the failure under that vendor's name — a provider
 * the user could not find anywhere in their settings. Returns null when there
 * is no second option, or when it would just repeat the same request.
 *
 * @param {Object} failed - The config that failed.
 * @returns {Promise<Object|null>}
 */
async function getFallbackConfig(failed) {
  if (failed.source === 'user') return null;

  const candidate = await getUserLlmConfig();
  if (!candidate?.apiKey) return null;
  if (candidate.apiKey === failed.apiKey && candidate.baseUrl === failed.baseUrl) return null;
  if (candidate.provider === 'builtin') return null;

  return candidate;
}


/**
 * Send a one-token probe to confirm the base URL, key, and model all work.
 * This is the "ping my key" check, available to the user at any time.
 *
 * @param {Object} [config] - Config to test. Read from storage when omitted.
 * @returns {Promise<{ok: boolean, latencyMs: number, model: string, detail: string}>}
 */
export async function testConnection(config) {
  const cfg = config || await getLlmConfig();
  const startedAt = performance.now();

  if (cfg.provider === 'builtin') {
    const { available, state } = await checkBuiltinAi();
    return {
      ok: available,
      latencyMs: Math.round(performance.now() - startedAt),
      model: 'Gemini Nano (on-device)',
      detail: available
        ? 'On-device model is ready.'
        : `On-device model unavailable (${state}). Chrome 138+ is required, and the model must finish downloading.`,
    };
  }

  try {
    // A tiny prompt with a tiny cap — enough to prove auth and routing work.
    const reply = await chat({
      system: 'Reply with the single word OK.',
      user: 'ping',
      config: { ...cfg, maxTokens: 16 },
    });
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      model: cfg.model,
      detail: `Reachable. Model replied: ${JSON.stringify(reply.trim().slice(0, 40))}`,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      model: cfg.model,
      detail: err.message,
    };
  }
}


/**
 * Ask the provider which models the key can use.
 *
 * This replaces a hardcoded model list that would go stale. If the provider has
 * no list endpoint the caller keeps its typed model string.
 *
 * @param {Object} [config] - Config to query. Read from storage when omitted.
 * @returns {Promise<string[]>} Model IDs, sorted.
 */
export async function listModels(config) {
  const cfg = config || await getLlmConfig();
  if (cfg.provider === 'builtin') return [];

  assertUsableBaseUrl(cfg);
  const { url, headers } = buildListRequest(cfg);

  // Same transport policy as chat(). One 503 used to kill the "Load models"
  // button outright while a chat request in the same second retried three times.
  const body = await withRetry(async () => {
    const response = await fetchWithTimeout(url, { method: 'GET', headers });
    const parsed = await readJson(response);
    if (!response.ok) throw toProviderError(response, parsed, cfg);
    return parsed;
  });

  // A proxy, a captive portal, or a provider mid-migration can put anything at
  // all in this envelope. Drop what is not a string id instead of throwing a
  // TypeError the user cannot act on.
  const rows = cfg.format === 'google' ? body.models : (body.data || body.models);
  const ids = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object') return '';
    if (cfg.format === 'google') {
      return typeof row.name === 'string' ? row.name.replace(/^models\//, '') : '';
    }
    const id = row.id || row.name;
    return typeof id === 'string' ? id : '';
  });

  return [...new Set(ids.filter(Boolean))].sort();
}


/**
 * Probe Chrome's on-device Prompt API across both its current and legacy shapes.
 *
 * Chrome 138+ exposes a global `LanguageModel`. Earlier builds exposed
 * `window.ai.languageModel` with a different method name. Checking both means
 * the feature degrades instead of throwing on whichever Chrome the user runs.
 *
 * @returns {Promise<{available: boolean, state: string, api: Object|null}>}
 */
export async function checkBuiltinAi() {
  // Current API: global LanguageModel with availability().
  const modern = globalThis.LanguageModel;
  if (modern && typeof modern.availability === 'function') {
    try {
      const state = await modern.availability();
      return { available: state === 'available' || state === 'downloadable', state, api: modern };
    } catch (err) {
      console.warn(LOG_PREFIX, 'LanguageModel.availability() failed:', err);
      return { available: false, state: 'error', api: null };
    }
  }

  // Legacy API: window.ai.languageModel with capabilities().
  const legacy = globalThis.ai?.languageModel;
  if (legacy && typeof legacy.capabilities === 'function') {
    try {
      const caps = await legacy.capabilities();
      return { available: caps.available !== 'no', state: caps.available, api: legacy };
    } catch (err) {
      console.warn(LOG_PREFIX, 'ai.languageModel.capabilities() failed:', err);
      return { available: false, state: 'error', api: null };
    }
  }

  return { available: false, state: 'unsupported', api: null };
}


// ============================================================================
// ERRORS
// ============================================================================

/**
 * A provider failure the UI can reason about.
 * `status` is the HTTP status, or 0 for local/config failures.
 */
export class LlmError extends Error {
  constructor(message, status = 0, retryAfterMs = 0) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = status === 429 || status >= 500;
  }
}


// ============================================================================
// REQUEST BUILDERS
// ============================================================================

/**
 * Build the chat request for the config's wire format.
 *
 * @param {Object} cfg - Resolved config.
 * @param {string} system - System instruction.
 * @param {string} user - User message.
 * @param {Object} [tweaks] - { dropTemperature, useMaxCompletionTokens }.
 * @returns {{url: string, headers: Object, body: Object}}
 */
function buildChatRequest(cfg, system, user, tweaks = {}) {
  if (cfg.format === 'anthropic') {
    return {
      url: `${cfg.baseUrl}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        // Without this header the API rejects requests that carry a browser
        // Origin, which every extension page does.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      // No temperature: current Claude models reject the parameter with a 400.
      body: {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
    };
  }

  if (cfg.format === 'google') {
    return {
      url: `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': cfg.apiKey,
      },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: cfg.maxTokens,
          ...(tweaks.dropTemperature ? {} : { temperature: cfg.temperature }),
        },
      },
    };
  }

  // OpenAI-compatible.
  const tokenKey = tweaks.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      [tokenKey]: cfg.maxTokens,
      ...(tweaks.dropTemperature ? {} : { temperature: cfg.temperature }),
    },
  };
}


/**
 * Build the model-list request for the config's wire format.
 *
 * @param {Object} cfg - Resolved config.
 * @returns {{url: string, headers: Object}}
 */
function buildListRequest(cfg) {
  if (cfg.format === 'anthropic') {
    return {
      url: `${cfg.baseUrl}/models?limit=1000`,
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    };
  }
  if (cfg.format === 'google') {
    return {
      url: `${cfg.baseUrl}/models?pageSize=1000`,
      headers: { 'x-goog-api-key': cfg.apiKey },
    };
  }
  return {
    url: `${cfg.baseUrl}/models`,
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
  };
}


/**
 * Pull the assistant text out of a provider response.
 *
 * @param {string} format - Wire format.
 * @param {Object} body - Parsed response body.
 * @returns {string}
 * @throws {LlmError} If the response carries no text.
 */
function extractText(format, body) {
  let text = '';

  const asText = (value) => (typeof value === 'string' ? value : '');

  if (format === 'anthropic') {
    text = (Array.isArray(body.content) ? body.content : [])
      .filter((block) => block && block.type === 'text')
      .map((block) => asText(block.text))
      .join('');

    if (!text && body.stop_reason === 'refusal') {
      throw new LlmError('The model declined this request.', 0);
    }
  } else if (format === 'google') {
    const candidate = (Array.isArray(body.candidates) ? body.candidates : [])[0];
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    text = parts.map((part) => asText(part?.text)).join('');

    if (!text && candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new LlmError(`Gemini stopped early: ${candidate.finishReason}.`, 0);
    }
    if (!text && body.promptFeedback?.blockReason) {
      throw new LlmError(`Gemini blocked the prompt: ${body.promptFeedback.blockReason}.`, 0);
    }
  } else {
    const choice = (Array.isArray(body.choices) ? body.choices : [])[0];
    const content = choice?.message?.content;
    // Some OpenAI-compatible servers return content as an array of parts.
    text = Array.isArray(content)
      ? content.map((part) => asText(part?.text)).join('')
      : asText(content);
  }

  if (!text.trim()) {
    // A 200 can still carry an error envelope. Reporting "empty response"
    // threw away the only explanation the provider gave.
    const detail = errorDetail(body);
    throw new LlmError(
      detail
        ? `The provider returned no text: ${String(detail).slice(0, 200)}`
        : 'The provider returned an empty response.',
      0,
    );
  }
  return text;
}


// ============================================================================
// TRANSPORT
// ============================================================================

/**
 * Perform one chat request, adapting to the two parameter quirks that split
 * otherwise-compatible OpenAI endpoints:
 *   - newer reasoning models want `max_completion_tokens`, not `max_tokens`
 *   - some of them reject any `temperature` other than the default
 *
 * Both are detected from the provider's own 400 and retried once each, so the
 * user never has to know which dialect their endpoint speaks.
 *
 * @param {Object} cfg - Resolved config.
 * @param {string} system - System instruction.
 * @param {string} user - User message.
 * @param {AbortSignal} [signal] - Cancellation.
 * @returns {Promise<string>}
 */
async function sendChat(cfg, system, user, signal) {
  assertUsableBaseUrl(cfg);
  const tweaks = {};

  for (let pass = 0; pass < 3; pass++) {
    const { url, headers, body } = buildChatRequest(cfg, system, user, tweaks);

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const parsed = await readJson(response);

    if (response.ok) return extractText(cfg.format, parsed);

    const detail = errorDetail(parsed) || '';
    // Both tweaks rewrite the OpenAI body and nothing else, so trying them for
    // anthropic or google resent a byte-identical request, up to three times,
    // and billed the user for each one.
    if (cfg.format === 'openai' && response.status === 400) {
      if (!tweaks.useMaxCompletionTokens && /max_completion_tokens/i.test(detail)) {
        tweaks.useMaxCompletionTokens = true;
        continue;
      }
      if (!tweaks.dropTemperature && TEMPERATURE_COMPLAINT.test(detail)) {
        tweaks.dropTemperature = true;
        continue;
      }
    }

    throw toProviderError(response, parsed, cfg);
  }

  throw new LlmError('The provider rejected every parameter combination tried.', 400);
}


/**
 * Run an operation, retrying only 429, 5xx, and network failures.
 * Honours Retry-After when the provider sends one.
 *
 * @param {(signal: AbortSignal|undefined) => Promise<any>} operation
 * @param {AbortSignal} [signal] - Caller cancellation.
 * @returns {Promise<any>}
 */
async function withRetry(operation, signal) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation(signal);
    } catch (err) {
      if (err.name === 'AbortError') throw err;

      const retryable = err instanceof LlmError ? err.retryable : true;
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;

      lastError = err;
      const backoffMs = err.retryAfterMs || 500 * (2 ** (attempt - 1));
      console.warn(LOG_PREFIX, `Attempt ${attempt} failed (${err.message}). Retrying in ${backoffMs}ms.`);
      await sleep(backoffMs, signal);
    }
  }

  throw lastError;
}


/**
 * fetch with a hard timeout, merged with any caller AbortSignal.
 *
 * @param {string} url
 * @param {Object} [options] - fetch options; `signal` is the caller's.
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  // An already-aborted signal fires no 'abort' event, so adding a listener was
  // not enough and the request went out anyway.
  options.signal?.throwIfAborted?.();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (err.name === 'AbortError') {
      throw new LlmError(`No response within ${REQUEST_TIMEOUT_MS / 1000}s.`, 504);
    }
    // A cross-origin or DNS failure surfaces here as an opaque "Failed to fetch".
    throw new LlmError(
      `Could not reach ${safeHost(url)}. Check the base URL, your network, and whether the provider allows browser requests.`,
      0,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}


/**
 * Parse a response body as JSON, tolerating providers that return HTML or text
 * on an error path.
 *
 * @param {Response} response
 * @returns {Promise<Object>}
 */
async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
}


/**
 * Turn a failed response into an LlmError with a message the user can act on.
 *
 * @param {Response} response
 * @param {Object} body - Parsed body.
 * @param {Object} cfg - Resolved config, used for provider-specific hints.
 * @returns {LlmError}
 */
function toProviderError(response, body, cfg) {
  const detail = errorDetail(body) || response.statusText || 'no detail';
  // Retry-After comes from the provider and is not trusted. Without a ceiling a
  // hostile or misconfigured 3600 would sleep for an hour; a negative value
  // produced a negative delay and retried with no wait at all.
  const rawRetryAfter = Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(rawRetryAfter) && rawRetryAfter > 0
    ? Math.min(rawRetryAfter, MAX_RETRY_AFTER_SECONDS) * 1000
    : 0;

  const hints = {
    401: 'The key was rejected. Check that you pasted the whole key and that it belongs to this provider.',
    403: 'The key is valid but not allowed to use this model or endpoint.',
    404: `No such endpoint or model at ${safeHost(response.url)}. Check the base URL and the model ID.`,
    429: 'Rate limit or quota exceeded.',
  };
  const hint = hints[response.status] || '';

  return new LlmError(
    `${PROVIDERS[cfg.provider]?.label || cfg.provider} returned ${response.status}. ${hint} ${redact(detail, cfg.apiKey)}`.trim(),
    response.status,
    retryAfterMs,
  );
}


/**
 * Dig the human-readable message out of the several error envelopes in use.
 *
 * @param {Object} body - Parsed response body.
 * @returns {string}
 */
function errorDetail(body) {
  if (!body || typeof body !== 'object') return '';

  // Only strings are usable. A message that arrived as an object reached the UI
  // as the literal text "[object Object]", which explained nothing.
  const str = (value) => (typeof value === 'string' ? value : '');

  // Gateways such as OpenRouter and LiteLLM forward the upstream envelope whole,
  // giving { error: { error: { message } } }. Reading one level down finds the
  // real reason instead of reporting "no detail".
  const error = body.error;
  const nested = error && typeof error === 'object' ? error.error : null;
  const inner = nested && typeof nested === 'object' ? nested : {};

  return (
    str(error?.message) ||
    str(error?.type) ||
    str(inner.message) ||
    str(inner.type) ||
    str(body.message) ||
    str(body.detail) ||
    str(error) ||
    str(body._raw) ||
    ''
  );
}


/**
 * Strip the API key from any text before it reaches a log or the UI.
 *
 * @param {string} text
 * @param {string} apiKey
 * @returns {string}
 */
function redact(text, apiKey) {
  // Google keys carry no separator and NVIDIA's use their own prefix, so both
  // survived this filter whenever the echoed key was not the configured one —
  // which is exactly the case when a user pastes the wrong provider's key.
  const cleaned = String(text).replace(
    /\b(?:(?:sk|xai|gsk|sk-ant|sk-or|nvapi)[-_][A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})/g,
    '[key redacted]',
  );
  return apiKey ? cleaned.split(apiKey).join('[key redacted]') : cleaned;
}


/**
 * Reject a base URL before it can build a broken or unsafe request.
 *
 * Checked here rather than in buildConfig because the settings UI saves as the
 * user types: a config read must never reject halfway through a typed URL, or
 * the screen that repairs it cannot render.
 *
 * @param {Object} cfg - Resolved config.
 * @returns {void}
 * @throws {LlmError} If the base URL cannot be used as a prefix.
 */
function assertUsableBaseUrl(cfg) {
  let url;
  try {
    url = new URL(cfg.baseUrl);
  } catch {
    throw new LlmError(
      `The base URL is not a valid URL: ${redact(cfg.baseUrl, cfg.apiKey)}`,
      0,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // Every other scheme, javascript: included, was handed straight to fetch.
    throw new LlmError(`The base URL must start with https://, not ${url.protocol}`, 0);
  }
  if (url.username || url.password) {
    throw new LlmError('The base URL must not carry a username or password.', 0);
  }
  if (url.search || url.hash) {
    // Every path is appended to this string, so a query string produced
    // ".../v1?key=abc/chat/completions" and a 404 nobody could explain.
    throw new LlmError(
      'The base URL must not contain a query string or #fragment. Put the key in the API key field.',
      0,
    );
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    // Plain http puts the key on the wire in clear text. Only a server on this
    // machine (Ollama, LM Studio, vLLM) is exempt.
    throw new LlmError(`The base URL must use https:// to reach ${url.hostname}.`, 0);
  }
}


/**
 * Host of a URL, for error messages that must not echo query strings
 * (Gemini historically accepted the key as ?key=).
 *
 * @param {string} url
 * @returns {string}
 */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'the provider';
  }
}


/**
 * Abortable sleep.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    // Removing the listener matters: a long-lived signal across many retries
    // would otherwise accumulate one listener per sleep.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
