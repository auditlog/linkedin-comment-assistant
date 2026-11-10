// History view (since 0.5.0): search, filter and manage the texts the user inserted
// or copied. The entries themselves are created in src/lib/voice.js
// (createHistoryEntry/addToHistory) and stored in chrome.storage.local ("history").
// See also: renderHistory() in src/sidepanel/sidepanel.js.

// Only real post URNs become links; fallback keys (pasted posts) and conversation keys
// ("msg:…") have no public address, and nothing else may end up in an href.
const POST_URN = /^urn:li:(activity|ugcPost|share):\d+$/;

/**
 * Lower case without diacritics, so "zolw" finds "Żółw" and "lodz" finds "Łódź".
 * "ł" is a separate letter in Unicode (no combining mark), hence the explicit mapping.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForSearch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * Entries of one kind that contain the query in the final text, author or post excerpt.
 * Entries from before 0.4.0 have no `kind` and count as comments.
 * @param {Array<object>|undefined} history - newest first
 * @param {{kind?: 'all'|'comment'|'message', query?: string}} [filter]
 * @returns {Array<object>}
 */
export function filterHistory(history, { kind = 'all', query = '' } = {}) {
  const needle = normalizeForSearch(query).trim();
  return (history ?? []).filter((entry) => {
    const entryKind = entry?.kind === 'message' ? 'message' : 'comment';
    if (kind !== 'all' && entryKind !== kind) return false;
    if (!needle) return true;
    return normalizeForSearch([entry.final, entry.author, entry.postExcerpt].filter(Boolean).join(' ')).includes(needle);
  });
}

/**
 * Address of the post an entry belongs to, or null when the key is not a post URN.
 * @param {{postKey?: string|null}} entry
 * @returns {string|null}
 */
export function postUrl(entry) {
  const key = String(entry?.postKey ?? '');
  return POST_URN.test(key) ? `https://www.linkedin.com/feed/update/${key}/` : null;
}

/**
 * Remove one entry (matched by time and post key) and keep the rest in order.
 * @param {Array<object>} history
 * @param {{at: number, postKey?: string|null}} entry
 * @returns {Array<object>}
 */
export function removeEntry(history, entry) {
  const index = (history ?? []).findIndex((item) => item.at === entry.at && (item.postKey ?? null) === (entry.postKey ?? null));
  if (index < 0) return [...(history ?? [])];
  return [...history.slice(0, index), ...history.slice(index + 1)];
}
