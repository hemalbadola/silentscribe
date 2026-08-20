// Drives the real modules with chrome.* and fetch stubbed, so the request
// shapes, retry logic, and map-reduce path are actually executed.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let store = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
    set: async (o) => Object.assign(store, o),
  } },
};
globalThis.performance = globalThis.performance || { now: () => 0 };

let calls = [];
let responder = () => ({ status: 200, body: { choices: [{ message: { content: 'hello' } }] } });

globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, method: options.method, headers: options.headers,
               body: options.body ? JSON.parse(options.body) : null });
  const { status, body } = responder(calls.length, url);
  return {
    ok: status >= 200 && status < 300,
    status, statusText: 'x', url,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
};

const { chat, setLlmConfig, getLlmConfig, listModels, testConnection } =
  await import(`${ROOT}/utils/llm.js`);
const { generateAiNotes, formatTranscript } = await import(`${ROOT}/utils/ai.js`);
const { renderMarkdown } = await import(`${ROOT}/utils/markdown.js`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const reset = () => { calls = []; };

// ── OpenAI wire format ──────────────────────────────────────────────────────
console.log('\n[openai]');
store = {}; reset();
await setLlmConfig({ provider: 'openai' });
await setLlmConfig({ apiKey: 'sk-test-1234567890abcdef' });
let out = await chat({ system: 'S', user: 'U' });
check('returns text', out === 'hello', out);
check('POST /chat/completions', calls[0].url === 'https://api.openai.com/v1/chat/completions', calls[0].url);
check('bearer auth', calls[0].headers.authorization === 'Bearer sk-test-1234567890abcdef');
check('system+user roles', JSON.stringify(calls[0].body.messages) === JSON.stringify([
  { role: 'system', content: 'S' }, { role: 'user', content: 'U' }]));
check('max_tokens sent', calls[0].body.max_tokens === 4096);
check('temperature sent', calls[0].body.temperature === 0.2);

// ── OpenAI parameter-dialect adaptation ─────────────────────────────────────
console.log('\n[openai dialect adaptation]');
reset();
responder = (n) => n === 1
  ? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } }
  : { status: 200, body: { choices: [{ message: { content: 'adapted' } }] } };
out = await chat({ system: 'S', user: 'U' });
check('retries with max_completion_tokens', out === 'adapted' && calls[1].body.max_completion_tokens === 4096, JSON.stringify(calls[1]?.body));
check('max_tokens dropped on retry', calls[1].body.max_tokens === undefined);

reset();
responder = (n) => n === 1
  ? { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } } }
  : { status: 200, body: { choices: [{ message: { content: 'notemp' } }] } };
out = await chat({ system: 'S', user: 'U' });
check('retries without temperature', out === 'notemp' && calls[1].body.temperature === undefined);

// ── Anthropic wire format ───────────────────────────────────────────────────
console.log('\n[anthropic]');
store = {}; reset();
responder = () => ({ status: 200, body: { content: [{ type: 'text', text: 'claude says hi' }], stop_reason: 'end_turn' } });
await setLlmConfig({ provider: 'anthropic' });
await setLlmConfig({ apiKey: 'sk-ant-secret-key-value' });
out = await chat({ system: 'S', user: 'U' });
check('returns text', out === 'claude says hi', out);
check('POST /messages', calls[0].url === 'https://api.anthropic.com/v1/messages', calls[0].url);
check('x-api-key header', calls[0].headers['x-api-key'] === 'sk-ant-secret-key-value');
check('anthropic-version header', calls[0].headers['anthropic-version'] === '2023-06-01');
check('browser-access header', calls[0].headers['anthropic-dangerous-direct-browser-access'] === 'true');
check('system is top-level', calls[0].body.system === 'S');
check('single user message', JSON.stringify(calls[0].body.messages) === JSON.stringify([{ role: 'user', content: 'U' }]));
check('NO temperature (400s on current models)', !('temperature' in calls[0].body), JSON.stringify(calls[0].body));
check('default model is claude-opus-5', calls[0].body.model === 'claude-opus-5', calls[0].body.model);

reset();
responder = () => ({ status: 200, body: { content: [], stop_reason: 'refusal' } });
try { await chat({ system: 'S', user: 'U' }); check('refusal throws', false); }
catch (e) { check('refusal throws', /declined/.test(e.message), e.message); }

// ── Google wire format ──────────────────────────────────────────────────────
console.log('\n[google]');
store = {}; reset();
responder = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'gemini hi' }] }, finishReason: 'STOP' }] } });
await setLlmConfig({ provider: 'google' });
await setLlmConfig({ apiKey: 'AIza-test-key' });
out = await chat({ system: 'S', user: 'U' });
check('returns text', out === 'gemini hi', out);
check(':generateContent URL', calls[0].url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', calls[0].url);
check('key in header not query', calls[0].headers['x-goog-api-key'] === 'AIza-test-key' && !calls[0].url.includes('key='));
check('systemInstruction', calls[0].body.systemInstruction.parts[0].text === 'S');

// ── Retry + error handling ──────────────────────────────────────────────────
console.log('\n[retry and errors]');
store = {}; reset();
await setLlmConfig({ provider: 'openai' });
await setLlmConfig({ apiKey: 'sk-retry-key-000' });
responder = (n) => n < 3
  ? { status: 503, body: { error: { message: 'overloaded' } } }
  : { status: 200, body: { choices: [{ message: { content: 'recovered' } }] } };
out = await chat({ system: 'S', user: 'U' });
check('retries 503 then succeeds', out === 'recovered' && calls.length === 3, `calls=${calls.length}`);

reset();
responder = () => ({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-retry-key-000' } } });
try { await chat({ system: 'S', user: 'U' }); check('401 throws', false); }
catch (e) {
  // A 401 is never retried against the SAME config. It may be retried once
  // against the fallback config, which is the managed-key feature.
  const openaiCalls = calls.filter((c) => c.url.includes('api.openai.com'));
  check('401 not retried against the same config', openaiCalls.length === 1, `openai calls=${openaiCalls.length}`);
  check('401 message is actionable', /key was rejected/i.test(e.message), e.message);
  check('key redacted from error', !e.message.includes('sk-retry-key-000'), e.message);
}

reset();
responder = () => ({ status: 404, body: { error: { message: 'model not found' } } });
try { await chat({ system: 'S', user: 'U' }); check('404 throws', false); }
catch (e) { check('404 names host + model hint', /api\.openai\.com/.test(e.message) && /model ID/.test(e.message), e.message); }

// ── listModels ──────────────────────────────────────────────────────────────
console.log('\n[listModels]');
reset();
responder = () => ({ status: 200, body: { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] } });
const models = await listModels();
check('GET /models', calls[0].url === 'https://api.openai.com/v1/models' && calls[0].method === 'GET');
check('deduped and sorted', JSON.stringify(models) === JSON.stringify(['gpt-a', 'gpt-b']), JSON.stringify(models));

// ── testConnection ──────────────────────────────────────────────────────────
console.log('\n[testConnection]');
reset();
responder = () => ({ status: 200, body: { choices: [{ message: { content: 'OK' } }] } });
let probe = await testConnection();
check('ok true on 200', probe.ok === true);
check('probe caps max_tokens at 16', calls[0].body.max_tokens === 16, JSON.stringify(calls[0].body));
reset();
responder = () => ({ status: 401, body: { error: { message: 'bad key' } } });
probe = await testConnection();
check('ok false on 401', probe.ok === false && /key was rejected/i.test(probe.detail), probe.detail);


// ── No key ships with the extension ───────────────────────────────────────
console.log('\n[no bundled key]');
const { getLlmConfig: readConfig } = await import(`${ROOT}/utils/llm.js`);

store = {}; reset();
let cfg = await readConfig();
check('a fresh install has no key and falls back to the on-device model',
      cfg.provider === 'builtin' && cfg.apiKey === '' && cfg.source === 'default',
      JSON.stringify({ p: cfg.provider, s: cfg.source, hasKey: Boolean(cfg.apiKey) }));

await setLlmConfig({ provider: 'openai' });
await setLlmConfig({ apiKey: 'sk-user-key-999999' });
cfg = await readConfig();
check("the user's own settings are used once set",
      cfg.provider === 'openai' && cfg.source === 'user' && cfg.apiKey === 'sk-user-key-999999',
      cfg.source);

// The extension must never quietly re-send a transcript to a second vendor.
reset();
responder = () => ({ status: 401, body: { error: { message: 'bad user key' } } });
try {
  await chat({ system: 'S', user: 'U' });
  check('a rejected user key surfaces as an error', false);
} catch (e) {
  check('a rejected user key surfaces as an error', /401/.test(e.message), e.message);
  check('the transcript is not re-sent to another provider', calls.length === 1, `calls=${calls.length}`);
  check('the error names the provider the user chose',
        /OpenAI/i.test(e.message) && !/NVIDIA/i.test(e.message), e.message);
}

reset();
responder = () => ({ status: 401, body: { error: { message: 'bad' } } });
const explicit = { ...(await readConfig()), provider: 'openai', format: 'openai',
                   baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-explicit-000000' };
try { await chat({ system: 'S', user: 'U', config: explicit }); check('explicit config throws', false); }
catch { check('an explicitly passed config never falls back', calls.length === 1, `calls=${calls.length}`); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
