/**
 * SilentScribe — Meeting Intelligence
 * ============================================================================
 *
 * Turns a transcript into meeting notes. Two engines, one entry point:
 *
 *   Chrome built-in (Gemini Nano) — on-device, free, private, small context.
 *   Bring-your-own-key           — any hosted provider, via utils/llm.js.
 *
 * The user picks the engine in Settings. Everything below is engine-agnostic
 * except createSession()/promptModel(), which hide the difference.
 *
 * LONG MEETINGS: a transcript that does not fit the engine's context is
 * summarized in a map-reduce pass — each slice produces partial notes, then the
 * partials are merged. When the partials themselves overrun the context, they
 * are merged in groups first, then those results are merged, until one call
 * fits. Nothing is silently truncated.
 *
 * SIDE FEATURES: generateAiTitle(), generateAiPlatform() and
 * cleanupTranscript() are cosmetic. They run beside the main flow and every one
 * of them degrades to its input on failure, so a dead key or an offline
 * provider can never block a recording.
 *
 * @module ai
 */

import { UI_CONFIG } from './constants.js';
import { chat, checkBuiltinAi, getLlmConfig, isConfigured, LlmError, PROVIDERS } from './llm.js';

const LOG_PREFIX = '[SilentScribe AI]';

/**
 * Characters of transcript sent in a single call, per engine.
 *
 * Roughly four characters per token. Gemini Nano's input quota is a few
 * thousand tokens, so it gets a small slice. Hosted models get 48k characters
 * (~12k tokens), which fits every current hosted model and most local ones.
 */
const CONTEXT_BUDGET_CHARS = Object.freeze({
  builtin: 4_000,
  hosted:  48_000,
});

/** How partial notes are joined before they are sent back to the model. */
const PARTIAL_SEPARATOR = '\n\n';

/**
 * Ceiling on group-merge rounds before the final merge is attempted anyway.
 *
 * Each round replaces N partials with far fewer, so two rounds already cover a
 * three-hour meeting on the on-device model. The cap only exists so a model
 * that answers with more text than it was given cannot loop forever.
 */
const MAX_REDUCE_ROUNDS = 4;

/** System prompt for a slice of a long transcript. */
const MAP_SYSTEM_PROMPT = `You are an expert meeting analyst. You are reading ONE PART of a longer meeting transcript.
Extract only what this part actually contains, in Markdown:
- **Discussed**: the topics covered, as short bullets.
- **Decisions**: decisions made, or "None" if there were none.
- **Actions**: tasks assigned, with the assignee when it is stated, or "None".
Do not speculate about parts you cannot see. Do not add pleasantries or preamble.`;

/**
 * System prompt for an intermediate round, when there are too many partials to
 * merge in one call. It keeps the map shape so the output can be merged again.
 */
const GROUP_MERGE_SYSTEM_PROMPT = `You are an expert meeting analyst. Below are notes from consecutive parts of one meeting, in order.
Condense them into ONE set of notes covering this span, in Markdown:
- **Discussed**: the topics covered, as short bullets.
- **Decisions**: decisions made, or "None".
- **Actions**: tasks assigned, with the assignee when it is stated, or "None".
Remove duplicates. Keep every distinct decision and action. Do not invent content. Do not add preamble.`;

/** System prompt for merging partial notes into the final document. */
const REDUCE_SYSTEM_PROMPT = `You are an expert executive assistant. Below are notes from consecutive parts of one meeting, in order.
Merge them into a single set of meeting notes in Markdown, with exactly these sections:

## Executive Summary
Two or three sentences covering the whole meeting.

## Action Items
A bulleted list of tasks, each with its assignee when one is stated. Write "None recorded." if there are no tasks.

## Key Moments
A short bulleted list of the most important decisions and insights.

Remove duplicates that appear in more than one part. Do not invent content. Do not add preamble.`;

/** System prompt for a transcript that fits in one call. */
const SINGLE_PASS_SYSTEM_PROMPT = `You are an expert executive assistant. Analyze the meeting transcript below.
Respond in Markdown with exactly these sections:

## Executive Summary
Two or three sentences covering what was discussed.

## Action Items
A bulleted list of tasks assigned, each with its assignee when one is stated. Write "None recorded." if there are no tasks.

## Key Moments
A short bulleted list of the most important decisions, insights, or repeated points.

Base every line on the transcript. Do not invent content. Do not add preamble or pleasantries.`;

/** System prompt for the one-line meeting title. */
const TITLE_SYSTEM_PROMPT = `You are a helpful assistant. Read the meeting transcript and write a short, descriptive title for it.
Use five words at most. Do not use quotation marks or trailing punctuation. Output the title on one line and nothing else.`;

/** System prompt for the "what kind of recording is this" tag. */
const PLATFORM_SYSTEM_PROMPT = `You are a helpful assistant. Read the transcript and decide what kind of media or meeting it is.
Output ONLY a category tag of one to three words, for example: Zoom Meeting, YouTube Video, Podcast, Interview, Lecture.
Do not use quotation marks. Do not explain the choice.`;

/**
 * System prompt for transcript cleanup.
 *
 * The [ID:N] prefix is the whole contract: it is what lets a cleaned line be
 * matched back to the segment it came from, so a model that reorders, merges or
 * invents lines is detected instead of trusted.
 */
const CLEANUP_SYSTEM_PROMPT = `You are a strict transcript editor. Clean up the raw speech-to-text lines below.
Rules:
1. Remove stutters and repeated words, and fix obvious grammar errors.
2. Do not change the meaning and do not add information. Replace a word only when it is clearly a mis-transcription.
3. Keep the EXACT line format: "[ID:N] [STARTs - ENDs] Speaker: Text". Keep every ID, one line per ID. Never merge, reorder, or drop a line.
4. Output the cleaned lines only, with no preamble and no commentary.`;


// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Report whether note generation can run right now, and on what.
 *
 * The side panel calls this to label its button instead of letting the user
 * click into a failure.
 *
 * @returns {Promise<{ready: boolean, engine: string, label: string, detail: string}>}
 */
export async function checkAiAvailability() {
  const config = await getLlmConfig();
  const label = PROVIDERS[config.provider]?.label || config.provider;

  if (config.provider === 'builtin') {
    const { available, state } = await checkBuiltinAi();
    return {
      ready: available,
      engine: 'builtin',
      label,
      detail: available
        ? 'On-device model is ready.'
        : `On-device model unavailable (${state}). Use Chrome 138 or later, or set a provider key in Settings.`,
    };
  }

  const ready = await isConfigured(config);
  return {
    ready,
    engine: 'byok',
    label: `${label} · ${config.model}`,
    detail: ready ? 'Provider configured.' : 'Open Settings and finish setting up the provider.',
  };
}


/**
 * Generate meeting notes from transcript segments.
 *
 * @param {Object[]} segments - Transcript segments ({ start, end, speaker, text }).
 * @param {Object} session - Session record, used for speaker names and metadata.
 * @param {Object} [options]
 * @param {(status: string, progress: number) => void} [options.onProgress] - Progress callback.
 * @param {AbortSignal} [options.signal] - Cancellation.
 * @returns {Promise<string>} Markdown notes.
 * @throws {Error} If no engine is available or the engine fails.
 */
export async function generateAiNotes(segments, session, options = {}) {
  const { onProgress = () => {}, signal } = options;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('There is no transcript to summarize.');
  }

  const config = await getLlmConfig();
  const budget = contextBudget(config);

  const transcript = formatTranscript(segments, session);

  // Segments that are all blank format to an empty string. Sending that spends
  // a request to ask the model to summarize nothing.
  if (!transcript.trim()) {
    throw new Error('There is no transcript to summarize.');
  }

  const slices = sliceTranscript(transcript, budget);

  console.log(LOG_PREFIX, `Transcript is ${transcript.length} chars, split into ${slices.length} slice(s).`);

  // Short meeting: one call, done.
  if (slices.length === 1) {
    onProgress('Reading the transcript...', 0.3);
    const notes = await promptModel(config, SINGLE_PASS_SYSTEM_PROMPT, transcript, signal);
    onProgress('Done', 1);
    return notes.trim();
  }

  // Long meeting: summarize each slice, then merge.
  const partials = [];
  for (let i = 0; i < slices.length; i++) {
    signal?.throwIfAborted();
    onProgress(`Summarizing part ${i + 1} of ${slices.length}...`, (i / slices.length) * 0.85);

    const partial = await promptModel(
      config,
      MAP_SYSTEM_PROMPT,
      `Part ${i + 1} of ${slices.length}:\n\n${slices[i]}`,
      signal,
    );
    partials.push(`### Part ${i + 1}\n${partial.trim()}`);
  }

  try {
    const merged = await reducePartials(config, partials, budget, signal, onProgress);
    onProgress('Done', 1);
    return merged;
  } catch (err) {
    // Cancellation is the user's choice, not a failure to recover from.
    if (err.name === 'AbortError') throw err;

    // Every partial above cost a request. Throwing here would bill the user for
    // the whole meeting and hand back nothing, so return the parts instead.
    console.warn(LOG_PREFIX, 'Merge failed; returning the per-part notes.', err);
    onProgress('Done', 1);
    return unmergedNotes(partials, err);
  }
}


/**
 * Suggest a short meeting title from the transcript.
 *
 * Cosmetic: the side panel uses it to replace "Untitled meeting". It never
 * throws, because a missing title must not interrupt a recording.
 *
 * @param {Object[]} segments - Transcript segments.
 * @returns {Promise<string|null>} A title of about five words, or null on any failure.
 */
export async function generateAiTitle(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  try {
    const config = await getLlmConfig();
    // The opening of a meeting states its purpose, so one slice is enough and
    // a three-hour recording costs exactly as much as a five-minute one.
    const opening = sliceTranscript(formatTranscript(segments), contextBudget(config))[0];
    if (!opening?.trim()) return null;

    const reply = await promptModel(config, TITLE_SYSTEM_PROMPT, opening);
    return firstLine(reply) || null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not generate a title:', err);
    return null;
  }
}


/**
 * Guess what kind of recording this is, as a short tag.
 *
 * Cosmetic, like generateAiTitle(): the side panel shows it as a badge.
 *
 * @param {Object[]} segments - Transcript segments.
 * @returns {Promise<string|null>} A tag of one to three words, or null on any failure.
 */
export async function generateAiPlatform(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  try {
    const config = await getLlmConfig();
    const opening = sliceTranscript(formatTranscript(segments), contextBudget(config))[0];
    if (!opening?.trim()) return null;

    const reply = await promptModel(config, PLATFORM_SYSTEM_PROMPT, opening);
    return firstLine(reply) || null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not guess the recording type:', err);
    return null;
  }
}


/**
 * Rewrite transcript segments to remove stutters, repetitions and obvious
 * mis-transcriptions, keeping every timestamp and speaker label.
 *
 * Long meetings are cleaned in chunks that each fit the engine's context.
 * A chunk the model fails or mangles keeps its raw lines, so the result is
 * never worse than the input. Returns the original array on any failure.
 *
 * @param {Object[]} segments - Transcript segments ({ start, end, speaker, text }).
 * @returns {Promise<Object[]>} Cleaned segments, or the original array unchanged.
 */
export async function cleanupTranscript(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;

  try {
    const config = await getLlmConfig();
    const numbered = numberSegments(segments);
    if (!numbered) return segments;

    // Copy first, then overwrite only the lines that came back parseable. A
    // chunk the model drops keeps its original text rather than vanishing.
    const cleaned = segments.slice();
    let applied = 0;

    for (const chunk of sliceTranscript(numbered, contextBudget(config))) {
      try {
        const reply = await promptModel(config, CLEANUP_SYSTEM_PROMPT, chunk);
        applied += applyCleanedLines(reply, segments, cleaned);
      } catch (err) {
        console.warn(LOG_PREFIX, 'Cleanup chunk failed; keeping its raw lines.', err);
      }
    }

    // Nothing parsed means the model ignored the format. Trust the raw text.
    return applied > 0 ? cleaned : segments;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Transcript cleanup failed; keeping the raw transcript.', err);
    return segments;
  }
}


/**
 * Render transcript segments as the plain "[mm:ss] Speaker: text" form the
 * model reads. Timestamps let the model cite when something was said.
 *
 * @param {Object[]} segments - Transcript segments.
 * @param {Object} [session] - Session record, for custom speaker names.
 * @returns {string}
 */
export function formatTranscript(segments, session = {}) {
  const names = session.speakerNames || {};

  return segments
    // A dropped frame or a truncated store can leave a null in the array. One
    // bad entry must not cost the user the whole transcript.
    .filter((segment) => segment && typeof segment === 'object')
    .map((segment) => {
      const speaker = names[segment.speaker] || segment.speaker || UI_CONFIG.DEFAULT_SPEAKERS.OTHERS;
      const text = String(segment.text || '').trim();
      return text ? `[${formatClock(segment.start)}] ${speaker}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}


// ============================================================================
// ENGINE DISPATCH
// ============================================================================

/**
 * Send one system+user turn to whichever engine is configured.
 *
 * @param {Object} config - Resolved LLM config.
 * @param {string} system - System instruction.
 * @param {string} user - User message.
 * @param {AbortSignal} [signal] - Cancellation.
 * @returns {Promise<string>}
 */
async function promptModel(config, system, user, signal) {
  if (config.provider === 'builtin') {
    return promptBuiltin(system, user, signal);
  }

  try {
    return await chat({ system, user, config, signal });
  } catch (err) {
    // Surface provider errors as-is; they already carry an actionable message.
    if (err instanceof LlmError) throw new Error(err.message);
    throw err;
  }
}


/**
 * Prompt Chrome's on-device model.
 *
 * Chrome moved this API twice. Chrome 138+ exposes a global `LanguageModel`
 * whose create() takes `initialPrompts`; older builds exposed
 * `window.ai.languageModel` whose create() took `systemPrompt`. Both shapes are
 * handled so the feature works rather than throwing on whichever build the user
 * is running.
 *
 * @param {string} system - System instruction.
 * @param {string} user - User message.
 * @param {AbortSignal} [signal] - Cancellation.
 * @returns {Promise<string>}
 */
async function promptBuiltin(system, user, signal) {
  const { available, state, api } = await checkBuiltinAi();

  if (!available) {
    throw new Error(
      state === 'unsupported'
        ? 'Chrome\'s built-in AI is not available in this browser. Open Settings and configure a provider key instead.'
        : `Chrome's built-in AI is not ready (${state}). Wait for the model to download, or configure a provider key in Settings.`,
    );
  }

  // The modern API exposes availability(); the legacy one exposes capabilities().
  const isModern = typeof api.availability === 'function';

  let modelSession;
  try {
    modelSession = isModern
      ? await api.create({ initialPrompts: [{ role: 'system', content: system }], signal })
      : await api.create({ systemPrompt: system });
  } catch (err) {
    throw new Error(`Could not start the on-device model: ${err.message}`);
  }

  try {
    return await modelSession.prompt(user, signal ? { signal } : undefined);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Nano throws QuotaExceededError when the prompt overruns its input quota.
    if (/quota/i.test(err.name) || /quota|too large|token/i.test(err.message || '')) {
      throw new Error(
        'The transcript is too long for Chrome\'s on-device model. Configure a provider key in Settings to summarize long meetings.',
      );
    }
    throw new Error(`On-device generation failed: ${err.message}`);
  } finally {
    modelSession.destroy?.();
  }
}


// ============================================================================
// MAP-REDUCE
// ============================================================================

/**
 * Merge partial notes into one document, in as many rounds as it takes.
 *
 * The final merge is the largest and most expensive call of the run, so it is
 * the one that must not be sent over budget. A one-hour meeting on the built-in
 * model produces ~70 partials, and 44 partials from a hosted model already
 * exceed 48k characters, so the partials are merged in groups until one call
 * fits.
 *
 * @param {Object} config - Resolved LLM config.
 * @param {string[]} partials - Per-part notes, in order.
 * @param {number} budgetChars - Maximum characters per call.
 * @param {AbortSignal} [signal] - Cancellation.
 * @param {(status: string, progress: number) => void} onProgress - Progress callback.
 * @returns {Promise<string>} The merged Markdown.
 */
async function reducePartials(config, partials, budgetChars, signal, onProgress) {
  let level = partials;

  for (let round = 1; round <= MAX_REDUCE_ROUNDS; round++) {
    if (level.length < 2 || level.join(PARTIAL_SEPARATOR).length <= budgetChars) break;

    const groups = groupWithinBudget(level, budgetChars);
    // One group per item means grouping cannot shrink anything, so looping
    // again would only repeat the same calls.
    if (groups.length >= level.length) break;

    console.log(LOG_PREFIX, `Merge round ${round}: ${level.length} partials -> ${groups.length} group(s).`);

    const nextLevel = [];
    for (let i = 0; i < groups.length; i++) {
      onProgress(`Merging the parts... (${i + 1} of ${groups.length})`, 0.88);
      signal?.throwIfAborted();
      const text = await promptModel(config, GROUP_MERGE_SYSTEM_PROMPT, groups[i], signal);
      nextLevel.push(`### Section ${i + 1}\n${text.trim()}`);
    }
    level = nextLevel;
  }

  onProgress('Merging the parts...', 0.95);
  // The signal is read after the status goes up, not before it. A user who
  // cancels while "Merging the parts..." is on screen used to pay for this
  // call anyway — the largest and most expensive one of the whole run.
  signal?.throwIfAborted();
  const merged = await promptModel(config, REDUCE_SYSTEM_PROMPT, level.join(PARTIAL_SEPARATOR), signal);
  return merged.trim();
}


/**
 * Pack items into as few groups as possible, each within the budget.
 *
 * @param {string[]} items - Notes to group, in order.
 * @param {number} budgetChars - Maximum characters per group.
 * @returns {string[]} Joined groups, in order.
 */
function groupWithinBudget(items, budgetChars) {
  const groups = [];
  let current = [];
  let length = 0;

  for (const item of items) {
    const added = current.length ? PARTIAL_SEPARATOR.length + item.length : item.length;

    if (current.length && length + added > budgetChars) {
      groups.push(current.join(PARTIAL_SEPARATOR));
      current = [item];
      length = item.length;
    } else {
      current.push(item);
      length += added;
    }
  }

  if (current.length) groups.push(current.join(PARTIAL_SEPARATOR));
  return groups;
}


/**
 * Present already-paid-for partials as a usable document when the merge fails.
 *
 * @param {string[]} partials - Per-part notes, in order.
 * @param {Error} err - Why the merge failed.
 * @returns {string} Markdown.
 */
function unmergedNotes(partials, err) {
  return [
    '## Notes by Part',
    '',
    `_These are per-part notes. The final step that merges them into one summary failed: ${err.message}_`,
    '',
    '_Every part of the meeting is covered below, in order. Nothing was lost. Run the summary again to retry the merge._',
    '',
    partials.join(PARTIAL_SEPARATOR),
  ].join('\n');
}


// ============================================================================
// TRANSCRIPT CLEANUP
// ============================================================================

/**
 * Render segments as the "[ID:N] [STARTs - ENDs] Speaker: Text" lines the
 * cleanup prompt round-trips. One segment per line, so sliceTranscript() can
 * chunk it without ever cutting a line in half.
 *
 * @param {Object[]} segments - Transcript segments.
 * @returns {string}
 */
function numberSegments(segments) {
  return segments
    .map((segment, index) => {
      if (!segment || typeof segment !== 'object') return '';
      const text = String(segment.text || '').trim();
      if (!text) return '';

      const start = safeSeconds(segment.start).toFixed(1);
      const end = safeSeconds(segment.end).toFixed(1);
      const speaker = segment.speaker || UI_CONFIG.DEFAULT_SPEAKERS.OTHERS;
      return `[ID:${index}] [${start}s - ${end}s] ${speaker}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}


/**
 * Parse cleaned lines back onto their source segments.
 *
 * Only the words come from the model. Timestamps and the speaker label are
 * taken from the stored segment, because a model that rounds a timestamp or
 * renames a speaker would desynchronize the transcript from the audio.
 *
 * @param {string} reply - The model's answer.
 * @param {Object[]} original - The segments that were sent.
 * @param {Object[]} target - Array to write cleaned segments into, by index.
 * @returns {number} How many segments were replaced.
 */
function applyCleanedLines(reply, original, target) {
  const LINE = /^\[ID:(\d+)\]\s*\[[\d.]+s\s*-\s*[\d.]+s\]\s*[^:]*:\s*(.+)$/;
  let applied = 0;

  for (const line of String(reply).split('\n')) {
    const match = line.trim().match(LINE);
    if (!match) continue;

    const index = Number(match[1]);
    const text = match[2].trim();
    if (!text || !original[index]) continue;

    target[index] = { ...original[index], text };
    applied++;
  }

  return applied;
}


// ============================================================================
// HELPERS
// ============================================================================

/**
 * Characters of transcript one call may carry, for a resolved config.
 *
 * @param {Object} config - Resolved LLM config.
 * @returns {number}
 */
function contextBudget(config) {
  return config.provider === 'builtin' ? CONTEXT_BUDGET_CHARS.builtin : CONTEXT_BUDGET_CHARS.hosted;
}


/**
 * First usable line of a model answer, without wrapping quotes.
 *
 * Models asked for one short phrase still sometimes add a second line. Taking
 * only the first keeps a stray sentence out of a title or a badge.
 *
 * @param {string} text - The model's answer.
 * @returns {string}
 */
function firstLine(text) {
  return String(text || '')
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim();
}


/**
 * Split a transcript into slices that each fit the engine's context budget.
 *
 * Splits on line boundaries so a speaker turn is never cut in half. A single
 * line longer than the budget is hard-split rather than dropped.
 *
 * @param {string} transcript - The formatted transcript.
 * @param {number} budgetChars - Maximum characters per slice.
 * @returns {string[]} One or more slices, in order.
 */
function sliceTranscript(transcript, budgetChars) {
  if (transcript.length <= budgetChars) return [transcript];

  const slices = [];
  let current = '';

  // A line exactly budgetChars long used to flush an empty `current`, which
  // became a blank slice and one wasted provider call.
  const flush = () => {
    if (current) slices.push(current);
    current = '';
  };

  for (const line of transcript.split('\n')) {
    if (line.length > budgetChars) {
      flush();
      for (let i = 0; i < line.length;) {
        // Math.max keeps the loop moving even if a pair sits on the only cut
        // point available, which a one-character budget could produce.
        const end = Math.max(i + 1, safeCut(line, Math.min(i + budgetChars, line.length)));
        slices.push(line.slice(i, end));
        i = end;
      }
      continue;
    }

    if (current.length + line.length + 1 > budgetChars) {
      flush();
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  flush();
  return slices;
}


/**
 * Move a cut index back off the middle of a surrogate pair.
 *
 * An emoji is two UTF-16 units. Cutting between them leaves a lone half at the
 * end of one slice and another at the start of the next, which every provider
 * renders as U+FFFD — the text is corrupted in both slices. Stepping back one
 * unit keeps the pair whole and stays lossless, because the unit moves to the
 * next slice instead of being dropped.
 *
 * @param {string} text - The line being split.
 * @param {number} index - Proposed cut index.
 * @returns {number} A cut index that does not split a surrogate pair.
 */
function safeCut(text, index) {
  if (index <= 0 || index >= text.length) return index;

  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  const isHigh = before >= 0xd800 && before <= 0xdbff;
  const isLow = after >= 0xdc00 && after <= 0xdfff;

  return isHigh && isLow ? index - 1 : index;
}


/**
 * Format seconds as mm:ss (or h:mm:ss past an hour).
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatClock(seconds) {
  const total = Math.floor(safeSeconds(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}


/**
 * A timestamp that is safe to print.
 *
 * A stalled or unset media element reports Infinity as its duration, and that
 * reached the model as "[Infinity:NaN:NaN]". Anything not finite and positive
 * is the start of the recording as far as the notes are concerned.
 *
 * @param {number} value - Seconds from the start of the recording.
 * @returns {number} A finite, non-negative number of seconds.
 */
function safeSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
