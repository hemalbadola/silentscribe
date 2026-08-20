// Independent check of sidepanel/shortcut-setup.js against a minimal DOM stub.
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_manifest = fs.readFileSync(`${ROOT}/manifest.json`, 'utf8');

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this._text = ''; this.className = ''; this.dataset = {}; this.listeners = {}; }
  append(...kids) { this.children.push(...kids); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  replaceChildren(...kids) { this.children = kids; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  get firstChild() { return this.children[0]; }
  get text() { return [this._text, ...this.children.map((c) => c.text)].join(' ').trim(); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const r = c.find(pred); if (r) return r; } return null; }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
}
globalThis.document = { createElement: (t) => new Node(t), addEventListener: () => {}, visibilityState: 'visible' };
globalThis.window = { addEventListener: () => {} };

let shortcut = '', platform = 'Windows', commandsThrows = false, opened = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({ get platform() { return platform; }, userAgentData: undefined }),
});
globalThis.chrome = {
  commands: { getAll: async () => { if (commandsThrows) throw new Error('unavailable'); return [{ name: 'toggle-recording', shortcut }]; } },
  runtime: { getManifest: () => JSON.parse(require_manifest) },
  tabs: { create: async (o) => { opened.push(o.url); } },
};

const { initShortcutSetup } = await import(`${ROOT}/sidepanel/shortcut-setup.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };
const run = async () => { const c = new Node('div'); await initShortcutSetup(c); return c.children[0]; };
const keys = (card) => card.all((n) => n.tagName === 'kbd').map((n) => n.textContent);

console.log('\n[bound — Windows word form]');
shortcut = 'Alt+Shift+R'; platform = 'Win32';
let card = await run();
check('one kbd per key', JSON.stringify(keys(card)) === '["Alt","Shift","R"]', JSON.stringify(keys(card)));
check('not the alert card', !card.className.includes('shortcut-card-alert'), card.className);
check('offers a change affordance', !!card.find((n) => n.textContent === 'Change shortcut'));

console.log('\n[bound — macOS glyph run, no separator]');
shortcut = '⌥⇧R'; platform = 'MacIntel';
card = await run();
check('glyph run split per key', JSON.stringify(keys(card)) === '["⌥","⇧","R"]', JSON.stringify(keys(card)));

console.log('\n[bound — macOS but Chrome reports words]');
shortcut = 'Alt+Shift+R'; platform = 'MacIntel';
card = await run();
check('words mapped to mac glyphs', JSON.stringify(keys(card)) === '["⌥","⇧","R"]', JSON.stringify(keys(card)));

console.log('\n[unbound]');
shortcut = ''; platform = 'Win32';
card = await run();
// Not an alert: with no suggested key in the manifest, having no shortcut is
// the normal starting state, and the panel has a Start Recording button.
check('is not styled as a failure', !card.className.includes('shortcut-card-alert'), card.className);
check('explains that no combination is claimed',
      /claims no combination/.test(card.text), card.text.slice(0, 160));
check('warns that a browser-owned combination will not stick',
      /will not stick/.test(card.text), card.text.slice(0, 200));
check('gives numbered steps', card.all((n) => n.tagName === 'li').length === 4);
check('uses the manifest description', card.text.includes('Start or stop recording the current meeting'));
const openBtn = card.find((n) => n.textContent === 'Open shortcut settings');
check('has the open button', !!openBtn);
opened = []; openBtn.listeners.click[0](); await new Promise((r) => setTimeout(r, 10));
check('button opens chrome://extensions/shortcuts', opened[0] === 'chrome://extensions/shortcuts', JSON.stringify(opened));

console.log('\n[degradation]');
commandsThrows = true;
card = await run();
check('does not throw when chrome.commands fails', !!card);
check('falls back to static instructions', card.text.includes('did not report'), card.text.slice(0, 120));
commandsThrows = false;

check('null container does not throw', await initShortcutSetup(null) === undefined);

console.log('\n[idempotence]');
shortcut = 'Alt+Shift+R';
const c2 = new Node('div');
await initShortcutSetup(c2); await initShortcutSetup(c2);
check('double init renders exactly one card', c2.children.length === 1, String(c2.children.length));

// ── The manifest must not suggest a key ─────────────────────────────────────
// Alt+Shift+R is owned by browsers (it opened reading mode on two different
// machines). A suggested key the browser owns cannot be granted, and re-adding
// one brings back the shortcut that silently clears itself on every reload.
console.log('\n[the manifest suggests nothing]');
const command = JSON.parse(require_manifest).commands?.['toggle-recording'];
check('the toggle-recording command still exists', Boolean(command));
check('and suggests no key', command && !('suggested_key' in command),
      JSON.stringify(command));
check('but still describes itself for the shortcuts page',
      Boolean(command?.description), JSON.stringify(command));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
