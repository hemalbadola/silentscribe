// Drives the real offscreen document in the environment Chrome actually gives
// it: `chrome.runtime` and nothing else.
//
// The bug this exists to catch: startCapture() called chrome.storage.local.get()
// on its first line of live-preview setup. `chrome.storage` is undefined in an
// offscreen document, so every recording died with "Cannot read properties of
// undefined (reading 'local')" before a single sample was written, and the panel
// showed "Something went wrong".
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };
const settle = (ticks = 6) => new Promise((r) => {
  let n = ticks;
  const step = () => (n-- > 0 ? setTimeout(step, 0) : r());
  step();
});

// ── The environment an offscreen document really has ────────────────────────

// Every acquired resource is registered, so a leak after a failed start is
// observable rather than a matter of opinion.
let liveTracks = [];
let openWritables = [];
const track = () => {
  const t = { live: true, kind: 'audio', stop() { t.live = false; } };
  liveTracks.push(t);
  return t;
};
const stream = () => {
  const tracks = [track()];
  return { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => tracks };
};

class FakeNode {
  connect() { return this; }
  disconnect() {}
}
class FakeAnalyser extends FakeNode {
  constructor() { super(); this.fftSize = 0; this.frequencyBinCount = 128; }
  getByteFrequencyData(a) { a.fill(0); }
}

let scriptProcessorsCreated = 0;
class FakeAudioContext {
  constructor(opts) { this.sampleRate = opts?.sampleRate || 48000; this.state = 'running'; this.destination = new FakeNode(); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource() { return new FakeNode(); }
  createMediaStreamDestination() { return { stream: stream() }; }
  createAnalyser() { return new FakeAnalyser(); }
  createScriptProcessor() { scriptProcessorsCreated++; return new FakeNode(); }
  decodeAudioData() { return { getChannelData: () => new Float32Array(16000) }; }
}

let recorders = [];
class FakeMediaRecorder {
  constructor(s, opts) { this.stream = s; this.mimeType = opts?.mimeType; this.state = 'inactive'; recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
}

let workersCreated = 0;
class FakeWorker {
  constructor(url) { this.url = String(url); workersCreated++; this.posted = []; }
  postMessage(m) { this.posted.push(m); }
  terminate() {}
}

const writes = [];
globalThis.AudioContext = FakeAudioContext;
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.Worker = FakeWorker;
globalThis.MediaStream = class { constructor() { this.tracks = []; } addTrack(t) { this.tracks.push(t); } };
globalThis.performance = globalThis.performance || { now: () => 0 };

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({
    mediaDevices: { getUserMedia: async () => stream() },
    storage: {
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => {
            const w = { open: true, write: async (d) => { writes.push(d); }, close: async () => { w.open = false; } };
            openWritables.push(w);
            return w;
          },
        }),
      }),
    },
  }),
});

// ── chrome, exactly as an offscreen document receives it ────────────────────
// chrome.storage is ABSENT on purpose. Touching it must throw, so that any
// regression fails this suite instead of shipping.

let storageBacking = {};
let settingsRequests = 0;
let swAnswers = true;
const sentToSw = [];
let listener = null;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    connect: () => ({ onDisconnect: { addListener() {} }, postMessage() {} }),
    getURL: (p) => `chrome-extension://test/${p}`,
    async sendMessage(msg) {
      sentToSw.push(msg);
      // Stand in for the service worker, which is the only context that can
      // reach storage.
      if (msg?.type === 'OFFSCREEN_GET_SETTINGS') {
        settingsRequests++;
        if (!swAnswers) return undefined;
        return {
          liveTranscript: Boolean(storageBacking.liveTranscript),
          modelSize: storageBacking.modelSize || 'Xenova/whisper-base',
        };
      }
      return undefined;
    },
  },
};

const source = readFileSync(join(ROOT, 'offscreen/offscreen.js'), 'utf8');
await import(`${ROOT}/offscreen/offscreen.js`);

const startCapture = (payload) => new Promise((resolve) => {
  listener({ type: 'OFFSCREEN_START_CAPTURE', payload }, {}, resolve);
});
const stopCapture = (payload) => new Promise((resolve) => {
  listener({ type: 'OFFSCREEN_STOP_CAPTURE', payload }, {}, resolve);
});

check('the offscreen document registered a message listener', typeof listener === 'function');
check('chrome.storage really is absent in this harness, as in Chrome',
      globalThis.chrome.storage === undefined);

// ── The reported crash ──────────────────────────────────────────────────────
console.log('\n[starting capture with no chrome.storage]');
recorders = []; sentToSw.length = 0;
let result = await startCapture({ streamId: 's1', micEnabled: false, sessionId: 'sess-1' });

check('capture starts instead of throwing', result?.success === true, JSON.stringify(result));
check('and does not fail on undefined storage',
      !String(result?.error || '').includes("reading 'local'"), result?.error || '');
check('a recorder was actually started',
      recorders.some((r) => r.state === 'recording'), `recorders=${recorders.length}`);
check('no capture error reached the service worker',
      !sentToSw.some((m) => m.type === 'CAPTURE_ERROR'),
      JSON.stringify(sentToSw.filter((m) => m.type === 'CAPTURE_ERROR')));
check('it asked the service worker for settings', settingsRequests > 0, `requests=${settingsRequests}`);

await stopCapture({ transcribe: false });

// ── The relayed value is really used ────────────────────────────────────────
console.log('\n[the relayed settings are honoured]');
storageBacking = { liveTranscript: false };
workersCreated = 0; scriptProcessorsCreated = 0; recorders = [];
await startCapture({ streamId: 's2', micEnabled: false, sessionId: 'sess-2' });
await settle();
check('live preview off means no worker and no audio tap',
      workersCreated === 0 && scriptProcessorsCreated === 0,
      `workers=${workersCreated} taps=${scriptProcessorsCreated}`);
await stopCapture({ transcribe: false });

storageBacking = { liveTranscript: true, modelSize: 'Xenova/whisper-small' };
workersCreated = 0; scriptProcessorsCreated = 0; recorders = [];
await startCapture({ streamId: 's3', micEnabled: false, sessionId: 'sess-3' });
await settle();
check('live preview on starts a worker and taps the audio',
      workersCreated === 1 && scriptProcessorsCreated === 1,
      `workers=${workersCreated} taps=${scriptProcessorsCreated}`);
await stopCapture({ transcribe: false });

// ── A settings read must never be able to kill a recording ──────────────────
console.log('\n[degradation]');
swAnswers = false;
recorders = []; workersCreated = 0;
result = await startCapture({ streamId: 's4', micEnabled: false, sessionId: 'sess-4' });
check('a service worker that does not answer still lets recording start',
      result?.success === true, JSON.stringify(result));
check('and falls back to preview off', workersCreated === 0, `workers=${workersCreated}`);
await stopCapture({ transcribe: false });
swAnswers = true;

const boom = globalThis.chrome.runtime.sendMessage;
globalThis.chrome.runtime.sendMessage = async (m) => {
  if (m?.type === 'OFFSCREEN_GET_SETTINGS') throw new Error('receiving end does not exist');
  return boom(m);
};
recorders = [];
result = await startCapture({ streamId: 's5', micEnabled: false, sessionId: 'sess-5' });
check('a settings read that throws still lets recording start',
      result?.success === true, JSON.stringify(result));
await stopCapture({ transcribe: false });
globalThis.chrome.runtime.sendMessage = boom;

// ── A failed start must leave nothing behind ────────────────────────────────
// This is the other half of the reported crash: the user saw the error and
// pressed "Try Again". If a half-built capture still holds the tab's audio
// tracks and an open OPFS stream, the retry fails differently and the whole
// thing becomes unexplainable.
console.log('\n[a failed start cleans up after itself]');
liveTracks = []; openWritables = []; recorders = [];
const goodRecorder = globalThis.MediaRecorder;
globalThis.MediaRecorder = class { constructor() { throw new Error('mimeType not supported'); } };

result = await startCapture({ streamId: 's6', micEnabled: true, sessionId: 'sess-6' });
check('a mid-build failure is reported, not swallowed',
      result?.success === false && /mimeType/.test(result?.error || ''), JSON.stringify(result));
check('the failure reaches the service worker as CAPTURE_ERROR',
      sentToSw.some((m) => m.type === 'CAPTURE_ERROR' && /mimeType/.test(m.payload?.error || '')));
check('no captured track is left running',
      liveTracks.length > 0 && liveTracks.every((t) => !t.live),
      `${liveTracks.filter((t) => t.live).length} of ${liveTracks.length} still live`);
check('no OPFS write stream is left open',
      openWritables.length > 0 && openWritables.every((w) => !w.open),
      `${openWritables.filter((w) => w.open).length} of ${openWritables.length} still open`);

globalThis.MediaRecorder = goodRecorder;

// The retry the user would actually press must now work.
liveTracks = []; openWritables = []; recorders = []; storageBacking = {};
result = await startCapture({ streamId: 's7', micEnabled: true, sessionId: 'sess-7' });
check('the next attempt succeeds after a failed one',
      result?.success === true, JSON.stringify(result));
check('and records', recorders.some((r) => r.state === 'recording'), `recorders=${recorders.length}`);

await stopCapture({ transcribe: false });
check('a normal stop also releases every track',
      liveTracks.length > 0 && liveTracks.every((t) => !t.live),
      `${liveTracks.filter((t) => t.live).length} of ${liveTracks.length} still live`);
check('a normal stop also closes every write stream',
      openWritables.length > 0 && openWritables.every((w) => !w.open),
      `${openWritables.filter((w) => w.open).length} of ${openWritables.length} still open`);

// ── The contract, in source ─────────────────────────────────────────────────
console.log('\n[contract]');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
check('offscreen.js never touches chrome.storage', !/chrome\.storage/.test(code));
check('offscreen.js uses only chrome.runtime',
      [...code.matchAll(/chrome\.([a-zA-Z]+)/g)].every((m) => m[1] === 'runtime'),
      [...new Set([...code.matchAll(/chrome\.([a-zA-Z]+)/g)].map((m) => m[1]))].join(', '));

const sw = readFileSync(join(ROOT, 'background/service-worker.js'), 'utf8');
check('the service worker answers OFFSCREEN_GET_SETTINGS',
      /case MSG\.OFFSCREEN_GET_SETTINGS/.test(sw));
check('its handler reads storage', /handleOffscreenGetSettings[\s\S]{0,400}chrome\.storage\.local\.get/.test(sw));
check('and cannot reject', /handleOffscreenGetSettings[\s\S]{0,600}catch/.test(sw));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
