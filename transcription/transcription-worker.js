/**
 * SilentScribe — Transcription Worker
 * ============================================================================
 * 
 * Web Worker that runs Whisper speech-to-text inference using the
 * @xenova/transformers library (ONNX Runtime Web).
 * 
 * This worker runs in a SEPARATE THREAD from the offscreen document.
 * It has no access to the DOM, chrome APIs, or any extension context.
 * Communication is exclusively via self.onmessage / self.postMessage.
 * 
 * LIFECYCLE:
 * 1. Offscreen doc creates this worker after recording stops
 * 2. Offscreen doc sends PCM audio data via postMessage (Transferable)
 * 3. Worker loads the Whisper model (first run: downloads ~75MB from HF Hub)
 * 4. Worker runs inference on 30-second chunks
 * 5. Worker posts progress updates and final transcript back
 * 6. Offscreen doc terminates the worker when transcription completes
 * 
 * MODEL LOADING:
 * @xenova/transformers automatically caches downloaded models in the
 * browser's Cache API (caches.open('transformers-cache')). First run
 * requires internet for the ~75MB download. Subsequent runs load from cache.
 * 
 * IMPORTANT: The library must be available to this worker. Since Chrome
 * extension CSP blocks external script imports by default, the library
 * should be bundled locally in the extension's lib/ directory. If not
 * available, the worker posts a clear error message.
 * 
 * @module transcription-worker
 */


// ============================================================================
// LIBRARY LOADING
// ============================================================================

/**
 * Reference to the loaded Whisper pipeline.
 * Cached after first load to avoid re-downloading for subsequent transcriptions.
 * 
 * @type {Object|null}
 */
let whisperPipeline = null;

/**
 * Default Whisper model, used when the caller sends no `modelId`.
 * Kept in sync with WHISPER_CONFIG.MODEL_ID in utils/constants.js — this worker
 * cannot import that module, because it must stay loadable before the
 * transformers library resolves.
 *
 * @type {string}
 */
const DEFAULT_MODEL_ID = 'Xenova/whisper-base';

/**
 * The model id the cached pipeline was built from. Used to detect that the user
 * changed the accuracy setting and the pipeline must be rebuilt.
 *
 * @type {string|null}
 */
let loadedModelId = null;

/**
 * True while a live chunk is being transcribed.
 *
 * Chunks arrive every few seconds but inference on one thread can take longer
 * than that. Without this guard the queue would grow without bound and starve
 * the recording it is supposed to be previewing.
 *
 * @type {boolean}
 */
let chunkBusy = false;

/**
 * Whether the library has been successfully loaded.
 * @type {boolean}
 */
let libraryLoaded = false;

/**
 * The pipeline and env objects from @xenova/transformers.
 * @type {Function|null}
 */
let pipelineFn = null;
let envConfig = null;


/**
 * Attempt to load the @xenova/transformers library.
 * 
 * Tries multiple loading strategies in order:
 * 1. Local bundled path (lib/transformers.js)
 * 2. CDN fallback (requires CSP exception in manifest)
 * 
 * Posts progress messages during loading.
 * 
 * @returns {Promise<boolean>} True if the library loaded successfully.
 */
async function loadLibrary() {
  if (libraryLoaded) return true;

  postProgress(0, 'Loading transcription engine...');

  // Strategy 1: Try loading from local bundle
  const localPaths = [
    '../lib/transformers.min.js',
    '../lib/transformers.js',
    '../node_modules/@xenova/transformers/dist/transformers.min.js',
  ];

  for (const path of localPaths) {
    try {
      const module = await import(path);
      pipelineFn = module.pipeline;
      envConfig = module.env;
      libraryLoaded = true;
      console.log(`[Transcription Worker] Library loaded from: ${path}`);
      return true;
    } catch (err) {
      // This path didn't work — try next
      continue;
    }
  }

  // Strategy 2: Try CDN (only works if manifest CSP allows it)
  try {
    const module = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    pipelineFn = module.pipeline;
    envConfig = module.env;
    libraryLoaded = true;
    console.log('[Transcription Worker] Library loaded from CDN');
    return true;
  } catch (err) {
    // CDN blocked by CSP — expected
  }

  // All strategies failed
  postError(
    'Transcription library not found. Please install it by running:\n' +
    '  cd silentscribe && npm install @xenova/transformers\n' +
    'Then copy the dist files to silentscribe/lib/ directory.\n' +
    'See the README for setup instructions.'
  );
  return false;
}


// ============================================================================
// MODEL MANAGEMENT
// ============================================================================

/**
 * Configure ONNX Runtime so it can run inside a Manifest V3 extension.
 *
 * Two defaults are wrong here and both are fatal:
 *
 * 1. THREADED WASM SPAWNS A BLOB WORKER. ONNX Runtime's multi-threaded backend
 *    builds its worker from a Blob URL and calls importScripts() on it. The MV3
 *    content security policy is `script-src 'self' 'wasm-unsafe-eval'`, which
 *    does not permit blob: scripts, and MV3 forbids adding blob: to that
 *    policy. The load fails with:
 *      NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'
 *    Pinning to a single thread means the worker is never created. Inference
 *    is slower, but it runs at all, which single-threaded WASM does correctly.
 *
 * 2. THE .wasm IS FETCHED FROM A CDN. By default the runtime downloads about
 *    10 MB from jsdelivr on every cold start, so transcription needs the
 *    network and breaks whenever the CDN is unreachable. The binaries ship in
 *    lib/, so point the loader at the extension's own copy. The URL is derived
 *    from this worker's own location because chrome.runtime is not dependable
 *    inside a dedicated worker.
 *
 * @param {Object} env - The `env` export from @xenova/transformers.
 * @returns {void}
 */
function configureOnnxRuntime(env) {
  const wasm = env.backends?.onnx?.wasm;
  if (!wasm) {
    console.warn('[Transcription Worker] ONNX wasm settings not found; using defaults');
    return;
  }

  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.wasmPaths = new URL('../lib/', self.location.href).href;

  // Quiet the graph optimizer. Loading Whisper emits a run of
  // "[W:onnxruntime:...] Removing initializer ... not used by any node"
  // warnings, which are the optimizer reporting normal work on the published
  // model — nothing is wrong and there is nothing to fix. Chrome collects
  // extension warnings into the Errors list on chrome://extensions, so leaving
  // them on buries real failures under noise that looks alarming and is not.
  const onnx = env.backends?.onnx;
  if (onnx) onnx.logLevel = 'error';

  console.log(`[Transcription Worker] ONNX configured: 1 thread, wasm from ${wasm.wasmPaths}`);
}


/**
 * Load the Whisper model or reuse a cached instance.
 * 
 * On first run, this downloads the model weights (~75MB for whisper-tiny)
 * from Hugging Face Hub and caches them in the browser's Cache API.
 * Subsequent calls load from cache instantly.
 * 
 * Posts progress updates during download for the side panel progress bar.
 * 
 * @returns {Promise<Object>} The loaded Whisper pipeline.
 * @throws {Error} If model loading fails.
 */
async function loadModel(modelId = DEFAULT_MODEL_ID) {
  // A different model than the cached one means the pipeline must be rebuilt.
  if (whisperPipeline && loadedModelId === modelId) {
    console.log('[Transcription Worker] Reusing cached Whisper pipeline');
    return whisperPipeline;
  }
  if (whisperPipeline) {
    console.log(`[Transcription Worker] Model changed to ${modelId} — rebuilding pipeline`);
    await whisperPipeline.dispose?.();
    whisperPipeline = null;
  }

  if (!libraryLoaded) {
    const loaded = await loadLibrary();
    if (!loaded) throw new Error('Transcription library not available');
  }

  postProgress(0.05, 'Loading Whisper model...');

  // Configure the transformers.js environment
  if (envConfig) {
    // Allow running in a worker context
    envConfig.allowLocalModels = false;
    envConfig.useBrowserCache = true;
    configureOnnxRuntime(envConfig);
  }

  // Per-file byte counters for this load.
  const downloadedFiles = new Map();

  try {
    // Create the ASR pipeline with progress callback
    whisperPipeline = await pipelineFn(
      'automatic-speech-recognition',
      modelId,
      {
        progress_callback: (progressData) => {
          // progressData is { status, name, file, progress, loaded, total } and
          // arrives PER FILE. Whisper is several files, so reporting whichever
          // one spoke last showed two different downloads' numbers side by side
          // ("54% 24%") and sent the bar backwards every time a new file began.
          // 'done' also fires per file, which used to jump the bar to 40% while
          // most of the model was still downloading.
          //
          // Summing bytes across every file seen so far gives one honest number.
          const fraction = aggregateDownload(downloadedFiles, progressData);
          if (fraction === null) return;

          // No percentage in the text: the panel appends its own, which is how
          // one number became two.
          postProgress(0.05 + fraction * 0.35, 'Downloading the speech model — first run only');
        },
      }
    );

    // Reported here rather than from the progress callback: 'done' fires once
    // per file, so announcing completion there claimed the model was ready
    // while most of it was still downloading.
    postProgress(0.4, 'Speech model ready');

    loadedModelId = modelId;
    console.log(`[Transcription Worker] Whisper pipeline loaded successfully (${modelId})`);
    return whisperPipeline;

  } catch (err) {
    console.error('[Transcription Worker] Model loading failed:', err);
    throw new Error(`Failed to load Whisper model: ${err.message}`);
  }
}


// ============================================================================
// TRANSCRIPTION
// ============================================================================

/**
 * Transcribe PCM audio data using the Whisper model.
 * 
 * Takes a Float32Array of 16kHz mono PCM audio and produces an array
 * of transcript segments with timestamps.
 * 
 * The @xenova/transformers pipeline handles:
 * - Chunking long audio into 30-second windows
 * - Overlapping chunks by 5 seconds for better boundary handling
 * - Merging overlapping segments
 * - Generating timestamps for each segment
 * 
 * @param {Float32Array} pcmData - 16kHz mono PCM audio data.
 * @param {string} sessionId - Session ID for tagging the result.
 * @param {string} [modelId] - Whisper model to use. Defaults to DEFAULT_MODEL_ID.
 * @returns {Promise<Object[]>} Array of transcript segments:
 *   [{start: number, end: number, text: string, confidence?: number}]
 */
async function transcribe(pcmData, sessionId, modelId) {
  console.log(`[Transcription Worker] Starting transcription — ${pcmData.length} samples (${(pcmData.length / 16000).toFixed(1)}s of audio)`);

  const pipeline = await loadModel(modelId);
  postProgress(0.45, 'Transcribing audio...');

  try {
    // Run Whisper inference
    let tokensGenerated = 0;
    const result = await pipeline(pcmData, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: null, // Auto-detect language
      callback_function: (beams) => {
        tokensGenerated++;
        // Very rough estimate: each token adds a tiny bit of progress
        // We cap it at 0.85 so it doesn't reach 100% until actually done
        const p = Math.min(0.85, 0.45 + (tokensGenerated * 0.0005));
        postProgress(p, 'Transcribing audio...');
      }
    });

    postProgress(0.9, 'Processing results...');

    // Parse the pipeline output into our segment format.
    // The output format from @xenova/transformers is:
    // { text: string, chunks: [{text: string, timestamp: [start, end]}] }
    let segments = [];

    if (result && result.chunks && Array.isArray(result.chunks)) {
      // Chunk-level timestamps available
      segments = result.chunks
        .filter((chunk) => chunk.text && chunk.text.trim().length > 0)
        .map((chunk) => ({
          start: chunk.timestamp[0] || 0,
          end: chunk.timestamp[1] || chunk.timestamp[0] + 5,
          text: chunk.text.trim(),
          confidence: null, // Whisper via transformers.js doesn't expose per-chunk confidence
        }));
    } else if (result && result.text) {
      // No chunk-level timestamps — wrap entire text as one segment
      const durationSeconds = pcmData.length / 16000;
      segments = [{
        start: 0,
        end: durationSeconds,
        text: result.text.trim(),
        confidence: null,
      }];
    }

    // Filter out segments that are just whitespace or very short
    segments = segments.filter((seg) => seg.text.length > 1);

    console.log(`[Transcription Worker] Transcription complete — ${segments.length} segments`);
    postProgress(1.0, 'Complete');

    return segments;

  } catch (err) {
    console.error('[Transcription Worker] Transcription failed:', err);
    throw new Error(`Whisper inference failed: ${err.message}`);
  }
}


// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Handle messages from the offscreen document.
 * 
 * Expected message format:
 * {
 *   type: 'START_TRANSCRIPTION',
 *   payload: {
 *     sessionId: string,
 *     pcmData: ArrayBuffer,  // Transferred (zero-copy)
 *     sampleRate: number     // Expected: 16000
 *   }
 * }
 */
self.onmessage = async function handleWorkerMessage(event) {
  const { type, payload } = event.data;

  if (type === 'RUN_SELF_TEST') {
    await selfTest();
    return;
  }

  // Live transcription: one short slice of audio while recording continues.
  // Deliberately best-effort — a failed slice is skipped rather than reported,
  // because the authoritative transcript is produced after the recording ends
  // and a live preview must never interfere with capture.
  if (type === 'TRANSCRIBE_CHUNK') {
    if (chunkBusy) return;
    chunkBusy = true;

    try {
      const pipeline = await loadModel(payload.modelId);
      const result = await pipeline(payload.pcmChunk, {
        language: null,
        task: 'transcribe',
        chunk_length_s: 30,
      });

      const text = String(result?.text || '').trim();
      if (text) {
        self.postMessage({ type: 'TRANSCRIPTION_CHUNK_RESULT', payload: { text } });
      }
    } catch (err) {
      console.warn('[Transcription Worker] Live chunk failed:', err.message);
    } finally {
      chunkBusy = false;
    }
    return;
  }

  if (type !== 'START_DUAL_TRANSCRIPTION') {
    console.warn(`[Transcription Worker] Unknown message type: ${type}`);
    return;
  }

  const { sessionId, primaryPcmData, micPcmData, primaryOffsetMs, micOffsetMs, sampleRate, modelId } = payload;

  try {
    const primaryPcm = new Float32Array(primaryPcmData);
    const micPcm = new Float32Array(micPcmData);
    let allSegments = [];
    
    // 1. Transcribe Primary Track (Desktop/Others)
    if (primaryPcm.length >= sampleRate * 0.5) {
      console.log(`[Transcription Worker] Processing Primary Track...`);
      const primarySegments = await transcribe(primaryPcm, sessionId, modelId);
      
      // Apply offset and hard speaker label
      primarySegments.forEach(seg => {
        seg.start += (primaryOffsetMs / 1000);
        seg.end += (primaryOffsetMs / 1000);
        seg.speaker = 'Others';
      });
      allSegments.push(...primarySegments);
    }

    // 2. Transcribe Mic Track (Me)
    if (micPcm.length >= sampleRate * 0.5) {
      console.log(`[Transcription Worker] Processing Mic Track...`);
      // Re-initialize progress or just let it overwrite
      const micSegments = await transcribe(micPcm, sessionId, modelId);
      
      // Apply offset and hard speaker label
      micSegments.forEach(seg => {
        seg.start += (micOffsetMs / 1000);
        seg.end += (micOffsetMs / 1000);
        seg.speaker = 'Me';
      });
      allSegments.push(...micSegments);
    }

    // No speech is a valid outcome, not a failure. Posting an error here sent
    // the extension to the ERROR view and invited the user to retry, which
    // would produce the same empty result every time. Return an empty
    // transcript instead; the recording is still saved and playable.
    if (allSegments.length === 0) {
      console.log('[Transcription Worker] No speech detected — returning an empty transcript.');
    }

    // 3. Merge and sort chronologically
    allSegments.sort((a, b) => a.start - b.start);

    // Send completed transcript back to the offscreen document
    self.postMessage({
      type: 'TRANSCRIPTION_COMPLETE',
      payload: {
        sessionId,
        segments: allSegments,
      },
    });

  } catch (err) {
    postError(err.message || 'Transcription failed with an unknown error.');
  }
};


// ============================================================================
// PROGRESS & ERROR HELPERS
// ============================================================================

/**
 * Fold one per-file progress event into an overall download fraction.
 *
 * Transformers.js reports progress PER FILE, and Whisper is several files. The
 * old code reported whichever file spoke last, so the label showed two
 * different downloads' numbers at once ("54% 24%") and the bar jumped backwards
 * whenever a new file began. Its `done` event fires per file too, which used to
 * announce the model as ready while most of it was still downloading.
 *
 * Summing bytes across every file seen so far gives one honest number.
 *
 * @param {Map<string, {loaded: number, total: number}>} files - Accumulator, mutated.
 * @param {{status: string, file?: string, loaded?: number, total?: number}} event
 * @returns {number|null} Fraction 0–0.99, or null when there is nothing to report.
 */
export function aggregateDownload(files, event) {
  const { status, file, loaded, total } = event || {};
  if (!file) return null;

  if (status === 'initiate' || status === 'progress') {
    files.set(file, { loaded: loaded || 0, total: total || 0 });
  } else if (status === 'done') {
    // A finished file counts as fully loaded even when no size was reported.
    const seen = files.get(file);
    const size = seen?.total || seen?.loaded || 0;
    files.set(file, { loaded: size, total: size });
  } else {
    return null;
  }

  let loadedBytes = 0;
  let totalBytes = 0;
  for (const entry of files.values()) {
    loadedBytes += entry.loaded;
    totalBytes += entry.total;
  }
  if (totalBytes <= 0) return null;

  // Capped below 1: files are discovered as they start, so the first one to
  // finish would otherwise read as the whole model being ready. Completion is
  // announced once, after the pipeline resolves.
  return Math.min(0.99, loadedBytes / totalBytes);
}


/**
 * Post a progress update to the offscreen document.
 * 
 * @param {number} progress - Progress value (0 to 1).
 * @param {string} status - Human-readable status message.
 */
function postProgress(progress, status) {
  self.postMessage({
    type: 'TRANSCRIPTION_PROGRESS',
    payload: { progress, status },
  });
}


/**
 * Post an error to the offscreen document.
 * 
 * @param {string} errorMessage - Human-readable error description.
 */
function postError(errorMessage) {
  self.postMessage({
    type: 'TRANSCRIPTION_ERROR',
    payload: { error: errorMessage },
  });
}

/**
 * Run a self-test to verify the library and model can be loaded.
 */
async function selfTest() {
  try {
    console.log('[Transcription Worker] Running self-test...');
    await loadModel();
    console.log('[Transcription Worker] Self-test passed: Model loaded successfully');
    self.postMessage({ type: 'TRANSCRIPTION_SELF_TEST_OK' });
  } catch (err) {
    console.error('[Transcription Worker] Self-test failed:', err);
    postError(`Self-test failed: ${err.message}`);
  }
}
