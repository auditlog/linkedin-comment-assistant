// Parsing of the model's tagged output, e.g. "<comment>...</comment>".
//
// We ask the model for simple XML-like tags instead of JSON (structured outputs)
// because (1) the text can be rendered while it streams in and (2) it works the
// same through OpenRouter's Anthropic-compatible endpoint, where pass-through of
// newer request parameters is not guaranteed.
// See also: src/lib/prompts.js (where the tags are requested).

/**
 * Remove a half-received closing/opening tag at the very end of streamed text,
 * e.g. "Nice to meet you</comm" -> "Nice to meet you".
 * @param {string} text
 * @returns {string}
 */
function stripTrailingPartialTag(text) {
  const lastLt = text.lastIndexOf('<');
  if (lastLt !== -1 && !text.slice(lastLt).includes('>')) {
    return text.slice(0, lastLt);
  }
  return text;
}

/**
 * Extract the content of each requested tag. Works on partial (streaming) text:
 * a tag that is opened but not yet closed returns what has arrived so far.
 * @param {string} text - raw model output (possibly incomplete)
 * @param {string[]} tags - tag names to extract
 * @returns {Record<string, string|null>} tag -> content (trimmed) or null when the tag has not appeared yet
 */
export function parseTagged(text, tags) {
  const result = {};
  for (const tag of tags) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const start = text.indexOf(open);
    if (start === -1) {
      result[tag] = null;
      continue;
    }
    const from = start + open.length;
    const end = text.indexOf(close, from);
    const value = end === -1 ? stripTrailingPartialTag(text.slice(from)) : text.slice(from, end);
    result[tag] = value.trim();
  }
  return result;
}

/**
 * Extract repeated items (e.g. <idea>...</idea>) from a block of text.
 * The last item may be incomplete while streaming; it is returned as-is.
 * @param {string|null} block
 * @param {string} itemTag
 * @returns {string[]}
 */
export function parseItems(block, itemTag) {
  if (!block) return [];
  const items = [];
  const open = `<${itemTag}>`;
  const close = `</${itemTag}>`;
  let pos = 0;
  while (true) {
    const start = block.indexOf(open, pos);
    if (start === -1) break;
    const from = start + open.length;
    const end = block.indexOf(close, from);
    const value = end === -1 ? stripTrailingPartialTag(block.slice(from)) : block.slice(from, end);
    if (value.trim()) items.push(value.trim());
    if (end === -1) break;
    pos = end + close.length;
  }
  return items;
}

/**
 * Turn a "- note\n- note" block into a list of notes.
 * @param {string|null} block
 * @returns {string[]}
 */
export function parseBullets(block) {
  if (!block) return [];
  return block
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0);
}
