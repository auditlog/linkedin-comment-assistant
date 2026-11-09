// LinkedIn DOM helpers used by the content script.
//
// LinkedIn changes its markup often and serves different DOM for the feed, the
// photo lightbox, the single-post page and comment replies. So every lookup here
// is a chain of strategies: known class names / data attributes first, then
// structural fallbacks. The side panel shows the extracted text and lets the
// user edit it, so a partial miss is recoverable.
// NOTE: when LinkedIn breaks extraction, start by updating the selector lists below.
// See also: src/lib/post-text.js (text cleanup), test/e2e/fixtures/ (sample markup).

import { cleanPostText, fallbackPostKey } from '../lib/post-text.js';

// Elements that represent a whole post (feed card, detail view, lightbox dialog).
const POST_CONTAINER_SELECTORS = [
  '[data-urn*="urn:li:activity:"]',
  '[data-urn*="urn:li:ugcPost:"]',
  '[data-urn*="urn:li:share:"]',
  '[data-id*="urn:li:activity:"]',
  '[data-id*="urn:li:ugcPost:"]',
  '[data-id*="urn:li:share:"]',
  '.feed-shared-update-v2',
  '[role="dialog"]',
  '[role="article"]',
  'article',
];

// Comments under a post (excluded from the post text; used to detect replies).
const COMMENT_SELECTORS = [
  '[data-id*="urn:li:comment:"]',
  '[data-urn*="urn:li:comment:"]',
  'article.comments-comment-entity',
  '.comments-comment-item',
  '.comments-comment-entity',
  '[class*="comments-comment-item"]',
  '[class*="comments-comment-entity"]',
];

// Whole comment sections and other non-content parts of a post.
const EXCLUDED_SELECTORS = [
  ...COMMENT_SELECTORS,
  '.comments-comments-list',
  '[class*="comments-comment-list"]',
  '.comments-comment-box',
  '[class*="comments-comment-box"]',
  '[class*="social-details"]',
  '[class*="social-action"]',
  '.update-components-actor',
  '[class*="update-components-actor"]',
  '[contenteditable="true"]',
  'button',
  '[role="button"]',
  'script',
  'style',
  'svg',
  'video',
  '.visually-hidden',
  '.a11y-text',
];

// Elements that usually hold exactly the post's own text.
const POST_TEXT_SELECTORS = [
  '.update-components-text',
  '.feed-shared-inline-show-more-text',
  '.feed-shared-update-v2__description',
  '.update-components-update-v2__commentary',
  '.feed-shared-text',
  '[data-test-id="main-feed-activity-card__commentary"]',
  '[class*="commentary"]',
];

const AUTHOR_SELECTORS = [
  '.update-components-actor__title span[aria-hidden="true"]',
  '.update-components-actor__name span[aria-hidden="true"]',
  '.update-components-actor__title',
  '.update-components-actor__name',
  '.feed-shared-actor__name',
  '[class*="actor__title"] span[aria-hidden="true"]',
  '[class*="actor__name"]',
];

const AUTHOR_HEADLINE_SELECTORS = [
  '.update-components-actor__description span[aria-hidden="true"]',
  '.update-components-actor__description',
  '.feed-shared-actor__description',
  '[class*="actor__description"]',
];

const LINK_PREVIEW_SELECTORS = {
  card: ['.update-components-article', '[class*="update-components-article"]', '.feed-shared-article'],
  title: ['.update-components-article__title', '[class*="article__title"]'],
  subtitle: ['.update-components-article__subtitle', '.update-components-article__description', '[class*="article__subtitle"]', '[class*="article__description"]'],
};

const MAX_EXISTING_COMMENTS = 3;

const COMMENT_AUTHOR_SELECTORS = [
  '.comments-comment-meta__description-title',
  '.comments-post-meta__name-text',
  '[class*="comment-meta__description-title"]',
  '[class*="post-meta__name"]',
];

const COMMENT_TEXT_SELECTORS = [
  '.comments-comment-item__main-content',
  '.comments-comment-item-content-body',
  '[class*="comment-item__main-content"]',
  '[class*="comment-content"]',
  '.update-components-text',
];

// Composers that are not comment boxes: messaging and the "start a post" editor.
const NON_COMMENT_EDITOR_CONTEXTS = ['.msg-form', '[class*="msg-form"]', '.share-creation-state', '[class*="share-box"]'];

const SEE_MORE_RE = /^…?\s*(więcej|see more|more|pokaż więcej|zobacz więcej)$/i;

/**
 * Is this element a LinkedIn comment/reply editor?
 * @param {Element|null} el
 * @returns {boolean}
 */
export function isCommentEditor(el) {
  if (!el || el.nodeType !== 1 || !el.isContentEditable) return false;
  const editor = editorRoot(el);
  if (!editor) return false;
  return !NON_COMMENT_EDITOR_CONTEXTS.some((sel) => editor.closest(sel));
}

/**
 * The outermost contenteditable element containing `el` (LinkedIn's editor root).
 * @param {Element} el
 * @returns {HTMLElement|null}
 */
export function editorRoot(el) {
  let node = el.closest('[contenteditable="true"], [contenteditable=""]');
  if (!node) return null;
  while (node.parentElement && node.parentElement.closest('[contenteditable="true"], [contenteditable=""]')) {
    node = node.parentElement.closest('[contenteditable="true"], [contenteditable=""]');
  }
  return node;
}

function matchesAny(el, selectors) {
  return selectors.some((sel) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });
}

function closestAny(el, selectors) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (matchesAny(node, selectors)) return node;
  }
  return null;
}

function isInsideExcluded(el, root) {
  for (let node = el; node && node !== root; node = node.parentElement) {
    if (node.nodeType === 1 && matchesAny(node, EXCLUDED_SELECTORS)) return true;
  }
  return false;
}

/**
 * Collect visible-ish text of `root`, skipping excluded subtrees and keeping line structure.
 * Uses textContent semantics (works for text hidden by "…more" clamping).
 * @param {Element} root
 * @returns {string}
 */
export function collectText(root) {
  const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE']);
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node !== root && matchesAny(node, EXCLUDED_SELECTORS)) return;
    if (node.tagName === 'BR') {
      out += '\n';
      return;
    }
    for (const child of node.childNodes) walk(child);
    if (BLOCK.has(node.tagName)) out += '\n';
  };
  walk(root);
  return out;
}

/**
 * Find the element that represents the post the editor belongs to.
 * Comment items match generic selectors like `article`, so they are skipped.
 * @param {Element} editor
 * @returns {Element|null}
 */
export function findPostContainer(editor) {
  for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
    if (matchesAny(node, COMMENT_SELECTORS)) continue;
    if (matchesAny(node, POST_CONTAINER_SELECTORS)) {
      // A generic match (article/dialog) must actually contain post text, not just the editor.
      if (cleanPostText(collectText(node)).length >= 20) return node;
    }
  }
  // Structural fallback: climb until the ancestor has a meaningful amount of text,
  // but stop before reaching an element that holds several editors (the whole feed).
  let best = null;
  for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
    if (node.querySelectorAll('[contenteditable="true"]').length > 3) break;
    if (cleanPostText(collectText(node)).length >= 80) {
      best = node;
      break;
    }
  }
  return best;
}

/**
 * "…more" buttons of the post itself (not comment loaders, not inside comments).
 * @param {Element} container
 * @returns {Element[]}
 */
export function findSeeMoreButtons(container) {
  const buttons = [];
  for (const btn of container.querySelectorAll('button, [role="button"]')) {
    const label = (btn.textContent || '').trim();
    const aria = btn.getAttribute('aria-label') || '';
    const looksLikeSeeMore = SEE_MORE_RE.test(label) || /see more|zobacz więcej|pokaż więcej/i.test(aria);
    const isCommentsLoader = /komentarz|comment|odpowiedz|repl/i.test(`${label} ${aria}`);
    if (looksLikeSeeMore && !isCommentsLoader && !closestAny(btn, COMMENT_SELECTORS)) buttons.push(btn);
  }
  return buttons;
}

/**
 * Click "…more" in the post so LinkedIn renders the full text.
 * Only called on an explicit user request from the side panel (zero-footprint rule).
 * @param {Element} container
 * @returns {boolean} whether something was clicked
 */
export function expandSeeMore(container) {
  const buttons = findSeeMoreButtons(container);
  for (const btn of buttons) btn.click();
  return buttons.length > 0;
}

function firstText(root, selectors, { skipComments = true } = {}) {
  for (const sel of selectors) {
    let nodes;
    try {
      nodes = root.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (skipComments && closestAny(node, COMMENT_SELECTORS) && !matchesAny(root, COMMENT_SELECTORS)) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * Post author name.
 * @param {Element} container
 * @returns {string}
 */
export function extractAuthor(container) {
  const direct = firstText(container, AUTHOR_SELECTORS);
  if (direct) return direct.slice(0, 120);
  for (const link of container.querySelectorAll('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')) {
    if (closestAny(link, COMMENT_SELECTORS)) continue;
    const text = (link.textContent || '').split('\n').map((t) => t.trim()).find(Boolean);
    if (text && text.length >= 2 && text.length <= 120) return text;
  }
  return '';
}

/**
 * Post text: specific text containers first, then all non-excluded text of the container.
 * @param {Element} container
 * @returns {string}
 */
export function extractPostText(container) {
  const found = [];
  for (const sel of POST_TEXT_SELECTORS) {
    let nodes;
    try {
      nodes = container.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (closestAny(node, COMMENT_SELECTORS)) continue;
      // Skip nodes nested in an already collected one (e.g. text span inside show-more wrapper).
      if (found.some((f) => f.contains(node) || node.contains(f))) continue;
      found.push(node);
    }
  }
  // Keep document order (reposts: reposter's words first, then the original post).
  found.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const specific = cleanPostText(found.map((n) => collectText(n)).join('\n\n'));
  if (specific.length >= 20) return specific;
  return cleanPostText(collectText(container));
}

/**
 * Large images of the post (skips avatars, logos and images inside comments).
 * @param {Element} container
 * @returns {string[]} up to 2 URLs
 */
export function extractImageUrls(container) {
  const urls = [];
  for (const img of container.querySelectorAll('img')) {
    if (closestAny(img, COMMENT_SELECTORS)) continue;
    const src = img.currentSrc || img.src || '';
    if (!/^https:\/\/[^/]*licdn\.com\//.test(src)) continue;
    const hint = `${img.className} ${img.alt || ''}`;
    if (/avatar|actor|profile|logo|ghost|entity-image|presence/i.test(hint)) continue;
    const width = Math.max(img.naturalWidth || 0, img.width || 0, Number(img.getAttribute('width')) || 0);
    if (width < 200) continue;
    if (!urls.includes(src)) urls.push(src);
    if (urls.length >= 2) break;
  }
  return urls;
}

/**
 * The comment element the editor replies to (the editor sits inside it), if any.
 * @param {Element} editor
 * @param {Element} container
 * @returns {Element|null}
 */
function findReplyNode(editor, container) {
  for (let node = editor.parentElement; node && node !== container; node = node.parentElement) {
    if (matchesAny(node, COMMENT_SELECTORS)) return node;
  }
  return null;
}

/**
 * Author and text of one comment element.
 * @param {Element} node
 * @param {Element|null} editor - excluded from the text (reply box inside the comment)
 * @returns {{author: string, text: string}|null}
 */
function readComment(node, editor = null) {
  const author = firstText(node, COMMENT_AUTHOR_SELECTORS, { skipComments: false });
  let text = '';
  for (const sel of COMMENT_TEXT_SELECTORS) {
    const el = node.querySelector(sel);
    if (el && !(editor && el.contains(editor))) {
      text = cleanPostText(collectText(el));
      if (text) break;
    }
  }
  if (!text) {
    // Fallback: the comment's own text without the nested reply editor and replies.
    text = cleanPostText(collectText(node));
  }
  return text ? { author, text } : null;
}

/**
 * When the editor is a reply box inside a comment, return that comment.
 * @param {Element} editor
 * @param {Element} container
 * @returns {{author: string, text: string}|null}
 */
export function extractReplyTarget(editor, container) {
  const node = findReplyNode(editor, container);
  return node ? readComment(node, editor) : null;
}

/**
 * Up to 3 top-level comments under the post (skipping the one being replied to),
 * so the model can avoid repeating what others already said.
 * @param {Element} container
 * @param {Element} editor
 * @returns {Array<{author: string, text: string}>}
 */
export function extractExistingComments(container, editor) {
  const replyNode = findReplyNode(editor, container);
  const nodes = [...container.querySelectorAll(COMMENT_SELECTORS.join(','))].filter((node) => {
    if (node === replyNode) return false;
    // Top-level only: no comment ancestor inside the post.
    for (let up = node.parentElement; up && up !== container; up = up.parentElement) {
      if (matchesAny(up, COMMENT_SELECTORS)) return false;
    }
    return true;
  });
  const comments = [];
  for (const node of nodes) {
    const comment = readComment(node, editor);
    if (comment) comments.push({ author: comment.author, text: comment.text.slice(0, 300) });
    if (comments.length >= MAX_EXISTING_COMMENTS) break;
  }
  return comments;
}

/**
 * Headline under the author's name, e.g. "CTO at DataCorp" or "1 234 followers".
 * @param {Element} container
 * @returns {string}
 */
export function extractAuthorHeadline(container) {
  const headline = firstText(container, AUTHOR_HEADLINE_SELECTORS).slice(0, 200);
  // Company pages show a follower count here; it says nothing about the author.
  return /^\d[\d\s\u00a0.,]*\s*(obserwując\p{L}*|followers?)$/iu.test(headline) ? '' : headline;
}

/**
 * Canonical LinkedIn URL of the post author (person or company page), without query string.
 * @param {Element} container
 * @returns {{url: string, type: 'person'|'company'}|null}
 */
export function extractAuthorProfile(container) {
  // The author block first: a "X likes this" header above the post links to someone else.
  const actorLinks = container.querySelectorAll(
    '.update-components-actor a[href*="/in/"], .update-components-actor a[href*="/company/"], [class*="actor"] a[href*="/in/"], [class*="actor"] a[href*="/company/"]',
  );
  const anyLinks = container.querySelectorAll('a[href*="/in/"], a[href*="/company/"]');
  for (const link of [...actorLinks, ...anyLinks]) {
    if (closestAny(link, COMMENT_SELECTORS)) continue;
    let url;
    try {
      url = new URL(link.getAttribute('href'), location.href);
    } catch {
      continue;
    }
    const match = url.pathname.match(/^\/(in|company)\/([^/]+)/);
    if (!match) continue;
    return {
      url: `https://www.linkedin.com/${match[1]}/${match[2]}/`,
      type: match[1] === 'in' ? 'person' : 'company',
    };
  }
  return null;
}

/**
 * Title and subtitle of a shared link card, if the post has one.
 * @param {Element} container
 * @returns {{title: string, subtitle: string, url: string}|null}
 */
export function extractLinkPreview(container) {
  const card = LINK_PREVIEW_SELECTORS.card.map((sel) => container.querySelector(sel)).find(Boolean);
  if (!card || closestAny(card, COMMENT_SELECTORS)) return null;
  const title = firstText(card, LINK_PREVIEW_SELECTORS.title);
  if (!title) return null;
  const subtitle = firstText(card, LINK_PREVIEW_SELECTORS.subtitle);
  const href = card.querySelector('a[href]')?.getAttribute('href') || '';
  return { title: title.slice(0, 200), subtitle: subtitle.slice(0, 200), url: href.slice(0, 500) };
}

/**
 * Identifier of the post (URN when LinkedIn provides one).
 * @param {Element} container
 * @param {string} author
 * @param {string} text
 */
export function postKey(container, author, text) {
  for (let node = container; node && node !== document.body; node = node.parentElement) {
    const urn = node.getAttribute?.('data-urn') || node.getAttribute?.('data-id') || '';
    if (/urn:li:(activity|ugcPost|share):/.test(urn)) return urn;
  }
  const inner = container.querySelector('[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"]');
  if (inner) return inner.getAttribute('data-urn') || inner.getAttribute('data-id');
  return fallbackPostKey(author, text);
}

/**
 * Everything the side panel needs about the post under `editor`.
 * Reads only; with `expand: true` (explicit user request) it first clicks "…more".
 * @param {Element} editor
 * @param {{expand?: boolean}} [options]
 * @returns {Promise<{key: string, author: string, text: string, replyTo: object|null, imageUrls: string[], pageUrl: string, found: boolean, hasSeeMore: boolean}>}
 */
export async function extractPost(editor, { expand = false } = {}) {
  const container = findPostContainer(editor);
  if (!container) {
    return {
      key: fallbackPostKey('', location.href),
      author: '',
      text: '',
      replyTo: null,
      imageUrls: [],
      pageUrl: location.href,
      found: false,
      hasSeeMore: false,
      authorHeadline: '',
      authorProfile: null,
      linkPreview: null,
      existingComments: [],
    };
  }
  if (expand && expandSeeMore(container)) {
    // Give LinkedIn a moment to render the expanded text.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const author = extractAuthor(container);
  const text = extractPostText(container);
  return {
    key: postKey(container, author, text),
    author,
    text,
    replyTo: extractReplyTarget(editor, container),
    imageUrls: extractImageUrls(container),
    pageUrl: location.href,
    found: text.length > 0,
    hasSeeMore: findSeeMoreButtons(container).length > 0,
    authorHeadline: extractAuthorHeadline(container),
    authorProfile: extractAuthorProfile(container),
    linkPreview: extractLinkPreview(container),
    existingComments: extractExistingComments(container, editor),
  };
}

function normalizeForCompare(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Replace the editor's content with `text` in a way LinkedIn's editor registers
 * (so the "Post" button becomes active). Tries execCommand first, then a synthetic paste.
 *
 * `lineBreaks: 'soft'` (message boxes): lines are joined with insertLineBreak, the
 * Shift+Enter equivalent, and no key events are dispatched. In LinkedIn messaging a
 * plain Enter sends the message, and the extension must never send anything.
 * @param {HTMLElement} editor
 * @param {string} text
 * @param {{lineBreaks?: 'paragraph'|'soft'}} [options]
 * @returns {boolean} whether the editor now contains the text
 */
export function insertIntoEditor(editor, text, { lineBreaks = 'paragraph' } = {}) {
  editor.scrollIntoView({ block: 'center' });
  editor.focus();
  const selectAll = () => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const contains = () => normalizeForCompare(editor.innerText || editor.textContent).includes(normalizeForCompare(text).slice(0, 60));

  selectAll();
  // execCommand is deprecated but still the most reliable way to fire the
  // beforeinput/input events that rich-text editors (Quill, ProseMirror) listen to.
  if (lineBreaks === 'soft') {
    text.split('\n').forEach((line, i) => {
      if (i > 0) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
  } else {
    document.execCommand('insertText', false, text);
  }
  if (contains()) return true;

  selectAll();
  const data = new DataTransfer();
  data.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  return contains();
}
