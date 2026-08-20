import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let store = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
  set: async (o) => Object.assign(store, o),
} } };
globalThis.performance = globalThis.performance || { now: () => 0 };

let calls = [];
globalThis.fetch = async (url, options = {}) => {
  const body = JSON.parse(options.body);
  calls.push(body);
  const user = body.messages.find((m) => m.role === 'user').content;
  return { ok: true, status: 200, url, headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ message: { content: `notes-for(${user.length}ch)` } }] }) };
};

const { setLlmConfig } = await import(`${ROOT}/utils/llm.js`);
const { generateAiNotes, formatTranscript, checkAiAvailability } = await import(`${ROOT}/utils/ai.js`);
const { renderMarkdown } = await import(`${ROOT}/utils/markdown.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

await setLlmConfig({ provider: 'openai' });
await setLlmConfig({ apiKey: 'sk-x-0000000000' });

// ── formatTranscript ────────────────────────────────────────────────────────
console.log('\n[formatTranscript]');
const segs = [
  { start: 5,    end: 8,    speaker: 'Me',     text: '  Hello everyone  ' },
  { start: 65,   end: 70,   speaker: 'Others', text: 'Hi there' },
  { start: 3725, end: 3730, speaker: 'Others', text: '' },
  { start: 3800, end: 3805, speaker: 'Others', text: 'Last point' },
];
let text = formatTranscript(segs, { speakerNames: { Others: 'Priya' } });
check('mm:ss under an hour', text.includes('[00:05] Me: Hello everyone'), text.split('\n')[0]);
check('minute rollover', text.includes('[01:05] Priya: Hi there'));
check('h:mm:ss past an hour', text.includes('[1:03:20] Priya: Last point'), text);
check('custom speaker name applied', !text.includes('Others'));
check('empty segments dropped', text.split('\n').length === 3, String(text.split('\n').length));

// ── single-pass path ────────────────────────────────────────────────────────
console.log('\n[short transcript: one call]');
calls = [];
let notes = await generateAiNotes(segs, {});
check('one provider call', calls.length === 1, `calls=${calls.length}`);
check('single-pass system prompt', calls[0].messages[0].content.includes('Executive Summary'));
check('returns model text', notes.startsWith('notes-for('), notes);

// ── map-reduce path ─────────────────────────────────────────────────────────
console.log('\n[long transcript: map-reduce]');
calls = [];
const line = 'x'.repeat(300);
const longSegs = Array.from({ length: 700 }, (_, i) =>
  ({ start: i * 5, end: i * 5 + 4, speaker: i % 2 ? 'Me' : 'Others', text: line }));
const fullLen = formatTranscript(longSegs, {}).length;
const progress = [];
notes = await generateAiNotes(longSegs, {}, { onProgress: (s, p) => progress.push([s, p]) });
const expectedSlices = calls.length - 1;
check(`transcript is ${fullLen} chars, split into ${expectedSlices} slices + 1 reduce`, calls.length > 2, `calls=${calls.length}`);
check('every map call is within budget', calls.slice(0, -1).every((c) => c.messages[1].content.length <= 48_000 + 200),
      String(Math.max(...calls.slice(0, -1).map((c) => c.messages[1].content.length))));
check('map calls use the part prompt', calls[0].messages[0].content.includes('ONE PART'));
check('final call is the reduce prompt', calls.at(-1).messages[0].content.includes('Merge them'));
check('no transcript content is dropped',
      calls.slice(0, -1).reduce((n, c) => n + c.messages[1].content.length, 0) >= fullLen,
      `sum=${calls.slice(0, -1).reduce((n, c) => n + c.messages[1].content.length, 0)} full=${fullLen}`);
check('progress reported per part', progress.some(([s]) => /part 1 of/i.test(s)) && progress.some(([s]) => /Merging/.test(s)));
check('progress ends at 1', progress.at(-1)[1] === 1);

// ── guards ──────────────────────────────────────────────────────────────────
console.log('\n[guards]');
try { await generateAiNotes([], {}); check('empty transcript throws', false); }
catch (e) { check('empty transcript throws', /no transcript/i.test(e.message), e.message); }

const ac = new AbortController();
calls = [];
const run = generateAiNotes(longSegs, {}, { signal: ac.signal, onProgress: () => ac.abort() });
try { await run; check('abort stops the run', false); }
catch (e) { check('abort stops the run', e.name === 'AbortError', `${e.name}: ${e.message}`); }

// ── availability reporting ──────────────────────────────────────────────────
console.log('\n[availability]');
let avail = await checkAiAvailability();
check('byok reported ready', avail.ready === true && avail.engine === 'byok', JSON.stringify(avail));
check('label names provider + model', avail.label.includes('OpenAI') && avail.label.includes('gpt-4.1-mini'), avail.label);
store = {};
avail = await checkAiAvailability();
// No key ships with the extension, so a fresh install falls back to Chrome's
// on-device model — which does not exist in Node, hence not ready. The panel
// turns this into "open Settings and add a key".
check('a fresh install reports not ready and says why',
      avail.ready === false && avail.engine === 'builtin' && /Settings/.test(avail.detail),
      JSON.stringify(avail));

// ── markdown renderer ───────────────────────────────────────────────────────
console.log('\n[markdown]');
const md = renderMarkdown('## Summary\n\n- **Bold** and *it* and `x`\n- second\n\n1. one\n\nPlain line.');
check('heading', md.includes('<h4>Summary</h4>'), md);
check('bullets in a ul', md.includes('<ul><li><strong>Bold</strong> and <em>it</em> and <code>x</code></li><li>second</li></ul>'), md);
check('ordered list', md.includes('<ol><li>one</li></ol>'), md);
check('paragraph', md.includes('<p>Plain line.</p>'));

const evil = renderMarkdown('<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n[link](javascript:alert(3))');
check('no live img tag', !/<img/i.test(evil), evil);
check('no script tag', !/<script/i.test(evil), evil);
check('no anchor from markdown link', !/<a /i.test(evil), evil);
check('markup shown as text', evil.includes('&lt;script&gt;'), evil);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
