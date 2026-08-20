/**
 * SilentScribe — First-Run Onboarding
 * ============================================================================
 *
 * A new user used to land on a bare "Grant Permission / Skip" screen. It never
 * said what was recorded, where the audio went, that the first transcription
 * downloads a speech model, or that the keyboard shortcut can already belong
 * to another extension. Each of those surfaced later as a failure the user had
 * no way to explain. This module is that missing explanation.
 *
 * It keeps no module-level state: the step index lives in the render closure
 * and every draw replaces the container's children, so a second call restarts
 * the tour rather than stacking a copy on the first.
 *
 * Every claim in the copy was read out of the code first. Whisper runs in
 * transcription/transcription-worker.js, a Web Worker on this machine, so
 * audio is never uploaded. offscreen/offscreen.js labels a segment "Me" only
 * when microphone energy dominates, so with no microphone every segment is
 * "Others". utils/ai.js sends transcript text to a hosted provider only for
 * the bring-your-own-key engine, and only from the notes button.
 *
 * @module onboarding
 */

import { initShortcutSetup } from './shortcut-setup.js';

const LOG_PREFIX = '[SilentScribe Onboarding]';

const STORAGE_KEY = 'onboardingCompletedAt';
const PANEL_PATH  = 'sidepanel/panel.html';

/** Shown in place of a card whose builder threw. Never leave the panel blank. */
const FALLBACK = 'This step could not be checked. You can finish setting up from Settings.';

/** Chrome's microphone verdict, worded as something the user can act on. */
const MIC_STATUS = Object.freeze({
  denied: { tone: 'is-error', text: 'Chrome is blocking the microphone for this extension. Open the tune icon in the address bar to allow it.' },
  prompt: { tone: 'is-pending', text: 'Chrome has not asked for the microphone yet.' },
});


/**
 * Render the first-run tour into a container.
 *
 * Safe to call more than once on the same element — each call redraws from
 * step one. Never throws: a check that cannot run degrades to static text.
 *
 * @param {HTMLElement} container - Element that receives the tour.
 * @param {{onComplete?: () => void}} [options] - Called once, on finish or skip.
 * @returns {Promise<void>}
 */
export async function renderOnboarding(container, { onComplete } = {}) {
  if (!container) {
    console.warn(LOG_PREFIX, 'No container element, tour not rendered.');
    return;
  }

  // Planned once, so "Step 2 of 3" stays honest for the whole tour.
  const steps = await planSteps();
  let index = 0;

  const ctx = { state: {}, next: () => go(index + 1), redraw: draw };

  function go(target) {
    if (target >= steps.length) return void finish();
    index = Math.max(0, target);
    draw();
  }

  async function finish() {
    await markComplete();
    try {
      onComplete?.();
    } catch (err) {
      console.warn(LOG_PREFIX, 'onComplete threw:', err);
    }
  }

  function draw() {
    const step = steps[index];
    const tour = el('div', 'onboarding-tour');
    tour.append(el('p', 'onboarding-progress', `Step ${index + 1} of ${steps.length}`));

    try {
      tour.append(step.build(ctx), ...(step.actions?.(ctx) || []));
    } catch (err) {
      console.warn(LOG_PREFIX, `Step "${step.key}" failed to render:`, err);
      tour.append(el('p', 'card-body', FALLBACK));
    }

    const nav = el('div', 'onboarding-nav');
    if (index > 0) nav.append(button('Back', 'btn btn-ghost', () => go(index - 1)));
    nav.append(button(step.nextLabel || 'Next', step.nextClass || 'btn btn-primary', ctx.next));
    tour.append(nav);

    // The last step's own button ends the tour, so it needs no skip link.
    if (index < steps.length - 1) {
      tour.append(button('Skip setup', 'btn btn-ghost onboarding-skip', finish));
    }

    container.replaceChildren(tour);
  }

  draw();
}


/**
 * Whether the tour was finished or skipped before. Returns true when storage
 * cannot be read, so a user whose completion can never be saved is not
 * trapped in the tour on every open.
 *
 * @returns {Promise<boolean>}
 */
export async function isOnboardingComplete() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    return Boolean(stored?.[STORAGE_KEY]);
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not read the onboarding flag:', err);
    return true;
  }
}


/**
 * Clear the completion flag so the tour plays again. A Settings entry calls
 * this, then calls renderOnboarding() to replay the tour.
 *
 * @returns {Promise<void>}
 */
export async function resetOnboarding() {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not clear the onboarding flag:', err);
  }
}


/** Decide which steps to show. A granted microphone drops its step entirely. */
async function planSteps() {
  const mic = await micPermissionState();
  return [INTRO_STEP, mic === 'granted' ? null : micStep(mic), SHORTCUT_STEP, READY_STEP]
    .filter(Boolean);
}


/** Step 1 — what the extension does, and what leaves the machine. */
const INTRO_STEP = {
  key: 'intro',
  build: () => card('🎙️', 'What SilentScribe does', [
    'SilentScribe records the audio of your meeting tab and writes a transcript of it.',
    'The transcript is made here. A Whisper speech model runs on this computer, so your audio is never uploaded.',
    'Meeting notes are separate and optional. If you connect a cloud provider in Settings, SilentScribe sends it the transcript text, and only when you ask for notes.',
  ]),
};


/** Step 2 — the microphone. `state` is Chrome's verdict, or '' when unknown. */
function micStep(state) {
  return {
    key: 'mic',
    // Next doubles as the honest skip: recording still works without a mic.
    nextLabel: 'Skip — meeting audio only',
    nextClass: 'btn btn-ghost',

    build: (ctx) => {
      const node = card('🎤', 'Your microphone', [
        'SilentScribe uses the microphone to tell your voice apart from the other people in the call.',
        'Without it, every line of the transcript is labeled "Others". The meeting audio is still recorded.',
      ]);
      const status = ctx.state.micNotice || MIC_STATUS[state];
      if (status) node.append(el('p', `settings-status ${status.tone}`, status.text));
      return node;
    },

    actions: (ctx) => {
      const allow = button('Allow microphone', 'btn btn-primary btn-full', () => requestMic(ctx));
      if (!ctx.state.micNotice?.needsTab) return [allow];
      return [allow, button('Open SilentScribe in a tab', 'btn btn-ghost btn-full', openPanelTab)];
    },
  };
}


/** Step 3 — the keyboard shortcut, drawn by the module that already owns it. */
const SHORTCUT_STEP = {
  key: 'shortcut',
  build: () => {
    const node = el('div', 'onboarding-shortcut');
    node.append(el('p', 'settings-description',
      'This shortcut starts and stops a recording without opening the panel.'));

    // shortcut-setup.js reads the live binding and handles its own failures.
    // Until it answers, this static line is what the user sees.
    const mount = el('div', null);
    mount.append(el('p', 'settings-hint', 'Reading your keyboard shortcut…'));
    node.append(mount);
    initShortcutSetup(mount)
      .catch((err) => console.warn(LOG_PREFIX, 'Shortcut card failed to render:', err));

    return node;
  },
};


/** Step 4 — the model download, so a slow first run does not read as a fault. */
const READY_STEP = {
  key: 'ready',
  nextLabel: 'Start using SilentScribe',
  build: () => card('⏳', 'Your first transcription', [
    'The first time you transcribe, SilentScribe downloads the Whisper speech model. The default model is about 145MB and takes a few minutes.',
    'It is not broken when it is slow. The model is stored in this browser and downloads one time only. Every transcription after it starts at once.',
    'You can choose a smaller or a larger model in Settings.',
  ]),
};


/** Chrome's microphone permission: 'granted', 'denied', 'prompt', or '' if unknown. */
async function micPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state || '';
  } catch (err) {
    // Some builds reject 'microphone' as a descriptor. Show the step anyway.
    console.warn(LOG_PREFIX, 'Could not read the microphone permission:', err);
    return '';
  }
}


/**
 * Ask for the microphone. Chrome refuses to show a permission prompt inside a
 * side panel, so a failure there is not a refusal — it needs a real tab. Only
 * a failure in a full tab means the user pressed Block.
 */
async function requestMic(ctx) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());  // The prompt was the point.
    ctx.state.micNotice = null;
    ctx.next();
  } catch (err) {
    console.warn(LOG_PREFIX, 'Microphone request failed:', err);
    let needsTab = true;
    try {
      needsTab = !(await chrome.tabs.getCurrent());
    } catch (tabErr) {
      console.warn(LOG_PREFIX, 'Could not identify this page:', tabErr);
    }
    ctx.state.micNotice = {
      tone: 'is-error',
      needsTab,
      text: needsTab
        ? 'Chrome cannot show the microphone prompt in a side panel. Open SilentScribe in a tab, allow the microphone there, then come back.'
        : 'Chrome blocked the microphone. Open the tune icon in the address bar, allow the microphone, then reload this page.',
    };
    ctx.redraw();
  }
}


/** Open the panel as a normal tab. Only the tabs API can open it from here. */
function openPanelTab() {
  const fail = (err) => console.warn(LOG_PREFIX, 'Could not open the panel in a tab:', err);
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) })?.catch?.(fail);
  } catch (err) {
    fail(err);
  }
}


/** Record that the tour is done, so later opens go straight to the panel. */
async function markComplete() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: new Date().toISOString() });
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not save the onboarding flag:', err);
  }
}


/** Build a glass card with an icon, a title, and one paragraph per string. */
function card(icon, title, paragraphs) {
  const node = el('div', 'card glass-card onboarding-step');
  const glyph = el('div', 'card-icon', icon);
  glyph.setAttribute('aria-hidden', 'true');
  node.append(glyph, el('h2', 'card-title', title));
  for (const text of paragraphs) node.append(el('p', 'card-body', text));
  return node;
}


/** Build a button. Promise.resolve().then() catches a sync throw and a rejection alike. */
function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', () => Promise.resolve().then(onClick)
    .catch((err) => console.warn(LOG_PREFIX, 'Action failed:', err)));
  return node;
}


/** Create an element. Text is always set with textContent, never innerHTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
