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
import { MSG, OFFSCREEN_CONFIG, SESSION_STATUS } from '../utils/constants.js';
import {
  createSession,
  finalizeSession,
  updateSessionStatus,
  updateSessionMetadata,
  saveTranscript,
  generateSessionId,
  getSession,
  getTranscript,
} from '../storage/db.js';
import { exportTxt, exportSrt, exportJson, exportMd } from '../utils/export.js';

import { cleanupTranscript, generateAiTitle } from '../utils/ai.js';


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
      handleStopRecording().then(sendResponse).catch((err) => {
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

    case MSG.UI_RETURN_TO_READY:
      setState(STATES.READY).then(sendResponse);
      return true;

    case MSG.UI_EXPORT:
      handleExport(payload).then(sendResponse);
      return true;

    // ── From Content Script ──────────────────────────────────────
    case MSG.UI_ONBOARDING_COMPLETE:
      handleOnboardingComplete(payload);
      return false;

    case MSG.MEETING_DETECTED:
      handleMeetingDetected(payload);
      return false; // Sync — no response needed

    case MSG.MEETING_STATE_CHANGED:
      handleMeetingStateChanged(payload);
      return false;

    // ── From Offscreen Document ──────────────────────────────────
    case MSG.CAPTURE_COMPLETE:
      handleCaptureComplete(payload);
      return false;

    case MSG.CAPTURE_ERROR:
      handleCaptureError(payload);
      return false;

    case MSG.CAPTURE_LEVELS:
      // Forward level data directly to side panel — no processing needed
      // Side panel listens for this via chrome.runtime.onMessage
      return false;

    // ── From Transcription Worker (via offscreen doc) ────────────
    case MSG.TRANSCRIPTION_PROGRESS:
      // Forwarded automatically since the offscreen doc sends via
      // chrome.runtime.sendMessage which broadcasts to all contexts
      return false;

    case MSG.TRANSCRIPTION_COMPLETE:
      handleTranscriptionComplete(payload);
      return false;

    case MSG.TRANSCRIPTION_ERROR:
      handleTranscriptionError(payload);
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
async function handleStartRecording(payload) {
  console.log('[SilentScribe SW] Starting recording...', payload);

  try {
    // Step 1: Generate session ID and create session record in IndexedDB
    const sessionId = generateSessionId();
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
    
    // If it's the expected tabCapture activeTab error, don't set the global ERROR state
    // because the UI is going to automatically handle the fallback to desktopCapture.
    if (!err.message.includes('Extension has not been invoked')) {
      await setState(STATES.ERROR, {
        error: err.message || 'Failed to start recording',
      });
      updateBadge('error');
    }
    
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

  try {
    const sessionId = generateSessionId();
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
async function handleStopRecording() {
  console.log('[SilentScribe SW] Stopping recording...');

  try {
    const state = await getState();
    if (state.state !== STATES.RECORDING) {
      console.warn('[SilentScribe SW] Cannot stop — not currently recording');
      return { success: false, error: 'Not recording' };
    }

    // Finalize the session's end time in IndexedDB
    await finalizeSession(state.sessionId);

    // Tell the offscreen document to stop capturing
    await chrome.runtime.sendMessage({
      type: MSG.OFFSCREEN_STOP_CAPTURE,
    });

    // Transition to PROCESSING — transcription will start in the offscreen doc
    await updateSessionStatus(state.sessionId, SESSION_STATUS.TRANSCRIBING);
    await setState(STATES.PROCESSING);
    updateBadge('processing');

    console.log(`[SilentScribe SW] Recording stopped — session: ${state.sessionId}`);
    return { success: true };

  } catch (err) {
    console.error('[SilentScribe SW] Failed to stop recording:', err);
    await setState(STATES.ERROR, {
      error: err.message || 'Failed to stop recording',
    });
    updateBadge('error');
    return { success: false, error: err.message };
  }
}


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

    // Recover from ERROR state if user tries to use the hotkey to record again
    if (state.state === STATES.ERROR) {
      console.log('[SilentScribe SW] Recovering from ERROR state via hotkey');
      await setState(STATES.READY);
      // Re-fetch state to ensure clean start
    }

    const newState = await getState();

    if (newState.state === STATES.READY) {
      await handleStartRecording({ micEnabled: newState.micEnabled });
    } else if (newState.state === STATES.RECORDING) {
      await handleStopRecording();
    } else {
      console.log(`[SilentScribe SW] Hotkey ignored — current state: ${newState.state}`);
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
    await chrome.storage.session.set({
      silentscribe_state: { ...state, platform: payload.platform },
    });
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
  
  // V2: Transcription is deferred to Intelligence Plane but still
  // triggered automatically for now. We stay in PROCESSING state.
  await updateSessionStatus(payload.sessionId, SESSION_STATUS.TRANSCRIBING);
}


/**
 * Handle capture errors from the offscreen document.
 * 
 * @param {Object} payload - { error: string }
 */
async function handleCaptureError(payload) {
  console.error(`[SilentScribe SW] Capture error: ${payload.error}`);
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

  try {
    // 1. Run AI cleanup on the raw segments before saving
    console.log('[SilentScribe SW] Running AI Transcript Cleanup...');
    chrome.runtime.sendMessage({
      type: MSG.TRANSCRIPTION_PROGRESS,
      payload: { progress: 1.0, status: 'Running AI Transcript Cleanup...' }
    }).catch(() => {});
    
    const cleanedTranscript = await cleanupTranscript(payload.transcript);

    // Save the cleaned transcript to IndexedDB
    await saveTranscript(payload.sessionId, cleanedTranscript);

    // 2. Generate AI Title
    console.log('[SilentScribe SW] Generating AI Meeting Title...');
    chrome.runtime.sendMessage({
      type: MSG.TRANSCRIPTION_PROGRESS,
      payload: { progress: 1.0, status: 'Generating meeting title...' }
    }).catch(() => {});
    
    const aiTitle = await generateAiTitle(cleanedTranscript);
    if (aiTitle) {
      await updateSessionMetadata(payload.sessionId, { title: aiTitle });
    }

    // Transition to COMPLETE state
    await updateSessionStatus(payload.sessionId, SESSION_STATUS.COMPLETE);
    await setState(STATES.COMPLETE, { sessionId: payload.sessionId });
    updateBadge('complete');

    // Close the offscreen document — no longer needed
    await closeOffscreenDocument();

    // Clear the badge after 3 seconds
    setTimeout(() => updateBadge('idle'), 3000);

  } catch (err) {
    console.error('[SilentScribe SW] Failed to save transcript:', err);
    await setState(STATES.ERROR, {
      error: 'Transcription completed but failed to save results.',
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

  // Still transition to COMPLETE if we have audio — the user can retry
  // transcription later. Don't lose their recording.
  const state = await getState();
  await updateSessionStatus(state.sessionId, SESSION_STATUS.ERROR);
  await setState(STATES.ERROR, {
    error: `Transcription failed: ${payload.error}. Your audio recording is saved and you can retry.`,
    sessionId: state.sessionId,
  });
  updateBadge('error');

  // Close the offscreen document
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
    await setState(STATES.PROCESSING, { sessionId: payload.sessionId });
    updateBadge('processing');

    await ensureOffscreenDocument();

    await chrome.runtime.sendMessage({
      type: MSG.UI_START_TRANSCRIPTION,
      payload: { sessionId: payload.sessionId },
    });

    return { success: true };
  } catch (err) {
    console.error('[SilentScribe SW] Failed to start transcription:', err);
    await setState(STATES.ERROR, {
      error: err.message || 'Failed to start transcription',
    });
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
