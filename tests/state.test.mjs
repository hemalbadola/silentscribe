// Exercises the real state machine, including the two edges added for the
// "stop without transcribing" and "transcribe later" flows.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let session = {};
const listeners = [];
globalThis.chrome = {
  storage: { session: {
    get: async (k) => ({ [k]: session[k] }),
    set: async (o) => Object.assign(session, o),
    onChanged: { addListener: (fn) => listeners.push(fn) },
  } },
  runtime: { sendMessage: async () => {} },
};

const { STATES, getState, setState, updateMetadata } = await import(`${ROOT}/utils/state.js`);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`)); };

const reset = async (state) => { session = {}; await setState(STATES.PERMISSIONS_NEEDED); await setState(STATES.READY);
  if (state === STATES.RECORDING || state === STATES.PROCESSING || state === STATES.COMPLETE) await setState(STATES.RECORDING);
  if (state === STATES.PROCESSING) await setState(STATES.PROCESSING);
  if (state === STATES.COMPLETE) await setState(STATES.COMPLETE);
};

const allowed = async (from, to) => {
  await reset(from);
  try { await setState(to); return true; } catch { return false; }
};

console.log('\n[new transitions]');
check('RECORDING to COMPLETE allowed (stop, video only)', await allowed(STATES.RECORDING, STATES.COMPLETE));
check('COMPLETE to PROCESSING allowed (transcribe later)', await allowed(STATES.COMPLETE, STATES.PROCESSING));

console.log('\n[existing transitions still enforced]');
check('RECORDING to PROCESSING still allowed', await allowed(STATES.RECORDING, STATES.PROCESSING));
check('PROCESSING to COMPLETE still allowed', await allowed(STATES.PROCESSING, STATES.COMPLETE));
check('READY to COMPLETE still rejected', !(await allowed(STATES.READY, STATES.COMPLETE)));
check('READY to PROCESSING still rejected', !(await allowed(STATES.READY, STATES.PROCESSING)));
check('COMPLETE to RECORDING still rejected', !(await allowed(STATES.COMPLETE, STATES.RECORDING)));
check('ERROR reachable from RECORDING', await allowed(STATES.RECORDING, STATES.ERROR));

console.log('\n[the skip flag survives the stop sequence]');
await reset(STATES.RECORDING);
await updateMetadata({ transcribe: false });
check('updateMetadata persists without a transition', (await getState()).transcribe === false);
check('state is still RECORDING after updateMetadata', (await getState()).state === STATES.RECORDING);
await setState(STATES.COMPLETE, { sessionId: 's1', transcribe: false });
let s = await getState();
check('COMPLETE keeps the flag and session id', s.state === STATES.COMPLETE && s.transcribe === false && s.sessionId === 's1', JSON.stringify(s));

console.log('\n[a later transcribe run flips the flag back]');
await setState(STATES.PROCESSING, { sessionId: 's1', transcribe: true });
s = await getState();
check('PROCESSING with transcribe true', s.state === STATES.PROCESSING && s.transcribe === true);
await setState(STATES.COMPLETE, { sessionId: 's1' });
check('back to COMPLETE', (await getState()).state === STATES.COMPLETE);

console.log('\n[transcribe flag is per-recording, not sticky]');
await reset(STATES.RECORDING);
await updateMetadata({ transcribe: false });
await setState(STATES.COMPLETE, { sessionId: 'a', transcribe: false });
await setState(STATES.READY);
await setState(STATES.RECORDING);
await updateMetadata({ transcribe: true });
check('second recording overrides the first choice', (await getState()).transcribe === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
