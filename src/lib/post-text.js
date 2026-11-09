// Pure text cleanup for post text scraped from LinkedIn's DOM.
// LinkedIn interleaves UI labels ("…więcej", "Pokaż tłumaczenie", reaction counts)
// with the post text; we drop those lines so the model sees only the content.
// See also: src/content/linkedin-dom.js (DOM side of the extraction).

const MAX_POST_CHARS = 8000;

// Whole-line UI labels in Polish and English.
const UI_LINE_PATTERNS = [
  /^…?\s*(więcej|mniej|more|less|see more|see less|zobacz więcej|pokaż więcej)$/i,
  /^(pokaż|zobacz|ukryj)\s+(tłumaczenie|oryginał)$/i,
  /^(show|see|hide)\s+(translation|original)$/i,
  /^(lubię to|like|komentarz|comment|udostępnij|share|repost|opublikuj ponownie|wyślij|send|obserwuj|follow|\+\s*obserwuj|\+\s*follow)$/i,
  /^\d[\d\s .,]*\s*(komentarz\w*|comments?|udostępnie\w*|reposts?|reakcj\w*|reactions?|wyświetle\w*|views?|impressions?)$/i,
  /^(promowane|promoted|sponsorowane|sponsored)$/i,
  /^•\s*(1st|2nd|3rd\+?|1\.|2\.|3\.\+?)$/i,
  /^(edytowano|edited)$/i,
];

/**
 * Normalize scraped text: unify whitespace, remove UI labels and empty runs, cap length.
 * @param {string} raw
 * @returns {string}
 */
export function cleanPostText(raw) {
  const lines = String(raw ?? '')
    .replace(/ /g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  const kept = [];
  for (const line of lines) {
    if (line && UI_LINE_PATTERNS.some((re) => re.test(line))) continue;
    // Collapse consecutive empty lines into one.
    if (!line && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();

  // Drop immediately repeated lines (LinkedIn renders some texts twice for screen readers).
  const deduped = kept.filter((line, i) => !(line && i > 0 && kept[i - 1] === line));

  let text = deduped.join('\n');
  if (text.length > MAX_POST_CHARS) {
    text = `${text.slice(0, MAX_POST_CHARS)}\n[…tekst skrócony]`;
  }
  return text;
}

/**
 * Stable key for a post when LinkedIn gives no URN: author + start of the text.
 * @param {string} author
 * @param {string} text
 * @returns {string}
 */
export function fallbackPostKey(author, text) {
  const basis = `${author}|${String(text).slice(0, 120)}`;
  let hash = 0;
  for (let i = 0; i < basis.length; i++) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return `text:${(hash >>> 0).toString(36)}`;
}
