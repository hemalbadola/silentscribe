/**
 * SilentScribe — Content Script (Meeting Detection)
 * ============================================================================
 * 
 * Runs on meeting platform pages (Google Meet, Zoom, Teams, Webex).
 * Detects whether a meeting call is currently active and reports
 * back to the service worker.
 * 
 * THIS SCRIPT DOES NOT:
 * - Capture any audio (that's the offscreen document's job)
 * - Inject any DOM elements into the page
 * - Modify the meeting platform's UI in any way
 * - Access the user's microphone
 * 
 * THIS SCRIPT DOES:
 * - Detect which meeting platform the page belongs to
 * - Monitor the DOM for call-active indicators (join/leave buttons)
 * - Report meeting state changes to the service worker
 * 
 * IMPORTANT: Content scripts cannot use ES module imports in MV3
 * without a bundler. This file uses an IIFE wrapper and duplicates
 * the platform patterns from constants.js.
 * 
 * @module content
 */

;(function SilentScribeContentScript() {
  'use strict';

  // =========================================================================
  // PLATFORM PATTERNS (duplicated from constants.js — content scripts
  // cannot import ES modules without bundling)
  // =========================================================================

  /**
   * Meeting platform detection configuration.
   * 
   * Each entry defines URL patterns and DOM selectors to detect:
   * 1. Which platform the page belongs to (URL matching)
   * 2. Whether a live call is active (DOM selector matching)
   * 3. Whether a call has ended (post-call screen detection)
   * 
   * FRAGILITY NOTE: DOM selectors are platform-specific and WILL break
   * when platforms update their UI. The detection falls back to URL-only
   * matching if selectors fail.
   * 
   * @type {Object[]}
   */
  const PLATFORMS = [
    {
      name: 'google-meet',
      urlPattern: /^https:\/\/meet\.google\.com\/.+/,
      callActiveSelectors: [
        'button[aria-label*="Leave call"]',
        'button[aria-label*="leave call"]',
        'button[data-tooltip*="Leave call"]',
        'div[data-meeting-title]',
        '[data-call-ended="false"]',
        // The call controls toolbar is only visible during an active call
        'div[jsname="EaZ7Me"]',
      ],
      callEndedSelectors: [
        '[data-call-ended="true"]',
        'div[class*="meetingEnded"]',
        'div[data-is-post-call="true"]',
      ],
    },
    {
      name: 'zoom',
      urlPattern: /^https:\/\/([\w-]+\.)?zoom\.us\/.+/,
      callActiveSelectors: [
        '#foot-bar',
        '.meeting-app',
        'button[aria-label*="Leave"]',
        '.meeting-info-container',
      ],
      callEndedSelectors: [
        '.meeting-ended',
        '.post-meeting-page',
      ],
    },
    {
      name: 'teams',
      urlPattern: /^https:\/\/([\w-]+\.)?teams\.microsoft\.com\/.+/,
      callActiveSelectors: [
        '#calling-container',
        'button[aria-label*="Hang up"]',
        'button[aria-label*="hang up"]',
        '[data-tid="calling-pre-join-screen"]',
        '#call-control-bar',
      ],
      callEndedSelectors: [
        '[data-tid="call-ended"]',
        '.call-ended-screen',
      ],
    },
    {
      name: 'webex',
      urlPattern: /^https:\/\/([\w-]+\.)?webex\.com\/.+/,
      callActiveSelectors: [
        '.meeting-controls-container',
        'button[aria-label*="Leave meeting"]',
        '.meeting-controls-bar',
      ],
      callEndedSelectors: [],
    },
  ];


  // =========================================================================
  // STATE
  // =========================================================================

  /** @type {Object|null} The detected meeting platform, or null if no match. */
  let detectedPlatform = null;

  /** @type {boolean|null} Current call-active state. null = unknown. */
  let lastCallActive = null;

  /** @type {MutationObserver|null} Observer watching for DOM changes. */
  let domObserver = null;

  /** @type {number|null} Interval ID for polling-based detection fallback. */
  let pollInterval = null;

  /** @type {boolean} Whether we've sent the initial MEETING_DETECTED message. */
  let initialDetectionSent = false;


  // =========================================================================
  // PLATFORM DETECTION
  // =========================================================================

  /**
   * Detect which meeting platform the current page belongs to.
   * 
   * Matches the current URL against each platform's urlPattern regex.
   * Returns the first matching platform object, or null if no match.
   * 
   * @returns {Object|null} The matching platform configuration, or null.
   */
  function detectPlatform() {
    const url = window.location.href;

    for (const platform of PLATFORMS) {
      if (platform.urlPattern.test(url)) {
        return platform;
      }
    }

    return null;
  }


  /**
   * Check whether a live call/meeting is currently active on the page.
   * 
   * Queries the DOM for platform-specific selectors that indicate a
   * call is in progress (e.g., a "Leave call" button exists).
   * 
   * Also checks for call-ended selectors to distinguish between
   * "in a call" and "call just ended" (post-call screen).
   * 
   * @param {Object} platform - The platform configuration to check against.
   * @returns {boolean|null} true = call active, false = call ended, null = unknown.
   */
  function isCallActive(platform) {
    // First check if the call has ended
    for (const selector of platform.callEndedSelectors) {
      try {
        if (document.querySelector(selector)) {
          return false; // Call has ended
        }
      } catch (err) {
        // Invalid selector — skip silently
      }
    }

    // Then check if a call is active
    for (const selector of platform.callActiveSelectors) {
      try {
        if (document.querySelector(selector)) {
          return true; // Call is active
        }
      } catch (err) {
        // Invalid selector — skip silently
      }
    }

    // No selectors matched — state is unknown
    return null;
  }


  // =========================================================================
  // MONITORING
  // =========================================================================

  /**
   * Start monitoring the page for meeting state changes.
   * 
   * Uses a dual detection strategy:
   * 1. MutationObserver watches the DOM for structural changes
   *    (new elements added that match call-active selectors)
   * 2. Polling every 3 seconds as a fallback — MutationObserver may miss
   *    changes in heavily dynamic SPA frameworks like Meet/Teams
   * 
   * Both strategies call checkAndReport() which debounces state changes.
   */
  function startMonitoring() {
    // Detect the platform from the URL
    detectedPlatform = detectPlatform();

    if (!detectedPlatform) {
      // URL doesn't match any known platform — shouldn't happen since
      // content_scripts.matches in manifest.json filters by URL, but
      // guard against edge cases
      console.log('[SilentScribe Content] No known meeting platform detected on this page');
      return;
    }

    console.log(`[SilentScribe Content] Platform detected: ${detectedPlatform.name}`);

    // Send initial platform detection to service worker
    sendMessage('MEETING_DETECTED', {
      platform: detectedPlatform.name,
      active: false, // We'll update this shortly
      url: window.location.href,
    });
    initialDetectionSent = true;

    // Do an initial check immediately
    checkAndReport();

    // Strategy 1: MutationObserver for real-time DOM changes
    try {
      domObserver = new MutationObserver(debounce(checkAndReport, 500));
      domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'data-call-ended', 'data-tid', 'class'],
      });
    } catch (err) {
      console.warn('[SilentScribe Content] MutationObserver failed:', err.message);
    }

    // Strategy 2: Polling fallback every 3 seconds
    // MutationObserver may not catch all changes in React/Angular SPAs
    // where the DOM is updated via virtual DOM diffing
    pollInterval = setInterval(checkAndReport, 3000);
  }


  /**
   * Check the current call state and report changes to the service worker.
   * 
   * Only sends a message if the state has actually changed, to avoid
   * flooding the service worker with duplicate messages.
   */
  function checkAndReport() {
    if (!detectedPlatform) return;

    const callActive = isCallActive(detectedPlatform);

    // Only report if state changed (or if this is the first detection)
    if (callActive !== lastCallActive) {
      lastCallActive = callActive;

      if (callActive !== null) {
        console.log(`[SilentScribe Content] Call state changed: active=${callActive}`);

        sendMessage('MEETING_STATE_CHANGED', {
          active: callActive,
        });

        // Also update the initial detection with the accurate state
        if (initialDetectionSent) {
          sendMessage('MEETING_DETECTED', {
            platform: detectedPlatform.name,
            active: callActive,
            url: window.location.href,
          });
        }
      }
    }
  }


  // =========================================================================
  // MESSAGING
  // =========================================================================

  /**
   * Send a message to the service worker.
   * 
   * Wraps chrome.runtime.sendMessage with error handling. If the extension
   * context is invalidated (e.g., extension updated/reloaded), the message
   * fails silently rather than throwing an error that could break the
   * meeting page.
   * 
   * @param {string} type - Message type (must be a valid MSG enum value).
   * @param {Object} payload - Message payload.
   */
  function sendMessage(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }).catch(() => {
        // Extension context invalidated — stop monitoring
        cleanup();
      });
    } catch (err) {
      // chrome.runtime may not exist if extension was unloaded
      cleanup();
    }
  }


  // =========================================================================
  // UTILITIES
  // =========================================================================

  /**
   * Create a debounced version of a function.
   * 
   * The debounced function delays invoking the original function until
   * after `wait` milliseconds have elapsed since the last call.
   * Used to prevent MutationObserver from firing checkAndReport() too
   * frequently during rapid DOM updates.
   * 
   * @param {Function} fn - The function to debounce.
   * @param {number} wait - Delay in milliseconds.
   * @returns {Function} The debounced function.
   */
  function debounce(fn, wait) {
    let timeout = null;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }


  /**
   * Clean up all monitoring resources.
   * 
   * Called when the extension context is invalidated or the page is
   * navigating away. Disconnects the MutationObserver and clears
   * the polling interval.
   */
  function cleanup() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }


  // =========================================================================
  // BOOTSTRAP
  // =========================================================================

  // Wait for the DOM to be ready before starting detection.
  // The manifest specifies run_at: document_idle, so the DOM is available,
  // but we add a safety check for robustness.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startMonitoring);
  } else {
    startMonitoring();
  }

  // Clean up when the page is unloading to prevent memory leaks
  window.addEventListener('beforeunload', cleanup);

})();
