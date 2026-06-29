/**
 * SilentScribe — Offscreen Document (Recording Engine)
 * ============================================================================
 * 
 * The MOST COMPLEX file in the extension. All audio capture, mixing,
 * recording, PCM extraction, and transcription orchestration happens here.
 * 
 * ARCHITECTURE:
 * This offscreen document is the only place where DOM-dependent APIs
 * (AudioContext, MediaRecorder, getUserMedia) can run in MV3. The service
 * worker has no DOM access and cannot handle audio.
 * 
 * AUDIO PIPELINE:
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  Tab Stream (chromeMediaSource:'tab')  ──┐                            │
 * │                                          ├──▶ AudioContext            │
 * │  Mic Stream (getUserMedia)  ─────────────┘        │                   │
 * │                                                   ├──▶ ctx.destination│
 * │                                                   │   (LOOPBACK FIX)  │
 * │                                                   ├──▶ MediaRecorder  │
 * │                                                   │   (WebM chunks)   │
 * │                                                   ├──▶ TabWorklet     │
 * │                                                   │   (16kHz PCM)     │
 * │                                                   └──▶ MicWorklet     │
 * │                                                       (16kHz PCM)     │
 * └────────────────────────────────────────────────────────────────────────┘
 * 
 * CRITICAL: LOOPBACK FIX
 * When tabCapture intercepts a tab's audio, Chrome redirects the audio
 * away from the speakers — the tab goes SILENT for the user. We MUST
 * connect the tab source to ctx.destination to re-route audio back.
 * Without this, the user hears nothing during their meeting.
 * 
 * @module offscreen
 */

import { MSG, AUDIO_CONFIG, OFFSCREEN_CONFIG } from '../utils/constants.js';
import { createWriteStream } from '../storage/opfs.js';


// ============================================================================
// MODULE STATE
// ============================================================================

/** @type {AudioContext|null} Web Audio API context for mixing and processing */
let audioContext = null;

/** @type {MediaRecorder|null} Records the primary audio stream (tab/desktop) */
let recorderPrimary = null;

/** @type {MediaRecorder|null} Records the mic audio stream */
let recorderMic = null;

/** @type {MediaStream|null} Audio stream captured from the meeting tab */
let tabStream = null;

/** @type {MediaStream|null} Audio stream captured from the user's microphone */
let micStream = null;

/** @type {MediaStreamAudioSourceNode|null} Source node for tab audio */
let tabSourceNode = null;

/** @type {MediaStreamAudioSourceNode|null} Source node for mic audio */
let micSourceNode = null;

/** @type {chrome.runtime.Port|null} Keepalive port to the service worker */
let keepalivePort = null;

/** @type {number|null} Interval ID for keepalive pings */
let keepaliveInterval = null;

/** @type {number} Current audio chunk index (incremented per ondataavailable) */
let chunkIndex = 0;

/** @type {string|null} ID of the currently active recording session */
let currentSessionId = null;

/** @type {FileSystemWritableFileStream|null} Direct OPFS writer for the primary audio/video stream */
let primaryWriteStream = null;

/** @type {FileSystemWritableFileStream|null} Direct OPFS writer for the mic stream */
let micWriteStream = null;

let primaryWritePromise = Promise.resolve();
let micWritePromise = Promise.resolve();

let primaryStartedAtPerf = null;
let micStartedAtPerf = null;

/** @type {AnalyserNode|null} Analyser for tab audio level visualization */
let tabAnalyser = null;

/** @type {AnalyserNode|null} Analyser for mic audio level visualization */
let micAnalyser = null;

/** @type {number|null} Interval ID for level meter updates */
let levelInterval = null;

/** @type {Worker|null} Transcription Web Worker running Whisper */
let transcriptionWorker = null;

// Worklets and memory-heavy PCM extraction removed for V2 architecture


// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the offscreen document.
 * 
 * Sets up the message listener and establishes a keepalive port
 * to the service worker. The keepalive port prevents Chrome from
 * killing the service worker while recording is active.
 */
function initialize() {
  console.log('[SilentScribe Offscreen] Initializing...');

  // Listen for commands from the service worker
  chrome.runtime.onMessage.addListener(handleMessage);

  // Establish keepalive port to the service worker.
  // As long as this port is open, Chrome keeps both the service worker
  // and this offscreen document alive.
  keepalivePort = chrome.runtime.connect({ name: 'keepalive' });

  keepalivePort.onDisconnect.addListener(() => {
    console.warn('[SilentScribe Offscreen] Keepalive port disconnected');
    keepalivePort = null;
    clearInterval(keepaliveInterval);
  });

  // Send periodic pings to keep the port active.
  // Chrome may garbage-collect idle ports after extended periods.
  keepaliveInterval = setInterval(() => {
    if (keepalivePort) {
      keepalivePort.postMessage({ type: 'ping' });
    }
  }, OFFSCREEN_CONFIG.KEEPALIVE_INTERVAL_MS);

  console.log('[SilentScribe Offscreen] Initialized — keepalive port connected');
}


/**
 * Route incoming messages to handler functions.
 * 
 * @param {Object} message - Message with type and payload.
 * @param {chrome.runtime.MessageSender} sender - Message sender info.
 * @param {Function} sendResponse - Response callback.
 * @returns {boolean} True if async response will be sent.
 */
function handleMessage(message, sender, sendResponse) {
  if (!message || !message.type) return false;

  switch (message.type) {
    case MSG.OFFSCREEN_START_CAPTURE:
      startCapture(message.payload)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.error('[SilentScribe Offscreen] Capture start failed:', err);
          sendCaptureError(err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true; // Async

    case MSG.OFFSCREEN_STOP_CAPTURE:
      stopCapture()
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.error('[SilentScribe Offscreen] Capture stop failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;

    case MSG.UI_START_TRANSCRIPTION:
      // Manual transcription request — load PCM from IndexedDB and transcribe
      handleManualTranscription(message.payload);
      return false;

    default:
      return false;
  }
}


// ============================================================================
// AUDIO CAPTURE
// ============================================================================

/**
 * Start audio capture from the meeting tab and optionally the microphone.
 * 
 * This is the core recording function. It:
 * 1. Creates an AudioContext
 * 2. Obtains the tab audio stream via the stream ID from tabCapture
 * 3. Optionally obtains the mic audio stream
 * 4. Routes both through an AudioContext mixer
 * 5. CRITICAL: Routes tab audio back to speakers (loopback fix)
 * 6. Sets up MediaRecorder for WebM output
 * 7. Sets up AudioWorklet nodes for 16kHz PCM extraction (for Whisper)
 * 8. Starts recording and level meter updates
 * 
 * @param {Object} config - Capture configuration.
 * @param {string} config.streamId - Stream ID from chrome.tabCapture.getMediaStreamId().
 * @param {boolean} config.micEnabled - Whether to capture microphone audio.
 * @param {string} config.sessionId - Recording session ID for tagging chunks.
 * @param {string} [config.sourceType='tab'] - 'tab' or 'desktop' depending on the capture source.
 * @returns {Promise<void>}
 * @throws {Error} If stream acquisition or AudioContext setup fails.
 */
async function startCapture({ streamId, micEnabled, sessionId, sourceType }) {
  console.log(`[SilentScribe Offscreen] Starting capture — session: ${sessionId}, mic: ${micEnabled}, source: ${sourceType || 'tab'}`);

  // Reset state for new recording
  currentSessionId = sessionId;
  chunkIndex = 0;
  primaryWriteStream = await createWriteStream(`session_${sessionId}_primary.webm`);

  // ── Step 1: Create AudioContext ────────────────────────────────────────
  // We use the browser's default sample rate (typically 48kHz).
  // The AudioWorklet handles downsampling to 16kHz for Whisper.
  audioContext = new AudioContext({ sampleRate: AUDIO_CONFIG.CONTEXT_SAMPLE_RATE });

  // CRITICAL: The AudioContext may start in 'suspended' state because
  // this offscreen document was not created by a user gesture.
  // We must explicitly resume it.
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
    console.log('[SilentScribe Offscreen] AudioContext resumed from suspended state');
  }

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    }
  };

  tabStream = await navigator.mediaDevices.getUserMedia(constraints);

  tabSourceNode = audioContext.createMediaStreamSource(tabStream);

  // ── Step 3: LOOPBACK FIX ───────────────────────────────────────────────
  // CRITICAL: tabCapture redirects the tab's audio output to our stream.
  // The tab goes SILENT for the user. We must route it back to speakers
  // by connecting to ctx.destination.
  tabSourceNode.connect(audioContext.destination);

  // ── Step 4: Optionally get mic audio ───────────────────────────────────
  if (micEnabled) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micSourceNode = audioContext.createMediaStreamSource(micStream);
      console.log('[SilentScribe Offscreen] Mic stream acquired');
    } catch (err) {
      // Mic failure is non-fatal — continue with tab audio only
      console.warn('[SilentScribe Offscreen] Mic access failed (continuing without mic):', err.message);
      micStream = null;
      micSourceNode = null;
    }
  }

  // ── Step 5: Create recording destinations ──────────────────────────────
  const primaryDestination = audioContext.createMediaStreamDestination();
  tabSourceNode.connect(primaryDestination);

  let micDestination = null;
  if (micSourceNode) {
    micDestination = audioContext.createMediaStreamDestination();
    micSourceNode.connect(micDestination);
    micWriteStream = await createWriteStream(`session_${sessionId}_mic.webm`);
  }

  // ── Step 6: Set up AnalyserNodes for level meters ──────────────────────
  tabAnalyser = audioContext.createAnalyser();
  tabAnalyser.fftSize = 256;
  tabSourceNode.connect(tabAnalyser);

  if (micSourceNode) {
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    micSourceNode.connect(micAnalyser);
  }

  // ── Step 7: Real-Time Audio Extraction (ScriptProcessorNode) ─────────
  // We use ScriptProcessorNode (despite deprecation) because it's reliable
  // inside MV3 offscreen documents where AudioWorklet external files fail CSP.
  // We capture at 48kHz and downsample to 16kHz for Whisper.
  
  const bufferSize = 4096;
  const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  tabSourceNode.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  let pcmBuffer = [];
  let samplesCollected = 0;
  const targetSampleRate = 16000;
  const downsampleRatio = audioContext.sampleRate / targetSampleRate;

  // Initialize the worker early for real-time
  startTranscriptionWorkerEarly(sessionId);

  scriptProcessor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    
    // Downsample to 16kHz on the fly
    for (let i = 0; i < inputData.length; i += downsampleRatio) {
      pcmBuffer.push(inputData[Math.floor(i)]);
      samplesCollected++;
    }

    // Every ~5 seconds (80,000 samples at 16kHz), dispatch a chunk
    if (samplesCollected >= targetSampleRate * 5) {
      const chunk = new Float32Array(pcmBuffer);
      if (transcriptionWorker) {
        transcriptionWorker.postMessage({
          type: 'TRANSCRIBE_CHUNK',
          payload: { pcmChunk: chunk }
        });
      }
      // Reset buffer, keeping a 1-second overlap (16,000 samples)
      // for better word boundary handling in Whisper
      const overlap = pcmBuffer.slice(-targetSampleRate);
      pcmBuffer = overlap;
      samplesCollected = overlap.length;
    }
  };

  // ── Step 8: Set up Dual MediaRecorders ─────────────────────────────────
  // We must construct a combined MediaStream!
  // Why? Because routing tabStream into AudioContext (for loopback/analysis)
  // often "steals" the audio track, leaving tabStream's original audio silent.
  // So we take the VIDEO from tabStream, and the AUDIO from our primaryDestination.
  const combinedStream = new MediaStream();
  if (tabStream.getVideoTracks().length > 0) {
    combinedStream.addTrack(tabStream.getVideoTracks()[0]);
  }
  if (primaryDestination.stream.getAudioTracks().length > 0) {
    combinedStream.addTrack(primaryDestination.stream.getAudioTracks()[0]);
  }

  recorderPrimary = new MediaRecorder(combinedStream, {
    mimeType: AUDIO_CONFIG.RECORDER_MIME_TYPE,
  });

  recorderPrimary.ondataavailable = (event) => {
    if (event.data && event.data.size > 0 && primaryWriteStream) {
      primaryWritePromise = primaryWritePromise.then(() => 
        primaryWriteStream.write(event.data)
      ).catch(err => {
        console.error('[SilentScribe Offscreen] Failed to stream primary to OPFS:', err);
      });
    }
  };

  recorderPrimary.onerror = (event) => {
    console.error('[SilentScribe Offscreen] recorderPrimary error:', event.error);
    sendCaptureError(`Primary recording failed: ${event.error?.message || 'Unknown MediaRecorder error'}`);
  };

  if (micDestination) {
    recorderMic = new MediaRecorder(micDestination.stream, {
      mimeType: AUDIO_CONFIG.MIC_RECORDER_MIME_TYPE,
    });

    recorderMic.ondataavailable = (event) => {
      if (event.data && event.data.size > 0 && micWriteStream) {
        micWritePromise = micWritePromise.then(() => 
          micWriteStream.write(event.data)
        ).catch(err => {
          console.error('[SilentScribe Offscreen] Failed to stream mic to OPFS:', err);
        });
      }
    };

    recorderMic.onerror = (event) => {
      console.error('[SilentScribe Offscreen] recorderMic error:', event.error);
    };
  }

  // Start recording with the configured timeslice as close together as possible
  primaryStartedAtPerf = performance.now();
  recorderPrimary.start(AUDIO_CONFIG.RECORDER_TIMESLICE_MS);

  if (recorderMic) {
    micStartedAtPerf = performance.now();
    recorderMic.start(AUDIO_CONFIG.RECORDER_TIMESLICE_MS);
  }

  // ── Step 9: Start level meter updates ──────────────────────────────────
  startLevelMeters();

  // Save offsets to DB
  try {
    const { updateSessionMetadata } = await import('../storage/db.js');
    await updateSessionMetadata(sessionId, {
      primaryStartOffsetMs: 0,
      micStartOffsetMs: recorderMic ? (micStartedAtPerf - primaryStartedAtPerf) : null
    }, null);
  } catch (err) {
    console.warn('[SilentScribe Offscreen] Failed to save session offsets:', err);
  }

  console.log('[SilentScribe Offscreen] Capture started — dual pipelines active');
}


/**
 * Stop audio capture and finalize the recording.
 * 
 * This function:
 * 1. Stops the MediaRecorder (triggers final ondataavailable)
 * 2. Stops all media stream tracks
 * 3. Stops level meter updates
 * 4. Collects PCM buffers for transcription
 * 5. Notifies the service worker that capture is complete
 * 6. Starts transcription in a Web Worker
 * 
 * @returns {Promise<void>}
 */
async function stopCapture() {
  console.log('[SilentScribe Offscreen] Stopping capture...');

  // 1. Trigger MediaRecorder stops and await their onstop events
  const stopPromises = [];
  
  if (recorderPrimary && recorderPrimary.state !== 'inactive') {
    stopPromises.push(new Promise(resolve => {
      recorderPrimary.onstop = resolve;
      recorderPrimary.stop();
    }));
  }
  
  if (recorderMic && recorderMic.state !== 'inactive') {
    stopPromises.push(new Promise(resolve => {
      recorderMic.onstop = resolve;
      recorderMic.stop();
    }));
  }

  // Wait for all recording to officially stop (triggering final ondataavailable)
  await Promise.all(stopPromises);

  // 2. Wait for any pending OPFS writes to finish successfully
  await primaryWritePromise;
  await micWritePromise;

  // Stop all media stream tracks to release hardware
  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
  }

  // Stop level meter updates
  stopLevelMeters();

  // Close AudioContext
  if (audioContext && audioContext.state !== 'closed') {
    await audioContext.close();
  }

  // Finalize OPFS streams (now safe to close)
  if (primaryWriteStream) {
    try {
      await primaryWriteStream.close();
      console.log(`[SilentScribe Offscreen] OPFS primary stream finalized`);
    } catch (err) {
      console.error('[SilentScribe Offscreen] Failed to close primary OPFS stream:', err);
    }
    primaryWriteStream = null;
  }
  if (micWriteStream) {
    try {
      await micWriteStream.close();
      console.log(`[SilentScribe Offscreen] OPFS mic stream finalized`);
    } catch (err) {
      console.error('[SilentScribe Offscreen] Failed to close mic OPFS stream:', err);
    }
    micWriteStream = null;
  }

  // Notify service worker that capture is complete
  chrome.runtime.sendMessage({
    type: MSG.CAPTURE_COMPLETE,
    payload: { sessionId: currentSessionId },
  }).catch(() => {});

  // Start offline decoding & transcription!
  runOfflineTranscription(currentSessionId);

  // Clean up references (but keep keepalive port)
  audioContext = null;
  recorderPrimary = null;
  recorderMic = null;
  tabStream = null;
  micStream = null;
  tabSourceNode = null;
  micSourceNode = null;
  tabAnalyser = null;
  micAnalyser = null;
}

/**
 * Offline Decoding & Transcription (V2 Intelligence Plane)
 * 
 * 1. Reads the WebM from OPFS.
 * 2. Decodes the WebM to PCM via OfflineAudioContext.
 * 3. Starts the Whisper transcription worker.
 * 
 * @param {string} sessionId 
 */
async function decodeWebM(blob) {
  if (!blob || blob.size === 0) return new Float32Array(0);
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  const pcm = audioBuffer.getChannelData(0);
  await decodeCtx.close();
  return pcm;
}

function findOnsetMs(pcm, sampleRate = 16000) {
  const threshold = 0.015;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) > threshold) return (i / sampleRate) * 1000;
  }
  return 0;
}

async function runOfflineTranscription(sessionId) {
  console.log(`[SilentScribe Offscreen] Starting offline transcription for session: ${sessionId}`);
  try {
    const { readFile } = await import('../storage/opfs.js');
    const { getSession, updateSessionMetadata } = await import('../storage/db.js');

    const session = await getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const primaryBlob = await readFile(`session_${sessionId}_primary.webm`);
    const primaryPcm = await decodeWebM(primaryBlob);
    console.log(`[SilentScribe Offscreen] Primary WebM decoded: ${(primaryPcm.length / 16000).toFixed(2)}s`);
    
    let micPcm = new Float32Array(0);
    if (session.files.micTrack) {
      const micBlob = await readFile(`session_${sessionId}_mic.webm`);
      micPcm = await decodeWebM(micBlob);
      console.log(`[SilentScribe Offscreen] Mic WebM decoded: ${(micPcm.length / 16000).toFixed(2)}s`);
    }

    // Save durations to DB
    await updateSessionMetadata(sessionId, null, {
      primary: primaryPcm.length / 16000,
      mic: micPcm.length > 0 ? micPcm.length / 16000 : null
    });

    let primaryOffsetMs = session.metadata.primaryStartOffsetMs || 0;
    let micOffsetMs = session.metadata.micStartOffsetMs || 0;

    // Lightweight onset detection sanity pass
    const pOnset = findOnsetMs(primaryPcm);
    const mOnset = findOnsetMs(micPcm);
    
    // If there is an obvious skew between the hardware onset and performance.now() delta,
    // we could adjust the micOffset here. For V2.1, we'll trust performance.now() + hardware silence.
    console.log(`[SilentScribe Offscreen] Alignment sanity check: perfPrimary=${primaryOffsetMs}ms, perfMic=${micOffsetMs}ms, onsetPrimary=${pOnset.toFixed(1)}ms, onsetMic=${mOnset.toFixed(1)}ms`);

    // We pass both PCMs to the transcription worker, which will run them sequentially.
    startTranscription(primaryPcm, micPcm, sessionId, primaryOffsetMs, micOffsetMs);
  } catch (err) {
    console.error('[SilentScribe Offscreen] Offline transcription failed:', err);
    chrome.runtime.sendMessage({
      type: MSG.TRANSCRIPTION_ERROR,
      payload: { error: `Offline decoding failed: ${err.message}` },
    }).catch(() => {});
  }
}


// ============================================================================
// TRANSCRIPTION
// ============================================================================

/**
 * Start transcription in a Web Worker.
 * 
 * Creates a new Web Worker that loads @xenova/transformers and runs
 * Whisper inference on the captured PCM audio. The worker communicates
 * progress and results back via postMessage.
 * 
 * After transcription completes, speaker diarization is applied using
 * stream-based label assignment (mic = "Me", tab = "Others").
 * 
 * @param {Float32Array} tabPcm - 16kHz mono PCM from the tab audio.
 * @param {Float32Array} micPcm - 16kHz mono PCM from the mic (may be empty).
 * @param {string} sessionId - The session ID.
 * @param {number} primaryOffsetMs - Offset for the primary track in ms.
 * @param {number} micOffsetMs - Offset for the mic track in ms.
 */
function startTranscriptionWorkerEarly(sessionId) {
  console.log('[SilentScribe Offscreen] Pre-initializing transcription worker for real-time...');
  try {
    transcriptionWorker = new Worker(
      new URL('../transcription/transcription-worker.js', import.meta.url),
      { type: 'module' }
    );
  } catch (err) {
    console.error('[SilentScribe Offscreen] Failed to create transcription worker:', err);
    return;
  }

  transcriptionWorker.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
      case 'TRANSCRIPTION_CHUNK_RESULT':
        // Send real-time transcript segment to the service worker/UI
        chrome.runtime.sendMessage({
          type: MSG.TRANSCRIPTION_PROGRESS,
          payload: { text: payload.text, isRealTime: true }
        }).catch(() => {});
        break;
      case 'TRANSCRIPTION_PROGRESS':
        chrome.runtime.sendMessage({ type: MSG.TRANSCRIPTION_PROGRESS, payload }).catch(() => {});
        break;
    }
  };
}

function startTranscription(tabPcm, micPcm, sessionId, primaryOffsetMs = 0, micOffsetMs = 0) {
  console.log('[SilentScribe Offscreen] Starting dual-track transcription worker...');

  try {
    transcriptionWorker = new Worker(
      new URL('../transcription/transcription-worker.js', import.meta.url),
      { type: 'module' }
    );
  } catch (err) {
    console.error('[SilentScribe Offscreen] Failed to create transcription worker:', err);
    chrome.runtime.sendMessage({
      type: MSG.TRANSCRIPTION_ERROR,
      payload: { error: 'Failed to initialize transcription engine: ' + err.message },
    }).catch(() => {});
    return;
  }

  // Store PCM references for diarization after transcription
  const tabPcmRef = tabPcm;
  const micPcmRef = micPcm;

  transcriptionWorker.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
      case 'TRANSCRIPTION_PROGRESS':
        // Forward progress to service worker → side panel
        chrome.runtime.sendMessage({
          type: MSG.TRANSCRIPTION_PROGRESS,
          payload,
        }).catch(() => {});
        break;

      case 'TRANSCRIPTION_COMPLETE':
        // The worker now returns pre-diarized segments
        chrome.runtime.sendMessage({
          type: MSG.TRANSCRIPTION_COMPLETE,
          payload: {
            sessionId: sessionId || currentSessionId,
            transcript: payload.segments,
          },
        }).catch(() => {});

        // Clean up worker
        transcriptionWorker.terminate();
        transcriptionWorker = null;
        break;

      case 'TRANSCRIPTION_ERROR':
        chrome.runtime.sendMessage({
          type: MSG.TRANSCRIPTION_ERROR,
          payload,
        }).catch(() => {});
        transcriptionWorker.terminate();
        transcriptionWorker = null;
        break;
    }
  };

  transcriptionWorker.onerror = (err) => {
    console.error('[SilentScribe Offscreen] Transcription worker error:', err);
    chrome.runtime.sendMessage({
      type: MSG.TRANSCRIPTION_ERROR,
      payload: { error: `Transcription worker crashed: ${err.message}` },
    }).catch(() => {});
  };

  // Start the transcription process with BOTH buffers.
  // The worker will transcribe them sequentially and merge them.
  transcriptionWorker.postMessage(
    {
      type: 'START_DUAL_TRANSCRIPTION',
      payload: {
        sessionId,
        primaryPcmData: tabPcm.buffer,
        micPcmData: micPcm.buffer,
        primaryOffsetMs,
        micOffsetMs,
        sampleRate: AUDIO_CONFIG.CONTEXT_SAMPLE_RATE,
      },
    },
    [tabPcm.buffer, micPcm.buffer].filter(buf => buf.byteLength > 0) // Zero-copy transfer
  );
}


/**
 * Handle manual transcription request for a past recording.
 * 
 * When the user wants to transcribe or re-transcribe a session that's
 * already been recorded, we need to extract PCM from the stored WebM.
 * 
 * For V1, this is a simplified path — we decode the WebM to PCM using
 * an AudioContext, then feed it to the transcription worker.
 * 
 * @param {Object} payload - { sessionId: string }
 */
async function handleManualTranscription(payload) {
  console.log(`[SilentScribe Offscreen] Manual transcription for session: ${payload.sessionId}`);

  try {
    const { getTranscript } = await import('../storage/db.js');
    const { readFile } = await import('../storage/opfs.js');
    const audioBlob = await readFile(`session_${payload.sessionId}_primary.webm`);
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error('No audio data found for this session');
    }

    // Decode WebM to PCM using AudioContext
    const arrayBuffer = await audioBlob.arrayBuffer();
    const decodeCtx = new AudioContext({ sampleRate: AUDIO_CONFIG.WHISPER_SAMPLE_RATE });
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);

    // Extract mono channel
    const pcm = audioBuffer.getChannelData(0);
    await decodeCtx.close();

    currentSessionId = payload.sessionId;

    // Start transcription with tab-only PCM (no mic separation for past recordings)
    startTranscription(pcm, new Float32Array(0));

  } catch (err) {
    console.error('[SilentScribe Offscreen] Manual transcription failed:', err);
    chrome.runtime.sendMessage({
      type: MSG.TRANSCRIPTION_ERROR,
      payload: { error: err.message },
    }).catch(() => {});
  }
}


// ============================================================================
// SPEAKER DIARIZATION
// ============================================================================

/**
 * Assign speaker labels to transcript segments using stream separation.
 * 
 * This is the V1 diarization approach: since we capture mic and tab audio
 * as separate streams, we can determine who was speaking during each
 * transcript segment by comparing the energy levels of each stream.
 * 
 * Algorithm:
 * 1. For each transcript segment (with start/end timestamps):
 * 2. Extract the corresponding PCM samples from both streams
 * 3. Compute RMS energy for each stream in that time window
 * 4. If mic energy exceeds the VAD threshold AND exceeds tab energy → "Me"
 * 5. Otherwise → "Others"
 * 
 * This is deterministically accurate for the "me vs. them" split because
 * the mic stream physically captures YOUR voice and the tab stream
 * captures THEIR audio. No ML needed.
 * 
 * @param {Object[]} segments - Raw transcript segments from Whisper.
 * @param {Float32Array} tabPcm - 16kHz mono PCM from tab audio.
 * @param {Float32Array} micPcm - 16kHz mono PCM from mic audio.
 * @returns {Object[]} Segments with speaker labels added.
 */
function assignSpeakerLabels(segments, tabPcm, micPcm) {
  // If no mic PCM, all segments are "Others" (no way to identify "Me")
  if (!micPcm || micPcm.length === 0) {
    return segments.map((seg) => ({ ...seg, speaker: 'Others' }));
  }

  const sampleRate = AUDIO_CONFIG.WHISPER_SAMPLE_RATE;
  const vadThresholdLinear = Math.pow(10, AUDIO_CONFIG.VAD_THRESHOLD_DB / 20);

  return segments.map((segment) => {
    const startSample = Math.floor(segment.start * sampleRate);
    const endSample = Math.min(Math.floor(segment.end * sampleRate), tabPcm.length);

    // Extract samples for this time window
    const tabWindow = tabPcm.slice(startSample, endSample);
    const micWindow = micPcm.slice(
      Math.min(startSample, micPcm.length),
      Math.min(endSample, micPcm.length)
    );

    // Compute RMS energy for each stream
    const tabRms = computeRms(tabWindow);
    const micRms = computeRms(micWindow);

    // Decision logic:
    // - If mic has voice activity AND mic energy dominates → "Me"
    // - Otherwise → "Others"
    let speaker = 'Others';
    if (micRms > vadThresholdLinear && micRms > tabRms * 0.5) {
      speaker = 'Me';
    }

    return { ...segment, speaker };
  });
}


/**
 * Compute the Root Mean Square (RMS) energy of an audio buffer.
 * 
 * RMS is the standard measure of signal energy. For speech detection,
 * an RMS value above the VAD threshold indicates voice activity.
 * 
 * @param {Float32Array} samples - Audio samples.
 * @returns {number} RMS energy (0 to 1 range for normalized audio).
 */
function computeRms(samples) {
  if (!samples || samples.length === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}


// ============================================================================
// AUDIO LEVEL METERS
// ============================================================================

/**
 * Start periodic level meter updates for the side panel visualization.
 * 
 * Reads the current audio levels from the AnalyserNodes and sends
 * them to the service worker, which forwards them to the side panel.
 */
function startLevelMeters() {
  levelInterval = setInterval(() => {
    const tabLevel = getLevel(tabAnalyser);
    const micLevel = getLevel(micAnalyser);

    chrome.runtime.sendMessage({
      type: MSG.CAPTURE_LEVELS,
      payload: { tab: tabLevel, mic: micLevel },
    }).catch(() => {
      // Side panel may not be open — ignore
    });
  }, AUDIO_CONFIG.LEVEL_UPDATE_INTERVAL_MS);
}


/**
 * Stop level meter updates.
 */
function stopLevelMeters() {
  if (levelInterval) {
    clearInterval(levelInterval);
    levelInterval = null;
  }
}


/**
 * Read the current audio level from an AnalyserNode.
 * 
 * Computes the average frequency magnitude and normalizes it to a
 * 0-1 range suitable for driving a visual level meter.
 * 
 * @param {AnalyserNode|null} analyser - The analyser node to read from.
 * @returns {number} Normalized audio level (0 = silence, 1 = maximum).
 */
function getLevel(analyser) {
  if (!analyser) return 0;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);

  // Compute average magnitude across all frequency bins
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }

  // Normalize: Uint8 values range from 0-255, average across bins
  return sum / (dataArray.length * 255);
}


// ============================================================================
// PCM UTILITIES
// ============================================================================

/**
 * Concatenate an array of Float32Array buffers into a single Float32Array.
 * 
 * Used to merge the accumulated PCM chunks from the AudioWorklet into
 * one contiguous buffer for transcription.
 * 
 * @param {Float32Array[]} buffers - Array of PCM buffers to concatenate.
 * @returns {Float32Array} Single concatenated buffer.
 */
function concatenateFloat32Arrays(buffers) {
  if (buffers.length === 0) return new Float32Array(0);

  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Float32Array(totalLength);

  let offset = 0;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }

  return result;
}


/**
 * Mix two PCM buffers into a single buffer by averaging samples.
 * 
 * Used to create a mixed audio stream for Whisper transcription.
 * Whisper needs a single audio input, so we mix tab + mic together.
 * 
 * If one buffer is longer than the other, the shorter one is zero-padded.
 * 
 * @param {Float32Array} a - First PCM buffer (tab audio).
 * @param {Float32Array} b - Second PCM buffer (mic audio).
 * @returns {Float32Array} Mixed PCM buffer.
 */
function mixPcmBuffers(a, b) {
  if (!b || b.length === 0) return new Float32Array(a);
  if (!a || a.length === 0) return new Float32Array(b);

  const length = Math.max(a.length, b.length);
  const mixed = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const sampleA = i < a.length ? a[i] : 0;
    const sampleB = i < b.length ? b[i] : 0;
    // Average the two signals to prevent clipping
    mixed[i] = (sampleA + sampleB) * 0.5;
  }

  return mixed;
}


// ============================================================================
// ERROR HELPERS
// ============================================================================

/**
 * Send a capture error message to the service worker.
 * 
 * @param {string} errorMessage - Human-readable error description.
 */
function sendCaptureError(errorMessage) {
  chrome.runtime.sendMessage({
    type: MSG.CAPTURE_ERROR,
    payload: { error: errorMessage },
  }).catch(() => {
    console.error('[SilentScribe Offscreen] Could not send error to service worker');
  });
}


// ============================================================================
// BOOTSTRAP
// ============================================================================

initialize();
