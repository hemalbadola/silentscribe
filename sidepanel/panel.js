/**
 * SilentScribe — Side Panel Controller
 * ============================================================================
 *
 * The sole user-facing surface of the extension. Manages six exclusive views
 * driven by the extension's state machine, handles user interactions, and
 * communicates with the service worker via chrome.runtime messaging.
 *
 * ARCHITECTURE:
 * - Reads state from chrome.storage.session (never writes it directly).
 * - Sends user-intent messages (MSG.UI_*) to the service worker.
 * - Receives STATE_CHANGED, CAPTURE_LEVELS, and TRANSCRIPTION_PROGRESS
 *   messages to update the UI reactively.
 *
 * @module panel
 */

import { MSG, UI_CONFIG } from '../utils/constants.js';
import { STATES, getState } from '../utils/state.js';
import {
  getSessions,
  getSession,
  getTranscript,
  updateSpeakerNames,
  updateSessionPlatform,
  updateSessionMeetingTitle,
  updateTranscriptSegment,
  mergeTranscriptSegments,
  splitTranscriptSegment,
  saveAiInsights,
  addBookmark,
  removeBookmark,
  deleteSession,
} from '../storage/db.js';
import { readFile } from '../storage/opfs.js';
import { exportTxt, exportSrt, exportJson, exportMd } from '../utils/export.js';
import {
  generateAiNotes,
  checkAiAvailability,
  generateAiTitle,
  generateAiPlatform,
} from '../utils/ai.js';
import { renderMarkdown } from '../utils/markdown.js';
import { collectDiagnostics, explainError } from '../utils/diagnostics.js';
import {
  PROVIDERS,
  WIRE_FORMATS,
  getLlmConfig,
  setLlmConfig,
  listModels,
  testConnection,
} from '../utils/llm.js';
import { initShortcutSetup } from './shortcut-setup.js';
import { renderOnboarding, isOnboardingComplete, resetOnboarding } from './onboarding.js';


// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Prefix for all console output from this module. */
const LOG_PREFIX = '[SilentScribe Panel]';

/** Slices kept in the live transcript before the oldest are dropped. */
const LIVE_TRANSCRIPT_MAX_SLICES = 40;

/**
 * Maps each extension state to the corresponding view element ID.
 * IDLE and PERMISSIONS_NEEDED both show the onboarding screen because
 * the user experience is identical — grant or skip mic permission.
 *
 * @type {Object<string, string>}
 */
/**
 * The state name currently drawn on screen.
 *
 * Guards against re-rendering for a broadcast that only carried new metadata.
 * @type {string|null}
 */
let renderedState = null;

/**
 * True while the user is watching a recording they opened from their history,
 * rather than one they just made. A transcript finishing in the background
 * broadcasts COMPLETE, and without this that broadcast swapped the video out
 * from under them for a different recording entirely.
 * @type {boolean}
 */
let viewingFromHistory = false;

/**
 * The view currently on screen, and the one Settings covered.
 *
 * Settings is an overlay, so closing it has to return to whatever was
 * underneath. It used to do that by re-running handleStateTransition, which
 * deliberately ignores a state it is already showing — so with the panel
 * already on READY the close button did nothing at all.
 * @type {string|null}
 */
let currentView = null;
let viewBeforeSettings = null;


const STATE_VIEW_MAP = {
  [STATES.IDLE]:               'view-onboarding',
  [STATES.PERMISSIONS_NEEDED]: 'view-onboarding',
  [STATES.READY]:              'view-ready',
  [STATES.RECORDING]:          'view-recording',
  // There is no transcription screen: the recording plays while the
  // transcript is generated behind it. A stale PROCESSING state lands here too.
  [STATES.PROCESSING]:         'view-complete',
  [STATES.COMPLETE]:           'view-complete',
  [STATES.ERROR]:              'view-error',
};

/**
 * Cached map of export format → formatter function.
 * Avoids a switch/if-chain in handleExport().
 *
 * @type {Object<string, Function>}
 */
const EXPORT_FORMATTERS = {
  txt:  exportTxt,
  srt:  exportSrt,
  json: exportJson,
  md:   exportMd,
};

/**
 * MIME types corresponding to each export format, used when creating
 * download blobs.
 *
 * @type {Object<string, string>}
 */
const EXPORT_MIME_TYPES = {
  txt:  'text/plain',
  srt:  'text/srt',
  json: 'application/json',
  md:   'text/markdown',
};


// ═══════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL STATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * setInterval ID for the recording timer. Stored so we can clear it
 * when the user stops recording.
 *
 * @type {number|null}
 */
let timerIntervalId = null;

/**
 * Unix timestamp (ms) when the current recording started. Received
 * from the state object's `recordingStartTime` field.
 *
 * @type {number|null}
 */
let recordingStartTime = null;

/**
 * The session ID currently being viewed in the COMPLETE view.
 * Used by export and playback functions.
 *
 * @type {string|null}
 */
let activeSessionId = null;

/**
 * Object URL for the audio player. Must be revoked when no longer
 * needed to avoid memory leaks.
 *
 * @type {string|null}
 */
let audioObjectUrl = null;

/**
 * Cached DOM element references. Populated once in initialize() to
 * avoid repeated querySelector calls during hot paths (level meters,
 * timer updates).
 *
 * @type {Object<string, HTMLElement>}
 */
const dom = {};

/**
 * AbortController for the note generation currently running, or null.
 * Lets the Cancel button stop a long map-reduce run mid-way.
 *
 * @type {AbortController|null}
 */
let aiRunController = null;

/**
 * Session whose transcription is running in the background, or null.
 * Mirrored from extension state so the transcript tab can show progress for
 * the session on screen and nothing for any other.
 *
 * @type {string|null}
 */
let transcribingSessionId = null;

/**
 * Message from the last failed transcription, or null.
 *
 * @type {string|null}
 */
let transcriptionError = null;

/**
 * What the open recording's transcript actually contains.
 *
 * renderTranscriptTabState needs these to pick a mode, and they were
 * previously passed straight into a second function that toggled cards on its
 * own — which is how two owners of the same cards came about.
 */
let transcriptionErrorSessionId = null;
let transcriptSegmentCount = 0;
let transcriptSessionTranscribed = false;

/**
 * Results of the last diagnostics run, kept so Copy report can serialise them.
 *
 * @type {Object[]|null}
 */
let lastDiagnostics = null;

/**
 * True while a metadata regeneration is in flight, so the chip cannot be
 * clicked into two concurrent runs.
 *
 * @type {boolean}
 */
let regeneratingMetadata = false;


// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entry point. Called on DOMContentLoaded.
 *
 * 1. Caches DOM references.
 * 2. Reads the current extension state and shows the correct view.
 * 3. Registers event listeners for all interactive elements.
 * 4. Subscribes to state changes and runtime messages.
 * 5. Pre-loads the session list for the ready view.
 *
 * @returns {Promise<void>}
 */
async function initialize() {
  console.log(LOG_PREFIX, 'Initializing side panel');

  cacheDomReferences();
  setupEventListeners();
  setupMessageListener();
  // Fire and forget. The module handles its own failures, but the call is
  // unawaited, so catch here too rather than risk an unhandled rejection.
  initShortcutSetup(document.getElementById('shortcut-setup'))
    .catch((err) => console.warn(LOG_PREFIX, 'Shortcut card failed to render:', err));

  try {
    const state = await getState();
    console.log(LOG_PREFIX, 'Current state:', state.state);
    
    // Fast-forward past onboarding if permission is already granted — but not
    // on a first run. Granting the microphone in a previous install is not the
    // same as having been told what this extension does.
    const tourPending = !(await isOnboardingComplete());

    if (!tourPending && (state.state === STATES.IDLE || state.state === STATES.PERMISSIONS_NEEDED)) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        if (status.state === 'granted') {
          console.log(LOG_PREFIX, 'Mic permission already granted, skipping onboarding');
          sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled: true });
          sendMessage(MSG.UI_ONBOARDING_COMPLETE);
          // The service worker will handle this and broadcast STATE_CHANGED
          // which will automatically switch us to the READY view.
        }
      } catch (e) {
        // Ignore if permissions API fails
      }
    }

    // Opening the panel is not the same as finishing a recording. The state is
    // kept for the whole browser session, so a panel reopened hours later used
    // to land straight on the last recording's video with no way back to the
    // list — and the shortcut was dead for the same reason, because nothing
    // ever left COMPLETE. Start where the user can act: the recordings list.
    if (state.state === STATES.COMPLETE || state.state === STATES.PROCESSING) {
      console.log(LOG_PREFIX, `Opening on the recordings list rather than restoring ${state.state}`);
      // Only COMPLETE is safe to clear. PROCESSING means a transcript is still
      // being written, and that run owns the state until it finishes.
      if (state.state === STATES.COMPLETE) sendMessage(MSG.UI_DISMISS_ERROR);
      showView('view-ready');
      loadSessionList();
      syncMicToggle(state.micEnabled);
    } else {
      handleStateTransition(state);
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to read initial state:', err);
    showView('view-error');
    showError(null, {
      title: 'The extension could not start',
      cause: 'Its saved state could not be read.',
      action: 'Reload the extension at chrome://extensions, then reopen this panel.',
    });
  }

  // Deliberately NOT also subscribing with onStateChange(). setState() and
  // updateMetadata() each write chrome.storage.session AND broadcast
  // STATE_CHANGED, so listening to both ran every transition twice — two view
  // renders, two session-list loads, and for a finished recording two full
  // reads out of OPFS with two object URLs, one of which leaked.
  // setupMessageListener() handles STATE_CHANGED, which is the same protocol
  // every other message in this panel uses.
}


/**
 * Cache frequently-accessed DOM elements into the `dom` object.
 * Called once during initialization — never re-queried afterward.
 *
 * @returns {void}
 */
function cacheDomReferences() {
  // Views
  dom.views = document.querySelectorAll('.view');

  // Onboarding
  dom.btnGrantPermission = document.getElementById('btn-grant-permission');
  dom.btnSkipPermission  = document.getElementById('btn-skip-permission');

  // Ready
  dom.toggleMic       = document.getElementById('toggle-mic');
  dom.micStatusLabel   = document.getElementById('mic-status-label');
  dom.sessionList      = document.getElementById('session-list');
  dom.noSessionsMsg    = document.getElementById('no-sessions-msg');

  // Recording
  dom.timerDisplay     = document.getElementById('timer-display');
  dom.meterTab         = document.getElementById('meter-tab');
  dom.meterMic         = document.getElementById('meter-mic');
  dom.platformLabel    = document.getElementById('platform-label');
  dom.platformName     = document.getElementById('platform-name');
  dom.btnStop          = document.getElementById('btn-stop');
  dom.btnStopVideoOnly = document.getElementById('btn-stop-video-only');
  dom.liveTranscript   = document.getElementById('live-transcript');
  dom.liveTranscriptText = document.getElementById('live-transcript-text');
  dom.toggleLiveTranscript = document.getElementById('toggle-live-transcript');

  // Processing
  dom.progressBar      = document.getElementById('progress-bar');
  dom.progressLabel    = document.getElementById('progress-label');

  // Complete
  dom.completeDuration = document.getElementById('complete-duration');
  dom.completePlatform = document.getElementById('complete-platform');
  dom.completeDate     = document.getElementById('complete-date');
  dom.completeTitle    = document.getElementById('complete-title');
  dom.transcriptContainer = document.getElementById('transcript-container');
  dom.noTranscriptMsg  = document.getElementById('no-transcript-msg');
  dom.transcribePrompt = document.getElementById('transcribe-prompt');
  dom.btnTranscribeNow = document.getElementById('btn-transcribe-now');
  dom.transcribePromptText = document.querySelector('#transcribe-prompt .transcribe-prompt-text');
  dom.transcribePromptHint = document.querySelector('#transcribe-prompt .transcribe-prompt-hint');
  dom.transcriptProgress = document.getElementById('transcript-progress');
  dom.transcriptError    = document.getElementById('transcript-error');
  dom.transcriptErrorText = document.getElementById('transcript-error-text');
  dom.btnRetryTranscription = document.getElementById('btn-retry-transcription');
  dom.transcriptErrorTitle  = document.getElementById('transcript-error-title');
  dom.transcriptErrorAction = document.getElementById('transcript-error-action');
  dom.transcriptErrorDetails = document.getElementById('transcript-error-details');
  dom.transcriptErrorRaw    = document.getElementById('transcript-error-raw');

  // Diagnostics
  dom.btnRunDiagnostics  = document.getElementById('btn-run-diagnostics');
  dom.btnCopyDiagnostics = document.getElementById('btn-copy-diagnostics');
  dom.diagnosticsResults = document.getElementById('diagnostics-results');
  dom.searchContainer  = document.getElementById('transcript-search-container');
  dom.mediaPlayer      = document.getElementById('media-player');
  dom.btnNewRecording  = document.getElementById('btn-new-recording');
  dom.btnBackComplete  = document.getElementById('btn-back-complete');

  // Error
  dom.errorTitle       = document.getElementById('error-title');
  dom.errorMessage     = document.getElementById('error-message');
  dom.errorAction      = document.getElementById('error-action');
  dom.errorRawDetails  = document.getElementById('error-raw-details');
  dom.errorRaw         = document.getElementById('error-raw');
  dom.btnDismissError  = document.getElementById('btn-dismiss-error');

  // Settings
  dom.btnRecord       = document.getElementById('btn-record');
  dom.recordHint      = document.getElementById('record-hint');
  dom.btnOpenInTab    = document.getElementById('btn-open-in-tab');
  dom.btnSettingsOpen  = document.getElementById('btn-settings-open');
  dom.btnSettingsClose = document.getElementById('btn-settings-close');
  dom.settingsRadios   = document.querySelectorAll('input[name="model-size"]');

  // Tabs
  dom.tabBtnTranscript = document.getElementById('tab-btn-transcript');
  dom.tabBtnAi         = document.getElementById('tab-btn-ai');
  dom.tabContentTranscript = document.getElementById('tab-content-transcript');
  dom.tabContentAi     = document.getElementById('tab-content-ai');

  // AI Notes
  dom.aiUninitialized  = document.getElementById('ai-uninitialized');
  dom.aiLoading        = document.getElementById('ai-loading');
  dom.aiError          = document.getElementById('ai-error');
  dom.aiNotesContainer = document.getElementById('ai-notes-container');
  dom.btnGenerateAi    = document.getElementById('btn-generate-ai');
  dom.btnRetryAi       = document.getElementById('btn-retry-ai');

  dom.aiHelpText       = document.getElementById('ai-help-text');
  dom.aiProgressText   = document.getElementById('ai-progress-text');
  dom.btnCancelAi      = document.getElementById('btn-cancel-ai');

  // Bookmarks
  dom.bookmarksContainer = document.getElementById('bookmarks-container');
  dom.btnAddBookmark   = document.getElementById('btn-add-bookmark');

  // BYOK provider settings
  dom.llmProvider      = document.getElementById('llm-provider');
  dom.llmFormat        = document.getElementById('llm-format');
  dom.llmFormatField   = document.getElementById('field-llm-format');
  dom.llmBaseUrl       = document.getElementById('llm-base-url');
  dom.llmApiKey        = document.getElementById('llm-api-key');
  dom.llmModel         = document.getElementById('llm-model');
  dom.llmModelOptions  = document.getElementById('llm-model-options');
  dom.llmByokFields    = document.getElementById('llm-byok-fields');
  dom.llmNote          = document.getElementById('llm-note');
  dom.llmKeysLink      = document.getElementById('link-provider-keys');
  dom.btnToggleKey     = document.getElementById('btn-toggle-key');
  dom.btnLoadModels    = document.getElementById('btn-load-models');
  dom.btnTestLlm       = document.getElementById('btn-test-llm');
  dom.llmTestResult    = document.getElementById('llm-test-result');
}


// ═══════════════════════════════════════════════════════════════════════════
// VIEW MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the guided tour on first use, or fall back to the plain permission ask.
 *
 * The tour explains what is recorded, what leaves the machine, and that the
 * first transcription downloads a large model — all things that previously
 * surfaced only as a surprise later on.
 *
 * @returns {Promise<void>}
 */
async function showOnboarding() {
  const tour = document.getElementById('onboarding-tour');
  const basic = document.getElementById('onboarding-basic');
  if (!tour || !basic) return;

  try {
    if (await isOnboardingComplete()) {
      tour.hidden = true;
      basic.hidden = false;
      return;
    }

    tour.hidden = false;
    basic.hidden = true;
    await renderOnboarding(tour, { onComplete: finishOnboarding });
  } catch (err) {
    // A tour that cannot render must never block setup.
    console.warn(LOG_PREFIX, 'Onboarding tour failed, showing the basic screen:', err);
    tour.hidden = true;
    basic.hidden = false;
  }
}


/**
 * Leave onboarding for the ready view.
 *
 * Hiding the tour is not enough on its own: the panel only changes view when
 * the service worker broadcasts a new state, so without UI_ONBOARDING_COMPLETE
 * the last button appeared to do nothing at all. The tour has already explained
 * what the microphone is for, so whatever Chrome says about it now is the
 * user's answer, and either answer moves on.
 *
 * @returns {Promise<void>}
 */
async function finishOnboarding() {
  let micEnabled = false;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    micEnabled = status.state === 'granted';
  } catch {
    // Permissions API unavailable here; record without the microphone.
  }

  console.log(LOG_PREFIX, `Onboarding finished (microphone: ${micEnabled ? 'on' : 'off'})`);
  sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled });
  sendMessage(MSG.UI_ONBOARDING_COMPLETE);

  // Restore the plain card underneath, so a dropped message leaves a usable
  // screen instead of an empty one.
  const tour = document.getElementById('onboarding-tour');
  const basic = document.getElementById('onboarding-basic');
  if (tour) tour.hidden = true;
  if (basic) basic.hidden = false;
}


/**
 * Show exactly one view section, hiding all others. Adds/removes the
 * `.active` class for CSS transition animation.
 *
 * @param {string} viewId - The DOM id of the section to show (e.g., 'view-ready').
 * @returns {void}
 */
function showView(viewId) {
  dom.views.forEach((view) => {
    if (view.id === viewId) {
      view.removeAttribute('hidden');
      // Force reflow so the CSS transition triggers
      void view.offsetHeight;
      view.classList.add('active');
    } else {
      view.classList.remove('active');
      // Delay adding hidden to allow the fade-out transition to complete
      view.setAttribute('hidden', '');
    }
  });

  currentView = viewId;
  console.log(LOG_PREFIX, 'View switched to:', viewId);
}


/**
 * Respond to a state change from the state machine. Switches the view,
 * starts/stops timers, and loads data as needed.
 *
 * @param {Object} stateObj - Full state object from chrome.storage.session.
 * @param {string} stateObj.state - Current state name from STATES enum.
 * @param {string|null} stateObj.sessionId - Active or last session ID.
 * @param {string|null} stateObj.error - Error message (when state is ERROR).
 * @param {number|null} stateObj.recordingStartTime - Unix ms timestamp.
 * @param {boolean} stateObj.micEnabled - Whether mic is toggled on.
 * @param {string|null} stateObj.platform - Detected meeting platform.
 * @returns {void}
 */
function handleStateTransition(stateObj) {
  const viewId = STATE_VIEW_MAP[stateObj.state];
  if (!viewId) {
    console.warn(LOG_PREFIX, 'Unknown state, cannot map to view:', stateObj.state);
    return;
  }

  // updateMetadata() broadcasts the same way setState() does, so an AI title
  // landing, or a platform being detected, arrives here looking like a
  // transition. Re-running the full switch on one of those rebuilt the view
  // and reset activeSessionId — which threw the user out of whatever recording
  // they had opened from their history, mid-watch. Only the light parts should
  // follow a metadata change.
  if (stateObj.state === renderedState) {
    syncMicToggle(stateObj.micEnabled);
    if (stateObj.state === STATES.RECORDING) showPlatformBadge(stateObj.platform);
    return;
  }

  // A background transcript finishing must not replace the recording the user
  // deliberately opened. A new recording starting still wins, because that is
  // the user acting.
  if (viewingFromHistory && (stateObj.state === STATES.COMPLETE || stateObj.state === STATES.PROCESSING)) {
    console.log(LOG_PREFIX, `Staying on the opened recording despite a ${stateObj.state} broadcast`);
    renderedState = stateObj.state;
    return;
  }

  renderedState = stateObj.state;
  viewingFromHistory = false;

  showView(viewId);

  switch (stateObj.state) {
    case STATES.IDLE:
    case STATES.PERMISSIONS_NEEDED:
      showOnboarding();
      break;

    case STATES.READY:
      stopRecordingTimer();
      revokeAudioUrl();
      loadSessionList();
      syncMicToggle(stateObj.micEnabled);
      break;

    case STATES.RECORDING:
      recordingStartTime = stateObj.recordingStartTime;
      startRecordingTimer();
      syncMicToggle(stateObj.micEnabled);
      showPlatformBadge(stateObj.platform);
      resetLiveTranscript();
      // Re-arm both stop buttons for this recording.
      dom.btnStop.disabled = false;
      if (dom.btnStopVideoOnly) dom.btnStopVideoOnly.disabled = false;
      break;

    case STATES.PROCESSING:
      // Reachable only from an older stored state. Treat it as COMPLETE.
      stopRecordingTimer();
      activeSessionId = stateObj.sessionId;
      loadCompleteView(stateObj.sessionId);
      break;

    case STATES.COMPLETE:
      stopRecordingTimer();
      activeSessionId = stateObj.sessionId;
      transcribingSessionId = stateObj.transcribingSessionId || null;
      transcriptionError = stateObj.transcriptionError || null;
      transcriptionErrorSessionId = stateObj.transcriptionErrorSessionId || null;
      loadCompleteView(stateObj.sessionId);
      break;

    case STATES.ERROR:
      stopRecordingTimer();
      showError(stateObj.error);
      break;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bind all static UI event listeners. Called once during initialization.
 * Dynamic listeners (session cards, speaker labels) are attached when
 * those elements are rendered.
 *
 * @returns {void}
 */
function setupEventListeners() {
  // ── Onboarding ─────────────────────────────────────────────────────
  dom.btnGrantPermission.addEventListener('click', handleGrantPermission);
  dom.btnSkipPermission.addEventListener('click', handleSkipPermission);

  // ── Ready View ──
  dom.btnRecord?.addEventListener('click', handleStartRecording);

  // Fullscreen is not available to a side panel at all, so this hands the
  // recording to a normal tab rather than pretending the button works.
  dom.btnOpenInTab?.addEventListener('click', () => {
    if (!activeSessionId) return;
    chrome.tabs.create({ url: chrome.runtime.getURL(`player/player.html?session=${encodeURIComponent(activeSessionId)}`) });
  });

  // ── Error View ──
  dom.btnDismissError.addEventListener('click', () => {
    sendMessage(MSG.UI_DISMISS_ERROR);
  });

  // ── Settings View ──
  dom.btnSettingsOpen?.addEventListener('click', () => {
    viewBeforeSettings = currentView;
    showView('view-settings');
  });

  dom.btnSettingsClose?.addEventListener('click', () => {
    // Go back to whatever Settings covered. Deliberately not routed through
    // handleStateTransition: that ignores a state already on screen, which is
    // correct for a broadcast and made this button dead.
    const back = viewBeforeSettings && viewBeforeSettings !== 'view-settings'
      ? viewBeforeSettings
      : 'view-ready';
    viewBeforeSettings = null;
    if (back === 'view-ready') loadSessionList();
    showView(back);
  });

  dom.settingsRadios?.forEach(radio => {
    radio.addEventListener('change', async (e) => {
      if (e.target.checked) {
        await chrome.storage.local.set({ modelSize: e.target.value });
        console.log(LOG_PREFIX, 'Saved model size:', e.target.value);
      }
    });
  });

  // Load existing setting on startup
  chrome.storage.local.get(['modelSize']).then(result => {
    if (result.modelSize) {
      dom.settingsRadios?.forEach(radio => {
        if (radio.value === result.modelSize) radio.checked = true;
      });
    }
  });

  setupLlmSettings();

  // Live transcript preference. The offscreen document reads this when a
  // recording starts, so a change takes effect on the next recording.
  chrome.storage.local.get('liveTranscript').then(({ liveTranscript }) => {
    if (dom.toggleLiveTranscript) dom.toggleLiveTranscript.checked = Boolean(liveTranscript);
  });

  dom.toggleLiveTranscript?.addEventListener('change', (event) => {
    chrome.storage.local.set({ liveTranscript: event.target.checked });
  });

  chrome.storage.local.get('transcriptCleanup').then(({ transcriptCleanup }) => {
    const box = document.getElementById('toggle-transcript-cleanup');
    if (box) box.checked = Boolean(transcriptCleanup);
  });

  document.getElementById('toggle-transcript-cleanup')?.addEventListener('change', (event) => {
    chrome.storage.local.set({ transcriptCleanup: event.target.checked });
  });

  document.getElementById('btn-replay-onboarding')?.addEventListener('click', async () => {
    await resetOnboarding();
    showView('view-onboarding');
    showOnboarding();
  });

  // ── Ready ──────────────────────────────────────────────────────────
  dom.toggleMic.addEventListener('change', handleMicToggle);

  // ── Recording ──────────────────────────────────────────────────────
  dom.btnStop.addEventListener('click', () => handleStopRecording(true));
  dom.btnStopVideoOnly?.addEventListener('click', () => handleStopRecording(false));

  // ── Complete ───────────────────────────────────────────────────────
  dom.btnNewRecording.addEventListener('click', handleNewRecording);
  dom.btnBackComplete.addEventListener('click', () => {
    viewingFromHistory = false;
    renderedState = STATES.READY;
    loadSessionList();
    showView('view-ready');
  });

  // Sync transcript highlighting with video playback
  dom.mediaPlayer.addEventListener('timeupdate', () => {
    const currentTime = dom.mediaPlayer.currentTime;
    const segments = dom.transcriptContainer.querySelectorAll('.transcript-segment');
    
    segments.forEach(segmentEl => {
      const start = parseFloat(segmentEl.dataset.start);
      const end = parseFloat(segmentEl.dataset.end);
      
      if (currentTime >= start && currentTime < end) {
        segmentEl.classList.add('active-segment');
      } else {
        segmentEl.classList.remove('active-segment');
      }
    });
  });

  // Export buttons — use event delegation on the export row
  document.querySelector('.export-row')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-export');
    if (btn) handleExport(btn.dataset.format);
  });

  // ── Search ─────────────────────────────────────────────────────────
  const searchInput = document.getElementById('transcript-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      handleTranscriptSearch(e.target.value);
    });
  }

  // ── Tabs ───────────────────────────────────────────────────────────
  dom.tabBtnTranscript?.addEventListener('click', () => switchTab('transcript'));
  dom.tabBtnAi?.addEventListener('click', () => switchTab('ai'));

  // ── AI Notes ───────────────────────────────────────────────────────
  dom.btnGenerateAi?.addEventListener('click', handleGenerateAiNotes);
  dom.btnRetryAi?.addEventListener('click', handleGenerateAiNotes);
  dom.btnCancelAi?.addEventListener('click', () => aiRunController?.abort());

  // ── Regenerate title and platform from the transcript ──────────────
  dom.completePlatform?.addEventListener('click', handleRegenerateMetadata);
  dom.completePlatform?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleRegenerateMetadata();
    }
  });

  // ── Transcribe a saved recording ───────────────────────────────────
  dom.btnTranscribeNow?.addEventListener('click', handleTranscribeNow);
  dom.btnRetryTranscription?.addEventListener('click', handleTranscribeNow);

  // ── Diagnostics ────────────────────────────────────────────────────
  dom.btnRunDiagnostics?.addEventListener('click', handleRunDiagnostics);
  dom.btnCopyDiagnostics?.addEventListener('click', handleCopyDiagnostics);

  // ── Bookmarks ──────────────────────────────────────────────────────
  dom.btnAddBookmark?.addEventListener('click', handleAddBookmark);

  // ── Error ──────────────────────────────────────────────────────────
  dom.btnDismissError.addEventListener('click', handleDismissError);
}


/**
 * Listen for chrome.runtime messages from the service worker.
 * Handles level updates, transcription progress, and state broadcasts.
 *
 * @returns {void}
 */
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case MSG.STATE_CHANGED:
        handleStateTransition(message.payload);
        break;

      case MSG.CAPTURE_LEVELS:
        updateLevelMeters(message.payload);
        break;

      case MSG.TRANSCRIPTION_PROGRESS:
        // Live preview slices arrive on the same channel as the post-recording
        // progress bar, distinguished by isRealTime.
        if (message.payload?.isRealTime) {
          appendLiveTranscript(message.payload.text);
        } else {
          updateProgressBar(message.payload);
        }
        break;

      case MSG.TRANSCRIPTION_COMPLETE:
        // Background work finished. Refresh in place only if the user is still
        // looking at that recording; otherwise the session list picks it up.
        transcribingSessionId = null;
        transcriptionError = null;
        transcriptionErrorSessionId = null;
        if (message.payload?.sessionId === activeSessionId) {
          loadCompleteView(activeSessionId);
        }
        break;

      case MSG.TRANSCRIPTION_ERROR:
        transcribingSessionId = null;
        transcriptionError = message.payload?.error || 'Transcription failed.';
        transcriptionErrorSessionId = message.payload?.sessionId || null;
        if (activeSessionId) renderTranscriptTabState();
        break;

      default:
        // Ignore messages not relevant to the side panel
        break;
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request microphone permission via getUserMedia. On success, notifies
 * the service worker to transition to READY. On failure, shows the
 * error in the onboarding card.
 *
 * @returns {Promise<void>}
 */
async function handleGrantPermission() {
  console.log(LOG_PREFIX, 'Requesting microphone permission');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop all tracks immediately — we just needed the permission prompt
    stream.getTracks().forEach((track) => track.stop());
    console.log(LOG_PREFIX, 'Microphone permission granted');
    
    // Nudge service worker to transition to READY
    sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled: true });
    sendMessage(MSG.UI_ONBOARDING_COMPLETE);

    // If we are in a standalone tab (not the side panel), close ourselves
    chrome.tabs.getCurrent((tab) => {
      if (tab) chrome.tabs.remove(tab.id);
    });

  } catch (err) {
    console.error(LOG_PREFIX, 'Microphone permission denied:', err);
    
    chrome.tabs.getCurrent((tab) => {
      if (!tab) {
        // We are in the side panel. Chrome blocks permission prompts here.
        // Show a message in the side panel so the user isn't confused
        if (dom.errorMessage) {
          showError(null, {
            title: 'Microphone permission needs a full tab',
            cause: 'Chrome does not allow a side panel to request microphone access.',
            action: 'A new tab has been opened. Grant access there, then come back.',
          });
        }
        showView('view-error');
        // Open the panel in a full tab to show the prompt.
        chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/panel.html') });
      } else {
        // We are in a full tab, meaning the user actually clicked "Block"
        if (dom.errorMessage) {
          showError(null, {
            title: 'Microphone access was denied',
            cause: 'Chrome is blocking this extension from using the microphone.',
            action: 'Click the tune icon in the address bar, allow the microphone, then reload.',
          });
        }
        showView('view-error');
      }
    });
  }
}


/**
 * Skip microphone permission — user wants tab-only recording.
 * Tells the service worker to transition to READY with mic disabled.
 *
 * @returns {void}
 */
function handleSkipPermission() {
  console.log(LOG_PREFIX, 'User skipped mic permission');
  sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled: false });
  sendMessage(MSG.UI_ONBOARDING_COMPLETE);
}


/**
 * Start recording. Reads the current mic toggle state and sends
 * UI_START_RECORDING to the service worker.
 *
 * This was deleted once, on the reasoning that the UI no longer used it. The
 * UI had no other way in: with the button gone the keyboard shortcut was the
 * only route to a recording, and that shortcut is unbound on any machine where
 * another extension claimed the same keys. The extension looked completely
 * inert to those users.
 *
 * @returns {void}
 */
async function handleStartRecording() {
  const micEnabled = dom.toggleMic ? dom.toggleMic.checked : true;
  console.log(LOG_PREFIX, `Start recording requested (mic: ${micEnabled ? 'on' : 'off'})`);

  // A start takes a moment to acquire the tab. Disable straight away so a
  // second click cannot open a second capture over the first.
  if (dom.btnRecord) dom.btnRecord.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      type: MSG.UI_START_RECORDING,
      payload: { micEnabled, source: 'panel' },
    });

    // Chrome accepts only four gestures as invoking an extension: the action,
    // a context menu item, a commands-API shortcut, and an omnibox suggestion.
    // A button in the side panel is none of them, so this panel can never grant
    // activeTab and tab capture from here always needs the picker instead.
    if (result?.needsPicker) {
      await startWithPicker(micEnabled);
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Start request failed:', err.message);
  } finally {
    if (dom.btnRecord) dom.btnRecord.disabled = false;
  }
}


/**
 * Ask Chrome which tab or window to record, then start with that stream.
 *
 * chrome.desktopCapture needs no activeTab grant — the user picking a source in
 * Chrome's own dialog IS the permission. It is the only route to a recording
 * that works from the side panel.
 *
 * @param {boolean} micEnabled - Whether to record the microphone too.
 * @returns {Promise<void>}
 */
async function startWithPicker(micEnabled) {
  const streamId = await new Promise((resolve) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(
        ['tab', 'audio', 'window', 'screen'],
        (id) => resolve(id || null),
      );
    } catch (err) {
      console.warn(LOG_PREFIX, 'Could not open the picker:', err.message);
      resolve(null);
    }
  });

  if (!streamId) {
    // Cancelling is a choice, not a failure. Say so where the button is,
    // rather than throwing up the full error screen.
    console.log(LOG_PREFIX, 'Source picker dismissed');
    if (dom.recordHint) {
      dom.recordHint.textContent = 'No source chosen. Press Start Recording and pick the meeting tab, '
        + 'or right-click the page and choose SilentScribe.';
      dom.recordHint.hidden = false;
    }
    return;
  }

  if (dom.recordHint) dom.recordHint.hidden = true;
  sendMessage(MSG.UI_START_RECORDING_WITH_STREAM, { streamId, micEnabled, mode: 'tab-video' });
}


/**
 * Stop recording. Sends UI_STOP_RECORDING to the service worker.
 *
 * @returns {void}
 */
function handleStopRecording(transcribe = true) {
  console.log(LOG_PREFIX, `Stop recording requested (transcribe: ${transcribe})`);

  // Both stop buttons write the same message; only the flag differs. Disable
  // them straight away so a double click cannot send two stops.
  dom.btnStop.disabled = true;
  if (dom.btnStopVideoOnly) dom.btnStopVideoOnly.disabled = true;

  sendMessage(MSG.UI_STOP_RECORDING, { transcribe });
}


/**
 * Transcribe the recording currently on screen.
 *
 * Used for recordings saved without transcription, and to re-run transcription
 * on an old session. The service worker moves the extension to PROCESSING and
 * the offscreen document does the work.
 *
 * @returns {void}
 */
function handleTranscribeNow() {
  if (!activeSessionId) return;

  console.log(LOG_PREFIX, 'Transcription requested for session:', activeSessionId);
  if (dom.btnTranscribeNow) dom.btnTranscribeNow.disabled = true;
  if (dom.btnRetryTranscription) dom.btnRetryTranscription.disabled = true;

  transcriptionError = null;
  transcribingSessionId = activeSessionId;
  renderTranscriptTabState();

  sendMessage(MSG.UI_START_TRANSCRIPTION, { sessionId: activeSessionId });
}


/**
 * Handle mic toggle change. Sends the new state to the service worker
 * and updates the status label.
 *
 * @returns {void}
 */
function handleMicToggle() {
  const micEnabled = dom.toggleMic.checked;
  dom.micStatusLabel.textContent = micEnabled ? 'On' : 'Off';
  sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled });
}


/**
 * Return to the READY state for a new recording. Sends UI_DISMISS_ERROR
 * which the service worker interprets as "go back to READY".
 *
 * @returns {void}
 */
async function handleNewRecording() {
  console.log(LOG_PREFIX, 'New recording requested or Back button clicked');
  revokeAudioUrl();
  
  const stateObj = await getState();
  if (stateObj.state === STATES.READY) {
    // If we were just viewing a past session, the global state is already READY.
    // Transitioning to READY won't trigger an event, so we must update the UI manually.
    showView('view-ready');
  } else {
    // If we just finished a recording or are in an error state, ask SW to reset to READY
    sendMessage(MSG.UI_DISMISS_ERROR);
  }
}


/**
 * Dismiss an error and return to READY state.
 *
 * @returns {void}
 */
function handleDismissError() {
  console.log(LOG_PREFIX, 'Dismissing error');
  sendMessage(MSG.UI_DISMISS_ERROR);
}


/**
 * Export the current transcript in the requested format. Creates a
 * download blob and triggers a click on a temporary anchor element.
 *
 * @param {string} format - One of 'txt', 'srt', 'json', 'md'.
 * @returns {Promise<void>}
 */
async function handleExport(format) {
  if (!activeSessionId) {
    console.warn(LOG_PREFIX, 'No active session for export');
    return;
  }

  // The video is the recording itself, so it exports even when there is no
  // transcript — which is now a normal state, not a failure.
  if (format === 'webm') {
    await exportRecording();
    return;
  }

  const formatter = EXPORT_FORMATTERS[format];
  if (!formatter) {
    console.error(LOG_PREFIX, 'Unknown export format:', format);
    return;
  }

  console.log(LOG_PREFIX, `Exporting as ${format} for session:`, activeSessionId);

  try {
    const [transcript, session] = await Promise.all([
      getTranscript(activeSessionId),
      getSession(activeSessionId),
    ]);

    if (!transcript || !transcript.segments || transcript.segments.length === 0) {
      console.warn(LOG_PREFIX, 'No transcript data to export');
      return;
    }

    const content = formatter(transcript.segments, session);
    const mimeType = EXPORT_MIME_TYPES[format] || 'text/plain';
    const blob = new Blob([content], { type: mimeType });

    triggerDownload(blob, `silentscribe-${formatDateForFilename(session?.startTime)}.${format}`);
  } catch (err) {
    console.error(LOG_PREFIX, 'Export failed:', err);
  }
}


/**
 * Download the raw recording for the session on screen.
 *
 * @returns {Promise<void>}
 */
async function exportRecording() {
  try {
    const [blob, session] = await Promise.all([
      readFile(`session_${activeSessionId}_primary.webm`),
      getSession(activeSessionId),
    ]);

    if (!blob || blob.size === 0) {
      showError(null, {
        title: 'There is no video to export',
        cause: 'No recording file was found for this session.',
        action: 'The capture may have failed. Record again.',
      });
      return;
    }

    // Name it for what it is. Chrome records MP4 where it can and WebM where it
    // cannot, and calling an MP4 ".webm" stops it opening in most players.
    const recorded = session?.metadata?.primaryMimeType || blob.type || '';
    const extension = recorded.includes('mp4') ? 'mp4' : 'webm';

    triggerDownload(blob, `silentscribe-${formatDateForFilename(session?.startTime)}.${extension}`);
  } catch (err) {
    console.error(LOG_PREFIX, 'Video export failed:', err);
  }
}


/**
 * Ask the model to re-read the transcript and name the recording.
 *
 * URL-based platform detection only knows the four meeting sites in the
 * manifest, so anything else records as "unknown". This reads the transcript
 * instead and sets both a title and a category. Both calls fail soft: a
 * provider that is unreachable leaves the existing values alone.
 *
 * @returns {Promise<void>}
 */
async function handleRegenerateMetadata() {
  if (!activeSessionId || regeneratingMetadata) return;

  const platformChip = dom.completePlatform?.querySelector('.chip-text');
  if (!platformChip) return;

  const previousPlatform = platformChip.textContent;
  regeneratingMetadata = true;
  platformChip.textContent = 'Thinking…';

  try {
    const transcript = await getTranscript(activeSessionId);
    if (!transcript?.segments?.length) {
      platformChip.textContent = previousPlatform;
      showError(null, {
        title: 'Nothing to read yet',
        cause: 'This recording has no transcript, so there is nothing to name it from.',
        action: 'Transcribe the recording first, then try again.',
      });
      return;
    }

    const [platform, title] = await Promise.all([
      generateAiPlatform(transcript.segments),
      generateAiTitle(transcript.segments),
    ]);

    if (platform) {
      await updateSessionPlatform(activeSessionId, platform);
      platformChip.textContent = capitalizePlatform(platform);
    } else {
      platformChip.textContent = previousPlatform;
    }

    if (title) {
      await updateSessionMeetingTitle(activeSessionId, title);
      if (dom.completeTitle) dom.completeTitle.textContent = title;
    }

    if (!platform && !title) {
      showError(null, {
        title: 'The model did not return anything usable',
        cause: 'The request completed but produced no title or category.',
        action: 'Check Settings, then run Test connection.',
      });
    }

    loadSessionList();
  } catch (err) {
    console.error(LOG_PREFIX, 'Metadata regeneration failed:', err);
    platformChip.textContent = previousPlatform;
  } finally {
    regeneratingMetadata = false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// RECORDING TIMER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start the elapsed-time timer. Updates the #timer-display every
 * UI_CONFIG.TIMER_UPDATE_MS (1 second). Calculates elapsed time
 * from the state's recordingStartTime so it stays accurate even
 * if the side panel is opened mid-recording.
 *
 * @returns {void}
 */
function startRecordingTimer() {
  // Avoid stacking intervals if called multiple times
  stopRecordingTimer();
  updateTimerDisplay();
  timerIntervalId = setInterval(updateTimerDisplay, UI_CONFIG.TIMER_UPDATE_MS);
}


/**
 * Stop and clear the recording timer interval.
 *
 * @returns {void}
 */
function stopRecordingTimer() {
  if (timerIntervalId !== null) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}


/**
 * Compute elapsed time from recordingStartTime and update the
 * timer display element.
 *
 * @returns {void}
 */
function updateTimerDisplay() {
  if (!recordingStartTime) {
    dom.timerDisplay.textContent = '00:00:00';
    return;
  }

  const elapsedMs = Date.now() - recordingStartTime;
  dom.timerDisplay.textContent = formatDuration(elapsedMs);
}


// ═══════════════════════════════════════════════════════════════════════════
// AUDIO LEVEL METERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update the audio level meter bars. Called on every CAPTURE_LEVELS
 * message from the offscreen document (typically every 100ms).
 *
 * Values are clamped to 0–100 and applied as CSS width percentages.
 * The CSS transition property on .meter-bar smooths the visual update.
 *
 * @param {Object} levels - Audio level data.
 * @param {number} levels.tab - Tab audio level, 0–1 range.
 * @param {number} levels.mic - Microphone audio level, 0–1 range.
 * @returns {void}
 */
function updateLevelMeters(levels) {
  const tabPct = Math.min(100, Math.max(0, (levels.tab || 0) * 100));
  const micPct = Math.min(100, Math.max(0, (levels.mic || 0) * 100));

  dom.meterTab.style.width = `${tabPct}%`;
  dom.meterTab.setAttribute('aria-valuenow', Math.round(tabPct));

  dom.meterMic.style.width = `${micPct}%`;
  dom.meterMic.setAttribute('aria-valuenow', Math.round(micPct));
}


// ═══════════════════════════════════════════════════════════════════════════
// PROGRESS BAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update the transcription progress bar.
 *
 * @param {Object} payload - Progress data.
 * @param {number} payload.progress - Progress value, 0–1 range.
 * @param {string} [payload.status] - Optional status text override.
 * @returns {void}
 */
function updateProgressBar(payload) {
  if (!dom.progressBar) return;

  const pct = Math.min(100, Math.max(0, (payload.progress || 0) * 100));
  dom.progressBar.style.width = `${pct}%`;
  dom.progressBar.setAttribute('aria-valuenow', Math.round(pct));

  // The worker's status is the informative part: it distinguishes a 145 MB
  // first-run model download from actual transcription.
  //
  // A status that already carries its own percentage does not get a second one
  // appended. That is how the label came to read "Downloading model: 54% 24%",
  // two different files' numbers sitting next to each other.
  const status = payload.status || '';
  dom.progressLabel.textContent = /\d\s*%/.test(status)
    ? status
    : `${status ? `${status} ` : ''}${Math.round(pct)}%`;
}


/**
 * Reset the progress bar to 0%.
 *
 * @returns {void}
 */
function resetProgressBar() {
  if (!dom.progressBar) return;
  dom.progressBar.style.width = '0%';
  dom.progressBar.setAttribute('aria-valuenow', '0');
  dom.progressLabel.textContent = 'Starting…';
}


// ═══════════════════════════════════════════════════════════════════════════
// TRANSCRIPT RENDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render a full transcript into the transcript container. Clears any
 * existing content and creates a segment element for each entry.
 *
 * Speaker labels are clickable — clicking one triggers inline renaming.
 *
 * @param {Object[]} segments - Array of transcript segments.
 * @param {number} segments[].start - Segment start time in seconds.
 * @param {number} segments[].end - Segment end time in seconds.
 * @param {string} segments[].speaker - Default speaker label.
 * @param {string} segments[].text - Transcribed text.
 * @param {Object} speakerNames - Map of default label → custom name.
 * @returns {void}
 */
function renderTranscript(segments, speakerNames = {}) {
  // Remove existing segments (keep the no-transcript placeholder)
  const existing = dom.transcriptContainer.querySelectorAll('.transcript-segment');
  existing.forEach((el) => el.remove());

  if (!segments || segments.length === 0) {
    dom.noTranscriptMsg.hidden = false;
    return;
  }
  dom.noTranscriptMsg.hidden = true;

  const fragment = document.createDocumentFragment();

  segments.forEach((segment, index) => {
    const row = document.createElement('div');
    row.className = 'transcript-segment';
    row.dataset.index = index;
    row.dataset.start = segment.start;
    row.dataset.end = segment.end;

    // Timestamp (clickable to seek video)
    const timestamp = document.createElement('span');
    timestamp.className = 'segment-timestamp';
    timestamp.textContent = formatTimestamp(segment.start);
    timestamp.title = 'Click to jump to this point in the video';
    timestamp.style.cursor = 'pointer';
    timestamp.style.textDecoration = 'underline';
    timestamp.addEventListener('click', () => {
      if (dom.mediaPlayer && dom.mediaPlayer.src) {
        dom.mediaPlayer.currentTime = segment.start;
        dom.mediaPlayer.play().catch(e => console.warn('Play failed', e));
      }
    });

    // Speaker label (clickable for renaming)
    const speaker = document.createElement('span');
    speaker.className = 'segment-speaker';
    const displayName = speakerNames[segment.speaker] || segment.speaker;
    speaker.textContent = displayName;
    speaker.dataset.speaker = segment.speaker;
    speaker.title = 'Click to rename speaker';
    speaker.addEventListener('click', () => {
      handleSpeakerRename(activeSessionId, segment.speaker, speaker);
    });

    // Text content (clickable for inline editing)
    const text = document.createElement('p');
    text.className = 'segment-text';
    text.textContent = segment.text;
    text.title = 'Click to edit text';
    text.addEventListener('click', () => {
      handleSegmentEdit(activeSessionId, index, text);
    });

    // Hover Actions
    const actions = document.createElement('div');
    actions.className = 'segment-actions';
    
    if (index > 0) {
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'btn-icon-small';
      mergeBtn.title = 'Merge with previous';
      mergeBtn.textContent = '↑';
      mergeBtn.addEventListener('click', async () => {
        try {
          await mergeTranscriptSegments(activeSessionId, index);
          // Reload the entire transcript view
          populateCompleteView(await getSession(activeSessionId));
        } catch (err) {
          console.error(LOG_PREFIX, 'Failed to merge segments:', err);
        }
      });
      actions.appendChild(mergeBtn);
    }

    row.appendChild(timestamp);
    row.appendChild(speaker);
    row.appendChild(text);
    row.appendChild(actions);
    fragment.appendChild(row);
  });

  dom.transcriptContainer.appendChild(fragment);
}


// ═══════════════════════════════════════════════════════════════════════════
// INLINE EDITING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace a segment's text with an editable textarea.
 * On blur or Enter (without Shift), saves the new text via updateTranscriptSegment.
 * Handles Shift+Enter for splitting segments.
 *
 * @param {string} sessionId - The active session ID.
 * @param {number} segmentIndex - The index of the segment.
 * @param {HTMLElement} textElement - The .segment-text element clicked.
 */
function handleSegmentEdit(sessionId, segmentIndex, textElement) {
  if (textElement.querySelector('textarea')) return;

  const currentText = textElement.textContent;

  const textarea = document.createElement('textarea');
  textarea.className = 'segment-text-edit';
  textarea.value = currentText;
  
  // Auto-resize
  textarea.style.height = `${textElement.offsetHeight}px`;
  
  textElement.textContent = '';
  textElement.appendChild(textarea);
  textarea.focus();
  
  // Place cursor at the click location if possible (browser default behavior usually handles this well enough on focus)
  
  async function commitEdit() {
    const newText = textarea.value.trim();
    textElement.innerHTML = '';
    textElement.textContent = newText || currentText;

    if (newText && newText !== currentText && sessionId) {
      try {
        await updateTranscriptSegment(sessionId, segmentIndex, newText);
        console.log(LOG_PREFIX, `Updated segment ${segmentIndex}`);
      } catch (err) {
        console.error(LOG_PREFIX, 'Failed to save segment edit:', err);
        textElement.textContent = currentText;
      }
    }
  }

  textarea.addEventListener('blur', commitEdit, { once: true });
  textarea.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Handle Split on Shift+Enter
        e.preventDefault();
        const cursorPosition = textarea.selectionStart;
        if (cursorPosition > 0 && cursorPosition < textarea.value.length) {
          // Temporarily save current text state up to this point just in case
          textarea.blur(); // Triggers save
          try {
            await splitTranscriptSegment(sessionId, segmentIndex, cursorPosition);
            // Reload transcript
            populateCompleteView(await getSession(activeSessionId));
          } catch (err) {
            console.error(LOG_PREFIX, 'Failed to split segment:', err);
          }
        }
      } else {
        // Save on normal Enter
        e.preventDefault();
        textarea.blur();
      }
    }
    if (e.key === 'Escape') {
      textElement.textContent = currentText; // Revert
    }
    // Auto-resize as user types
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filter and highlight the transcript based on a search query.
 * 
 * @param {string} query - The search text.
 */
/**
 * Split text into nodes with each match of `query` wrapped for highlighting.
 *
 * Returns DOM nodes rather than an HTML string so no part of the transcript is
 * ever parsed as markup, and no pattern is compiled from user input.
 *
 * @param {string} text - The original segment text.
 * @param {string} textLower - The same text, lowercased, for matching.
 * @param {string} query - The lowercased search query.
 * @returns {Node[]}
 */
function highlightMatches(text, textLower, query) {
  const nodes = [];
  let from = 0;

  for (;;) {
    const at = textLower.indexOf(query, from);
    if (at === -1) break;

    if (at > from) nodes.push(document.createTextNode(text.slice(from, at)));

    const mark = document.createElement('span');
    mark.className = 'search-highlight';
    mark.textContent = text.slice(at, at + query.length);
    nodes.push(mark);

    from = at + query.length;
  }

  if (from < text.length) nodes.push(document.createTextNode(text.slice(from)));
  return nodes;
}


/**
 * Filter and highlight transcript segments against a search query.
 *
 * @param {string} query - Raw text from the search box.
 * @returns {void}
 */
function handleTranscriptSearch(query) {
  const q = query.trim().toLowerCase();
  const segments = dom.transcriptContainer.querySelectorAll('.transcript-segment');
  const noTranscriptMsg = dom.noTranscriptMsg;
  
  if (!segments.length) return;

  let hasVisibleMatches = false;

  segments.forEach((segment) => {
    const textEl = segment.querySelector('.segment-text');
    const speakerEl = segment.querySelector('.segment-speaker');
    const timeEl = segment.querySelector('.segment-timestamp');
    if (!textEl) return;

    // Clear previous highlights
    if (textEl.dataset.originalText) {
      textEl.textContent = textEl.dataset.originalText;
    }

    if (!q) {
      // Clear search
      segment.classList.remove('hidden-by-search');
      hasVisibleMatches = true;
      return;
    }

    const text = textEl.dataset.originalText || textEl.textContent;
    const speaker = (speakerEl?.textContent || '').toLowerCase();
    const time = (timeEl?.textContent || '').toLowerCase();
    const textLower = text.toLowerCase();

    if (textLower.includes(q) || speaker.includes(q) || time.includes(q)) {
      segment.classList.remove('hidden-by-search');
      hasVisibleMatches = true;

      // Save original text for restoring later
      if (!textEl.dataset.originalText) {
        textEl.dataset.originalText = text;
      }

      // Highlight with DOM nodes, not a regex and not innerHTML.
      //
      // The old version compiled the raw query as a pattern, so searching for
      // "(" threw a SyntaxError and broke the box. It also wrote transcript
      // text straight into innerHTML, so anything the speech model produced
      // that looked like markup became live markup in the panel.
      if (textLower.includes(q)) {
        textEl.replaceChildren(...highlightMatches(text, textLower, q));
      }
    } else {
      segment.classList.add('hidden-by-search');
    }
  });

  // Show a message if no results match (using existing noTranscriptMsg or creating one)
  if (!hasVisibleMatches && q) {
    noTranscriptMsg.textContent = 'No matching results found.';
    noTranscriptMsg.hidden = false;
  } else if (hasVisibleMatches) {
    noTranscriptMsg.hidden = true;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// SPEAKER RENAMING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace a speaker label with an inline text input for renaming.
 * On blur or Enter, saves the new name via updateSpeakerNames() and
 * updates all matching labels in the current transcript view.
 *
 * @param {string|null} sessionId - The active session ID.
 * @param {string} defaultLabel - The original speaker label (e.g., 'Me').
 * @param {HTMLElement} element - The .segment-speaker element clicked.
 * @returns {void}
 */
function handleSpeakerRename(sessionId, defaultLabel, element) {
  // Don't re-enter if already editing
  if (element.querySelector('.segment-speaker-input')) return;

  const currentName = element.textContent;

  // Create inline input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'segment-speaker-input';
  input.value = currentName;
  input.setAttribute('aria-label', `Rename speaker ${currentName}`);

  // Replace label text with input
  element.textContent = '';
  element.appendChild(input);
  input.focus();
  input.select();

  /**
   * Commit the rename. Saves to IndexedDB and updates all matching
   * speaker labels in the DOM.
   *
   * @returns {Promise<void>}
   */
  async function commitRename() {
    const newName = input.value.trim() || currentName;
    element.textContent = newName;

    if (newName !== currentName && sessionId) {
      try {
        await updateSpeakerNames(sessionId, { [defaultLabel]: newName });
        console.log(LOG_PREFIX, `Renamed "${defaultLabel}" → "${newName}"`);

        // Update all other instances of this speaker in the transcript
        const allLabels = dom.transcriptContainer.querySelectorAll(
          `.segment-speaker[data-speaker="${defaultLabel}"]`
        );
        allLabels.forEach((label) => {
          // Skip the one we just edited (already updated)
          if (label !== element) label.textContent = newName;
        });
      } catch (err) {
        console.error(LOG_PREFIX, 'Failed to save speaker rename:', err);
        element.textContent = currentName; // Revert on error
      }
    }
  }

  input.addEventListener('blur', commitRename, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur(); // Triggers commitRename via the blur handler
    }
    if (e.key === 'Escape') {
      element.textContent = currentName; // Revert without saving
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// SESSION LIST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load and render the list of past recording sessions in the Ready view.
 * Sessions are ordered by most recent first (handled by db.getSessions).
 *
 * @returns {Promise<void>}
 */
async function loadSessionList() {
  try {
    const sessions = await getSessions(UI_CONFIG.MAX_SESSIONS_DISPLAYED);
    renderSessionList(sessions);
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load sessions:', err);
    dom.noSessionsMsg.hidden = false;
  }
}


/**
 * Render the past recordings list. Each session becomes a clickable card
 * showing date, duration, platform, and transcription status.
 *
 * @param {Object[]} sessions - Array of session records from IndexedDB.
 * @returns {void}
 */
function renderSessionList(sessions) {
  // Remove existing session cards (keep the no-sessions placeholder)
  const existing = dom.sessionList.querySelectorAll('.session-card');
  existing.forEach((el) => el.remove());

  if (!sessions || sessions.length === 0) {
    dom.noSessionsMsg.hidden = false;
    return;
  }
  dom.noSessionsMsg.hidden = true;

  const fragment = document.createDocumentFragment();

  sessions.forEach((session) => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.id;

    // Card body with title and meta
    const body = document.createElement('div');
    body.className = 'session-card-body';

    const title = document.createElement('div');
    title.className = 'session-card-title';
    title.textContent = formatSessionTitle(session);

    // Built from nodes, not an HTML string. `platform` is no longer only a
    // fixed enum from URL detection — generateAiPlatform() can set it from
    // model output, which must never be parsed as markup.
    const meta = document.createElement('div');
    meta.className = 'session-card-meta';
    meta.append(
      spanWithText(session.duration ? formatDuration(session.duration) : '—'),
      spanWithText('·'),
      spanWithText(capitalizePlatform(session.platform)),
    );

    body.appendChild(title);
    body.appendChild(meta);

    // Transcription badge
    const badge = document.createElement('span');
    badge.className = `session-badge ${session.transcribed ? 'session-badge-transcribed' : 'session-badge-pending'}`;
    // "Pending" would be wrong now that skipping transcription is a choice —
    // an untranscribed recording is finished, just without a transcript.
    badge.textContent = session.transcribed ? 'Transcript' : 'Video only';

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-session';
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete recording';
    deleteBtn.setAttribute('aria-label', 'Delete this recording');
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger the card click
      handleDeleteSession(session.id, card);
    });

    card.appendChild(body);
    card.appendChild(badge);
    card.appendChild(deleteBtn);

    // Click card to view session
    card.addEventListener('click', () => handleViewSession(session.id));

    fragment.appendChild(card);
  });

  dom.sessionList.appendChild(fragment);
}


/**
 * Handle clicking a session card — load its transcript (if available)
 * or set up audio playback.
 *
 * @param {string} sessionId - The session to view.
 * @returns {Promise<void>}
 */
async function handleViewSession(sessionId) {
  console.log(LOG_PREFIX, 'Viewing session:', sessionId);
  activeSessionId = sessionId;

  try {
    const session = await getSession(sessionId);
    if (!session) {
      // Clicking a card and getting nothing at all is the worst outcome here.
      showView('view-error');
      showError(null, {
        title: 'That recording could not be opened',
        cause: 'Its entry is in the list, but the recording itself is no longer stored.',
        action: 'Delete it from the list with the ✕ button. Other recordings are unaffected.',
      });
      return;
    }

    // Populate the complete view and switch to it
    await populateCompleteView(session);
    viewingFromHistory = true;
    renderedState = STATES.COMPLETE;
    showView('view-complete');
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load session:', sessionId, err);
    showView('view-error');
    showError(err, {
      title: 'That recording could not be opened',
      action: 'Try another recording. If none open, run Diagnostics in Settings.',
    });
  }
}


/**
 * Delete a session after user confirmation.
 *
 * @param {string} sessionId - The session to delete.
 * @param {HTMLElement} cardElement - The DOM card to remove from the list.
 * @returns {Promise<void>}
 */
async function handleDeleteSession(sessionId, cardElement) {
  // Simple inline confirmation — card fades out
  try {
    await deleteSession(sessionId);
    cardElement.style.opacity = '0';
    cardElement.style.transform = 'translateX(20px)';
    setTimeout(() => cardElement.remove(), 250);
    console.log(LOG_PREFIX, 'Session deleted:', sessionId);

    // Check if list is now empty
    const remaining = dom.sessionList.querySelectorAll('.session-card');
    if (remaining.length <= 1) {
      // The one being removed is still in DOM briefly — check after timeout
      setTimeout(() => {
        const left = dom.sessionList.querySelectorAll('.session-card');
        if (left.length === 0) dom.noSessionsMsg.hidden = false;
      }, 300);
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to delete session:', err);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// COMPLETE VIEW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load all data for the complete view when transitioning from PROCESSING.
 * Delegates to populateCompleteView for the actual rendering.
 *
 * @param {string} sessionId - The session to display.
 * @returns {Promise<void>}
 */
async function loadCompleteView(sessionId) {
  if (!sessionId) {
    console.warn(LOG_PREFIX, 'No session ID for complete view');
    return;
  }

  try {
    const session = await getSession(sessionId);
    if (!session) {
      console.warn(LOG_PREFIX, 'Session not found for complete view:', sessionId);
      return;
    }
    await populateCompleteView(session);
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load complete view:', err);
  }
}


/**
 * Populate all elements in the complete view with session data.
 *
 * @param {Object} session - The session record from IndexedDB.
 * @returns {Promise<void>}
 */
async function populateCompleteView(session) {
  // Session info chips
  const durationChip = dom.completeDuration.querySelector('.chip-text');
  durationChip.textContent = session.duration ? formatDuration(session.duration) : '—';

  const platformChip = dom.completePlatform.querySelector('.chip-text');
  platformChip.textContent = capitalizePlatform(session.platform);

  const dateChip = dom.completeDate.querySelector('.chip-text');
  dateChip.textContent = formatDate(session.startTime);

  if (dom.completeTitle) dom.completeTitle.textContent = formatSessionTitle(session);

  // Transcript
  let segments = [];
  try {
    const transcript = await getTranscript(session.id);
    segments = transcript?.segments || [];
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load transcript:', err);
  }
  renderTranscript(segments, session.speakerNames || {});
  // Transcribed with nothing found is a different state from never transcribed.
  // Offering "Transcribe now" for the first would just repeat an empty result.
  transcriptSegmentCount = segments.length;
  transcriptSessionTranscribed = Boolean(session.transcribed);
  renderTranscriptTabState();

  // Audio player. setupAudioPlayer() keeps the object URL in module state so
  // revokeAudioUrl() can free it — creating one inline here leaked the whole
  // video blob every time a session was opened.
  await setupAudioPlayer(session.id);
  dom.mediaPlayer.dataset.sessionId = dom.mediaPlayer.getAttribute('src') ? session.id : '';

  // Bookmarks
  renderBookmarks(session.bookmarks || []);

  // AI Notes
  renderAiNotesState(session);
}


// ═══════════════════════════════════════════════════════════════════════════
// AUDIO PLAYER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Swap the transcript tab between the transcript itself and the offer to
 * generate one.
 *
 * @param {boolean} show - True when the recording has no transcript.
 * @returns {void}
 */
/**
 * Show whichever of the transcript tab's four states applies right now:
 * running, failed, empty result, or never transcribed.
 *
 * Called after a view load and whenever a background job changes state, so it
 * must be safe to run at any time.
 *
 * @returns {void}
 */
/**
 * Decide which single card the transcript tab should show.
 *
 * Separated from the DOM writes purely so the decision can be tested. The
 * failure it exists to prevent is more than one card being visible at once.
 *
 * @param {Object} s - { running, explained, segments, transcribed }
 * @returns {'running'|'failed'|'transcript'|'empty'|'offer'}
 */
export function transcriptTabMode({ running, explained, segments, transcribed }) {
  if (running) return 'running';
  if (explained?.title) return 'failed';
  if (segments > 0) return 'transcript';
  return transcribed ? 'empty' : 'offer';
}


function renderTranscriptTabState() {
  // ONE owner, ONE mode. This and showTranscribePrompt used to toggle the same
  // three cards independently, each hiding only what it knew about, so the
  // result depended on which ran last — and all three could end up on screen
  // together: a finished progress bar reading "Complete 100%", an error card
  // with no message in it, and an offer to transcribe, stacked.
  const running = Boolean(activeSessionId) && transcribingSessionId === activeSessionId;

  // An error with no explanation is not worth a card. The empty red box with a
  // lone "Try again" button came from showing this before its text was set.
  // Only for the recording it actually happened to. An untagged error is from
  // an older build and is shown on whatever is open, which is the old behaviour.
  const errorIsForThisSession = !transcriptionErrorSessionId
    || transcriptionErrorSessionId === activeSessionId;
  const explained = transcriptionError && errorIsForThisSession
    ? explainError(transcriptionError)
    : null;
  const failed = Boolean(explained?.title) && !running;

  const mode = transcriptTabMode({
    running,
    explained: failed ? explained : null,
    segments: transcriptSegmentCount,
    transcribed: transcriptSessionTranscribed,
  });

  // Every card is set explicitly, every time. Nothing is left as it was.
  if (dom.transcriptProgress) dom.transcriptProgress.hidden = mode !== 'running';
  if (dom.transcriptError) dom.transcriptError.hidden = mode !== 'failed';
  if (dom.transcribePrompt) dom.transcribePrompt.hidden = mode !== 'empty' && mode !== 'offer';
  if (dom.searchContainer) dom.searchContainer.hidden = mode !== 'transcript';
  if (dom.transcriptContainer) dom.transcriptContainer.hidden = mode !== 'transcript';

  if (mode === 'failed') {
    if (dom.transcriptErrorTitle) dom.transcriptErrorTitle.textContent = explained.title;
    if (dom.transcriptErrorText) dom.transcriptErrorText.textContent = explained.cause;
    if (dom.transcriptErrorAction) dom.transcriptErrorAction.textContent = explained.action || '';
    // The raw message stays available but folded away, so the panel reads
    // clearly while still carrying everything needed for a bug report.
    if (dom.transcriptErrorDetails) {
      dom.transcriptErrorDetails.hidden = !explained.raw || explained.raw === explained.cause;
    }
    if (dom.transcriptErrorRaw) dom.transcriptErrorRaw.textContent = explained.raw || '';
  }

  if (mode === 'empty' || mode === 'offer') fillTranscribePrompt(mode === 'empty');

  // Re-arm the retry button whenever the failure panel comes back into view.
  if (dom.btnRetryTranscription) dom.btnRetryTranscription.disabled = running;
  if (dom.btnTranscribeNow) dom.btnTranscribeNow.disabled = false;

  if (running) resetProgressBar();
}


/**
 * Write the wording for the "no transcript" card.
 *
 * Visibility is not decided here — renderTranscriptTabState owns that. This
 * only chooses between "never transcribed" and "transcribed, found nothing",
 * which are different situations and need different offers.
 *
 * @param {boolean} emptyResult - True when a run finished and found no speech.
 * @returns {void}
 */
function fillTranscribePrompt(emptyResult) {
  if (dom.transcribePromptText) {
    dom.transcribePromptText.textContent = emptyResult
      ? 'No speech was detected in this recording.'
      : 'This recording has no transcript yet.';
  }
  if (dom.transcribePromptHint) {
    dom.transcribePromptHint.textContent = emptyResult
      ? 'The audio was processed but contained no recognisable speech. Check that the meeting tab was producing sound, then try again.'
      : 'Runs Whisper on your computer. Long recordings take a few minutes.';
  }
  if (dom.btnTranscribeNow) {
    dom.btnTranscribeNow.replaceChildren(document.createTextNode(
      emptyResult ? 'Try transcribing again' : 'Transcribe now',
    ));
  }
}


/**
 * Make a MediaRecorder recording report its real length.
 *
 * MediaRecorder writes WebM without a duration in the header, because it does
 * not know the length until recording stops and never goes back to patch it.
 * The player therefore reports Infinity, shows 0:00, and its scrub bar does
 * nothing at all.
 *
 * Seeking far past the end forces the browser to read to the last cluster and
 * work the duration out, after which seeking behaves normally.
 *
 * @param {HTMLMediaElement} media - The element to fix up.
 * @returns {void}
 */
function forceDurationLookup(media) {
  if (!media) return;

  const settle = () => {
    if (media.duration !== Infinity) return;

    const restore = () => {
      media.removeEventListener('timeupdate', restore);
      media.currentTime = 0;
    };
    media.addEventListener('timeupdate', restore);
    // Any value beyond the end will do; this one cannot be a real timestamp.
    media.currentTime = 1e101;
  };

  media.addEventListener('loadedmetadata', settle, { once: true });
  if (media.readyState >= 1) settle();
}


/**
 * Set up the HTML5 audio player with the full recording blob.
 * Creates an Object URL from the assembled WebM chunks.
 *
 * @param {string} sessionId - The session whose audio to load.
 * @returns {Promise<void>}
 */
async function setupAudioPlayer(sessionId) {
  revokeAudioUrl(); // Clean up any previous URL

  try {
    const blob = await readFile(`session_${sessionId}_primary.webm`);
    if (blob && blob.size > 0) {
      audioObjectUrl = URL.createObjectURL(blob);
      dom.mediaPlayer.src = audioObjectUrl;
      forceDurationLookup(dom.mediaPlayer);
    } else {
      dom.mediaPlayer.removeAttribute('src');
      console.warn(LOG_PREFIX, 'No audio data for session:', sessionId);
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to set up audio player:', err);
    dom.mediaPlayer.removeAttribute('src');
  }
}


/**
 * Revoke the current audio Object URL to free memory.
 * Called when leaving the complete view or loading a different session.
 *
 * @returns {void}
 */
function revokeAudioUrl() {
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// HELPERS — UI STATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sync the mic toggle switch and status label with the state machine's
 * micEnabled value. Called when entering READY or RECORDING views.
 *
 * @param {boolean} micEnabled - Whether the mic is enabled.
 * @returns {void}
 */
function syncMicToggle(micEnabled) {
  dom.toggleMic.checked = micEnabled;
  dom.micStatusLabel.textContent = micEnabled ? 'On' : 'Off';
}


/**
 * Show or hide the platform badge in the recording view.
 *
 * @param {string|null} platform - Platform name from state, or null.
 * @returns {void}
 */
function showPlatformBadge(platform) {
  if (platform) {
    dom.platformName.textContent = capitalizePlatform(platform);
    dom.platformLabel.hidden = false;
  } else {
    dom.platformLabel.hidden = true;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// HELPERS — MESSAGING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a message to the service worker. Wraps chrome.runtime.sendMessage
 * with error handling for the case where no listener is active.
 *
 * @param {string} type - Message type from the MSG enum.
 * @param {Object} [payload={}] - Optional data payload.
 * @returns {void}
 */
function sendMessage(type, payload = {}) {
  chrome.runtime.sendMessage({ type, payload }).catch((err) => {
    // Expected when the service worker has been terminated and hasn't
    // restarted yet. The state machine will recover on next wake.
    console.warn(LOG_PREFIX, 'Failed to send message:', type, err.message);
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// HELPERS — FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert milliseconds to HH:MM:SS format.
 *
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Formatted time string, e.g., '01:23:45'.
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}


/**
 * Convert seconds to [MM:SS] format for transcript timestamps.
 *
 * @param {number} totalSeconds - Time in seconds.
 * @returns {string} Formatted timestamp, e.g., '[02:15]'.
 */
function formatTimestamp(totalSeconds) {
  const secs = Math.floor(Math.max(0, totalSeconds));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}


/**
 * Format a Unix timestamp into a human-readable date string.
 *
 * @param {number|null} timestamp - Unix timestamp in milliseconds.
 * @returns {string} Formatted date, e.g., 'Jun 24, 2026'.
 */
function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}


/**
 * Format a Unix timestamp into a filename-safe date string.
 *
 * @param {number|null} timestamp - Unix timestamp in milliseconds.
 * @returns {string} Date in YYYY-MM-DD format, or 'unknown'.
 */
function getFilenameDateString(timestamp) {
  if (!timestamp) return 'unknown';
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// AI NOTES & BOOKMARKS (V2 Features)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate meeting notes for the session on screen.
 *
 * Routes to whichever engine Settings selects — Chrome's on-device model or a
 * provider key. Long transcripts are summarized part by part, so the progress
 * line reports which part is running and Cancel can stop the run.
 *
 * @returns {Promise<void>}
 */
async function handleGenerateAiNotes() {
  if (!activeSessionId) return;

  const session = await getSession(activeSessionId);
  if (!session) return;

  aiRunController?.abort();
  aiRunController = new AbortController();
  const sessionIdAtStart = activeSessionId;

  dom.aiUninitialized.hidden = true;
  dom.aiLoading.hidden = false;
  dom.aiError.hidden = true;
  dom.aiNotesContainer.hidden = true;
  setAiProgress('Reading the transcript...');

  try {
    const transcript = await getTranscript(activeSessionId);
    if (!transcript?.segments?.length) {
      throw new Error('There is no transcript to summarize yet.');
    }

    const notes = await generateAiNotes(transcript.segments, session, {
      signal: aiRunController.signal,
      onProgress: (status) => setAiProgress(status),
    });

    // The user may have navigated to another session while this ran.
    if (activeSessionId !== sessionIdAtStart) return;

    await saveAiInsights(sessionIdAtStart, notes);
    renderAiNotesState(await getSession(sessionIdAtStart));
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(LOG_PREFIX, 'AI note generation cancelled by the user.');
      renderAiNotesState(session);
      return;
    }

    console.error(LOG_PREFIX, 'Failed to generate AI notes:', err);
    dom.aiLoading.hidden = true;
    dom.aiError.hidden = false;
    const errorEl = dom.aiError.querySelector('p') || dom.aiError;
    errorEl.textContent = err.message || 'AI generation failed.';
  } finally {
    aiRunController = null;
  }
}


/**
 * Clear the live transcript back to its waiting state.
 *
 * @returns {void}
 */
function resetLiveTranscript() {
  if (!dom.liveTranscriptText) return;
  dom.liveTranscriptText.textContent = 'Listening…';
  dom.liveTranscriptText.dataset.empty = 'true';
  if (dom.liveTranscript) {
    // Stays hidden until the setting produces a first slice, so an unused
    // feature never takes up space in the recording view.
    dom.liveTranscript.hidden = !dom.toggleLiveTranscript?.checked;
  }
}


/**
 * Append a slice of live transcript during recording.
 *
 * Text nodes only: this is speech-model output and must never be parsed as
 * markup. Older slices are dropped so a long meeting cannot grow the panel
 * without bound.
 *
 * @param {string} text - The recognised text for one slice.
 * @returns {void}
 */
function appendLiveTranscript(text) {
  if (!dom.liveTranscriptText || !text) return;

  if (dom.liveTranscript) dom.liveTranscript.hidden = false;
  if (dom.liveTranscriptText.dataset.empty !== 'false') {
    dom.liveTranscriptText.textContent = '';
    dom.liveTranscriptText.dataset.empty = 'false';
  }

  dom.liveTranscriptText.append(document.createTextNode(`${text} `));

  while (dom.liveTranscriptText.childNodes.length > LIVE_TRANSCRIPT_MAX_SLICES) {
    dom.liveTranscriptText.firstChild.remove();
  }

  dom.liveTranscriptText.parentElement.scrollTop =
    dom.liveTranscriptText.parentElement.scrollHeight;
}


/**
 * Update the line shown under the spinner while notes are generating.
 *
 * @param {string} status - Human-readable progress text.
 * @returns {void}
 */
function setAiProgress(status) {
  if (dom.aiProgressText) dom.aiProgressText.textContent = status;
}


async function handleAddBookmark() {
  if (!activeSessionId || !dom.mediaPlayer) return;
  const currentTimeMs = Math.floor(dom.mediaPlayer.currentTime * 1000);
  try {
    await addBookmark(activeSessionId, currentTimeMs);
    const session = await getSession(activeSessionId);
    if (session) {
      renderBookmarks(session.bookmarks || []);
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to add bookmark:', err);
  }
}


/**
 * Show either the stored notes or the "generate" prompt for a session.
 *
 * @param {Object} session - Session record.
 * @returns {void}
 */
function renderAiNotesState(session) {
  if (!session) return;

  if (session.aiInsights) {
    dom.aiUninitialized.hidden = true;
    dom.aiLoading.hidden = true;
    dom.aiError.hidden = true;
    dom.aiNotesContainer.hidden = false;
    // renderMarkdown escapes the model's output before applying Markdown,
    // so nothing it writes can become live markup.
    dom.aiNotesContainer.innerHTML = renderMarkdown(session.aiInsights);
  } else {
    dom.aiUninitialized.hidden = false;
    dom.aiLoading.hidden = true;
    dom.aiError.hidden = true;
    dom.aiNotesContainer.hidden = true;
    refreshAiHelpText();
  }
}


/**
 * Describe the configured engine under the Generate button, and disable the
 * button when no engine can run. Better than letting the user click into a
 * failure.
 *
 * @returns {Promise<void>}
 */
async function refreshAiHelpText() {
  if (!dom.aiHelpText) return;

  try {
    const { ready, engine, label, detail } = await checkAiAvailability();
    dom.aiHelpText.textContent = ready
      ? (engine === 'builtin'
          ? `${label}. Nothing leaves your computer.`
          : `Sends the transcript to ${label}.`)
      : detail;
    if (dom.btnGenerateAi) dom.btnGenerateAi.disabled = !ready;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not check AI availability:', err);
    dom.aiHelpText.textContent = 'Could not check the notes engine. Open Settings.';
  }
}


function renderBookmarks(bookmarks) {
  if (!dom.bookmarksContainer) return;
  dom.bookmarksContainer.innerHTML = '';
  
  if (!bookmarks || bookmarks.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state-text';
    p.textContent = 'No bookmarks yet. Click the bookmark button during playback to save important moments.';
    dom.bookmarksContainer.appendChild(p);
    return;
  }
  
  bookmarks.forEach((bm) => {
    const bmEl = document.createElement('div');
    bmEl.className = 'bookmark-item';
    bmEl.textContent = `🔖 Bookmark at ${formatTimestamp(bm.timeMs / 1000)}`;
    bmEl.addEventListener('click', () => {
      if (dom.mediaPlayer) {
        dom.mediaPlayer.currentTime = bm.timeMs / 1000;
        dom.mediaPlayer.play();
      }
    });
    dom.bookmarksContainer.appendChild(bmEl);
  });
}
function formatDateForFilename(timestamp) {
  if (!timestamp) return 'unknown';
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}


/**
 * A <span> carrying exactly the given text and nothing else.
 *
 * @param {string} text
 * @returns {HTMLSpanElement}
 */
function spanWithText(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}


/**
 * Create a display title for a session. Uses the meeting title if
 * available, otherwise falls back to platform + date.
 *
 * @param {Object} session - Session record.
 * @returns {string} Display title.
 */
function formatSessionTitle(session) {
  if (session.meetingTitle) return session.meetingTitle;
  const date = formatDate(session.startTime);
  const platform = capitalizePlatform(session.platform);
  return `${platform} — ${date}`;
}


/**
 * Capitalize a platform slug for display (e.g., 'google-meet' → 'Google Meet').
 *
 * @param {string|null} platform - Platform identifier.
 * @returns {string} Human-readable platform name.
 */
function capitalizePlatform(platform) {
  if (!platform || platform === 'unknown') return 'Unknown';
  return platform
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Switch between the Transcript and AI Notes tabs in the Complete view.
 *
 * @param {string} tabName - 'transcript' or 'ai'
 */
function switchTab(tabName) {
  if (tabName === 'transcript') {
    dom.tabBtnTranscript?.classList.add('active');
    dom.tabBtnAi?.classList.remove('active');
    dom.tabContentTranscript?.classList.add('active');
    dom.tabContentAi?.classList.remove('active');
  } else if (tabName === 'ai') {
    dom.tabBtnAi?.classList.add('active');
    dom.tabBtnTranscript?.classList.remove('active');
    dom.tabContentAi?.classList.add('active');
    dom.tabContentTranscript?.classList.remove('active');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// HELPERS — FILE DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trigger a browser file download from a Blob. Creates a temporary
 * anchor element, sets the download attribute, and clicks it.
 *
 * @param {Blob} blob - The file content as a Blob.
 * @param {string} filename - Suggested filename for the download.
 * @returns {void}
 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  anchor.remove();

  // 100ms was enough for a text file and far too little for a video: revoking
  // the URL while Chrome was still reading a multi-megabyte blob cancelled the
  // download with no error anywhere. A minute costs nothing — the blob is
  // already in memory either way — and the page outliving it releases it too.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}


// ═══════════════════════════════════════════════════════════════════════════
// ERROR PRESENTATION AND DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fill the error view with a cause and a next action rather than a raw string.
 *
 * @param {Error|string} error - The failure.
 * @param {Object} [override] - Optional {title, cause, action} to show verbatim.
 * @returns {void}
 */
function showError(error, override) {
  // An override refines the explanation rather than replacing it. It used to
  // replace it outright, which threw away the real message whenever a caller
  // wanted a better title, and printed "undefined" for any field the override
  // happened not to set.
  const base = error
    ? explainError(error)
    : { title: 'Something went wrong', cause: '', action: '', raw: '', known: true };

  const explained = { ...base, ...override };
  if (!explained.cause) explained.cause = base.raw || 'No details were reported.';

  if (dom.errorTitle) dom.errorTitle.textContent = explained.title;
  if (dom.errorMessage) dom.errorMessage.textContent = explained.cause;
  if (dom.errorAction) dom.errorAction.textContent = explained.action || '';

  // Show the raw text only when it is not already the cause, so the panel
  // never prints the same sentence twice.
  const showRaw = Boolean(explained.raw) && explained.raw !== explained.cause;
  if (dom.errorRawDetails) dom.errorRawDetails.hidden = !showRaw;
  if (dom.errorRaw) dom.errorRaw.textContent = explained.raw || '';
}


/**
 * Run every check and render the results.
 *
 * @returns {Promise<void>}
 */
async function handleRunDiagnostics() {
  dom.btnRunDiagnostics.disabled = true;
  dom.diagnosticsResults.hidden = false;
  dom.diagnosticsResults.replaceChildren(buildDiagnosticRow({
    name: 'Running', status: 'pending', detail: 'Checking every component...',
  }));

  try {
    const { checks, summary } = await collectDiagnostics();

    const rows = checks.map(buildDiagnosticRow);
    const heading = document.createElement('p');
    heading.className = 'diagnostics-summary';
    heading.textContent = summary.fail
      ? `${summary.fail} failing, ${summary.warn} warning, ${summary.ok} healthy`
      : summary.warn
        ? `${summary.warn} warning, ${summary.ok} healthy`
        : `All ${summary.ok} checks healthy`;

    dom.diagnosticsResults.replaceChildren(heading, ...rows);
    dom.btnCopyDiagnostics.hidden = false;
    lastDiagnostics = checks;
  } catch (err) {
    console.error(LOG_PREFIX, 'Diagnostics failed:', err);
    dom.diagnosticsResults.replaceChildren(buildDiagnosticRow({
      name: 'Diagnostics', status: 'fail', detail: err.message,
    }));
  } finally {
    dom.btnRunDiagnostics.disabled = false;
  }
}


/**
 * Build one result row. Text is set with textContent throughout, because these
 * details include provider messages and file paths.
 *
 * @param {{name: string, status: string, detail: string}} check
 * @returns {HTMLElement}
 */
function buildDiagnosticRow(check) {
  const row = document.createElement('div');
  row.className = `diagnostic-row is-${check.status}`;

  const icon = document.createElement('span');
  icon.className = 'diagnostic-icon';
  icon.textContent = { ok: '✓', warn: '!', fail: '✕', pending: '…' }[check.status] || '?';
  icon.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'diagnostic-body';

  const name = document.createElement('span');
  name.className = 'diagnostic-name';
  name.textContent = check.name;

  const detail = document.createElement('span');
  detail.className = 'diagnostic-detail';
  detail.textContent = check.detail;

  body.append(name, detail);
  row.append(icon, body);
  return row;
}


/**
 * Copy the last diagnostics run as plain text, for pasting into a bug report.
 *
 * @returns {Promise<void>}
 */
async function handleCopyDiagnostics() {
  if (!lastDiagnostics) return;

  const report = lastDiagnostics
    .map((c) => `[${c.status.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`)
    .join('\n');

  try {
    await navigator.clipboard.writeText(`SilentScribe diagnostics\n${report}`);
    dom.btnCopyDiagnostics.textContent = 'Copied';
    setTimeout(() => { dom.btnCopyDiagnostics.textContent = 'Copy report'; }, 2000);
  } catch (err) {
    console.warn(LOG_PREFIX, 'Clipboard write failed:', err);
    dom.btnCopyDiagnostics.textContent = 'Could not copy — see console';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BRING-YOUR-OWN-KEY PROVIDER SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the provider settings controls and wire them to storage.
 *
 * Every field writes straight through to chrome.storage.local, so the settings
 * screen has no save button and no unsaved state to lose.
 *
 * @returns {void}
 */
function setupLlmSettings() {
  if (!dom.llmProvider) return;

  // Populate the two fixed dropdowns once.
  dom.llmProvider.replaceChildren(
    ...Object.entries(PROVIDERS).map(([id, preset]) => new Option(preset.label, id)),
  );
  dom.llmFormat.replaceChildren(
    ...WIRE_FORMATS.map((format) => new Option(format.label, format.value)),
  );

  dom.llmProvider.addEventListener('change', async (event) => {
    clearTestResult();
    renderLlmSettings(await setLlmConfig({ provider: event.target.value }));
  });

  dom.llmFormat.addEventListener('change', async (event) => {
    clearTestResult();
    await setLlmConfig({ format: event.target.value });
  });

  // Text fields save as the user types, debounced so a long key is written once.
  bindLlmField(dom.llmBaseUrl, (value) => ({ baseUrl: value.trim().replace(/\/+$/, '') }));
  bindLlmField(dom.llmApiKey,  (value) => ({ apiKey: value.trim() }));
  bindLlmField(dom.llmModel,   (value) => ({ model: value.trim() }));

  dom.btnToggleKey.addEventListener('click', () => {
    const hidden = dom.llmApiKey.type === 'password';
    dom.llmApiKey.type = hidden ? 'text' : 'password';
    dom.btnToggleKey.textContent = hidden ? 'Hide' : 'Show';
  });

  dom.btnLoadModels.addEventListener('click', handleLoadModels);
  dom.btnTestLlm.addEventListener('click', handleTestConnection);

  dom.llmKeysLink.addEventListener('click', (event) => {
    event.preventDefault();
    if (dom.llmKeysLink.dataset.url) {
      chrome.tabs.create({ url: dom.llmKeysLink.dataset.url });
    }
  });

  getLlmConfig()
    .then(renderLlmSettings)
    .catch((err) => console.error(LOG_PREFIX, 'Could not load provider settings:', err));
}


/**
 * Save one text field to storage, 400 ms after the user stops typing.
 *
 * @param {HTMLInputElement} input - The field.
 * @param {(value: string) => Object} toPatch - Maps the field value to a config patch.
 * @returns {void}
 */
function bindLlmField(input, toPatch) {
  let debounceId = null;

  input.addEventListener('input', () => {
    clearTimeout(debounceId);
    clearTestResult();
    debounceId = setTimeout(() => setLlmConfig(toPatch(input.value)), 400);
  });

  // Blur commits immediately, so closing Settings never loses the last keystroke.
  input.addEventListener('blur', () => {
    clearTimeout(debounceId);
    setLlmConfig(toPatch(input.value));
  });
}


/**
 * Reflect a config into the settings controls.
 *
 * @param {Object} config - Resolved config from getLlmConfig().
 * @returns {void}
 */
function renderLlmSettings(config) {
  const preset = PROVIDERS[config.provider] || PROVIDERS.custom;

  dom.llmProvider.value = config.provider;
  dom.llmFormat.value   = config.format;
  dom.llmBaseUrl.value  = config.baseUrl;
  dom.llmApiKey.value   = config.apiKey;
  dom.llmModel.value    = config.model;

  // The on-device engine needs no URL, key, or model.
  dom.llmByokFields.hidden = config.provider === 'builtin';

  // Only the custom preset exposes the wire-format choice; for a known provider
  // the format is fixed and showing it would only invite a wrong answer.
  dom.llmFormatField.hidden = config.provider !== 'custom';

  dom.llmNote.textContent = preset.note || '';
  dom.llmNote.hidden = !preset.note;

  dom.llmKeysLink.hidden = !preset.keysUrl;
  dom.llmKeysLink.dataset.url = preset.keysUrl || '';

  dom.llmApiKey.placeholder = preset.needsKey ? 'Paste your key' : 'Not required';
}


/**
 * Ask the provider which models this key can use, and offer them as
 * autocomplete on the model field.
 *
 * @returns {Promise<void>}
 */
async function handleLoadModels() {
  dom.btnLoadModels.disabled = true;
  showTestResult('pending', 'Loading models...');

  try {
    const models = await listModels();
    dom.llmModelOptions.replaceChildren(...models.map((id) => new Option(id)));
    showTestResult(
      models.length ? 'ok' : 'error',
      models.length
        ? `${models.length} models available. Click the model field to pick one.`
        : 'The provider returned no models.',
    );
  } catch (err) {
    showTestResult('error', err.message);
  } finally {
    dom.btnLoadModels.disabled = false;
  }
}


/**
 * Ping the configured provider and report whether the key, URL, and model all
 * work. This is the check to run whenever notes stop generating.
 *
 * @returns {Promise<void>}
 */
async function handleTestConnection() {
  dom.btnTestLlm.disabled = true;
  showTestResult('pending', 'Contacting the provider...');

  try {
    const result = await testConnection();
    showTestResult(
      result.ok ? 'ok' : 'error',
      `${result.ok ? 'Working' : 'Failed'} — ${result.model} — ${result.latencyMs} ms. ${result.detail}`,
    );
  } catch (err) {
    showTestResult('error', err.message);
  } finally {
    dom.btnTestLlm.disabled = false;
    refreshAiHelpText();
  }
}


/**
 * Show a status line under the Test button.
 *
 * @param {'ok'|'error'|'pending'} kind - Which style to apply.
 * @param {string} message - Text to show.
 * @returns {void}
 */
function showTestResult(kind, message) {
  dom.llmTestResult.textContent = message;
  dom.llmTestResult.className = `settings-status is-${kind}`;
  dom.llmTestResult.hidden = false;
}


/**
 * Hide the status line, because the config changed and it no longer applies.
 *
 * @returns {void}
 */
function clearTestResult() {
  if (dom.llmTestResult) dom.llmTestResult.hidden = true;
}


// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', initialize);
