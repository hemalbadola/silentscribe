// The transcript tab shows exactly one thing at a time.
//
// The bug this exists to catch: a finished progress bar reading "Complete
// 100%", an error card containing nothing but a "Try again" button, and an
// offer to transcribe, all stacked on screen together. Two functions toggled
// the same three cards, each hiding only what it knew about, so the result
// depended on which ran last.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const panel = readFileSync(join(ROOT, 'sidepanel/panel.js'), 'utf8');

// panel.js is a DOM module; only the exported decision is needed here.
const src = panel.slice(panel.indexOf('export function transcriptTabMode'));
// From the brace that opens the BODY, not the destructuring brace in the
// signature — those are different braces and the first one is the wrong one.
const bodyStart = src.indexOf('{', src.indexOf(')'));
const body = src.slice(bodyStart + 1, src.indexOf('\n}\n'));
const transcriptTabMode = new Function('s', `const { running, explained, segments, transcribed } = s;${body}`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

// Which cards each mode puts on screen, mirroring renderTranscriptTabState.
const CARDS = {
  running:    ['progress'],
  failed:     ['error'],
  empty:      ['prompt'],
  offer:      ['prompt'],
  transcript: ['transcript'],
};

const ERR = { title: 'Transcription failed', cause: 'x', action: 'y', raw: 'x' };

console.log('\n[exactly one card, in every combination]');
let worst = null;
for (const running of [true, false]) {
  for (const explained of [null, ERR]) {
    for (const segments of [0, 5]) {
      for (const transcribed of [true, false]) {
        const mode = transcriptTabMode({ running, explained, segments, transcribed });
        const shown = CARDS[mode];
        if (!shown || shown.length !== 1) {
          worst = { running, explained: !!explained, segments, transcribed, mode };
        }
      }
    }
  }
}
check('every state maps to exactly one card', worst === null, JSON.stringify(worst));

console.log('\n[the states the user actually hit]');
// All three at once: a run finished, an error was left set, and the recording
// still had no segments.
check('a finished run with a stale error shows only the error',
      transcriptTabMode({ running: false, explained: ERR, segments: 0, transcribed: true }) === 'failed');
check('progress wins while a run is going, even with an old error',
      transcriptTabMode({ running: true, explained: ERR, segments: 0, transcribed: true }) === 'running');
check('an error with no explanation is not a card',
      transcriptTabMode({ running: false, explained: null, segments: 0, transcribed: false }) === 'offer');

console.log('\n[the ordinary paths]');
check('never transcribed offers to transcribe',
      transcriptTabMode({ running: false, explained: null, segments: 0, transcribed: false }) === 'offer');
check('transcribed but silent is a different message',
      transcriptTabMode({ running: false, explained: null, segments: 0, transcribed: true }) === 'empty');
check('segments show the transcript',
      transcriptTabMode({ running: false, explained: null, segments: 5, transcribed: true }) === 'transcript');
check('segments beat a stale transcribed flag',
      transcriptTabMode({ running: false, explained: null, segments: 5, transcribed: false }) === 'transcript');

console.log('\n[one owner]');
check('the old second owner is gone',
      !/function showTranscribePrompt/.test(panel), 'showTranscribePrompt still defined');
check('every card is set on every render',
      ['transcriptProgress', 'transcriptError', 'transcribePrompt', 'searchContainer', 'transcriptContainer']
        .every((el) => new RegExp(`dom\\.${el}\\.hidden = mode !==`).test(panel)),
      'a card is left as it was');
check('the error card is only shown with a title',
      /Boolean\(explained\?\.title\)/.test(panel), 'can show an empty error');
check('an error is scoped to its own recording',
      /transcriptionErrorSessionId === activeSessionId/.test(panel), 'errors leak across recordings');

const sw = readFileSync(join(ROOT, 'background/service-worker.js'), 'utf8');
check('the service worker tags errors with their session',
      (sw.match(/transcriptionErrorSessionId/g) || []).length >= 5, 'not tagged everywhere');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
