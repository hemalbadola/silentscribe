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
import { STATES, getState, onStateChange } from '../utils/state.js';
import {
  getSessions,
  getSession,
  getTranscript,
  updateSpeakerNames,
  updateTranscriptSegment,
  mergeTranscriptSegments,
  splitTranscriptSegment,
  saveAiInsights,
  addBookmark,
  removeBookmark,
  deleteSession,
  updateSessionPlatform,
  updateSessionMetadata
} from '../storage/db.js';
import { readFile } from '../storage/opfs.js';
import { exportTxt, exportSrt, exportJson, exportMd } from '../utils/export.js';
import { generateAiNotes, generateAiPlatform, generateAiTitle } from '../utils/ai.js';


// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Prefix for all console output from this module. */
const LOG_PREFIX = '[SilentScribe Panel]';

/**
 * Maps each extension state to the corresponding view element ID.
 * IDLE and PERMISSIONS_NEEDED both show the onboarding screen because
 * the user experience is identical — grant or skip mic permission.
 *
 * @type {Object<string, string>}
 */
const STATE_VIEW_MAP = {
  [STATES.IDLE]:               'view-onboarding',
  [STATES.PERMISSIONS_NEEDED]: 'view-onboarding',
  [STATES.READY]:              'view-ready',
  [STATES.RECORDING]:          'view-recording',
  [STATES.PROCESSING]:         'view-processing',
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

  try {
    const state = await getState();
    console.log(LOG_PREFIX, 'Current state:', state.state);
    
    // Fast-forward past onboarding if previously completed
    if (state.state === STATES.IDLE || state.state === STATES.PERMISSIONS_NEEDED) {
      const { onboardingComplete, micEnabled } = await chrome.storage.local.get(['onboardingComplete', 'micEnabled']);
      if (onboardingComplete) {
        console.log(LOG_PREFIX, 'Skipping onboarding based on saved preference');
        sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled: !!micEnabled });
        sendMessage(MSG.UI_ONBOARDING_COMPLETE);
        // The service worker will handle this and broadcast STATE_CHANGED
        // which will automatically switch us to the READY view.
      }
    }

    handleStateTransition(state);
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to read initial state:', err);
    showView('view-error');
    dom.errorMessage.textContent = 'Failed to load extension state. Please reload.';
  }

  // React to future state changes pushed from the service worker
  onStateChange(handleStateTransition);
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
  dom.btnRecord        = document.getElementById('btn-record');
  dom.sessionList      = document.getElementById('session-list');
  dom.noSessionsMsg    = document.getElementById('no-sessions-msg');

  // Recording
  dom.timerDisplay     = document.getElementById('timer-display');
  dom.meterTab         = document.getElementById('meter-tab');
  dom.meterMic         = document.getElementById('meter-mic');
  dom.platformLabel    = document.getElementById('platform-label');
  dom.platformName     = document.getElementById('platform-name');
  dom.btnStop          = document.getElementById('btn-stop');

  // Processing
  dom.progressBar      = document.getElementById('progress-bar');
  dom.progressLabel    = document.getElementById('progress-label');

  // Complete
  dom.completeTitle    = document.getElementById('complete-title');
  dom.completeDuration = document.getElementById('complete-duration');
  dom.completePlatform = document.getElementById('complete-platform');
  dom.completeDate     = document.getElementById('complete-date');
  dom.transcriptContainer = document.getElementById('transcript-container');
  dom.noTranscriptMsg  = document.getElementById('no-transcript-msg');
  dom.mediaPlayer      = document.getElementById('media-player');
  dom.btnNewRecording  = document.getElementById('btn-new-recording');
  dom.btnBackComplete  = document.getElementById('btn-back-complete');

  // Error
  dom.errorMessage     = document.getElementById('error-message');
  dom.btnDismissError  = document.getElementById('btn-dismiss-error');

  // Settings
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

  // Bookmarks
  dom.bookmarksContainer = document.getElementById('bookmarks-container');
  dom.btnAddBookmark   = document.getElementById('btn-add-bookmark');
}


// ═══════════════════════════════════════════════════════════════════════════
// VIEW MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

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

  showView(viewId);

  switch (stateObj.state) {
    case STATES.IDLE:
    case STATES.PERMISSIONS_NEEDED:
      // Nothing extra needed — onboarding is static
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
      break;

    case STATES.PROCESSING:
      stopRecordingTimer();
      resetProgressBar();
      break;

    case STATES.COMPLETE:
      stopRecordingTimer();
      activeSessionId = stateObj.sessionId;
      loadCompleteView(stateObj.sessionId);
      break;

    case STATES.ERROR:
      stopRecordingTimer();
      dom.errorMessage.textContent = stateObj.error || 'An unexpected error occurred.';
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

  // ── Error View ──
  dom.btnDismissError.addEventListener('click', () => {
    sendMessage(MSG.UI_DISMISS_ERROR);
  });

  // ── Settings View ──
  dom.btnSettingsOpen?.addEventListener('click', () => {
    showView('view-settings');
  });

  dom.btnSettingsClose?.addEventListener('click', () => {
    // Return to the normal view based on the current extension state
    getState().then((state) => {
      handleStateTransition(state);
    }).catch(() => showView('view-error'));
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

  // ── Ready ──────────────────────────────────────────────────────────
  // dom.btnRecord.addEventListener('click', handleStartRecording);
  dom.toggleMic.addEventListener('change', handleMicToggle);

  // ── Recording ──────────────────────────────────────────────────────
  dom.btnStop.addEventListener('click', handleStopRecording);

  // ── Complete ───────────────────────────────────────────────────────
  dom.btnNewRecording.addEventListener('click', handleNewRecording);
  dom.btnBackComplete.addEventListener('click', async () => {
    const state = await getState();
    if (state.state === STATES.COMPLETE) {
      // We just finished a meeting, tell the service worker to return to READY
      sendMessage(MSG.UI_RETURN_TO_READY);
    } else {
      // We were just viewing a past recording in READY state
      // Simply return to the past recordings list without changing the state
      showView('view-ready');
      loadSessionList();
    }
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

  // Regenerate Platform & Title when clicking Platform chip
  dom.completePlatform.addEventListener('click', handleRegenerateMetadata);

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
        if (message.payload.isRealTime) {
          const liveText = document.getElementById('live-transcript-text');
          if (liveText) {
            if (liveText.textContent === 'Listening...') {
              liveText.textContent = '';
            }
            const span = document.createElement('span');
            span.textContent = message.payload.text + " ";
            liveText.appendChild(span);
            liveText.parentElement.scrollTop = liveText.parentElement.scrollHeight;
          }
        } else {
          updateProgressBar(message.payload);
        }
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
    // Check if we are in a side panel or a full tab
    const currentTab = await new Promise(resolve => chrome.tabs.getCurrent(resolve));
    
    if (!currentTab) {
      // We are in the side panel. Chrome blocks permission prompts here and hangs getUserMedia.
      console.log(LOG_PREFIX, 'In side panel. Opening full tab for permission prompt.');
      if (dom.errorMessage) {
        dom.errorMessage.textContent = 'Chrome requires you to grant microphone permission from a full tab. A new tab has been opened for you.';
      }
      showView('view-error');
      // Open the panel in a full tab to show the prompt.
      chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/panel.html') });
      return; // Do not call getUserMedia!
    }

    // We are in a full tab, it is safe to call getUserMedia
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop all tracks immediately — we just needed the permission prompt
    stream.getTracks().forEach((track) => track.stop());
    console.log(LOG_PREFIX, 'Microphone permission granted');
    
    // Success: Save permission in local storage
    await chrome.storage.local.set({ onboardingComplete: true, micEnabled: true });
    sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled: true });
    sendMessage(MSG.UI_ONBOARDING_COMPLETE);

    // Close the standalone tab automatically
    chrome.tabs.remove(currentTab.id);

  } catch (err) {
    console.error(LOG_PREFIX, 'Microphone permission denied:', err);
    
    // We are in a full tab, meaning the user actually clicked "Block"
    if (dom.errorMessage) {
      dom.errorMessage.textContent = 'Microphone access was denied. Please click the site settings icon in the URL bar to allow microphone access, then reload this page.';
    }
    showView('view-error');
  }
}


function handleSkipPermission() {
  console.log(LOG_PREFIX, 'User skipped mic permission');
  chrome.storage.local.set({ onboardingComplete: true, micEnabled: false });
  sendMessage(MSG.UI_TOGGLE_MIC, { micEnabled: false });
  sendMessage(MSG.UI_ONBOARDING_COMPLETE);
}


/**
 * Start recording. Reads the current mic toggle state and sends
 * UI_START_RECORDING to the service worker.
 *
 * @returns {void}
 */
// Removed handleStartRecording entirely as it is no longer used by the UI


/**
 * Stop recording. Sends UI_STOP_RECORDING to the service worker.
 *
 * @returns {void}
 */
function handleStopRecording() {
  console.log(LOG_PREFIX, 'Stop recording requested');
  sendMessage(MSG.UI_STOP_RECORDING);
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

  const formatter = EXPORT_FORMATTERS[format];
  if (!formatter) {
    console.error(LOG_PREFIX, 'Unknown export format:', format);
    return;
  }

  console.log(LOG_PREFIX, `Exporting as ${format} for session:`, activeSessionId);

  try {
    const session = await getSession(activeSessionId);
    if (!session) return;

    if (format === 'webm') {
      const blob = await readFile(`session_${activeSessionId}_primary.webm`);
      if (!blob) {
        console.warn(LOG_PREFIX, 'No video file found for export');
        return;
      }
      triggerDownload(blob, `silentscribe-${formatDateForFilename(session?.startTime)}.webm`);
      return;
    }

    const transcript = await getTranscript(activeSessionId);

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
  const pct = Math.min(100, Math.max(0, (payload.progress || 0) * 100));
  dom.progressBar.style.width = `${pct}%`;
  dom.progressBar.setAttribute('aria-valuenow', Math.round(pct));
  dom.progressLabel.textContent = `${Math.round(pct)}%`;
  
  if (payload.status) {
    const titleEl = document.querySelector('.processing-title');
    if (titleEl) titleEl.textContent = payload.status;
  }
}


/**
 * Reset the progress bar to 0%.
 *
 * @returns {void}
 */
function resetProgressBar() {
  dom.progressBar.style.width = '0%';
  dom.progressBar.setAttribute('aria-valuenow', '0');
  dom.progressLabel.textContent = '0%';
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
    const speaker = speakerEl.textContent.toLowerCase();
    const time = timeEl.textContent.toLowerCase();
    const textLower = text.toLowerCase();

    if (textLower.includes(q) || speaker.includes(q) || time.includes(q)) {
      segment.classList.remove('hidden-by-search');
      hasVisibleMatches = true;

      // Save original text for restoring later
      if (!textEl.dataset.originalText) {
        textEl.dataset.originalText = text;
      }

      // Highlight matching text (case-insensitive) if the match is in the text
      if (textLower.includes(q)) {
        const regex = new RegExp(`(${q})`, 'gi');
        textEl.innerHTML = text.replace(regex, '<span class="search-highlight">$1</span>');
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

    const meta = document.createElement('div');
    meta.className = 'session-card-meta';
    meta.innerHTML = `
      <span>${session.duration ? formatDuration(session.duration) : '—'}</span>
      <span>·</span>
      <span>${capitalizePlatform(session.platform)}</span>
    `;

    body.appendChild(title);
    body.appendChild(meta);

    // Transcription badge
    const badge = document.createElement('span');
    badge.className = `session-badge ${session.transcribed ? 'session-badge-transcribed' : 'session-badge-pending'}`;
    badge.textContent = session.transcribed ? 'Done' : 'Pending';

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
      console.warn(LOG_PREFIX, 'Session not found:', sessionId);
      return;
    }

    // Populate the complete view and switch to it
    await populateCompleteView(session);
    showView('view-complete');
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load session:', sessionId, err);
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
  // Set title
  if (dom.completeTitle) {
    dom.completeTitle.textContent = session.metadata?.title || 'Recording Details';
  }

  // Session info chips
  const durationChip = dom.completeDuration.querySelector('.chip-text');
  durationChip.textContent = session.duration ? formatDuration(session.duration) : '—';

  const platformChip = dom.completePlatform.querySelector('.chip-text');
  platformChip.textContent = capitalizePlatform(session.platform);
  // Store session ID on the chip so the click handler knows which session to update
  dom.completePlatform.dataset.sessionId = session.id;

  const dateChip = dom.completeDate.querySelector('.chip-text');
  dateChip.textContent = formatDate(session.startTime);

  // Transcript
  try {
    const transcript = await getTranscript(session.id);
    if (transcript && transcript.segments) {
      renderTranscript(transcript.segments, session.speakerNames || {});
    } else {
      renderTranscript([], {});
    }
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load transcript:', err);
    renderTranscript([], {});
  }

  // Audio player
  const audioBlob = await readFile(`session_${session.id}_primary.webm`);
  if (audioBlob) {
    const audioUrl = URL.createObjectURL(audioBlob);
    dom.mediaPlayer.src = audioUrl;
    dom.mediaPlayer.dataset.sessionId = session.id;
  } else {
    dom.mediaPlayer.removeAttribute('src');
    dom.mediaPlayer.dataset.sessionId = '';
  }

  // Bookmarks
  renderBookmarks(session.bookmarks || []);

  // AI Notes
  renderAiNotesState(session);
}


// ═══════════════════════════════════════════════════════════════════════════
// AUDIO PLAYER
// ═══════════════════════════════════════════════════════════════════════════

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

async function handleGenerateAiNotes() {
  if (!activeSessionId) return;
  if (!dom.aiLoading.hidden) return; // Prevent overlapping clicks

  const session = await getSession(activeSessionId);
  if (!session) return;

  dom.aiUninitialized.hidden = true;
  dom.aiLoading.hidden = false;
  dom.aiError.hidden = true;
  dom.aiNotesContainer.hidden = true;

  const progressTextEl = document.getElementById('ai-progress-text');

  try {
    const transcript = await getTranscript(activeSessionId);
    if (!transcript || !transcript.segments || transcript.segments.length === 0) {
      throw new Error("No transcript available to generate notes.");
    }

    // Format transcript into a simple readable text for the prompt
    const formattedTranscript = transcript.segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n');

    const notes = await generateAiNotes(formattedTranscript, (progressText) => {
      if (progressTextEl) {
        progressTextEl.textContent = progressText;
      }
    });

    await saveAiInsights(activeSessionId, notes);
    
    // Refresh the view
    const updatedSession = await getSession(activeSessionId);
    renderAiNotesState(updatedSession);
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to generate AI notes:', err);
    dom.aiLoading.hidden = true;
    dom.aiError.hidden = false;
    const errorEl = dom.aiError.querySelector('p') || dom.aiError;
    errorEl.textContent = err.message || 'AI Generation failed.';
  }
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

function renderAiNotesState(session) {
  if (!session) return;
  
  if (session.aiSummary) {
    dom.aiUninitialized.hidden = true;
    dom.aiLoading.hidden = true;
    dom.aiError.hidden = true;
    dom.aiNotesContainer.hidden = false;
    dom.aiNotesContainer.innerHTML = '';
    const p = document.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = session.aiSummary;
    dom.aiNotesContainer.appendChild(p);
  } else {
    dom.aiUninitialized.hidden = false;
    dom.aiLoading.hidden = true;
    dom.aiError.hidden = true;
    dom.aiNotesContainer.hidden = true;
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
 * Create a display title for a session. Uses the meeting title if
 * available, otherwise falls back to platform + date.
 *
 * @param {Object} session - Session record.
 * @returns {string} Display title.
 */
function formatSessionTitle(session) {
  if (session.metadata?.title) return session.metadata.title;
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
// METADATA GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handle clicking the platform chip to regenerate both Platform and Title via AI.
 */
async function handleRegenerateMetadata() {
  const sessionId = dom.completePlatform.dataset.sessionId;
  if (!sessionId) return;

  const platformChip = dom.completePlatform.querySelector('.chip-text');
  const originalPlatform = platformChip.textContent;
  const originalTitle = dom.completeTitle.textContent;

  platformChip.innerHTML = '<i class="ph ph-spinner ph-spin"></i> Thinking...';
  dom.completePlatform.style.pointerEvents = 'none'; // Prevent double clicks

  try {
    const transcript = await getTranscript(sessionId);
    if (!transcript || !transcript.segments) throw new Error('No transcript found');

    const [newPlatform, newTitle] = await Promise.all([
      generateAiPlatform(transcript.segments),
      generateAiTitle(transcript.segments)
    ]);

    if (newPlatform) {
      await updateSessionPlatform(sessionId, newPlatform);
      platformChip.textContent = capitalizePlatform(newPlatform);
    } else {
      platformChip.textContent = originalPlatform;
    }

    if (newTitle) {
      await updateSessionMetadata(sessionId, { title: newTitle });
      dom.completeTitle.textContent = newTitle;
    } else {
      dom.completeTitle.textContent = originalTitle;
    }

  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to regenerate metadata:', err);
    platformChip.textContent = originalPlatform;
  } finally {
    dom.completePlatform.style.pointerEvents = 'auto';
  }
}

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

  // Cleanup after a short delay to ensure the download starts
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 100);
}


// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', initialize);
