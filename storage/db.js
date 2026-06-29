/**
 * SilentScribe — IndexedDB Storage Layer
 * ============================================================================
 * 
 * Persistent storage for recording sessions, audio chunks, transcripts,
 * and temporary PCM data. All data is stored locally in IndexedDB, scoped
 * to the extension's origin. Nothing leaves the machine.
 * 
 * ARCHITECTURE:
 * - Sessions: metadata about each recording (timestamps, platform, duration)
 * - AudioChunks: WebM blobs (Opus-encoded), linked to sessions by sessionId
 * - Transcripts: structured JSON segments with timestamps and speaker labels
 * - PcmData: temporary Float32Array buffers used during transcription,
 *   deleted after processing to reclaim storage
 * 
 * USAGE:
 * This module is imported by the service worker, offscreen document,
 * and side panel. All operations are async and return Promises.
 * 
 * @module db
 */

import { STORAGE_CONFIG } from '../utils/constants.js';

const { DB_NAME, DB_VERSION, STORES } = STORAGE_CONFIG;


// ============================================================================
// DATABASE CONNECTION
// ============================================================================

/**
 * Singleton database connection promise. Reused across all calls to avoid
 * opening multiple connections.
 * 
 * @type {Promise<IDBDatabase>|null}
 */
let dbPromise = null;


/**
 * Open (or reuse) the IndexedDB database connection.
 * 
 * On first call, this creates the database and object stores if they
 * don't exist. On subsequent calls, it returns the cached connection.
 * 
 * The onupgradeneeded handler creates all object stores and their indexes.
 * When bumping DB_VERSION, add migration logic here.
 * 
 * @returns {Promise<IDBDatabase>} The open database connection.
 */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    /**
     * Schema creation / migration handler.
     * Runs when the database is created for the first time or when
     * DB_VERSION is incremented.
     */
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // ── Sessions Store ──────────────────────────────────────────
      // Key: auto-incremented id
      // Indexes: by startTime (for listing in reverse chronological order)
      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        const sessionStore = db.createObjectStore(STORES.SESSIONS, {
          keyPath: 'id',
          autoIncrement: false, // We generate UUIDs
        });
        sessionStore.createIndex('byStartTime', 'startTime', { unique: false });
        sessionStore.createIndex('byPlatform', 'platform', { unique: false });
      }

      // ── Transcripts Store ───────────────────────────────────────
      // Key: sessionId (one transcript per session)
      if (!db.objectStoreNames.contains(STORES.TRANSCRIPTS)) {
        db.createObjectStore(STORES.TRANSCRIPTS, {
          keyPath: 'sessionId',
        });
      }

      // ── Audio Chunks & PCM Data Stores (Deprecated in V2) ─────────
      if (event.oldVersion < 2) {
        if (db.objectStoreNames.contains('audioChunks')) {
          db.deleteObjectStore('audioChunks');
        }
        if (db.objectStoreNames.contains('pcmData')) {
          db.deleteObjectStore('pcmData');
        }
      }
    };

    request.onsuccess = () => resolve(request.result);

    request.onerror = () => {
      console.error('[SilentScribe DB] Failed to open database:', request.error);
      dbPromise = null; // Allow retry on next call
      reject(request.error);
    };
  });

  return dbPromise;
}


// ============================================================================
// GENERIC HELPERS
// ============================================================================

/**
 * Execute a single read/write transaction on one object store.
 * 
 * Wraps the IndexedDB transaction lifecycle in a Promise. The callback
 * receives the object store and should return the IDBRequest to await.
 * 
 * @param {string} storeName - Name of the object store.
 * @param {'readonly'|'readwrite'} mode - Transaction mode.
 * @param {Function} callback - Receives (objectStore) and returns an IDBRequest.
 * @returns {Promise<*>} The result of the IDBRequest.
 */
async function withStore(storeName, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = callback(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}


/**
 * Execute a cursor-based query that collects all matching records.
 * 
 * @param {string} storeName - Name of the object store.
 * @param {string} [indexName] - Optional index to query on.
 * @param {IDBKeyRange} [range] - Optional key range filter.
 * @param {string} [direction='prev'] - Cursor direction ('next' or 'prev').
 * @param {number} [limit] - Maximum number of records to return.
 * @returns {Promise<Object[]>} Array of matching records.
 */
async function queryAll(storeName, indexName = null, range = null, direction = 'prev', limit = Infinity) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const source = indexName ? store.index(indexName) : store;
    const request = source.openCursor(range, direction);

    const results = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}


// ============================================================================
// SESSION OPERATIONS
// ============================================================================

/**
 * Generate a unique session ID.
 * 
 * Uses crypto.randomUUID() which is available in all Chrome extension
 * contexts (service worker, offscreen doc, side panel).
 * 
 * @returns {string} A UUID v4 string.
 */
export function generateSessionId() {
  return crypto.randomUUID();
}


/**
 * Create a new recording session.
 * 
 * Called when the user starts a recording. The session record stores
 * metadata — actual audio data goes into the audioChunks store.
 * 
 * @param {Object} session - Session metadata.
 * @param {string} session.id - Unique session ID (from generateSessionId).
 * @param {string} session.platform - Meeting platform name (e.g., 'google-meet').
 * @param {boolean} session.micEnabled - Whether mic capture is active.
 * @param {string} [session.meetingTitle] - Optional meeting title if detectable.
 * @returns {Promise<string>} The session ID.
 */
export async function createSession(sessionParams) {
  const now = Date.now();
  const id = sessionParams.id || generateSessionId();
  
  const record = {
    id,
    createdAt: now,
    mode: sessionParams.mode || 'tab-audio', // tab-audio, tab-video, window-video, screen-video, hybrid
    sources: {
      desktop: !!sessionParams.desktopStreamId,
      mic: sessionParams.micEnabled || false,
      webcam: false // Future expansion
    },
    files: {
      primaryMedia: {
        filename: `session_${id}_primary.webm`,
        kind: 'video',
        mimeType: 'video/webm',
        bytesWritten: 0,
        finalized: false,
        createdAt: now,
        durationSeconds: null
      },
      micTrack: sessionParams.micEnabled ? {
        filename: `session_${id}_mic.webm`,
        kind: 'audio',
        mimeType: 'audio/webm',
        bytesWritten: 0,
        finalized: false,
        createdAt: now,
        durationSeconds: null
      } : null,
      webcamTrack: null,
      transcript: { filename: `session_${id}_transcript.json`, kind: 'data' },
      edl: { filename: `session_${id}_edl.json`, kind: 'data' },
      summary: null
    },
    status: 'INTENT_CREATED',
    lastHeartbeat: now,
    startTime: now, // Kept for sorting backwards compatibility
    endTime: null,
    duration: null,
    speakerNames: {}, 
    aiSummary: null,
    bookmarks: [],
    metadata: {
      platform: sessionParams.platform || 'unknown',
      meetingTitle: sessionParams.meetingTitle || null,
      primaryStartOffsetMs: null,
      micStartOffsetMs: null
    }
  };

  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(record));
  return record.id;
}


/**
 * Finalize a recording session.
 * 
 * Called when the user stops recording. Updates endTime and duration.
 * 
 * @param {string} sessionId - The session to finalize.
 * @returns {Promise<void>}
 */
export async function finalizeSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.endTime = Date.now();
  session.duration = session.endTime - session.startTime;

  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}


export async function getSession(sessionId) {
  return withStore(STORES.SESSIONS, 'readonly', (store) => store.get(sessionId));
}

/**
 * Update the status of a recording session.
 * 
 * @param {string} sessionId - The session ID.
 * @param {string} status - New SESSION_STATUS string.
 * @returns {Promise<void>}
 */
export async function updateSessionStatus(sessionId, status) {
  const session = await getSession(sessionId);
  if (!session) return;
  session.status = status;
  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}

/**
 * Update session metadata offsets and track durations.
 * 
 * @param {string} sessionId
 * @param {Object} metadataUpdates
 * @param {Object} durationUpdates
 */
export async function updateSessionMetadata(sessionId, metadataUpdates, durationUpdates) {
  const session = await getSession(sessionId);
  if (!session) return;
  
  if (metadataUpdates) {
    session.metadata = { ...session.metadata, ...metadataUpdates };
  }
  if (durationUpdates) {
    if (durationUpdates.primary !== undefined) {
      session.files.primaryMedia.durationSeconds = durationUpdates.primary;
    }
    if (durationUpdates.mic !== undefined && session.files.micTrack) {
      session.files.micTrack.durationSeconds = durationUpdates.mic;
    }
  }
  
  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}

export async function updateSessionPlatform(sessionId, platform) {
  const session = await getSession(sessionId);
  if (!session) return;
  session.platform = platform;
  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}

/**
 * Get all sessions, ordered by most recent first.
 * 
 * @param {number} [limit=50] - Maximum number of sessions to return.
 * @returns {Promise<Object[]>} Array of session records.
 */
export async function getSessions(limit = 50) {
  return queryAll(STORES.SESSIONS, 'byStartTime', null, 'prev', limit);
}


/**
 * Update speaker name mappings for a session.
 * 
 * Allows users to rename "Me" → "Rahul" and "Others" → "Priya"
 * after recording.
 * 
 * @param {string} sessionId - The session ID.
 * @param {Object} speakerNames - Map of default label → custom name.
 * @returns {Promise<void>}
 */
export async function updateSpeakerNames(sessionId, speakerNames) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.speakerNames = { ...session.speakerNames, ...speakerNames };
  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}


/**
 * Delete a session and all associated data (audio chunks, transcript, PCM).
 * 
 * @param {string} sessionId - The session ID to delete.
 * @returns {Promise<void>}
 */
export async function deleteSession(sessionId) {
  const db = await openDB();

  // Delete from OPFS first
  try {
    const { deleteFile } = await import('./opfs.js');
    await deleteFile(`session_${sessionId}_primary.webm`);
    await deleteFile(`session_${sessionId}_mic.webm`);
  } catch (err) {
    console.warn('[SilentScribe DB] OPFS cleanup failed:', err);
  }

  return new Promise((resolve, reject) => {
    // Only use existing stores
    const tx = db.transaction(
      [STORES.SESSIONS, STORES.TRANSCRIPTS],
      'readwrite'
    );

    tx.objectStore(STORES.SESSIONS).delete(sessionId);
    tx.objectStore(STORES.TRANSCRIPTS).delete(sessionId);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}


// ============================================================================
// AUDIO CHUNK OPERATIONS (DEPRECATED V2)
// ============================================================================
// Raw media is now streamed directly to OPFS via storage/opfs.js.


// ============================================================================
// TRANSCRIPT OPERATIONS
// ============================================================================

/**
 * Save a transcript for a session.
 * 
 * A transcript is an array of segments, each with a start time, end time,
 * speaker label, and transcribed text.
 * 
 * @param {string} sessionId - The session ID.
 * @param {Object[]} segments - Array of transcript segments.
 * @param {number} segments[].start - Segment start time in seconds.
 * @param {number} segments[].end - Segment end time in seconds.
 * @param {string} segments[].speaker - Speaker label ('Me' or 'Others').
 * @param {string} segments[].text - Transcribed text.
 * @param {number} [segments[].confidence] - Whisper confidence score (0-1).
 * @returns {Promise<void>}
 */
export async function saveTranscript(sessionId, segments) {
  const record = {
    sessionId,
    segments,
    createdAt: Date.now(),
    wordCount: segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0),
  };

  await withStore(STORES.TRANSCRIPTS, 'readwrite', (store) => store.put(record));

  // Mark session as transcribed
  const session = await getSession(sessionId);
  if (session) {
    session.transcribed = true;
    await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
  }
}


/**
 * Get the transcript for a session.
 * 
 * @param {string} sessionId - The session ID.
 * @returns {Promise<Object|null>} The transcript record, or null if not yet transcribed.
 */
export async function getTranscript(sessionId) {
  return withStore(STORES.TRANSCRIPTS, 'readonly', (store) => store.get(sessionId));
}


/**
 * Update the text of a specific transcript segment.
 * 
 * @param {string} sessionId - The session ID.
 * @param {number} segmentIndex - The index of the segment to update.
 * @param {string} newText - The new text for the segment.
 * @returns {Promise<void>}
 */
export async function updateTranscriptSegment(sessionId, segmentIndex, newText) {
  const transcript = await getTranscript(sessionId);
  if (!transcript || !transcript.segments[segmentIndex]) return;

  transcript.segments[segmentIndex].text = newText;
  
  // Update total word count
  transcript.wordCount = transcript.segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);

  await withStore(STORES.TRANSCRIPTS, 'readwrite', (store) => store.put(transcript));
}


// REMOVED DUPLICATE FUNCTION


/**
 * Merge a segment into the preceding segment.
 * 
 * @param {string} sessionId - The session ID.
 * @param {number} segmentIndex - The index of the segment to merge backwards (must be > 0).
 * @returns {Promise<void>}
 */
export async function mergeTranscriptSegments(sessionId, segmentIndex) {
  if (segmentIndex <= 0) return;
  
  const transcript = await getTranscript(sessionId);
  if (!transcript || !transcript.segments[segmentIndex] || !transcript.segments[segmentIndex - 1]) return;

  const prev = transcript.segments[segmentIndex - 1];
  const curr = transcript.segments[segmentIndex];

  // Merge curr into prev
  prev.text = `${prev.text.trim()} ${curr.text.trim()}`.trim();
  prev.end = curr.end; // Extend duration

  // Remove the merged segment
  transcript.segments.splice(segmentIndex, 1);
  
  transcript.wordCount = transcript.segments.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
  await withStore(STORES.TRANSCRIPTS, 'readwrite', (store) => store.put(transcript));
}


/**
 * Split a segment into two at a specific string index.
 * 
 * @param {string} sessionId - The session ID.
 * @param {number} segmentIndex - The index of the segment to split.
 * @param {number} charIndex - The character index within the text where the split occurs.
 * @returns {Promise<void>}
 */
export async function splitTranscriptSegment(sessionId, segmentIndex, charIndex) {
  const transcript = await getTranscript(sessionId);
  if (!transcript || !transcript.segments[segmentIndex]) return;

  const seg = transcript.segments[segmentIndex];
  const text1 = seg.text.substring(0, charIndex).trim();
  const text2 = seg.text.substring(charIndex).trim();

  if (!text1 || !text2) return; // Prevent splitting into empty segments

  // Calculate approximate duration split based on text length ratio
  const duration = seg.end - seg.start;
  const ratio = text1.length / seg.text.length;
  const splitTime = seg.start + (duration * ratio);

  const seg1 = { ...seg, text: text1, end: splitTime };
  const seg2 = { ...seg, text: text2, start: splitTime };

  // Replace original segment with the two new ones
  transcript.segments.splice(segmentIndex, 1, seg1, seg2);

  await withStore(STORES.TRANSCRIPTS, 'readwrite', (store) => store.put(transcript));
}


// ============================================================================
// PCM DATA OPERATIONS (TEMPORARY)
// ============================================================================

/**
 * Store raw PCM audio data for transcription processing.
 * 
 * PCM data is stored as two separate channel arrays (mic and tab)
 * to support stream-based speaker diarization. Each array contains
 * Float32Array buffers of 16kHz mono audio.
 * 
 * This data is TEMPORARY — it should be deleted after transcription
 * completes to reclaim storage space.
 * 
 * @param {string} sessionId - The session ID.
 * @param {Object} pcmData - Raw PCM audio data.
 * @param {ArrayBuffer[]} pcmData.mic - PCM chunks from microphone (may be empty).
 * @param {ArrayBuffer[]} pcmData.tab - PCM chunks from tab audio.
 * @returns {Promise<void>}
 */
export async function savePcmData(sessionId, pcmData) {
  const record = {
    sessionId,
    mic: pcmData.mic,
    tab: pcmData.tab,
    storedAt: Date.now(),
  };

  await withStore(STORES.PCM_DATA, 'readwrite', (store) => store.put(record));
}


/**
 * Get stored PCM data for a session.
 * 
 * @param {string} sessionId - The session ID.
 * @returns {Promise<Object|null>} PCM data with mic and tab arrays.
 */
export async function getPcmData(sessionId) {
  return withStore(STORES.PCM_DATA, 'readonly', (store) => store.get(sessionId));
}


/**
 * Delete PCM data after transcription is complete.
 * 
 * PCM data is large (16kHz × 4 bytes × seconds) and should not be
 * kept longer than necessary.
 * 
 * @param {string} sessionId - The session ID.
 * @returns {Promise<void>}
 */
export async function deletePcmData(sessionId) {
  await withStore(STORES.PCM_DATA, 'readwrite', (store) => store.delete(sessionId));
}


// ============================================================================
// MEETING INTELLIGENCE (AI & BOOKMARKS)
// ============================================================================

/**
 * Save AI-generated insights (Summary, Key Moments, etc.) to the session.
 * 
 * @param {string} sessionId - The session ID.
 * @param {string} markdownNotes - The AI-generated markdown notes.
 * @returns {Promise<void>}
 */
export async function saveAiInsights(sessionId, markdownNotes) {
  const session = await getSession(sessionId);
  if (!session) return;

  session.aiSummary = markdownNotes;
  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}


/**
 * Add a bookmark to a specific timestamp in the session.
 * 
 * @param {string} sessionId - The session ID.
 * @param {number} time - The timestamp in seconds.
 * @param {string} label - A label for the bookmark.
 * @returns {Promise<void>}
 */
export async function addBookmark(sessionId, time, label = 'Bookmark') {
  const session = await getSession(sessionId);
  if (!session) return;

  if (!session.bookmarks) session.bookmarks = [];
  
  // Prevent duplicate exact bookmarks
  const exists = session.bookmarks.some(b => b.time === time);
  if (!exists) {
    session.bookmarks.push({ time, label, createdAt: Date.now() });
    // Keep bookmarks sorted chronologically
    session.bookmarks.sort((a, b) => a.time - b.time);
    await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
  }
}

/**
 * Remove a bookmark by timestamp.
 * 
 * @param {string} sessionId - The session ID.
 * @param {number} time - The timestamp of the bookmark to remove.
 * @returns {Promise<void>}
 */
export async function removeBookmark(sessionId, time) {
  const session = await getSession(sessionId);
  if (!session || !session.bookmarks) return;

  session.bookmarks = session.bookmarks.filter(b => b.time !== time);
  await withStore(STORES.SESSIONS, 'readwrite', (store) => store.put(session));
}


// ============================================================================
// STORAGE ANALYTICS
// ============================================================================

/**
 * Get storage usage statistics.
 * 
 * Useful for the side panel to show how much space recordings are using
 * and warn the user if they're approaching quota limits.
 * 
 * @returns {Promise<{
 *   sessionCount: number,
 *   totalAudioSize: number,
 *   estimatedQuota: number,
 *   usagePercentage: number
 * }>}
 */
export async function getStorageStats() {
  const sessions = await getSessions(Infinity);
  const sessionCount = sessions.length;

  // Sum up audio chunk sizes
  let totalAudioSize = 0;
  for (const session of sessions) {
    const chunks = await getAudioChunks(session.id);
    totalAudioSize += chunks.reduce((sum, chunk) => sum + (chunk.size || 0), 0);
  }

  // Get quota estimate from the StorageManager API
  let estimatedQuota = 0;
  let usagePercentage = 0;
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    estimatedQuota = estimate.quota || 0;
    usagePercentage = estimatedQuota > 0
      ? ((estimate.usage || 0) / estimatedQuota) * 100
      : 0;
  }

  return {
    sessionCount,
    totalAudioSize,
    estimatedQuota,
    usagePercentage: Math.round(usagePercentage * 100) / 100,
  };
}
