// Conservative, read-only media extraction within the single selected post.
// Selectors are fixture-tested; real LinkedIn variants still need DOM probes.
const EXCLUDED = '[class*="comments-comment"], [contenteditable], .update-components-actor';
const MAX_PAGES = 6;
const text = (el, max = 2000) => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max);
const usable = (el) => el && !el.closest(EXCLUDED);
const first = (root, selectors) => selectors.map((sel) => [...root.querySelectorAll(sel)].find(usable)).find(Boolean);

export function extractPostMedia(container) {
  const poll = first(container, ['.update-components-poll', '.feed-shared-poll', '[data-testid="poll"]']);
  if (poll) {
    const question = text(first(poll, ['.update-components-poll__question', '[class*="poll__question"]', 'h3', 'h2']));
    const nodes = [...poll.querySelectorAll('.update-components-poll__option, [class*="poll__option-text"], [role="radio"]')].filter(usable);
    const options = nodes.filter((node) => !nodes.some((parent) => parent !== node && parent.contains(node)))
      .map((node) => text(node, 300)).filter(Boolean);
    return { kind: 'poll', question, options: [...new Set(options)].slice(0, 10), complete: Boolean(question && options.length >= 2) };
  }
  const document = first(container, ['.update-components-document', '.feed-shared-document', '[data-testid="document-viewer"]', 'iframe[title*="document" i]']);
  if (document) {
    const title = text(first(document, ['[class*="document__title"]', '[class*="document-title"]', 'h3', 'h2']), 200) || document.getAttribute('title') || '';
    const countText = document.getAttribute('data-page-count') || text(first(document, ['[class*="page-count"]', '[class*="page-counter"]']));
    const countMatch = countText.match(/(?:\/|(?<![\p{L}\p{N}_])(?:of|z)(?![\p{L}\p{N}_]))\s*(\d+)/iu) || countText.match(/^(\d+)$/);
    const totalPages = countMatch ? Math.min(10000, Number(countMatch[1])) || null : null;
    let root = document;
    if (document.tagName === 'IFRAME') {
      try { root = document.contentDocument?.body || document; } catch { /* cross-origin: title only */ }
    }
    const pages = [];
    for (const img of root.querySelectorAll('img')) {
      if (!usable(img)) continue;
      const url = img.currentSrc || img.src || '';
      if (!/^https:\/\/(?:[a-z0-9-]+\.)*licdn\.com\//i.test(url)) continue;
      if (Math.max(img.width || 0, img.naturalWidth || 0) < 200) continue;
      if (pages.some((page) => page.url === url)) continue;
      const number = Number(img.getAttribute('data-page-number') || img.closest('[data-page-number]')?.getAttribute('data-page-number'));
      pages.push({ url, number: Number.isInteger(number) && number > 0 ? number : null });
      if (pages.length === MAX_PAGES) break;
    }
    return { kind: 'document', title: title.slice(0, 200), totalPages, pages };
  }
  // Detect unsupported video so the UI never suggests it watched the footage.
  if (first(container, ['video', '[class*="update-components-video"]'])) return { kind: 'video' };
  return null;
}
