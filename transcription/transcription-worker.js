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
async function loadModel() {
  if (whisperPipeline) {
    console.log('[Transcription Worker] Reusing cached Whisper pipeline');
    return whisperPipeline;
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
  }

  try {
    // Create the ASR pipeline with progress callback
    whisperPipeline = await pipelineFn(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny',
      {
        progress_callback: (progressData) => {
          // progressData can be: { status, name, file, progress, loaded, total }
          if (progressData.status === 'progress' && progressData.progress != null) {
            // Map download progress (0-100) to our progress range (0.05-0.4)
            const downloadProgress = 0.05 + (progressData.progress / 100) * 0.35;
            postProgress(downloadProgress, `Downloading model: ${Math.round(progressData.progress)}%`);
          } else if (progressData.status === 'done') {
            postProgress(0.4, 'Model loaded');
          } else if (progressData.status === 'initiate') {
            postProgress(0.05, `Loading: ${progressData.file || 'model files'}...`);
          }
        },
      }
    );

    console.log('[Transcription Worker] Whisper pipeline loaded successfully');
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
 * @returns {Promise<Object[]>} Array of transcript segments:
 *   [{start: number, end: number, text: string, confidence?: number}]
 */
async function transcribe(pcmData, sessionId) {
  console.log(`[Transcription Worker] Starting transcription — ${pcmData.length} samples (${(pcmData.length / 16000).toFixed(1)}s of audio)`);

  const pipeline = await loadModel();
  postProgress(0.45, 'Transcribing audio...');

  try {
    // Run Whisper inference
    let tokensGenerated = 0;
    const result = await pipeline(pcmData, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: null, // Auto-detect language
      
      // Hallucination mitigation:
      repetition_penalty: 1.1,
      no_repeat_ngram_size: 4,

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

    // Filter out repetitive hallucinations (exact consecutive duplicates)
    const cleanedSegments = [];
    let lastText = null;
    for (const seg of segments) {
      // Basic normalization for comparison (lowercase, remove punctuation)
      const normalizedText = seg.text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      if (normalizedText !== lastText) {
        cleanedSegments.push(seg);
        lastText = normalizedText;
      }
    }
    segments = cleanedSegments;

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

  if (type === 'TRANSCRIBE_CHUNK') {
    try {
      const { pcmChunk } = payload;
      const pipeline = await loadModel();
      const result = await pipeline(pcmChunk, {
        language: null, // Auto-detect
        task: 'transcribe',
        chunk_length_s: 30, // Helps with boundaries
      });
      if (result && result.text && result.text.trim().length > 0) {
        postMessage({
          type: 'TRANSCRIPTION_CHUNK_RESULT',
          payload: { text: result.text.trim() }
        });
      }
    } catch (err) {
      console.error('[Transcription Worker] Chunk error', err);
    }
    return;
  }

  if (type !== 'START_DUAL_TRANSCRIPTION') {
    console.warn(`[Transcription Worker] Unknown message type: ${type}`);
    return;
  }

  const { sessionId, primaryPcmData, micPcmData, primaryOffsetMs, micOffsetMs, sampleRate } = payload;

  try {
    const primaryPcm = new Float32Array(primaryPcmData);
    const micPcm = new Float32Array(micPcmData);
    let allSegments = [];
    
    // 1. Transcribe Primary Track (Desktop/Others)
    if (primaryPcm.length >= sampleRate * 0.5) {
      console.log(`[Transcription Worker] Processing Primary Track...`);
      const primarySegments = await transcribe(primaryPcm, sessionId);
      
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
      const micSegments = await transcribe(micPcm, sessionId);
      
      // Apply offset and hard speaker label
      micSegments.forEach(seg => {
        seg.start += (micOffsetMs / 1000);
        seg.end += (micOffsetMs / 1000);
        seg.speaker = 'Me';
      });
      allSegments.push(...micSegments);
    }

    if (allSegments.length === 0) {
      postError('No speech detected in either track.');
      return;
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
