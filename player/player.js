/**
 * SilentScribe — Player Tab
 * ============================================================================
 *
 * Plays one recording at full size in an ordinary tab.
 *
 * This exists because a Chrome side panel cannot enter fullscreen — the
 * Fullscreen API is not available there, so the player's own fullscreen button
 * does nothing and there is no way to make it work from inside the panel. In a
 * normal tab, fullscreen, picture-in-picture and the browser's own download all
 * behave as expected.
 *
 * @module player
 */

import { readFile } from '../storage/opfs.js';
import { getSession } from '../storage/db.js';

const LOG_PREFIX = '[SilentScribe Player]';

const video = document.getElementById('video');
const titleEl = document.getElementById('title');
const statusEl = document.getElementById('status');
const downloadBtn = document.getElementById('download');

let objectUrl = null;

/**
 * Show a message in place of the recording.
 *
 * @param {string} text - What went wrong and what to do about it.
 * @returns {void}
 */
function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
}


/**
 * Make a MediaRecorder recording report its real length.
 *
 * MediaRecorder writes its container without a duration, because it does not
 * know the length until recording stops and never goes back to patch the
 * header. The player therefore reports Infinity, shows 0:00, and its scrub bar
 * does nothing. Seeking past the end forces the browser to read to the last
 * cluster and work the duration out.
 *
 * @param {HTMLMediaElement} media - The element to fix up.
 * @returns {void}
 */
function forceDurationLookup(media) {
  const settle = () => {
    if (media.duration !== Infinity) return;
    const restore = () => {
      media.removeEventListener('timeupdate', restore);
      media.currentTime = 0;
    };
    media.addEventListener('timeupdate', restore);
    media.currentTime = 1e101;
  };

  media.addEventListener('loadedmetadata', settle, { once: true });
  if (media.readyState >= 1) settle();
}


/**
 * Load the recording named in the query string.
 *
 * @returns {Promise<void>}
 */
async function load() {
  const sessionId = new URLSearchParams(location.search).get('session');

  if (!sessionId) {
    showStatus('No recording was specified. Open a recording from the SilentScribe side panel.');
    downloadBtn.disabled = true;
    return;
  }

  let session = null;
  try {
    session = await getSession(sessionId);
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not read the session record:', err);
  }

  const blob = await readFile(`session_${sessionId}_primary.webm`).catch((err) => {
    console.error(LOG_PREFIX, 'Could not read the recording:', err);
    return null;
  });

  if (!blob || blob.size === 0) {
    showStatus('This recording could not be found. Its entry may still be listed, but the file itself is no longer stored.');
    downloadBtn.disabled = true;
    return;
  }

  const platform = session?.platform && session.platform !== 'unknown' ? session.platform : null;
  const name = session?.meetingTitle || (platform ? `${platform} recording` : 'Recording');
  titleEl.textContent = name;
  document.title = `${name} — SilentScribe`;

  objectUrl = URL.createObjectURL(blob);
  video.src = objectUrl;
  forceDurationLookup(video);

  // The container is whatever MediaRecorder could produce; naming the file
  // wrongly stops it opening.
  const recorded = session?.metadata?.primaryMimeType || blob.type || '';
  const extension = recorded.includes('mp4') ? 'mp4' : 'webm';
  const stamp = session?.startTime ? new Date(session.startTime).toISOString().slice(0, 10) : 'recording';

  downloadBtn.addEventListener('click', () => {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `silentscribe-${stamp}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
}

// The object URL is the video's source for the life of the page, so it is
// released when the page goes rather than on a timer.
addEventListener('pagehide', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

load().catch((err) => {
  console.error(LOG_PREFIX, 'Failed to load:', err);
  showStatus(`This recording could not be opened: ${err.message}`);
});
