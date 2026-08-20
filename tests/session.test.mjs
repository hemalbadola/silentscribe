// Drives the real storage layer against an in-memory IndexedDB.
//
// The bugs this exists to catch, all reported as "it does not show my past
// recordings properly":
//   - getSessions() returned raw records while getSession() normalized them, so
//     a recording looked right when opened and wrong in the list it came from.
//   - createSession() writes platform and title under metadata, but every
//     reader asks for them flat, so cards showed "Unknown" and a generic title.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── A small IndexedDB that behaves the way db.js uses one ───────────────────

const later = (fn) => setTimeout(fn, 0);

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; }
  succeed(value) { this.result = value; later(() => this.onsuccess?.({ target: this })); return this; }
}

class FakeIndex {
  constructor(store, keyPath) { this.store = store; this.keyPath = keyPath; }
  openCursor(range, direction) {
    const req = new FakeRequest();
    // Records with no value for the indexed key are absent from a real index.
    const rows = [...this.store.data.values()]
      .filter((r) => r[this.keyPath] !== undefined && r[this.keyPath] !== null)
      .sort((a, b) => (a[this.keyPath] - b[this.keyPath]) * (direction === 'prev' ? -1 : 1));

    let i = 0;
    const step = () => {
      if (i >= rows.length) { req.result = null; later(() => req.onsuccess?.({ target: req })); return; }
      const value = rows[i++];
      req.result = { value, continue: step };
      later(() => req.onsuccess?.({ target: req }));
    };
    later(step);
    return req;
  }
}

class FakeStore {
  constructor(name) { this.name = name; this.data = new Map(); this.indexes = new Map(); }
  createIndex(name, keyPath) { this.indexes.set(name, keyPath); return new FakeIndex(this, keyPath); }
  index(name) { return new FakeIndex(this, this.indexes.get(name)); }
  // Structured clone, like the real thing: callers must not keep a live handle.
  put(record) { this.data.set(record.id, JSON.parse(JSON.stringify(record))); return new FakeRequest().succeed(record.id); }
  get(id) { const r = this.data.get(id); return new FakeRequest().succeed(r ? JSON.parse(JSON.stringify(r)) : undefined); }
  delete(id) { this.data.delete(id); return new FakeRequest().succeed(undefined); }
}

class FakeDB {
  constructor() { this.stores = new Map(); }
  get objectStoreNames() { const s = this.stores; return { contains: (n) => s.has(n) }; }
  createObjectStore(name) { const store = new FakeStore(name); this.stores.set(name, store); return store; }
  transaction(name) { return { objectStore: (n) => this.stores.get(n) }; }
}

const db = new FakeDB();
globalThis.indexedDB = {
  open() {
    const req = new FakeRequest();
    later(() => {
      req.result = db;
      req.onupgradeneeded?.({ target: { result: db } });
      req.onsuccess?.({ target: req });
    });
    return req;
  },
};
// Node already provides crypto; only fill the gap if it is missing.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => `id-${Math.random()}` } });
}

const {
  createSession, getSession, getSessions, finalizeSession,
  updateSessionPlatform, updateSessionMeetingTitle,
} = await import(`${ROOT}/storage/db.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

// ── The reported symptom ────────────────────────────────────────────────────
console.log('\n[a recording made the ordinary way]');
const id = await createSession({ platform: 'google-meet', micEnabled: true, meetingTitle: 'Standup' });

const opened = await getSession(id);
check('opened directly, it knows its platform', opened.platform === 'google-meet', String(opened.platform));
check('opened directly, it knows its title', opened.meetingTitle === 'Standup', String(opened.meetingTitle));

const [listed] = await getSessions(10);
check('the list returns it', Boolean(listed), 'list was empty');
check('and the list agrees about the platform', listed?.platform === 'google-meet', String(listed?.platform));
check('and the list agrees about the title', listed?.meetingTitle === 'Standup', String(listed?.meetingTitle));
check('the list and the opened record agree',
      listed?.platform === opened.platform && listed?.meetingTitle === opened.meetingTitle);

check('an untranscribed recording says so explicitly', listed?.transcribed === false, String(listed?.transcribed));

// ── Duration ────────────────────────────────────────────────────────────────
console.log('\n[duration]');
check('a recording that never finished has no duration', listed?.duration == null, String(listed?.duration));
await finalizeSession(id);
const done = await getSession(id);
check('finalizing sets a duration', Number.isFinite(done.duration), String(done.duration));
check('and it is in milliseconds, as the formatter expects',
      done.duration >= 0 && done.duration < 60_000, String(done.duration));

// ── The writers must not split the two copies apart ─────────────────────────
console.log('\n[renaming keeps both copies in step]');
await updateSessionPlatform(id, 'zoom');
await updateSessionMeetingTitle(id, 'Budget review');
const renamed = await getSession(id);
check('the flat platform updated', renamed.platform === 'zoom', String(renamed.platform));
check('the nested platform updated too', renamed.metadata?.platform === 'zoom', String(renamed.metadata?.platform));
check('the flat title updated', renamed.meetingTitle === 'Budget review', String(renamed.meetingTitle));
check('the nested title updated too', renamed.metadata?.meetingTitle === 'Budget review', String(renamed.metadata?.meetingTitle));

const [relisted] = await getSessions(10);
check('and the list shows the new name', relisted?.meetingTitle === 'Budget review', String(relisted?.meetingTitle));

// ── Ordering and old records ────────────────────────────────────────────────
console.log('\n[ordering and older records]');
const second = await createSession({ platform: 'zoom' });
const all = await getSessions(10);
check('newest first', all[0].id === second, `${all[0].id} vs ${second}`);
check('both recordings are listed', all.length === 2, `got ${all.length}`);

// A record written before the nested shape existed must still list.
db.stores.get('sessions').data.set('legacy', {
  id: 'legacy', startTime: 1, platform: 'teams', meetingTitle: 'Old one',
  duration: 5000, transcribed: true, bookmarks: [null, { time: 1200 }],
});
const withLegacy = await getSessions(10);
const legacy = withLegacy.find((s) => s.id === 'legacy');
check('an older flat record still lists', Boolean(legacy));
check('its platform survives', legacy?.platform === 'teams', String(legacy?.platform));
check('a null bookmark does not break it', Array.isArray(legacy?.bookmarks) && legacy.bookmarks.length === 1,
      JSON.stringify(legacy?.bookmarks));
check('and its bookmark time is migrated', legacy?.bookmarks?.[0]?.timeMs === 1200, JSON.stringify(legacy?.bookmarks));

// ── The shortcut and the panel must be able to leave COMPLETE ───────────────
// Source-level, because both live in contexts this suite cannot boot. The two
// symptoms — "opens my last recording" and "the shortcut stopped working" —
// were the same dead end.
console.log('\n[nothing gets stuck in COMPLETE]');
const sw = readFileSync(join(ROOT, 'background/service-worker.js'), 'utf8');
const hotkey = sw.slice(sw.indexOf('commands.onCommand'), sw.indexOf('commands.onCommand') + 1800);
check('the hotkey leaves COMPLETE', /STATES\.COMPLETE/.test(hotkey), 'COMPLETE not handled');
check('the hotkey still leaves ERROR', /STATES\.ERROR/.test(hotkey));
check('a refused press is not silent', /flashBadge/.test(hotkey));

const panel = readFileSync(join(ROOT, 'sidepanel/panel.js'), 'utf8');
const init = panel.slice(panel.indexOf('async function initialize'), panel.indexOf('async function initialize') + 2500);
check('opening the panel does not restore COMPLETE', /STATES\.COMPLETE/.test(init) && /view-ready/.test(init));
check('and it loads the recordings list instead', /loadSessionList\(\)/.test(init));

// ── There must be a way to start a recording ────────────────────────────────
// The Record button was deleted with the note "no longer used by the UI". It
// was the only button that started a recording, so the keyboard shortcut became
// the sole way in — and that shortcut is unbound on any machine where another
// extension claimed the keys. Those users had an extension that did nothing.
console.log('\n[the extension can be started]');
const html = readFileSync(join(ROOT, 'sidepanel/panel.html'), 'utf8');
check('the ready view has a record button', /id="btn-record"/.test(html));
check('it sits in the ready view, above the recordings list',
      html.indexOf('id="btn-record"') > html.indexOf('id="view-ready"') &&
      html.indexOf('id="btn-record"') < html.indexOf('id="session-list"'));
check('the panel sends UI_START_RECORDING', /MSG\.UI_START_RECORDING\b/.test(panel));
check('and a click is wired to it',
      /btnRecord\??\.addEventListener\(\s*'click'/.test(panel), 'no click listener');
check('the handler reads the microphone toggle', /function handleStartRecording[\s\S]{0,400}toggleMic/.test(panel));

// ── The panel must not render every broadcast twice ─────────────────────────
console.log('\n[one subscription, not two]');
check('the panel does not also subscribe via onStateChange',
      !/^\s*onStateChange\(/m.test(panel), 'still subscribing twice');
check('a metadata-only broadcast does not re-render',
      /renderedState/.test(panel), 'no guard against repeat renders');

// ── Starting a second recording must be legal ───────────────────────────────
// Only READY may become RECORDING, and every finished recording leaves the
// extension in COMPLETE. Without normalising first, the second recording of a
// session threw "Invalid state transition: COMPLETE -> RECORDING" — dead button
// and dead shortcut after a single use.
console.log('\n[a second recording]');
const start = sw.slice(sw.indexOf('async function handleStartRecording('));
check('handleStartRecording normalises COMPLETE before recording',
      /COMPLETE[\s\S]{0,200}setState\(STATES\.READY\)/.test(start.slice(0, 1200)), 'no normalisation');
check('and normalises ERROR too', /STATES\.ERROR[\s\S]{0,200}setState\(STATES\.READY\)/.test(start.slice(0, 1200)));

// ── A failed start must never be silent ─────────────────────────────────────
console.log('\n[failed starts are reported]');
const startCatch = start.slice(start.indexOf('} catch'), start.indexOf('} catch') + 1400);
check('a failed start always sets ERROR', /setState\(STATES\.ERROR/.test(startCatch));
check('with no exception for the activeTab error',
      !/panelWillRetry/.test(startCatch), 'the swallow is back');
check('and it removes the empty session record', /deleteSession/.test(startCatch));

// ── A stop that could not save must not report success ──────────────────────
console.log('\n[a failed save is not hidden]');
const stop = sw.slice(sw.indexOf('async function handleStopRecording('));
check('the stop response is checked, not discarded',
      /stopResponse[\s\S]{0,300}success === false/.test(stop.slice(0, 2500)), 'response ignored');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
