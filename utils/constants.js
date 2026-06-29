/**
 * SilentScribe — Shared Constants
 * ============================================================================
 * 
 * Single source of truth for all configuration values shared across the
 * extension's execution contexts. Every magic number, URL pattern, and
 * configuration value lives here.
 * 
 * IMPORT NOTE: This file is imported by the service worker, offscreen
 * document, side panel, and content script. Keep it dependency-free.
 * 
 * @module constants
 */

// ============================================================================
// SESSION STATES
// ============================================================================

/**
 * Provisional and recovery-oriented session states for V2 architecture.
 * @enum {string}
 */
export const SESSION_STATUS = Object.freeze({
  INTENT_CREATED: 'INTENT_CREATED',
  REQUESTING_CAPTURE: 'REQUESTING_CAPTURE',
  STREAM_READY: 'STREAM_READY',
  RECORDING: 'RECORDING',
  STOPPING: 'STOPPING',
  RECORDED: 'RECORDED',
  TRANSCRIBING: 'TRANSCRIBING',
  COMPLETE: 'COMPLETE',
  RECOVERED_PARTIAL: 'RECOVERED_PARTIAL',
  ERROR: 'ERROR'
});

// ============================================================================
// MESSAGE TYPES
// ============================================================================

/**
 * All inter-context message types used across the extension.
 * 
 * Chrome MV3 extensions communicate between contexts via
 * chrome.runtime.sendMessage / onMessage. Every message has a `type`
 * field from this enum and an optional `payload` field.
 * 
 * Naming convention: CONTEXT_ACTION (e.g., OFFSCREEN_START_CAPTURE)
 * 
 * @enum {string}
 */
export const MSG = Object.freeze({
  // ── Service Worker → Offscreen Document ──────────────────────────────
  /** Start audio capture. Payload: { streamId: string, micEnabled: boolean } */
  OFFSCREEN_START_CAPTURE:    'OFFSCREEN_START_CAPTURE',

  /** Stop audio capture and finalize recording. Payload: none */
  OFFSCREEN_STOP_CAPTURE:     'OFFSCREEN_STOP_CAPTURE',

  // ── Offscreen Document → Service Worker ──────────────────────────────
  /** Audio chunk recorded. Payload: { sessionId: string, chunkIndex: number, blob: Blob } */
  CAPTURE_AUDIO_CHUNK:        'CAPTURE_AUDIO_CHUNK',

  /** Recording finalized. All chunks written. Payload: { sessionId: string, pcmData: { mic: Float32Array[], tab: Float32Array[] } } */
  CAPTURE_COMPLETE:           'CAPTURE_COMPLETE',

  /** Capture encountered an error. Payload: { error: string } */
  CAPTURE_ERROR:              'CAPTURE_ERROR',

  /** Audio level update for visualization. Payload: { mic: number, tab: number } (0-1 range) */
  CAPTURE_LEVELS:             'CAPTURE_LEVELS',

  // ── Service Worker → Side Panel ──────────────────────────────────────
  /** State changed. Payload: full state object from state.js */
  STATE_CHANGED:              'STATE_CHANGED',

  // ── Side Panel → Service Worker ──────────────────────────────────────
  /** User clicked record button. Payload: { micEnabled: boolean } */
  UI_START_RECORDING:         'UI_START_RECORDING',

  /** User initiated desktop capture from side panel. Payload: { streamId: string, micEnabled: boolean } */
  UI_START_RECORDING_WITH_STREAM: 'UI_START_RECORDING_WITH_STREAM',

  /** User clicked stop button. Payload: none */
  UI_STOP_RECORDING:          'UI_STOP_RECORDING',

  /** User toggled mic on/off. Payload: { micEnabled: boolean } */
  UI_TOGGLE_MIC:              'UI_TOGGLE_MIC',

  /** User wants to transcribe a session. Payload: { sessionId: string } */
  UI_START_TRANSCRIPTION:     'UI_START_TRANSCRIPTION',

  /** User dismissed an error. Payload: none */
  UI_DISMISS_ERROR:           'UI_DISMISS_ERROR',

  /** User finished onboarding. Payload: none */
  UI_ONBOARDING_COMPLETE:     'UI_ONBOARDING_COMPLETE',

  /** User requests to return to ready state from complete view. Payload: none */
  UI_RETURN_TO_READY:         'UI_RETURN_TO_READY',

  /** User requests export. Payload: { sessionId: string, format: 'txt'|'srt'|'json'|'md' } */
  UI_EXPORT:                  'UI_EXPORT',

  // ── Content Script → Service Worker ──────────────────────────────────
  /** Meeting platform detected. Payload: { platform: string, active: boolean, url: string } */
  MEETING_DETECTED:           'MEETING_DETECTED',

  /** Meeting call state changed (joined/left). Payload: { active: boolean } */
  MEETING_STATE_CHANGED:      'MEETING_STATE_CHANGED',

  // ── Transcription Worker → Offscreen/Service Worker ──────────────────
  /** Model download progress. Payload: { progress: number (0-1), status: string } */
  TRANSCRIPTION_PROGRESS:     'TRANSCRIPTION_PROGRESS',

  /** Transcription of a chunk complete. Payload: { chunkIndex: number, result: TranscriptSegment[] } */
  TRANSCRIPTION_CHUNK_DONE:   'TRANSCRIPTION_CHUNK_DONE',

  /** All transcription complete. Payload: { sessionId: string, transcript: TranscriptSegment[] } */
  TRANSCRIPTION_COMPLETE:     'TRANSCRIPTION_COMPLETE',

  /** Transcription error. Payload: { error: string } */
  TRANSCRIPTION_ERROR:        'TRANSCRIPTION_ERROR',
});


// ============================================================================
// MEETING PLATFORM PATTERNS
// ============================================================================

/**
 * URL patterns and DOM selectors for detecting supported meeting platforms.
 * 
 * Each platform entry contains:
 * - urlPattern: RegExp to match the platform's URL
 * - name: Human-readable platform name
 * - callActiveSelector: CSS selector that's present in the DOM only when
 *   a call/meeting is actively in progress (not just the landing page)
 * - callEndedSelector: CSS selector that appears when a call has ended
 * 
 * IMPORTANT: These selectors are fragile — platforms update their DOM
 * regularly. The content script should fall back to URL-only detection
 * if selectors fail.
 * 
 * @type {Object[]}
 */
export const PLATFORMS = Object.freeze([
  {
    name: 'google-meet',
    urlPattern: /^https:\/\/meet\.google\.com\/.+/,
    // The end-call button (red phone icon) is only present during an active call
    callActiveSelectors: [
      '[data-call-ended]',                           // Data attribute on call container
      'button[aria-label*="Leave call"]',             // Leave call button
      'button[aria-label*="Aramayı bırak"]',         // Turkish
      'div[data-meeting-title]',                      // Meeting title bar
    ],
    // "You left the meeting" / "Meeting ended" screen
    callEndedSelectors: [
      '[data-call-ended="true"]',
      'div[class*="meeting-ended"]',
    ],
  },
  {
    name: 'zoom',
    urlPattern: /^https:\/\/([\w-]+\.)?zoom\.us\/.+/,
    callActiveSelectors: [
      '#foot-bar',                                    // Zoom's bottom toolbar
      '.meeting-app',                                 // Main meeting container
      'button[aria-label*="Leave"]',                  // Leave meeting button
    ],
    callEndedSelectors: [
      '.meeting-ended',
    ],
  },
  {
    name: 'teams',
    urlPattern: /^https:\/\/([\w-]+\.)?teams\.microsoft\.com\/.+/,
    callActiveSelectors: [
      '#calling-container',                           // Teams call container
      'button[aria-label*="Hang up"]',                // Hang up button
      '[data-tid="calling-pre-join-screen"]',         // Pre-join screen
    ],
    callEndedSelectors: [
      '[data-tid="call-ended"]',
    ],
  },
  {
    name: 'webex',
    urlPattern: /^https:\/\/([\w-]+\.)?webex\.com\/.+/,
    callActiveSelectors: [
      '.meeting-controls-container',
      'button[aria-label*="Leave meeting"]',
    ],
    callEndedSelectors: [],
  },
]);


// ============================================================================
// AUDIO CONFIGURATION
// ============================================================================

/**
 * Audio capture and processing configuration.
 * 
 * These values are tuned for Whisper model compatibility and Chrome's
 * AudioWorklet performance characteristics.
 */
export const AUDIO_CONFIG = Object.freeze({
  /** 
   * Target sample rate for Whisper transcription (Hz).
   * Whisper models require exactly 16kHz mono PCM input.
   * The AudioWorklet downsamples from the AudioContext's native rate
   * (typically 48kHz) to this value.
   */
  WHISPER_SAMPLE_RATE: 16000,

  /**
   * AudioContext sample rate (Hz).
   * Chrome defaults to 48kHz on most systems. We don't override this
   * because the AudioWorklet handles resampling.
   */
  CONTEXT_SAMPLE_RATE: 48000,

  /**
   * Number of audio channels. Whisper requires mono.
   * Stereo input is averaged to mono in the AudioWorklet.
   */
  CHANNELS: 1,

  /**
   * MediaRecorder chunk interval (ms).
   * ondataavailable fires every N ms, producing one WebM blob.
   * 10 seconds balances storage granularity vs overhead.
   */
  RECORDER_TIMESLICE_MS: 10_000,

  /**
   * Transcription chunk duration (seconds).
   * PCM audio is sliced into chunks of this length before being
   * sent to Whisper. 30s is Whisper's native window size.
   */
  TRANSCRIPTION_CHUNK_DURATION: 30,

  /**
   * MediaRecorder MIME type and codec for the primary stream.
   * Includes vp8 for video and opus for audio.
   */
  RECORDER_MIME_TYPE: 'video/webm;codecs=vp8,opus',

  /**
   * MediaRecorder MIME type and codec for the microphone stream.
   * Audio-only (opus).
   */
  MIC_RECORDER_MIME_TYPE: 'audio/webm;codecs=opus',

  /**
   * Voice Activity Detection threshold (dB).
   * RMS energy below this threshold is considered silence.
   * -40 dB is conservative — catches quiet speech without triggering
   * on ambient noise in most environments.
   */
  VAD_THRESHOLD_DB: -40,

  /**
   * VAD frame size (ms).
   * Energy is computed per frame of this duration.
   * 50ms provides good temporal resolution for speaker turn detection.
   */
  VAD_FRAME_MS: 50,

  /**
   * Audio level meter update interval (ms).
   * How often the offscreen document sends level updates to the
   * side panel for visualization.
   */
  LEVEL_UPDATE_INTERVAL_MS: 100,
});


// ============================================================================
// WHISPER CONFIGURATION
// ============================================================================

/**
 * Whisper model configuration for @xenova/transformers.
 */
export const WHISPER_CONFIG = Object.freeze({
  /**
   * Hugging Face model identifier for Whisper Base.
   * ~145MB download, slightly slower than tiny but significantly better accuracy.
   */
  MODEL_ID: 'Xenova/whisper-base',

  /**
   * Task type for the transformers.js pipeline.
   */
  TASK: 'automatic-speech-recognition',

  /**
   * Generation options passed to Whisper during inference.
   */
  GENERATION_OPTIONS: {
    /** Return word-level or chunk-level timestamps */
    return_timestamps: true,

    /** Chunk length in seconds for long-form transcription */
    chunk_length_s: 30,

    /** Stride (overlap) between chunks for better boundary handling */
    stride_length_s: 5,

    /** Language hint — null for auto-detect, 'en' for English-only */
    language: null,
  },
});


// ============================================================================
// STORAGE CONFIGURATION
// ============================================================================

/**
 * IndexedDB database and object store configuration.
 */
export const STORAGE_CONFIG = Object.freeze({
  /** Database name. */
  DB_NAME: 'SilentScribeDB',
  /** 
   * Database version. Increment this when changing the schema.
   * V1 -> V2: Removed AUDIO_CHUNKS and PCM_DATA, migrated to OPFS.
   */
  DB_VERSION: 2,
  /** Object store names. */
  STORES: {
    SESSIONS: 'sessions',
    TRANSCRIPTS: 'transcripts',
  },
});


// ============================================================================
// OFFSCREEN DOCUMENT
// ============================================================================

/**
 * Offscreen document configuration.
 */
export const OFFSCREEN_CONFIG = Object.freeze({
  /** Path to the offscreen document HTML file (relative to extension root) */
  URL: 'offscreen/offscreen.html',

  /**
   * Reasons for creating the offscreen document.
   * Chrome requires at least one valid reason from the OffscreenReason enum.
   * USER_MEDIA: We use getUserMedia for mic capture.
   * AUDIO_PLAYBACK: We route tab audio back to speakers.
   */
  REASONS: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'DISPLAY_MEDIA'],

  /** Justification string shown in Chrome's task manager */
  JUSTIFICATION: 'SilentScribe: Audio capture, mixing, and recording for meeting transcription.',

  /**
   * Keepalive ping interval (ms).
   * The offscreen document sends a ping on the port at this interval
   * to keep the service worker alive. Chrome kills idle service workers
   * after ~30s; pinging every 20s prevents this.
   */
  KEEPALIVE_INTERVAL_MS: 20_000,
});


// ============================================================================
// UI CONFIGURATION
// ============================================================================

/**
 * Side panel UI configuration values.
 */
export const UI_CONFIG = Object.freeze({
  /**
   * Recording timer update interval (ms).
   * How often the elapsed-time display refreshes during recording.
   */
  TIMER_UPDATE_MS: 1000,

  /**
   * Maximum number of past sessions to show in the session list.
   */
  MAX_SESSIONS_DISPLAYED: 50,

  /**
   * Default speaker labels used before the user renames them.
   */
  DEFAULT_SPEAKERS: {
    SELF: 'Me',
    OTHERS: 'Others',
  },
});
