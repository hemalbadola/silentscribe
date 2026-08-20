// Checks explainError against the exact messages this app actually produces.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const { explainError } = await import(`${ROOT}/utils/diagnostics.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

// The message the user actually reported, verbatim.
const REAL = "Transcription worker crashed: Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'blob:chrome-extension://enicjagndheadibgocnngkhmhhkdoeel/c0a584af-b9ec-4b48-a0ab-9101115c3ffa' failed to load.";

console.log('\n[the reported error]');
let e = explainError(REAL);
check('recognised', e.known === true, JSON.stringify(e.title));
check('names the real cause', /blob|content security policy/i.test(e.cause), e.cause);
check('gives a concrete action', /reload the extension/i.test(e.action), e.action);
check('does not say "retry"', !/^retry/i.test(e.action) && !/try again/i.test(e.action), e.action);
check('keeps the raw text for reporting', e.raw === REAL);

console.log('\n[other real signatures]');
const cases = [
  ['Transcription library not found. Please install it by running: npm install', 'library is missing'],
  ['Failed to load Whisper model: fetch failed',                                 'could not be downloaded'],
  ['OpenAI returned 401. The key was rejected.',                                 'key was rejected'],
  ['Groq returned 429. Rate limit or quota exceeded.',                           'rate limiting'],
  ['NVIDIA NIM returned 404. No such endpoint or model at integrate.api.nvidia.com.', 'does not exist'],
  ['Could not reach api.openai.com. Check the base URL',                         'could not be reached'],
  ['No audio was found for this recording.',                                     'no audio'],
  ['Extension has not been invoked for the current page',                        'tab capture'],
  ['QuotaExceededError: write failed',                                           'Storage'],
  ['Anthropic returned 429. Rate limit or quota exceeded.',                      'rate limiting'],
  ['OpenRouter returned 429. quota exceeded for this key',                       'rate limiting'],
];
for (const [raw, expect] of cases) {
  const r = explainError(raw);
  check(`"${raw.slice(0, 42)}..." -> ${r.title}`,
        r.known && r.title.toLowerCase().includes(expect.toLowerCase().split(' ')[0]),
        `got "${r.title}"`);
}

console.log('\n[unknown errors are not flattened]');
e = explainError('Some brand new failure nobody predicted');
check('marked unknown', e.known === false);
check('keeps the exact message as the cause', e.cause === 'Some brand new failure nobody predicted', e.cause);
check('still gives a next step', /diagnostics/i.test(e.action), e.action);

console.log('\n[degenerate input]');
for (const [label, input] of [['null', null], ['undefined', undefined], ['empty string', ''], ['a number', 42], ['an Error', new Error('boom')]]) {
  const r = explainError(input);
  check(`${label} does not throw and yields a title`, typeof r.title === 'string' && r.title.length > 0);
}

// An internal fault must say so. The user who hit "Cannot read properties of
// undefined (reading 'local')" got "Something went wrong" and a Try Again
// button, which told them nothing and could not help.
console.log('\n[a bug in our own code says so]');
for (const raw of [
  "Cannot read properties of undefined (reading 'local')",
  'Capture start failed: TypeError: Cannot read properties of undefined',
  'startLivePreview is not a function',
  'WHISPER_CONFIG is not defined',
]) {
  const r = explainError(raw);
  check(`recognised: ${raw.slice(0, 40)}`, r.known === true, r.title);
  check('  and names SilentScribe as the cause', /SilentScribe/.test(r.title), r.title);
  check('  and gives something to do', /reload|issue/i.test(r.action), r.action);
}

// The generic signature is last on purpose and must never steal a specific one.
console.log('\n[it does not swallow specific errors]');
for (const [raw, expected] of [
  ['429 rate limit', /rate limiting/],
  ['Failed to fetch', /could not be reached/],
  ['QuotaExceededError: storage quota', /Storage is full/],
  ['NotAllowedError: Permission denied', /Microphone/],
  ['401 Incorrect API key', /key was rejected/],
]) {
  check(`still classified correctly: ${raw.slice(0, 30)}`, expected.test(explainError(raw).title), explainError(raw).title);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
