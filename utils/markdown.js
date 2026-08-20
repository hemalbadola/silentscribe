/**
 * SilentScribe — Minimal Markdown Renderer
 * ============================================================================
 *
 * The notes come back from a language model as Markdown. Rendering them with
 * textContent shows the raw asterisks; rendering them with innerHTML would let
 * model output inject markup into the panel.
 *
 * This renderer escapes every HTML character FIRST, then applies a small,
 * fixed set of Markdown rules to the already-escaped text. Nothing the model
 * writes can become an element, an attribute, or a URL.
 *
 * Supported: ATX headings (# to ###), bold, italic, inline code, unordered and
 * ordered lists, and paragraphs. Everything else stays literal text. Links are
 * deliberately NOT rendered as anchors — a model-authored href is a place to
 * hide a redirect, and these notes never need one.
 *
 * @module markdown
 */

/**
 * Convert Markdown to a safe HTML string.
 *
 * @param {string} markdown - Model-authored Markdown.
 * @returns {string} HTML safe to assign to innerHTML.
 */
export function renderMarkdown(markdown) {
  const lines = escapeHtml(String(markdown || '')).split(/\r?\n/);
  const html = [];
  let listTag = null;

  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  };

  const openList = (tag) => {
    if (listTag !== tag) {
      closeList();
      html.push(`<${tag}>`);
      listTag = tag;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 2; // # renders as h3, ### as h5
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      openList('ul');
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      openList('ol');
      html.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inline(trimmed)}</p>`);
  }

  closeList();
  return html.join('');
}


/**
 * Apply inline Markdown to one already-escaped line.
 *
 * Code spans are lifted out before the emphasis rules run and put back after.
 * Running all three rules over one string let a `**` pair straddle a code
 * boundary, so `` `**a` ** `` emitted `<code><strong>a</code> </strong>`.
 *
 * The placeholder is `<n>`. escapeHtml turned every `<` in the input into
 * `&lt;` already, so model text cannot forge one, and the only tags in play by
 * then are <strong> and <em>, which do not match `<digits>`.
 *
 * Emphasis delimiters must hug their content: an opening `*` cannot be
 * followed by a space, and a closing `*` cannot be preceded by one. Without
 * that rule, prose such as `2 * 3 * 4` renders as `2 <em> 3 </em> 4`.
 *
 * Every replacement takes a function rather than a `$` pattern, so `$&` or
 * `$1` written by the model is never re-expanded into the output.
 *
 * @param {string} text - HTML-escaped text.
 * @returns {string}
 */
function inline(text) {
  const codes = [];
  const masked = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `<${codes.length - 1}>`;
  });

  return masked
    .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, (_, body) => `<strong>${body}</strong>`)
    .replace(/(^|[^*])\*(?!\s)([^*]+?)(?<!\s)\*/g, (_, before, body) => `${before}<em>${body}</em>`)
    .replace(/<(\d+)>/g, (_, index) => `<code>${codes[index]}</code>`);
}


/**
 * Escape every character that can start markup.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
