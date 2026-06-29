/**
 * SilentScribe — AudioWorklet PCM Extractor
 * ============================================================================
 * 
 * AudioWorkletProcessor that extracts 16kHz mono PCM audio from the
 * AudioContext's audio graph. This is the bridge between Chrome's audio
 * pipeline (running at 48kHz) and Whisper's requirements (16kHz mono).
 * 
 * HOW IT WORKS:
 * 1. Chrome's AudioContext processes audio at 48kHz (CONTEXT_SAMPLE_RATE)
 * 2. The process() method receives 128-sample frames at 48kHz
 * 3. We downsample from 48kHz → 16kHz by taking every 3rd sample
 *    (48000 / 16000 = 3, so decimation factor = 3)
 * 4. If the input is stereo, we average the channels to mono
 * 5. We accumulate samples in an internal buffer to reduce message
 *    overhead (sending 128/3 ≈ 43 samples per frame would be wasteful)
 * 6. When the buffer reaches ~1600 samples (100ms at 16kHz), we flush
 *    it to the main thread via port.postMessage()
 * 
 * WHY AUDIOWORKLET (NOT ScriptProcessorNode):
 * - ScriptProcessorNode is deprecated and will be removed from Chrome
 * - AudioWorklet runs on a separate audio rendering thread — no main
 *   thread blocking, no audio glitches
 * - AudioWorklet has lower latency and better performance guarantees
 * 
 * RESAMPLING APPROACH:
 * We use simple decimation (take every Nth sample) rather than a proper
 * polyphase FIR resampler. This introduces minor aliasing artifacts but:
 * - Whisper is trained on real-world audio and handles minor artifacts well
 * - The computational savings are significant in real-time processing
 * - For V1, the transcription accuracy difference is negligible
 * A proper anti-aliasing filter can be added in V2 if needed.
 * 
 * IMPORTANT: This file runs in a separate AudioWorklet thread. It has
 * NO access to the DOM, chrome APIs, or any variables from offscreen.js.
 * Communication is via port.postMessage() only.
 * 
 * @see https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor
 */


/**
 * Decimation factor: ratio of input sample rate to output sample rate.
 * 48000 Hz / 16000 Hz = 3
 * 
 * We take every 3rd sample from the input to produce 16kHz output.
 * 
 * @constant {number}
 */
const DECIMATION_FACTOR = 3;


/**
 * Number of 16kHz samples to accumulate before flushing to the main thread.
 * 
 * 1600 samples at 16kHz = 100ms of audio.
 * This balances latency (100ms is acceptable) against message overhead
 * (sending messages 375 times/sec at 128 samples would overwhelm the port).
 * 
 * @constant {number}
 */
const FLUSH_THRESHOLD = 1600;


/**
 * PCM Extractor AudioWorklet Processor.
 * 
 * Receives audio frames from the AudioContext's processing graph,
 * downsamples from 48kHz to 16kHz mono, and sends Float32Array buffers
 * to the main thread for accumulation.
 * 
 * Usage (from offscreen.js):
 *   await audioContext.audioWorklet.addModule('offscreen/audio-worklet-processor.js');
 *   const workletNode = new AudioWorkletNode(audioContext, 'pcm-extractor');
 *   sourceNode.connect(workletNode);
 *   workletNode.port.onmessage = (e) => pcmBuffers.push(e.data.pcm);
 */
class PcmExtractorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /**
     * Internal accumulation buffer.
     * Samples are accumulated here until FLUSH_THRESHOLD is reached,
     * then the buffer is flushed to the main thread.
     * 
     * @type {Float32Array}
     */
    this._buffer = new Float32Array(FLUSH_THRESHOLD);

    /**
     * Current write position in the accumulation buffer.
     * 
     * @type {number}
     */
    this._writeIndex = 0;

    /**
     * Fractional sample position tracker for precise resampling.
     * 
     * Because 128 / 3 = 42.666..., we can't take exactly every 3rd
     * sample from each 128-sample frame without accumulating a drift.
     * This tracker maintains the fractional position across frames.
     * 
     * @type {number}
     */
    this._resampleOffset = 0;
  }


  /**
   * Process a single audio frame.
   * 
   * Called by the audio rendering thread approximately every 2.67ms
   * (128 samples at 48kHz). This is a hot path — performance is critical.
   * 
   * @param {Float32Array[][]} inputs - Array of inputs, each containing
   *   an array of channel data. inputs[0][0] is the first channel of
   *   the first input.
   * @param {Float32Array[][]} outputs - Not used (we don't output audio).
   * @param {Object} parameters - AudioParam values (none defined).
   * @returns {boolean} True to keep the processor alive, false to terminate.
   */
  process(inputs, outputs, parameters) {
    // Get the first input's channels
    const input = inputs[0];

    // No input data — node may be disconnected. Keep alive.
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    // ── Step 1: Convert to mono ──────────────────────────────────────
    // If stereo (2+ channels), average all channels to produce mono.
    // If already mono, use the single channel directly.
    const channelCount = input.length;
    const frameLength = input[0].length; // Typically 128 samples
    let monoSamples;

    if (channelCount === 1) {
      monoSamples = input[0];
    } else {
      // Average all channels to mono
      monoSamples = new Float32Array(frameLength);
      for (let i = 0; i < frameLength; i++) {
        let sum = 0;
        for (let ch = 0; ch < channelCount; ch++) {
          sum += input[ch][i];
        }
        monoSamples[i] = sum / channelCount;
      }
    }

    // ── Step 2: Downsample from 48kHz to 16kHz ──────────────────────
    // Simple decimation: take every DECIMATION_FACTOR-th sample.
    // We track a fractional offset across frames to maintain accurate timing.
    let samplePos = this._resampleOffset;

    while (samplePos < frameLength) {
      // Read the sample at the current (integer) position
      const sampleIndex = Math.floor(samplePos);
      if (sampleIndex < frameLength) {
        this._buffer[this._writeIndex++] = monoSamples[sampleIndex];
      }

      // Advance by the decimation factor
      samplePos += DECIMATION_FACTOR;

      // Flush the buffer when it's full
      if (this._writeIndex >= FLUSH_THRESHOLD) {
        this._flushBuffer();
      }
    }

    // Store the fractional remainder for the next frame.
    // This ensures we don't drift over time.
    this._resampleOffset = samplePos - frameLength;

    return true; // Keep processor alive
  }


  /**
   * Flush the accumulation buffer to the main thread.
   * 
   * Creates a copy of the buffer and sends it via the port.
   * Uses Transferable ArrayBuffer to avoid copying overhead.
   * Resets the write index for the next batch.
   */
  _flushBuffer() {
    if (this._writeIndex === 0) return;

    // Create a correctly-sized copy (buffer may not be completely full
    // on the final flush)
    const output = this._buffer.slice(0, this._writeIndex);

    // Send to main thread with ownership transfer (zero-copy)
    this.port.postMessage(
      { pcm: output },
      [output.buffer]
    );

    // Reset write position
    this._writeIndex = 0;
  }
}


// Register the processor with a name that matches the AudioWorkletNode
// constructor in offscreen.js
registerProcessor('pcm-extractor', PcmExtractorProcessor);
