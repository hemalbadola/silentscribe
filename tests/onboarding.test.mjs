// Drives the real onboarding module through a DOM stub.
//
// The bug this exists to catch: the tour rendered correctly and its last
// button called nothing that moved the app on, so "Start using SilentScribe"
// looked dead. Finishing must always reach onComplete, by every route.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {};
    this._text = ''; this.className = ''; this.listeners = {}; this.hidden = false;
    // Real elements always have these. Without them the shortcut step threw and
    // rendered its fallback, so the test passed while skipping the card.
    this.dataset = {}; this.style = {};
  }
  append(...kids) { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids) { this.children = kids.filter(Boolean); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  get text() { return [this._text, ...this.children.map((c) => c.text)].join(' ').trim(); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
  // Real elements expose these, and the modules under test use them. Leaving
  // them out made product code throw and the tour silently show a fallback.
  get firstChild() { return this.children[0]; }
  get firstElementChild() { return this.children[0]; }
  get childNodes() { return this.children; }
  get parentElement() { return this._parent || null; }
  click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); }
}

globalThis.document = { createElement: (t) => new Node(t), addEventListener() {}, visibilityState: 'visible' };
globalThis.window = { addEventListener() {} };

let store = {};
let micState = 'prompt';
let shortcut = 'Alt+Shift+R';
let storageThrows = false;

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({
    platform: 'MacIntel',
    userAgentData: undefined,
    permissions: { query: async () => ({ state: micState }) },
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  }),
});

globalThis.chrome = {
  storage: { local: {
    get: async (k) => { if (storageThrows) throw new Error('storage down'); return { [k]: store[k] }; },
    set: async (o) => { if (storageThrows) throw new Error('storage down'); Object.assign(store, o); },
    remove: async (k) => { if (storageThrows) throw new Error('storage down'); delete store[k]; },
  } },
  commands: { getAll: async () => [{ name: 'toggle-recording', shortcut }] },
  runtime: { getManifest: () => JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')), sendMessage: async () => {} },
  tabs: { create: async () => {} },
};

const { renderOnboarding, isOnboardingComplete, resetOnboarding } =
  await import(`${ROOT}/sidepanel/onboarding.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };
// The shortcut card is filled in by a fire-and-forget async call, so a single
// microtask tick is not enough to see it.
const settle = (ticks = 4) => new Promise((r) => {
  let n = ticks;
  const step = () => (n-- > 0 ? setTimeout(step, 0) : r());
  step();
});

const buttons = (c) => c.all((n) => n.tagName === 'button');

// The forward button lives in the nav row. Searching the whole tree would pick
// up a step's own buttons — the shortcut card contributes "Change shortcut".
const forward = (c) => {
  const nav = c.all((n) => n.className === 'onboarding-nav')[0];
  return nav ? buttons(nav).find((b) => b.textContent !== 'Back') : undefined;
};
const byLabel = (c, label) => buttons(c).find((b) => b.textContent === label);
const progress = (c) => (c.all((n) => n.className === 'onboarding-progress')[0] || {}).textContent || '';

// ── The reported failure ────────────────────────────────────────────────────
console.log('\n[finishing the tour]');
store = {}; micState = 'prompt';
let container = new Node('div');
let completed = 0;
await renderOnboarding(container, { onComplete: () => { completed++; } });

const total = Number(progress(container).match(/of (\d+)/)?.[1] || 0);
check('the tour reports a step count', total >= 3, progress(container));

// Walk to the last step using whatever the forward button is called.
for (let i = 0; i < total - 1; i++) {
  forward(container).click();
  await settle();
}
check('reached the last step', progress(container) === `Step ${total} of ${total}`, progress(container));

const finishButton = forward(container);
check('the last step offers "Start using SilentScribe"',
      finishButton?.textContent === 'Start using SilentScribe',
      buttons(container).map((b) => b.textContent).join(' | '));

// The shortcut step must show the real card, not the "could not be checked"
// fallback. Rendering the fallback is how this test used to pass by accident.
store = {}; micState = 'prompt';
const shortcutProbe = new Node('div');
await renderOnboarding(shortcutProbe, { onComplete: () => {} });
let sawShortcutCard = false;
for (let i = 0; i < total; i++) {
  await settle();
  if (shortcutProbe.all((n) => n.className === 'shortcut-combo').length) {
    sawShortcutCard = true;
    break;
  }
  const next = forward(shortcutProbe);
  if (!next) break;
  next.click();
}
check('the shortcut step renders the real card, not the fallback', sawShortcutCard,
      shortcutProbe.text.slice(0, 120));

finishButton.click();
await settle();
check('clicking it calls onComplete', completed === 1, `completed=${completed}`);
check('and records that onboarding is done', await isOnboardingComplete() === true);

// ── Skip is the other way out ───────────────────────────────────────────────
console.log('\n[skipping]');
store = {}; completed = 0;
container = new Node('div');
await renderOnboarding(container, { onComplete: () => { completed++; } });
byLabel(container, 'Skip setup').click();
await settle();
check('skip calls onComplete', completed === 1, `completed=${completed}`);
check('skip records completion', await isOnboardingComplete() === true);

// ── Navigation ──────────────────────────────────────────────────────────────
console.log('\n[navigation]');
store = {}; container = new Node('div');
await renderOnboarding(container, { onComplete: () => {} });
check('no Back on the first step', !byLabel(container, 'Back'));
forward(container).click();
await settle();
check('Back appears after moving forward', Boolean(byLabel(container, 'Back')));
byLabel(container, 'Back').click();
await settle();
check('Back returns to step 1', progress(container).startsWith('Step 1'), progress(container));

// ── The step count adapts ───────────────────────────────────────────────────
console.log('\n[granted microphone drops its step]');
store = {}; micState = 'granted';
const granted = new Node('div');
await renderOnboarding(granted, { onComplete: () => {} });
check('one fewer step when the microphone is already allowed',
      Number(progress(granted).match(/of (\d+)/)?.[1]) === total - 1, progress(granted));

// ── Degradation ─────────────────────────────────────────────────────────────
console.log('\n[degradation]');
store = {}; micState = 'prompt';
const savedCommands = chrome.commands.getAll;
chrome.commands.getAll = async () => { throw new Error('commands unavailable'); };
const degraded = new Node('div');
await renderOnboarding(degraded, { onComplete: () => {} });
check('a failing chrome.commands still renders the tour', degraded.children.length === 1);
chrome.commands.getAll = savedCommands;

check('a null container does not throw', await renderOnboarding(null, {}) === undefined);

storageThrows = true;
check('unreadable storage does not trap the user in the tour',
      await isOnboardingComplete() === true);
storageThrows = false;

store = {}; await resetOnboarding();
check('reset clears the flag', await isOnboardingComplete() === false);

// ── The panel must actually advance ─────────────────────────────────────────
// A source-level assertion, because the failure was not in this module at all:
// the tour finished correctly and the panel simply never told the service
// worker, so the view never changed.
console.log('\n[panel wiring]');
const panel = readFileSync(join(ROOT, 'sidepanel/panel.js'), 'utf8');
const handler = panel.slice(panel.indexOf('async function finishOnboarding'));
check('panel.js has a finishOnboarding handler', handler.length > 0);
check('it is passed to renderOnboarding',
      /renderOnboarding\([^)]*onComplete:\s*finishOnboarding/.test(panel));
check('it sends UI_ONBOARDING_COMPLETE',
      handler.slice(0, 1200).includes('MSG.UI_ONBOARDING_COMPLETE'));
check('it sets the microphone state first',
      handler.indexOf('UI_TOGGLE_MIC') < handler.indexOf('UI_ONBOARDING_COMPLETE'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
