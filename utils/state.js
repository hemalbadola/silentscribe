/**
 * SilentScribe — State Machine
 * ============================================================================
 * 
 * Central state management for the entire extension. The state machine enforces
 * a strict lifecycle across all four execution contexts (service worker,
 * offscreen document, content script, side panel).
 * 
 * ARCHITECTURE RULE: Only the service worker may WRITE state. All other
 * contexts READ state via chrome.storage.session and react to changes
 * via the onChanged listener.
 * 
 * State is stored in chrome.storage.session (ephemeral — cleared when the
 * browser closes). This is intentional: recording state should not persist
 * across browser restarts. Session history lives in IndexedDB separately.
 * 
 * @module state
 */

// ============================================================================
// STATE ENUM
// ============================================================================

/**
 * All possible extension states. Each state maps to a specific side panel
 * view and determines which actions are available.
 * 
 * Lifecycle:
 *   IDLE → PERMISSIONS_NEEDED → READY → RECORDING → PROCESSING → COMPLETE
 *                                 ↑                                    │
 *                                 └────────────────────────────────────┘
 *   Any state → ERROR → READY (on dismiss)
 * 
 * @enum {string}
 */
export const STATES = Object.freeze({
  /** Extension loaded, no permissions checked yet. Initial boot state. */
  IDLE: 'IDLE',

  /** Microphone permission not yet granted. Shows onboarding UI. */
  PERMISSIONS_NEEDED: 'PERMISSIONS_NEEDED',

  /** Permissions granted (or skipped). Ready to record. Default resting state. */
  READY: 'READY',

  /** Actively recording audio from the meeting tab (and optionally mic). */
  RECORDING: 'RECORDING',

  /** Recording stopped. Transcription is running on the captured audio. */
  PROCESSING: 'PROCESSING',

  /** Transcription complete. Transcript available for viewing and export. */
  COMPLETE: 'COMPLETE',

  /** An error occurred. User can dismiss to return to READY. */
  ERROR: 'ERROR',
});


// ============================================================================
// VALID STATE TRANSITIONS
// ============================================================================

/**
 * Defines which state transitions are legal. Any transition not listed here
 * will be rejected by setState(). This prevents impossible states like
 * jumping from IDLE to RECORDING without checking permissions.
 * 
 * The ERROR state is reachable from ANY state (not listed explicitly to
 * avoid repetition — handled in the transition validator).
 * 
 * @type {Object<string, string[]>}
 */
const VALID_TRANSITIONS = Object.freeze({
  [STATES.IDLE]:                [STATES.PERMISSIONS_NEEDED, STATES.READY],
  [STATES.PERMISSIONS_NEEDED]:  [STATES.READY],
  [STATES.READY]:               [STATES.RECORDING],
  [STATES.RECORDING]:           [STATES.PROCESSING, STATES.READY],
  [STATES.PROCESSING]:          [STATES.COMPLETE, STATES.READY],
  [STATES.COMPLETE]:            [STATES.READY],
  [STATES.ERROR]:               [STATES.READY],
});


// ============================================================================
// STORAGE KEY
// ============================================================================

/** Key used in chrome.storage.session to store the current state object. */
const STATE_STORAGE_KEY = 'silentscribe_state';


// ============================================================================
// STATE ACCESSORS
// ============================================================================

/**
 * Retrieve the current extension state from chrome.storage.session.
 * 
 * Returns a state object with the current state name and any associated
 * metadata (error message, active session ID, etc.).
 * 
 * @returns {Promise<{
 *   state: string,
 *   sessionId: string|null,
 *   error: string|null,
 *   recordingStartTime: number|null,
 *   micEnabled: boolean,
 *   platform: string|null
 * }>}
 */
export async function getState() {
  const result = await chrome.storage.session.get(STATE_STORAGE_KEY);
  return result[STATE_STORAGE_KEY] || createDefaultState();
}


/**
 * Transition to a new state. Validates the transition is legal, updates
 * chrome.storage.session, and broadcasts the change to all contexts.
 * 
 * IMPORTANT: This function should ONLY be called from the service worker.
 * Other contexts should send a message to the service worker requesting
 * a state change.
 * 
 * @param {string} newState - The target state from STATES enum.
 * @param {Object} [metadata={}] - Additional data to store with the state.
 * @param {string} [metadata.sessionId] - Active recording session ID.
 * @param {string} [metadata.error] - Error message (for ERROR state).
 * @param {number} [metadata.recordingStartTime] - Unix timestamp when recording started.
 * @param {boolean} [metadata.micEnabled] - Whether mic capture is active.
 * @param {string} [metadata.platform] - Detected meeting platform name.
 * 
 * @throws {Error} If the transition is not valid from the current state.
 * @returns {Promise<void>}
 */
export async function setState(newState, metadata = {}) {
  const current = await getState();
  const currentStateName = current.state;

  // ERROR is reachable from any state — special case
  if (newState !== STATES.ERROR) {
    const allowedNextStates = VALID_TRANSITIONS[currentStateName];
    if (!allowedNextStates || !allowedNextStates.includes(newState)) {
      throw new Error(
        `[SilentScribe] Invalid state transition: ${currentStateName} → ${newState}. ` +
        `Allowed transitions from ${currentStateName}: [${(allowedNextStates || []).join(', ')}]`
      );
    }
  }

  // Build the new state object, preserving metadata from the current state
  // unless explicitly overridden
  const newStateObject = {
    ...current,
    ...metadata,
    state: newState,
    lastTransitionTime: Date.now(),
  };

  // Clear error when leaving ERROR state
  if (currentStateName === STATES.ERROR && newState !== STATES.ERROR) {
    newStateObject.error = null;
  }

  // Clear session data when returning to READY
  if (newState === STATES.READY) {
    newStateObject.recordingStartTime = null;
    // sessionId is preserved so the side panel can still show the last session
  }

  await chrome.storage.session.set({ [STATE_STORAGE_KEY]: newStateObject });

  // Broadcast state change to all extension contexts
  // (side panel, offscreen doc, content scripts)
  broadcastState(newStateObject);
}


/**
 * Update metadata in the current state without triggering a state transition.
 * Validates and broadcasts the update to all contexts.
 * 
 * @param {Object} metadata - The metadata to update.
 * @returns {Promise<void>}
 */
export async function updateMetadata(metadata) {
  const current = await getState();
  const updated = { ...current, ...metadata };
  await chrome.storage.session.set({ [STATE_STORAGE_KEY]: updated });
  broadcastState(updated);
}

/**
 * Listen for state changes. Fires the callback whenever the state is
 * updated in chrome.storage.session.
 * 
 * Usage (in side panel, content script, or offscreen doc):
 *   onStateChange((newState) => {
 *     console.log('State changed to:', newState.state);
 *     updateUI(newState);
 *   });
 * 
 * @param {Function} callback - Called with the new state object.
 * @returns {void}
 */
export function onStateChange(callback) {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes[STATE_STORAGE_KEY]) {
      callback(changes[STATE_STORAGE_KEY].newValue);
    }
  });
}


// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Create the default state object used on first load.
 * 
 * @returns {Object} Default state with IDLE status and null metadata.
 */
function createDefaultState() {
  return {
    state: STATES.IDLE,
    sessionId: null,
    error: null,
    recordingStartTime: null,
    micEnabled: true,
    platform: null,
    lastTransitionTime: Date.now(),
  };
}


/**
 * Broadcast a state change to all extension contexts via chrome.runtime.
 * 
 * This uses a fire-and-forget pattern — if no listeners are active
 * (e.g., side panel is closed), the message is silently dropped.
 * 
 * @param {Object} stateObject - The full state object to broadcast.
 * @returns {void}
 */
function broadcastState(stateObject) {
  const message = {
    type: 'STATE_CHANGED',
    payload: stateObject,
  };

  // Send to all extension contexts (service worker, side panel, offscreen doc)
  // Wrapped in try-catch because sendMessage throws if no listener is active
  chrome.runtime.sendMessage(message).catch(() => {
    // No listeners active — this is expected when side panel is closed
  });
}
