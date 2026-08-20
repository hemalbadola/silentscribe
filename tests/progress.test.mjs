// Download progress reporting.
//
// The bug this exists to catch: Transformers.js reports progress PER FILE and
// Whisper is several files, so the panel showed two different downloads'
// numbers side by side — "Downloading model: 54% 24%" — with the bar at one
// value and the text at another, jumping backwards each time a file began.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The worker assigns self.onmessage at load.
globalThis.self = { location: { href: `file://${ROOT}/transcription/` } };

const { aggregateDownload } = await import(`${ROOT}/transcription/transcription-worker.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

const WHISPER = [['encoder.onnx', 90e6], ['decoder.onnx', 50e6], ['tokenizer.json', 3e6], ['config.json', 1e6]];

/** Replay a whole download, returning every percentage the user would see. */
function replay({ concurrent }) {
  const files = new Map();
  const seen = [];
  const feed = (event) => {
    const f = aggregateDownload(files, event);
    if (f !== null) seen.push(Math.round(f * 100));
  };

  if (concurrent) {
    for (const [file, total] of WHISPER) feed({ status: 'initiate', file, loaded: 0, total });
    for (let p = 0.25; p <= 1.0001; p += 0.25) {
      for (const [file, total] of WHISPER) feed({ status: 'progress', file, loaded: total * p, total });
    }
    for (const [file] of WHISPER) feed({ status: 'done', file });
  } else {
    for (const [file, total] of WHISPER) {
      feed({ status: 'initiate', file, loaded: 0, total });
      for (let p = 0; p <= 1.0001; p += 0.5) feed({ status: 'progress', file, loaded: total * p, total });
      feed({ status: 'done', file });
    }
  }
  return seen;
}

// ── How transformers.js actually behaves: files start together ──────────────
console.log('\n[a real download]');
const real = replay({ concurrent: true });
check('it reports progress', real.length > 0);
check('it never runs backwards', real.every((v, i) => i === 0 || v >= real[i - 1]), real.join(' '));
check('it never claims to be finished early',
      real.slice(0, -1).every((v) => v < 100), real.join(' '));
check('it never exceeds 100', real.every((v) => v <= 100), real.join(' '));
check('it gets close to done', Math.max(...real) >= 99, `max ${Math.max(...real)}`);

// ── Worst case: files discovered one after another ──────────────────────────
// It can dip here, because a file that does not exist yet cannot be counted.
// What must never happen is reporting complete while work remains.
console.log('\n[files discovered late]');
const staggered = replay({ concurrent: false });
check('still never claims to be finished early',
      staggered.slice(0, -1).every((v) => v < 100), staggered.join(' '));
check('and never exceeds 100', staggered.every((v) => v <= 100), staggered.join(' '));

// ── One file is one number ──────────────────────────────────────────────────
console.log('\n[the arithmetic]');
let files = new Map();
check('half of a single file is 50%',
      Math.round(aggregateDownload(files, { status: 'progress', file: 'a', loaded: 50, total: 100 }) * 100) === 50);
aggregateDownload(files, { status: 'initiate', file: 'b', loaded: 0, total: 100 });
check('a second file of equal size halves it',
      Math.round(aggregateDownload(files, { status: 'progress', file: 'a', loaded: 50, total: 100 }) * 100) === 25);
check('finishing a file with no reported size does not break the sum',
      aggregateDownload(files, { status: 'done', file: 'b' }) !== null);

console.log('\n[degenerate input]');
files = new Map();
check('an event with no file is ignored', aggregateDownload(files, { status: 'progress' }) === null);
check('an unknown status is ignored', aggregateDownload(files, { status: 'ready', file: 'a' }) === null);
check('nothing at all is ignored', aggregateDownload(files, undefined) === null);
check('zero total reports nothing rather than dividing by zero',
      aggregateDownload(files, { status: 'progress', file: 'a', loaded: 0, total: 0 }) === null);

// ── The text must not carry its own percentage ──────────────────────────────
console.log('\n[one number, not two]');
const worker = readFileSync(join(ROOT, 'transcription/transcription-worker.js'), 'utf8');
const panel = readFileSync(join(ROOT, 'sidepanel/panel.js'), 'utf8');
check('the worker does not put a percentage in the status text',
      !/postProgress\([^)]*%`/.test(worker), 'a status still embeds %');
check('and the panel refuses to append a second one',
      /test\(status\)/.test(panel), 'no guard against doubling');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
