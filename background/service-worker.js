/**
 * SilentScribe — Service Worker (Background Script)
 * ============================================================================
 * 
 * The ORCHESTRATOR of the entire extension. This is the only execution context
 * that has authority to write state, manage the offscreen document lifecycle,
 * and initiate tab capture.
 * 
 * RESPONSIBILITIES:
 * 1. State machine owner — sole writer of extension state
 * 2. Message router — relays messages between all four contexts
 * 3. Tab capture — calls chrome.tabCapture.getMediaStreamId() on user gesture
 * 4. Offscreen document lifecycle — creates/destroys the hidden recording page
 * 5. Hotkey handler — Alt+Shift+R to toggle recording
 * 6. Badge management — visual recording state on the extension icon
 * 7. Port-based keepalive — stays alive while offscreen doc holds a port open
 * 
 * ARCHITECTURE RULE:
 * The service worker NEVER touches audio directly. All audio flows through
 * the offscreen document. The service worker only passes a stream ID and
 * control messages.
 * 
 * @module service-worker
 */

import { STATES, getState, setState, updateMetadata } from '../utils/state.js';
import { MSG, OFFSCREEN_CONFIG, SESSION_STATUS, WHISPER_CONFIG } from '../utils/constants.js';
import {
  createSession,
  deleteSession,
  finalizeSession,
  updateSessionStatus,
  saveTranscript,
  generateSessionId,
  getSession,
  getTranscript,
} from '../storage/db.js';
import { exportTxt, exportSrt, exportJson, exportMd } from '../utils/export.js';
import { REFRESH_ALARM, fetchRemoteConfig, isRemoteConfigured } from '../utils/remote-config.js';
import { cleanupTranscript } from '../utils/ai.js';


// ============================================================================
// MODULE STATE
// ============================================================================

/**
 * Reference to the keepalive port opened by the offscreen document.
 * When this port is open, Chrome keeps the service worker alive.
 * If the port disconnects unexpectedly during recording, we treat it
 * as a capture failure and transition to ERROR state.
 * 
 * @type {chrome.runtime.Port|null}
 */
let keepalivePort = null;


/**
 * True while the offscreen document is still transcribing.
 *
 * Transcription runs in the BACKGROUND now, so the extension state is COMPLETE
 * (or PROCESSING) while the document is still working. State alone therefore
 * cannot say whether the document is busy, and closeOffscreenDocument used to
 * destroy a running transcription with no error at all.
 *
 * @type {boolean}
 */
let transcriptionInFlight = false;


/**
 * True while a stop is already running.
 *
 * The panel disables both Stop buttons, but re-enables them milliseconds later,
 * so a double click sends two UI_STOP_RECORDING messages. Both used to read
 * RECORDING before either wrote COMPLETE, which stopped the same session twice
 * and started two transcriptions of it. This flag is set before the first
 * await, so the second message cannot get past it.
 *
 * @type {boolean}
 */
let stopInProgress = false;


// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Handle extension installation or update.
 * 
 * On first install: set state to IDLE, configure side panel.
 * On update: preserve existing state, log version change.
 * 
 * @param {chrome.runtime.InstalledDetails} details - Install event details.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  scheduleConfigRefresh().catch((err) =>
    console.warn('[SilentScribe SW] Config refresh failed:', err));
  console.log(`[SilentScribe SW] Installed — reason: ${details.reason}`);

  try {
    // Configure side panel to open when the extension icon is clicked.
    // This replaces the default popup behavior.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

    if (details.reason === 'install') {
      // First install: initialize state to IDLE.
      // The side panel will check permissions and transition to
      // PERMISSIONS_NEEDED or READY on first open.
      const state = await getState();
      if (state.state !== STATES.IDLE) {
        // Force reset without validation
        await chrome.storage.session.set({ silentscribe_state: { ...state, state: STATES.IDLE } });
      }
      console.log('[SilentScribe SW] Initial state set to IDLE');
    }
  } catch (err) {
    console.error('[SilentScribe SW] Installation handler failed:', err);
  }
});


/**
 * Handle browser startup (when Chrome opens with the extension already installed).
 * 
 * Resets ephemeral state to IDLE since chrome.storage.session is cleared
 * on browser restart. The side panel will re-check permissions on open.
 */
chrome.runtime.onStartup.addListener(async () => {
  scheduleConfigRefresh().catch((err) =>
    console.warn('[SilentScribe SW] Config refresh failed:', err));
  console.log('[SilentScribe SW] Browser startup — resetting state');
  try {
    const state = await getState();
    if (state.state !== STATES.IDLE) {
      await chrome.storage.session.set({ silentscribe_state: { ...state, state: STATES.IDLE } });
    }
  } catch (err) {
    console.error('[SilentScribe SW] Startup handler failed:', err);
  }
});


// ============================================================================
// MESSAGE ROUTER
// ============================================================================

/**
 * Central message handler. Routes all inter-context messages to their
 * respective handler functions.
 * 
 * Every message follows the protocol: { type: MSG.*, payload: {...} }
 * 
 * Returns true for async handlers (required by Chrome to keep the
 * message channel open for sendResponse).
 */
/**
 * Catch a fire-and-forget handler's rejection.
 *
 * These handlers answer no message, so nothing awaited them and a rejection
 * surfaced as "Uncaught (in promise)" in the service worker with no indication
 * of which handler produced it — and, worse, silently abandoned whatever the
 * handler had left to do.
 *
 * @param {string} name - The handler, for the log line.
 * @returns {(err: Error) => void}
 */
const reportHandlerFailure = (name) => (err) => {
  console.error(`[SilentScribe SW] ${name} failed:`, err);
};


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Guard against malformed messages
  if (!message || !message.type) return false;

  const { type, payload } = message;

  switch (type) {
    // ── From Side Panel ──────────────────────────────────────────
    case MSG.UI_START_RECORDING:
      handleStartRecording(payload).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true; // Async response

    case MSG.UI_START_RECORDING_WITH_STREAM:
      handleStartRecordingWithStream(payload).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;

    case MSG.UI_STOP_RECORDING:
      handleStopRecording(payload).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;

    case MSG.UI_TOGGLE_MIC:
      handleToggleMic(payload).then(sendResponse);
      return true;

    case MSG.UI_START_TRANSCRIPTION:
      handleStartTranscription(payload).then(sendResponse);
      return true;

    case MSG.UI_DISMISS_ERROR:
      handleDismissError().then(sendResponse);
      return true;

    case MSG.UI_EXPORT:
      handleExport(payload).then(sendResponse);
      return true;

    // ── From Content Script ──────────────────────────────────────
    case MSG.UI_ONBOARDING_COMPLETE:
      handleOnboardingComplete(payload).catch(reportHandlerFailure('handleOnboardingComplete'));
      return false;

    case MSG.MEETING_DETECTED:
      handleMeetingDetected(payload).catch(reportHandlerFailure('handleMeetingDetected'));
      return false; // Sync — no response needed

    case MSG.MEETING_STATE_CHANGED:
      handleMeetingStateChanged(payload).catch(reportHandlerFailure('handleMeetingStateChanged'));
      return false;

    // ── From Offscreen Document ──────────────────────────────────
    case MSG.CAPTURE_COMPLETE:
      handleCaptureComplete(payload).catch(reportHandlerFailure('handleCaptureComplete'));
      return false;

    case MSG.CAPTURE_ERROR:
      handleCaptureError(payload).catch(reportHandlerFailure('handleCaptureError'));
      return false;

    case MSG.CAPTURE_LEVELS:
      // Forward level data directly to side panel — no processing needed
      // Side panel listens for this via chrome.runtime.onMessage
      return false;

    case MSG.OFFSCREEN_GET_SETTINGS:
      // The offscreen document cannot read chrome.storage — that API is not
      // exposed to it at all. It asks here instead.
      handleOffscreenGetSettings().then(sendResponse);
      return true;

    // ── From Transcription Worker (via offscreen doc) ────────────
    case MSG.TRANSCRIPTION_PROGRESS:
      // Forwarded automatically since the offscreen doc sends via
      // chrome.runtime.sendMessage which broadcasts to all contexts.
      // Progress is also proof the document is still working: after a service
      // worker restart the in-flight marker is gone, and this is the only
      // signal left that stops closeOffscreenDocument killing the run.
      transcriptionInFlight = true;
      return false;

    case MSG.TRANSCRIPTION_COMPLETE:
      handleTranscriptionComplete(payload).catch(reportHandlerFailure('handleTranscriptionComplete'));
      return false;

    case MSG.TRANSCRIPTION_ERROR:
      handleTranscriptionError(payload).catch(reportHandlerFailure('handleTranscriptionError'));
      return false;

    default:
      // Unknown message type — ignore silently
      return false;
  }
});


// ============================================================================
// RECORDING FLOW
// ============================================================================

/**
 * Start a new recording session.
 * 
 * This is the main recording entry point, triggered by:
 * - Side panel "Record" button click
 * - Alt+Shift+R hotkey
 * 
 * Flow:
 * 1. Generate a unique session ID
 * 2. Get the active tab
 * 3. Obtain a media stream ID from chrome.tabCapture
 * 4. Ensure the offscreen document exists
 * 5. Send the stream ID to the offscreen doc to start capturing
 * 6. Transition to RECORDING state
 * 7. Update the extension badge
 * 
 * IMPORTANT: chrome.tabCapture.getMediaStreamId() requires a user gesture.
 * This function must be called from a click handler or command handler.
 * 
 * @param {Object} payload - Recording configuration.
 * @param {boolean} payload.micEnabled - Whether to capture microphone audio.
 * @returns {Promise<{success: boolean}>}
 */
/**
 * Explain why a tab can never be captured, or return null when it can.
 *
 * These are refusals no permission can lift: Chrome does not allow an
 * extension to capture its own UI, another extension's pages, the Web Store,
 * or the devtools window.
 *
 * @param {string|undefined} url - The tab's URL. Undefined when unreadable.
 * @returns {string|null} A sentence for the user, or null if the tab is fine.
 */
function describeUncapturableTab(url) {
  if (!url) return null;  // Unreadable is not the same as forbidden.

  const named = [
    [/^chrome:\/\//i, "Chrome's own pages, like chrome://extensions"],
    [/^(edge|brave|opera|vivaldi|arc|comet):\/\//i, "your browser's own settings pages"],
    [/^chrome-extension:\/\//i, 'extension pages, including this one'],
    [/^devtools:\/\//i, 'the developer tools'],
    [/^about:/i, 'browser pages like about:blank'],
    [/^view-source:/i, 'a view-source page'],
    [/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i, 'the Chrome Web Store'],
  ];

  for (const [pattern, what] of named) {
    if (pattern.test(url)) {
      return `This tab cannot be recorded: Chrome never allows ${what} to be captured. `
        + 'Switch to the tab with your meeting in it, then start the recording.';
    }
  }
  return null;
}


async function handleStartRecording(payload) {
  console.log('[SilentScribe SW] Starting recording...', payload);

  // Only READY may become RECORDING. Every finished recording leaves the
  // extension in COMPLETE, and a failure leaves it in ERROR, so without this
  // the second recording of a session threw "Invalid state transition:
  // COMPLETE -> RECORDING" — the button and the shortcut both dead after one
  // use. Normalising here covers every entry point rather than each caller
  // remembering to do it.
  const entryState = await getState();
  if (entryState.state === STATES.COMPLETE || entryState.state === STATES.ERROR) {
    await setState(STATES.READY);
  }

  // Declared out here so the catch can remove the record that step 1 writes.
  let sessionId = null;

  try {
    // Step 1: Generate session ID and create session record in IndexedDB
    sessionId = generateSessionId();
    const currentState = await getState();

    await createSession({
      id: sessionId,
      platform: currentState.platform || 'unknown',
      micEnabled: payload.micEnabled !== false, // Default to true
      mode: 'tab-audio'
    });

    // Step 2: Get the active tab in the current window
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!activeTab || !activeTab.id) {
      throw new Error('No active tab found. Please focus the meeting tab and try again.');
    }

    // Say so before trying. Chrome refuses to capture its own pages, and the
    // refusal it gives back names the activeTab permission — which sends people
    // off granting permissions that were never the problem. This tab can never
    // be recorded, no matter what is granted.
    const blocked = describeUncapturableTab(activeTab.url);
    if (blocked) throw new Error(blocked);

    // Step 3: Get a media stream ID from tabCapture.
    // This returns a string token that the offscreen document uses to obtain
    // the actual MediaStream via getUserMedia({chromeMediaSource: 'tab'}).
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTab.id,
    });

    if (!streamId) {
      throw new Error('Failed to obtain tab capture stream. Make sure you clicked the Record button (not used a script).');
    }

    // Step 4: Create the offscreen document if it doesn't already exist.
    // Chrome allows exactly ONE offscreen document per extension.
    await ensureOffscreenDocument();

    // Step 5: Send the stream ID and config to the offscreen document.
    // The offscreen doc will use this to start audio capture.
    const offscreenResponse = await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_START_CAPTURE,
      payload: {
        streamId,
        micEnabled: payload.micEnabled !== false,
        sessionId,
        sourceType: 'tab',
      },
    });

    if (!offscreenResponse || !offscreenResponse.success) {
      throw new Error(offscreenResponse?.error || 'Unknown offscreen capture error');
    }// Step 6: Transition to RECORDING state
    await updateSessionStatus(sessionId, SESSION_STATUS.RECORDING);
    await setState(STATES.RECORDING, {
      sessionId,
      recordingStartTime: Date.now(),
      micEnabled: payload.micEnabled !== false,
    });

    // Step 7: Update extension badge to show recording state
    updateBadge('recording');

    console.log(`[SilentScribe SW] Recording started — session: ${sessionId}`);
    return { success: true };

  } catch (err) {
    console.error('[SilentScribe SW] Failed to start recording:', err);

    // createSession writes the record as step 1, before any capture is tried,
    // so a failed start used to leave a permanent empty entry in Past
    // Recordings and a committed zero-byte OPFS file. The cleanup must not
    // replace the real error, so its own failure is only logged.
    if (sessionId) {
      await deleteSession(sessionId).catch((cleanupErr) =>
        console.warn('[SilentScribe SW] Could not remove the empty session:', cleanupErr));
    }

    // Every failed start is reported, from every entry point.
    //
    // This used to swallow the tabCapture activeTab error, on the reasoning
    // that "the UI will fall back to desktopCapture". That fallback has never
    // existed: UI_START_RECORDING_WITH_STREAM has a handler in this file and a
    // name in constants.js, and nothing anywhere sends it. So the one failure
    // the code recognised by name was the one failure nobody was ever told
    // about — press the shortcut, or the button, and get nothing at all.
    const isActiveTabError = err.message.includes('Extension has not been invoked');

    await setState(STATES.ERROR, {
      // The raw activeTab string names a permission, not an action.
      error: isActiveTabError
        ? 'Chrome will not let SilentScribe capture this tab yet. Click the SilentScribe icon on the tab once, then start the recording again.'
        : err.message || 'Failed to start recording',
    });
    updateBadge('error');

    return { success: false, error: err.message };
  }
}

/**
 * Start a new recording session using an existing streamId from desktopCapture.
 * This is used as a fallback when tabCapture is blocked by activeTab requirements.
 * 
 * @param {Object} payload - { streamId: string, micEnabled: boolean }
 * @returns {Promise<{success: boolean}>}
 */
async function handleStartRecordingWithStream(payload) {
  console.log('[SilentScribe SW] Starting recording with provided stream ID...', payload);

  // Declared out here so the catch can remove the record createSession writes
  // below, for the same reason as the tab path: a failed start must not leave
  // an empty recording behind.
  let sessionId = null;

  try {
    sessionId = generateSessionId();
    const currentState = await getState();

    // If we were previously in ERROR state (due to tabCapture failing first),
    // we must gracefully recover back to READY before transitioning to RECORDING.
    if (currentState.state === STATES.ERROR) {
      console.log('[SilentScribe SW] Recovering from ERROR state for fallback capture');
      await setState(STATES.READY);
    }

    await createSession({
      id: sessionId,
      platform: currentState.platform || 'unknown',
      micEnabled: payload.micEnabled !== false,
      mode: payload.mode || 'screen-video',
      desktopStreamId: payload.streamId
    });

    await ensureOffscreenDocument();

    const offscreenResponse = await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_START_CAPTURE,
      payload: {
        streamId: payload.streamId,
        micEnabled: payload.micEnabled !== false,
        sessionId,
        sourceType: 'desktop', // Critical: tells getUserMedia to use 'desktop' not 'tab'
      },
    });

    if (!offscreenResponse || !offscreenResponse.success) {
      throw new Error(offscreenResponse?.error || 'Unknown offscreen capture error');
    }

    await updateSessionStatus(sessionId, SESSION_STATUS.RECORDING);
    await setState(STATES.RECORDING, {
      sessionId,
      recordingStartTime: Date.now(),
      micEnabled: payload.micEnabled !== false,
    });

    updateBadge('recording');
    console.log(`[SilentScribe SW] Recording started (desktop fallback) — session: ${sessionId}`);
    
    return { success: true };
  } catch (err) {
    console.error('[SilentScribe SW] Failed to start desktop recording:', err);

    if (sessionId) {
      await deleteSession(sessionId).catch((cleanupErr) =>
        console.warn('[SilentScribe SW] Could not remove the empty session:', cleanupErr));
    }

    await setState(STATES.ERROR, {
      error: err.message || 'Failed to start desktop recording',
    });
    updateBadge('error');
    return { success: false, error: err.message };
  }
}

/**
 * Stop the current recording session.
 * 
 * Sends a stop command to the offscreen document, which will:
 * 1. Finalize the MediaRecorder (triggers final ondataavailable)
 * 2. Stop all media tracks
 * 3. Collect PCM buffers for transcription
 * 4. Send CAPTURE_COMPLETE back to this service worker
 * 
 * After receiving CAPTURE_COMPLETE, the service worker transitions
 * to PROCESSING state and the offscreen doc begins transcription.
 * 
 * @returns {Promise<{success: boolean}>}
 */
async function handleStopRecording(payload) {
  // Default to transcribing, so the keyboard shortcut and any older caller
  // that sends no payload keep the original behaviour.
  const transcribe = payload?.transcribe !== false;

  // Checked before the first await: two stop messages arriving milliseconds
  // apart both used to read RECORDING and run the whole stop, which finalized
  // the session twice and started two transcriptions of it.
  if (stopInProgress) {
    console.warn('[SilentScribe SW] Ignoring a duplicate stop — one is already running');
    return { success: false, error: 'Already stopping' };
  }
  stopInProgress = true;

  console.log(`[SilentScribe SW] Stopping recording (transcribe: ${transcribe})...`);

  try {
    const state = await getState();
    if (state.state !== STATES.RECORDING) {
      console.warn('[SilentScribe SW] Cannot stop — not currently recording');
      return { success: false, error: 'Not recording' };
    }

    // Record the choice before the offscreen document reports back, so
    // handleCaptureComplete knows whether a transcription is coming.
    await updateMetadata({ transcribe });

    // Finalize the session's end time in IndexedDB
    await finalizeSession(state.sessionId);

    // Tell the offscreen document to stop capturing. It only starts
    // transcription when we ask it to.
    //
    // The answer matters: the offscreen document reports a stop that failed to
    // flush its audio to disk. Ignoring it marked a recording COMPLETE and put
    // a truncated or empty file on screen as though nothing had gone wrong,
    // which is the one failure a recorder must never hide.
    const stopResponse = await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_STOP_CAPTURE,
      payload: { transcribe },
    });

    if (stopResponse && stopResponse.success === false) {
      throw new Error(stopResponse.error || 'The recording could not be saved.');
    }

    // The recording is written and playable, so show it straight away. There is
    // no waiting screen: transcription, when asked for, runs behind the video
    // and drops into the transcript tab when it finishes.
    await updateSessionStatus(
      state.sessionId,
      transcribe ? SESSION_STATUS.TRANSCRIBING : SESSION_STATUS.RECORDED,
    );
    await setState(STATES.COMPLETE, {
      sessionId: state.sessionId,
      transcribe,
      transcribingSessionId: transcribe ? state.sessionId : null,
    });
    updateBadge(transcribe ? 'processing' : 'complete');

    // The offscreen document starts transcription by itself once capture ends.
    // Record that, so closeOffscreenDocument cannot close the document while
    // that run is going. Only set, never cleared here: a stop without
    // transcription must not cancel a previous session still being transcribed.
    if (transcribe) transcriptionInFlight = true;

    if (!transcribe) {
      await closeOffscreenDocument();
      setTimeout(() => updateBadge('idle'), 3000);
    }

    console.log(`[SilentScribe SW] Recording stopped — session: ${state.sessionId}`);
    return { success: true };

  } catch (err) {
    console.error('[SilentScribe SW] Failed to stop recording:', err);
    await setState(STATES.ERROR, {
      error: err.message || 'Failed to stop recording',
    });
    updateBadge('error');
    return { success: false, error: err.message };

  } finally {
    // Released either way: a stop that failed must be retryable.
    stopInProgress = false;
  }
}


// ============================================================================
// MANAGED CONFIG REFRESH
// ============================================================================

/**
 * Pull the published config on a schedule.
 *
 * This is how an install receives a new API key, model, or notice without
 * being reinstalled — and the only practical way to retire a leaked key,
 * since the bundled one is readable by anyone who has the extension.
 *
 * An alarm is used rather than setInterval because the service worker is
 * stopped whenever it goes idle; alarms wake it back up.
 *
 * @returns {Promise<void>}
 */
async function scheduleConfigRefresh() {
  if (!(await isRemoteConfigured())) {
    console.info('[SilentScribe SW] No config URL set — skipping managed config refresh.');
    return;
  }

  await chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
  await fetchRemoteConfig();
}


chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REFRESH_ALARM) return;
  await fetchRemoteConfig();
});


// ============================================================================
// OFFSCREEN DOCUMENT LIFECYCLE
// ============================================================================

/**
 * Ensure the offscreen document exists, creating it if necessary.
 * 
 * Chrome allows exactly ONE offscreen document per extension at any time.
 * If one already exists, this function is a no-op.
 * 
 * The offscreen document is a hidden HTML page that has access to DOM APIs,
 * AudioContext, MediaRecorder, getUserMedia — things the service worker cannot
 * access. It's the "recording room" of the extension.
 * 
 * @returns {Promise<void>}
 */
async function ensureOffscreenDocument() {
  // Check if an offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_CONFIG.URL)],
  });

  if (existingContexts.length > 0) {
    console.log('[SilentScribe SW] Offscreen document already exists');
    return;
  }

  // Create the offscreen document
  console.log('[SilentScribe SW] Creating offscreen document...');
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_CONFIG.URL,
    reasons: OFFSCREEN_CONFIG.REASONS,
    justification: OFFSCREEN_CONFIG.JUSTIFICATION,
  });

  console.log('[SilentScribe SW] Offscreen document created');
}


/**
 * Close the offscreen document.
 * 
 * Called after transcription completes or on error cleanup.
 * Safe to call if no offscreen document exists.
 * 
 * @returns {Promise<void>}
 */
async function closeOffscreenDocument() {
  // The offscreen document holds the live MediaRecorder AND runs transcription.
  // Now that transcription finishes in the background, a transcription that
  // ends while a new recording is running must not close the document out from
  // under it.
  const state = await getState();
  if (state.state === STATES.RECORDING) {
    console.log('[SilentScribe SW] Keeping the offscreen document — a recording is active');
    return;
  }

  // Refusing only during RECORDING was not enough. Transcription runs after the
  // recording is finished, so the state is COMPLETE or PROCESSING while the
  // document is still transcribing, and closing it there destroyed the run
  // silently — no transcript, no error, nothing.
  if (transcriptionInFlight) {
    console.log('[SilentScribe SW] Keeping the offscreen document — a transcription is still running');
    return;
  }

  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_CONFIG.URL)],
    });

    if (existingContexts.length > 0) {
      await chrome.offscreen.closeDocument();
      console.log('[SilentScribe SW] Offscreen document closed');
    }
  } catch (err) {
    console.warn('[SilentScribe SW] Error closing offscreen document:', err);
  }
}


// ============================================================================
// PORT-BASED KEEPALIVE
// ============================================================================

/**
 * Handle incoming port connections.
 * 
 * The offscreen document opens a port named 'keepalive' when it starts.
 * As long as this port is open, Chrome keeps the service worker alive.
 * 
 * If the port disconnects unexpectedly while we're recording, that means
 * the offscreen document was killed (OOM, tab discard, etc.) — we must
 * transition to ERROR state.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    console.log('[SilentScribe SW] Keepalive port connected');
    keepalivePort = port;

    port.onDisconnect.addListener(async () => {
      console.log('[SilentScribe SW] Keepalive port disconnected');
      keepalivePort = null;

      // The document that was doing the work is gone, so nothing is in flight.
      // Without this the marker would stay true forever and the next offscreen
      // document could never be closed.
      transcriptionInFlight = false;

      // Check if we were recording when the port disconnected
      const state = await getState();
      if (state.state === STATES.RECORDING || state.state === STATES.PROCESSING) {
        console.error('[SilentScribe SW] Offscreen document died during recording!');
        await setState(STATES.ERROR, {
          error: 'Recording interrupted — the capture process was terminated unexpectedly. This may be caused by high memory usage.',
        });
        updateBadge('error');
      }
    });

    // Listen for keepalive pings (we don't need to respond, the port
    // connection itself is what keeps the service worker alive)
    port.onMessage.addListener((msg) => {
      // Ping received — service worker stays alive. No action needed.
    });
  }
});


// ============================================================================
// HOTKEY HANDLER
// ============================================================================

/**
 * Handle keyboard shortcut commands.
 * 
 * The 'toggle-recording' command (Alt+Shift+R) toggles recording on/off.
 * If READY → start recording (with current mic setting).
 * If RECORDING → stop recording.
 * All other states → ignored.
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;

  console.log('[SilentScribe SW] Hotkey triggered: toggle-recording');

  try {
    const state = await getState();

    // States the hotkey has to be able to leave. COMPLETE is the important one:
    // it is where every finished recording lands and nothing left it on its own,
    // so the shortcut worked exactly once and then appeared broken for the rest
    // of the browser session. ERROR is the same dead end after a failure.
    if (state.state === STATES.ERROR || state.state === STATES.COMPLETE) {
      console.log(`[SilentScribe SW] Hotkey leaving ${state.state} to start a new recording`);
      await setState(STATES.READY);
    }

    const newState = await getState();

    if (newState.state === STATES.READY) {
      // This listener discards the result, so a failed start has to make
      // itself visible: handleStartRecording sets ERROR and the red badge for
      // a hotkey start, and the title says why when the panel is closed.
      const started = await handleStartRecording({ micEnabled: newState.micEnabled, source: 'hotkey' });
      if (!started?.success) {
        chrome.action.setTitle({ title: `SilentScribe — could not start: ${started?.error || 'unknown error'}` });
      }
    } else if (newState.state === STATES.RECORDING) {
      await handleStopRecording();
    } else {
      // Only IDLE, PERMISSIONS_NEEDED and PROCESSING reach here, and each has a
      // real reason. Say it in the badge instead of only the console, so the
      // key never just does nothing.
      console.log(`[SilentScribe SW] Hotkey ignored — current state: ${newState.state}`);
      flashBadge(newState.state === STATES.PROCESSING ? 'busy' : 'setup');
    }
  } catch (err) {
    console.error('[SilentScribe SW] Hotkey handler failed:', err);
  }
});


// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

/**
 * Handle mic toggle from the side panel.
 * 
 * Updates the micEnabled flag in state. If currently recording,
 * forwards the toggle to the offscreen document.
 * 
 * @param {Object} payload - { micEnabled: boolean }
 * @returns {Promise<{success: boolean}>}
 */
async function handleToggleMic(payload) {
  const state = await getState();
  const currentState = state.state;
  const newMicEnabled = payload.micEnabled;

  // Update state with new mic setting
  await updateMetadata({ micEnabled: newMicEnabled });

  // If recording, forward to offscreen doc
  if (currentState === STATES.RECORDING) {
    await chrome.runtime.sendMessage({
      type: MSG.UI_TOGGLE_MIC,
      payload: { micEnabled: newMicEnabled },
    });
  }

  console.log(`[SilentScribe SW] Mic toggled: ${newMicEnabled}`);
  return { success: true };
}


/**
 * Handle onboarding complete message.
 * Transitions from IDLE or PERMISSIONS_NEEDED to READY.
 */
async function handleOnboardingComplete() {
  const state = await getState();
  if (state.state === STATES.IDLE || state.state === STATES.PERMISSIONS_NEEDED) {
    await setState(STATES.READY);
  }
}


/**
 * Handle meeting detection from the content script.
 * 
 * Updates the platform field in state so the recording knows which
 * meeting platform is active.
 * 
 * @param {Object} payload - { platform: string, active: boolean, url: string }
 */
async function handleMeetingDetected(payload) {
  console.log(`[SilentScribe SW] Meeting detected: ${payload.platform}, active: ${payload.active}`);

  const state = await getState();
  // Only update platform info if we're not currently recording
  // (don't change context mid-recording)
  if (state.state !== STATES.RECORDING && state.state !== STATES.PROCESSING) {
    // Writing chrome.storage.session directly skipped the mutation queue in
    // utils/state.js and broadcast nothing: a transition landing between the
    // read above and this write was erased, and no context heard about the new
    // platform. updateMetadata queues the read-modify-write and broadcasts.
    await updateMetadata({ platform: payload.platform });
  }
}


/**
 * Handle meeting state changes (user joined/left the call).
 * 
 * @param {Object} payload - { active: boolean }
 */
async function handleMeetingStateChanged(payload) {
  console.log(`[SilentScribe SW] Meeting state changed: active=${payload.active}`);
  // Future: auto-stop recording when meeting ends
  // For V1, we just log it
}



/**
 * Read the settings the offscreen document needs, on its behalf.
 *
 * An offscreen document is given `chrome.runtime` and essentially nothing
 * else — `chrome.storage` is undefined there, so reading a setting directly
 * from that context throws `Cannot read properties of undefined`. Routing the
 * read through here keeps one source of truth and means a setting changed
 * mid-recording is still picked up when transcription starts.
 *
 * Never rejects: the offscreen document must be able to record whatever
 * storage does, so a failure returns the same defaults as a missing key.
 *
 * @returns {Promise<{liveTranscript: boolean, modelSize: string}>}
 */
async function handleOffscreenGetSettings() {
  try {
    const stored = await chrome.storage.local.get(['liveTranscript', 'modelSize']);
    return {
      liveTranscript: Boolean(stored.liveTranscript),
      modelSize: stored.modelSize || WHISPER_CONFIG.MODEL_ID,
    };
  } catch (err) {
    console.warn('[SilentScribe SW] Could not read offscreen settings:', err.message);
    return { liveTranscript: false, modelSize: WHISPER_CONFIG.MODEL_ID };
  }
}


/**
 * Handle capture completion from the offscreen document.
 * 
 * This fires after the offscreen doc stops the MediaRecorder and
 * finalizes all audio data. The offscreen doc then starts transcription
 * automatically.
 * 
 * @param {Object} payload - { sessionId: string }
 */
async function handleCaptureComplete(payload) {
  console.log(`[SilentScribe SW] Capture complete for session: ${payload.sessionId}`);

  // When the user chose to skip transcription, handleStopRecording has already
  // marked the session RECORDED. Overwriting that with TRANSCRIBING would leave
  // a finished recording looking like it is stuck mid-transcription.
  const state = await getState();
  if (state.transcribe === false) return;

  await updateSessionStatus(payload.sessionId, SESSION_STATUS.TRANSCRIBING);
}


/**
 * Handle capture errors from the offscreen document.
 * 
 * @param {Object} payload - { error: string }
 */
async function handleCaptureError(payload) {
  console.error(`[SilentScribe SW] Capture error: ${payload.error}`);

  // Capture failed, so the transcription this stop expected will never run.
  // Leaving the marker set would keep the offscreen document open forever.
  transcriptionInFlight = false;

  await setState(STATES.ERROR, { error: payload.error });
  updateBadge('error');
}


/**
 * Handle transcription completion from the offscreen document.
 * 
 * Saves the transcript to IndexedDB and transitions to COMPLETE state.
 * Closes the offscreen document since it's no longer needed.
 * 
 * @param {Object} payload - { sessionId: string, transcript: Array }
 */
async function handleTranscriptionComplete(payload) {
  console.log(`[SilentScribe SW] Transcription complete for session: ${payload.sessionId}`);

  // The document reported it finished, so closeOffscreenDocument below is
  // allowed to close it.
  transcriptionInFlight = false;

  try {
    // Optional pass to fix stutters and mis-hearings. Off by default because it
    // sends the transcript to the provider without the user asking, and costs a
    // request. cleanupTranscript returns the original segments on any failure,
    // so a provider outage can never lose a transcript.
    let segments = payload.transcript;
    const { transcriptCleanup } = await chrome.storage.local.get('transcriptCleanup');
    if (transcriptCleanup) {
      console.log('[SilentScribe SW] Running transcript cleanup...');
      segments = await cleanupTranscript(segments);
    }

    await saveTranscript(payload.sessionId, segments);
    await updateSessionStatus(payload.sessionId, SESSION_STATUS.COMPLETE);

    // Transcription is background work now. Clear the in-progress marker and
    // leave the current view alone — the user may be watching the recording,
    // or may already have started another one. The side panel picks the new
    // transcript up from TRANSCRIPTION_COMPLETE.
    await updateMetadata({ transcribingSessionId: null, transcriptionError: null });

    updateBadge('complete');
    await closeOffscreenDocument();
    setTimeout(() => updateBadge('idle'), 3000);

  } catch (err) {
    console.error('[SilentScribe SW] Failed to save transcript:', err);
    await updateMetadata({
      transcribingSessionId: null,
      transcriptionError: 'The transcript was generated but could not be saved.',
    });
  }
}


/**
 * Handle transcription errors from the offscreen document.
 * 
 * @param {Object} payload - { error: string }
 */
async function handleTranscriptionError(payload) {
  console.error(`[SilentScribe SW] Transcription error: ${payload.error}`);

  // The run is over, so the offscreen document may be closed at the end.
  transcriptionInFlight = false;

  // A failed transcription must not take over the screen. The recording itself
  // is safe and playable, and this used to throw the user into the full-screen
  // ERROR view with a "retry" prompt. Record the failure against the session
  // and let the transcript tab show it in place.
  const state = await getState();
  const sessionId = state.transcribingSessionId || state.sessionId;

  if (sessionId) {
    await updateSessionStatus(sessionId, SESSION_STATUS.RECORDED);
  }

  await updateMetadata({
    transcribingSessionId: null,
    transcriptionError: payload.error || 'Transcription failed.',
  });

  updateBadge('error');
  setTimeout(() => updateBadge('idle'), 3000);
  await closeOffscreenDocument();
}


/**
 * Handle user dismissing an error from the side panel.
 * 
 * Transitions back to READY state.
 * 
 * @returns {Promise<{success: boolean}>}
 */
async function handleDismissError() {
  console.log('[SilentScribe SW] Error dismissed');
  const state = await getState();
  if (state.state !== STATES.READY) {
    await setState(STATES.READY);
  }
  updateBadge('idle');
  return { success: true };
}


/**
 * Handle manual transcription request from the side panel.
 * 
 * Used when the user wants to transcribe (or re-transcribe) a past
 * recording. Ensures the offscreen document exists and sends the
 * transcription command.
 * 
 * @param {Object} payload - { sessionId: string }
 * @returns {Promise<{success: boolean}>}
 */
async function handleStartTranscription(payload) {
  console.log(`[SilentScribe SW] Starting transcription for session: ${payload.sessionId}`);

  try {
    // No state transition: the user stays on the recording they are watching.
    // Progress reaches the transcript tab through TRANSCRIPTION_PROGRESS.
    await updateMetadata({ transcribingSessionId: payload.sessionId, transcriptionError: null });
    updateBadge('processing');
    transcriptionInFlight = true;

    await ensureOffscreenDocument();

    try {
      await chrome.runtime.sendMessage({
        type: MSG.UI_START_TRANSCRIPTION,
        payload: { sessionId: payload.sessionId },
      });
    } catch (relayErr) {
      // The offscreen handler for this message returns false and never calls
      // sendResponse, so a delivered message can still settle as "The message
      // port closed before a response was received". That messaging string was
      // escalated to the full-screen ERROR view — on a transcription that had
      // in fact started, and with nothing that ever transitioned back out.
      if (!/message port closed/i.test(relayErr.message)) throw relayErr;
      console.log('[SilentScribe SW] Transcription request delivered without a reply');
    }

    return { success: true };
  } catch (err) {
    console.error('[SilentScribe SW] Failed to start transcription:', err);

    // A transcription that could not start is not a reason to take over the
    // screen: the recording is safe and playable. Report it in place on the
    // transcript tab, exactly like a transcription that fails later, and clear
    // the marker so the tab does not sit on a spinner nothing ever leaves.
    transcriptionInFlight = false;
    await updateMetadata({
      transcribingSessionId: null,
      transcriptionError: 'Transcription could not be started. Try again.',
    });
    updateBadge('idle');

    return { success: false, error: err.message };
  }
}


/**
 * Handle export request from the side panel.
 * 
 * Retrieves the transcript and session data, formats it in the requested
 * format, and triggers a download.
 * 
 * @param {Object} payload - { sessionId: string, format: 'txt'|'srt'|'json'|'md' }
 * @returns {Promise<{success: boolean}>}
 */
async function handleExport(payload) {
  const { sessionId, format } = payload;
  console.log(`[SilentScribe SW] Exporting session ${sessionId} as ${format}`);

  try {
    const [session, transcriptRecord] = await Promise.all([
      getSession(sessionId),
      getTranscript(sessionId),
    ]);

    if (!session) throw new Error('Session not found');
    if (!transcriptRecord) throw new Error('No transcript available for this session');

    // Format the transcript
    const formatters = { txt: exportTxt, srt: exportSrt, json: exportJson, md: exportMd };
    const formatter = formatters[format];
    if (!formatter) throw new Error(`Unknown export format: ${format}`);

    const content = formatter(transcriptRecord.segments, session);

    // Determine file extension and MIME type
    const mimeTypes = {
      txt: 'text/plain',
      srt: 'text/plain',
      json: 'application/json',
      md: 'text/markdown',
    };

    // Create a data URL for the download
    const blob = new Blob([content], { type: mimeTypes[format] });
    const reader = new FileReader();

    return new Promise((resolve) => {
      reader.onloadend = async () => {
        const dateStr = new Date(session.startTime).toISOString().slice(0, 10);
        const filename = `SilentScribe_${dateStr}_${session.platform}.${format}`;

        try {
          // Request downloads permission if not already granted
          const hasDownloads = await chrome.permissions.contains({
            permissions: ['downloads'],
          });

          if (!hasDownloads) {
            const granted = await chrome.permissions.request({
              permissions: ['downloads'],
            });
            if (!granted) {
              resolve({ success: false, error: 'Download permission denied' });
              return;
            }
          }

          await chrome.downloads.download({
            url: reader.result,
            filename,
            saveAs: true,
          });

          resolve({ success: true });
        } catch (err) {
          console.error('[SilentScribe SW] Download failed:', err);
          resolve({ success: false, error: err.message });
        }
      };

      reader.readAsDataURL(blob);
    });

  } catch (err) {
    console.error('[SilentScribe SW] Export failed:', err);
    return { success: false, error: err.message };
  }
}


// ============================================================================
// BADGE MANAGEMENT
// ============================================================================

/**
 * Update the extension icon badge to reflect the current state.
 * 
 * Badge states:
 * - recording: Red "REC" — actively capturing audio
 * - processing: Yellow "..." — transcription in progress
 * - complete: Green "✓" — transcription done (auto-clears after 3s)
 * - error: Red "!" — something went wrong
 * - idle: No badge — default state
 * 
 * @param {'recording'|'processing'|'complete'|'error'|'idle'} state - Badge state.
 */
/**
 * Show a short badge saying why the hotkey did nothing.
 *
 * A key that silently does nothing is the worst kind of broken: there is no
 * error to read and nothing to search for. The badge is the only surface the
 * shortcut has when the side panel is closed.
 *
 * @param {'busy'|'setup'} reason - Why the press was refused.
 * @returns {void}
 */
function flashBadge(reason) {
  const flashes = {
    busy:  { text: '...', color: '#FFB300', title: 'SilentScribe — still finishing the last recording' },
    setup: { text: '?',   color: '#FFB300', title: 'SilentScribe — open the side panel to finish setup' },
  };
  const flash = flashes[reason] || flashes.setup;

  chrome.action.setBadgeText({ text: flash.text });
  chrome.action.setBadgeBackgroundColor({ color: flash.color });
  chrome.action.setTitle({ title: flash.title });

  setTimeout(async () => {
    try {
      const { state } = await getState();
      updateBadge(state === STATES.RECORDING ? 'recording' : 'idle');
      chrome.action.setTitle({ title: 'SilentScribe — Open Side Panel' });
    } catch { /* the worker went away; the badge resets with it */ }
  }, 2500);
}


function updateBadge(state) {
  const badges = {
    recording:  { text: 'REC', color: '#E53935' },
    processing: { text: '...', color: '#FFB300' },
    complete:   { text: '✓',   color: '#00C896' },
    error:      { text: '!',   color: '#E53935' },
    idle:       { text: '',    color: '#000000' },
  };

  const badge = badges[state] || badges.idle;

  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
  chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
}
