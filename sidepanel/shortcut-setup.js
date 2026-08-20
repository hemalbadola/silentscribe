/**
 * SilentScribe — Keyboard Shortcut Setup
 * ============================================================================
 *
 * `suggested_key` in the manifest is only a suggestion. Chrome awards a key
 * combination to the first extension that claims it, so where another
 * extension already owns ours, `chrome.commands.getAll()` reports an empty
 * `shortcut` and the keys trigger that other extension. The single fix is
 * chrome://extensions/shortcuts, which a renderer cannot navigate to — Chrome
 * blocks chrome:// URLs from an <a href>, so the page opens through
 * `chrome.tabs.create` and nothing else.
 *
 * This module renders one self-updating card: the live combination when the
 * command is bound, numbered setup steps when it is not. It re-checks on
 * visibility and focus, so the card corrects itself after the user assigns
 * the shortcut in the other tab.
 *
 * macOS note: Chrome reports Mac shortcuts as a glyph run with no separator
 * ("⌥⇧R"), Windows and Linux as words ("Alt+Shift+R"). Both are tokenized.
 *
 * @module shortcut-setup
 */

const LOG_PREFIX = '[SilentScribe Shortcut]';

const COMMAND_NAME  = 'toggle-recording';
const SHORTCUTS_URL = 'chrome://extensions/shortcuts';
const RECHECK_DELAY = 300;

/** Modifier words Chrome can report, mapped to the macOS glyph. */
const MAC_GLYPHS = {
  command: '⌘', cmd: '⌘', ctrl: '⌘', control: '⌘',
  macctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧', search: '🔍',
};


/**
 * Render the shortcut card into a container and keep it current.
 *
 * Safe to call more than once on the same element: the refresh listeners
 * attach only on the first call. Never throws — every failure degrades to
 * static setup instructions.
 *
 * @param {HTMLElement} container - Empty element that receives the card.
 * @returns {Promise<void>}
 */
export async function initShortcutSetup(container) {
  if (!container) return;

  if (!container.dataset.shortcutWired) {
    container.dataset.shortcutWired = 'true';
    attachRefreshTriggers(container);
  }

  await render(container);
}


/** Read the live binding and replace the card with the matching view. */
async function render(container) {
  let shortcut = '';
  let available = true;

  try {
    const commands = await chrome.commands.getAll();
    shortcut = commands.find((c) => c.name === COMMAND_NAME)?.shortcut || '';
  } catch (err) {
    available = false;
    console.warn(LOG_PREFIX, 'Could not read keyboard shortcuts:', err);
  }

  container.replaceChildren(shortcut ? boundCard(shortcut) : unboundCard(available));
}


/** Card for a bound command. `shortcut` is the combination Chrome reports. */
function boundCard(shortcut) {
  const card = el('div', 'card glass-card shortcut-card');

  const head = el('div', 'shortcut-head');
  head.append(
    el('span', 'card-icon-small', '⌨️'),
    el('p', 'shortcut-lead', 'Start or stop recording in the background with:'),
  );
  head.firstChild.setAttribute('aria-hidden', 'true');

  const combo = el('div', 'shortcut-combo');
  combo.setAttribute('aria-label', `Shortcut: ${shortcut}`);
  for (const token of tokenize(shortcut)) {
    combo.append(el('kbd', 'shortcut-key', keyLabel(token)));
  }

  const change = el('button', 'shortcut-change', 'Change shortcut');
  change.type = 'button';
  change.addEventListener('click', openShortcutsPage);

  card.append(
    head,
    combo,
    el('p', 'shortcut-note', 'No shortcut needed: the toolbar icon opens this panel, and Start Recording is at the top.'),
    change,
  );
  return card;
}


/** Card for an unbound command. `available` is false if chrome.commands failed. */
function unboundCard(available) {
  const { suggested, description } = readManifestCommand();
  const card = el('div', 'card glass-card shortcut-card shortcut-card-alert');

  const head = el('div', 'shortcut-head');
  head.append(
    el('span', 'card-icon-small', '⌨️'),
    el('h3', 'shortcut-title', 'No shortcut assigned'),
  );
  head.firstChild.setAttribute('aria-hidden', 'true');

  const lead = !available
    ? 'Chrome did not report a shortcut for SilentScribe. Assign one to record from the keyboard.'
    : `Another extension already owns ${suggested || 'the default combination'}. `
      + 'Chrome gives a combination to the first extension that claims it.';

  const steps = el('ol', 'shortcut-steps');
  for (const text of [
    'Find SilentScribe in the list.',
    `Click the box next to "${description}".`,
    'Press the keys you want to use.',
  ]) {
    steps.append(el('li', null, text));
  }

  const open = el('button', 'btn btn-primary btn-full', 'Open shortcut settings');
  open.type = 'button';
  open.addEventListener('click', openShortcutsPage);

  card.append(
    head,
    el('p', 'shortcut-lead', lead),
    steps,
    open,
    el('p', 'shortcut-note', 'Return to this panel afterwards. This card updates itself.'),
  );
  return card;
}


/**
 * Open chrome://extensions/shortcuts in a new tab. A chrome:// URL cannot be
 * reached from an <a href> or window.open — only the tabs API, which runs in
 * the browser process, can navigate there.
 */
function openShortcutsPage() {
  const fail = (err) => console.warn(LOG_PREFIX, 'Could not open the shortcuts page:', err);
  try {
    chrome.tabs.create({ url: SHORTCUTS_URL })?.catch?.(fail);
  } catch (err) {
    fail(err);
  }
}


/** Re-check on visibility and focus. Debounced, so a quick tab flip renders once. */
function attachRefreshTriggers(container) {
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => render(container), RECHECK_DELAY);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('focus', refresh);
}


/** Read the command's manifest entry, so no combination or label is duplicated here. */
function readManifestCommand() {
  let entry = null;
  try {
    entry = chrome.runtime.getManifest().commands?.[COMMAND_NAME] || null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not read the manifest:', err);
  }

  const keys = entry?.suggested_key || {};
  const raw = (isMac() ? keys.mac : null) || keys.default || '';

  return {
    suggested: tokenize(raw).map(keyLabel).join(isMac() ? '' : '+'),
    description: entry?.description || 'Start or stop recording',
  };
}


/**
 * Split a combination into single keys. Windows and Linux use "+" separators.
 * macOS Chrome returns a run of glyphs with no separator at all.
 */
function tokenize(shortcut) {
  const text = String(shortcut || '');
  if (!text) return [];
  if (text.includes('+')) return text.split('+').map((t) => t.trim()).filter(Boolean);
  return Array.from(text).filter((ch) => ch.trim());
}


/** Label one key for the current platform. Glyphs pass through untouched. */
function keyLabel(token) {
  if (!isMac()) return token;
  return MAC_GLYPHS[token.toLowerCase()] || token;
}


/** True on macOS, where modifiers render as glyphs. */
function isMac() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(platform);
}


/** Create an element. Text is always set with textContent, never innerHTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
