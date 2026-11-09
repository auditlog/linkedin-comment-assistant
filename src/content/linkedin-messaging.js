// LinkedIn messaging (since 0.4.0): read the conversation the user is replying in —
// both the full /messaging/ page and the chat bubbles in the bottom-right corner.
// Read-only, and only for the conversation whose message box the user focused.
// Like linkedin-dom.js, every lookup is a list of selectors plus structural fallbacks.
// NOTE: when LinkedIn changes its messaging markup, start with the selector lists below.
// See also: src/content/linkedin-dom.js (posts), test/e2e/fixtures/messaging.html.

import { collectText } from './linkedin-dom.js';
import { cleanPostText, fallbackPostKey } from '../lib/post-text.js';

export const MESSAGE_FORM_SELECTORS = ['.msg-form', '[class*="msg-form"]'];

// The element that holds one conversation (bubble or the thread pane of /messaging/).
const CONVERSATION_SELECTORS = [
  '.msg-overlay-conversation-bubble',
  '[class*="msg-overlay-conversation-bubble"]',
  '.msg-convo-wrapper',
  '[class*="msg-convo-wrapper"]',
  '.msg-thread',
  '[class*="msg-thread"]',
];

// One message (or one event) in the list.
const MESSAGE_ITEM_SELECTORS = ['li.msg-s-message-list__event', '.msg-s-event-listitem', '[class*="message-list__event"]'];
const MESSAGE_BODY_SELECTORS = ['.msg-s-event-listitem__body', '[class*="event-listitem__body"]'];
// Shown on the first message of a group of consecutive messages from one sender.
const SENDER_NAME_SELECTORS = ['.msg-s-message-group__name', '[class*="message-group__name"]', '.msg-s-message-group__profile-link'];

const COUNTERPART_NAME_SELECTORS = [
  '.msg-overlay-bubble-header__title',
  '[class*="bubble-header__title"]',
  '.msg-entity-lockup__entity-title',
  '[class*="entity-lockup__entity-title"]',
  '.msg-thread__link-to-profile',
];
const COUNTERPART_HEADLINE_SELECTORS = [
  '.msg-entity-lockup__entity-info',
  '[class*="entity-lockup__entity-info"]',
  '[class*="bubble-header__subtitle"]',
];

export const MAX_MESSAGES = 10;

function matches(el, selectors) {
  return selectors.some((sel) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });
}

function closest(el, selectors) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (matches(node, selectors)) return node;
  }
  return null;
}

function queryAll(root, selectors) {
  for (const sel of selectors) {
    let found;
    try {
      found = root.querySelectorAll(sel);
    } catch {
      continue;
    }
    if (found.length) return [...found];
  }
  return [];
}

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstText(root, selectors) {
  for (const el of queryAll(root, selectors)) {
    const value = text(el);
    if (value) return value;
  }
  return '';
}

/**
 * Is this editor the message box of a LinkedIn conversation?
 * @param {Element} editor - editor root (contenteditable)
 */
export function isMessageEditor(editor) {
  return Boolean(editor && closest(editor, MESSAGE_FORM_SELECTORS));
}

/**
 * The element that holds the conversation of this message box.
 * @param {Element} editor
 * @returns {Element|null}
 */
export function findConversation(editor) {
  const known = closest(editor, CONVERSATION_SELECTORS);
  if (known) return known;
  // Structural fallback: the nearest ancestor that also contains the message list.
  for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
    if (queryAll(node, MESSAGE_ITEM_SELECTORS).length) return node;
  }
  return null;
}

/**
 * Name, headline and profile of the other person.
 * @param {Element} conversation
 */
export function extractCounterpart(conversation) {
  const name = firstText(conversation, COUNTERPART_NAME_SELECTORS).slice(0, 120);
  const headline = firstText(conversation, COUNTERPART_HEADLINE_SELECTORS).slice(0, 200);
  let profile = null;
  // Header link first, then a link inside the other person's message ("--other").
  // Never "any profile link": message groups also link to the user's own profile.
  const links = [
    ...queryAll(conversation, ['[class*="header"] a[href*="/in/"]', '[class*="entity-lockup"] a[href*="/in/"]', 'a.msg-thread__link-to-profile']),
    ...queryAll(conversation, ['[class*="--other"] a[href*="/in/"]']),
  ];
  for (const link of links) {
    let url;
    try {
      url = new URL(link.getAttribute('href'), location.href);
    } catch {
      continue;
    }
    const match = url.pathname.match(/^\/in\/([^/]+)/);
    if (!match) continue;
    profile = { url: `https://www.linkedin.com/in/${match[1]}/`, type: 'person' };
    break;
  }
  return { name, headline, profile };
}

/**
 * Last messages with the sender's side ("them" / "me").
 * @param {Element} conversation
 * @param {string} counterpartName
 * @returns {Array<{from: 'them'|'me', author: string, text: string}>}
 */
export function extractMessages(conversation, counterpartName = '') {
  const messages = [];
  let sender = '';
  let senderIsThem = null;
  for (const item of queryAll(conversation, MESSAGE_ITEM_SELECTORS)) {
    const name = firstText(item, SENDER_NAME_SELECTORS);
    if (name) {
      sender = name;
      senderIsThem = null;
    }
    const body = queryAll(item, MESSAGE_BODY_SELECTORS)[0];
    const value = cleanPostText(body ? collectText(body) : collectText(item));
    if (!value) continue;
    // LinkedIn marks the other person's messages with an "--other" modifier class.
    const markedOther = closest(body || item, ['[class*="--other"]']) !== null || item.querySelector('[class*="--other"]') !== null;
    if (markedOther) senderIsThem = true;
    const isThem = markedOther || senderIsThem === true || (counterpartName && sender && sender === counterpartName);
    messages.push({ from: isThem ? 'them' : 'me', author: isThem ? sender || counterpartName : '', text: value.slice(0, 1500) });
  }
  return messages.slice(-MAX_MESSAGES);
}

/**
 * Stable key of the conversation: the thread id from the URL on /messaging/,
 * otherwise the other person's name.
 * @param {Element} conversation
 * @param {string} counterpartName
 */
export function conversationKey(conversation, counterpartName) {
  const fromAttr = conversation?.getAttribute?.('data-conversation-urn') || conversation?.getAttribute?.('data-urn');
  if (fromAttr) return `msg:${fromAttr}`;
  const thread = location.pathname.match(/\/messaging\/thread\/([^/]+)/);
  if (thread && !closest(conversation, ['.msg-overlay-conversation-bubble', '[class*="msg-overlay-conversation-bubble"]'])) {
    return `msg:thread:${thread[1]}`;
  }
  return `msg:${fallbackPostKey(counterpartName || 'conversation', '')}`;
}

/**
 * Transcript shown in the panel and sent to the model (editable there).
 * @param {Array<{from: string, author: string, text: string}>} messages
 * @param {string} counterpartName
 */
export function formatTranscript(messages, counterpartName = '') {
  return messages
    .map((m) => `${m.from === 'them' ? m.author || counterpartName || 'Rozmówca' : 'Ja'}: ${m.text}`)
    .join('\n');
}

/**
 * Everything the side panel needs about the conversation of this message box,
 * in the same shape as a post (kind: "message").
 * @param {Element} editor
 */
export function extractConversation(editor) {
  const conversation = findConversation(editor);
  if (!conversation) {
    return {
      kind: 'message',
      key: `msg:${fallbackPostKey('', location.href)}`,
      author: '',
      authorHeadline: '',
      authorProfile: null,
      text: '',
      lastIncoming: '',
      replyTo: null,
      imageUrls: [],
      linkPreview: null,
      existingComments: [],
      hasSeeMore: false,
      pageUrl: location.href,
      found: false,
    };
  }
  const counterpart = extractCounterpart(conversation);
  const messages = extractMessages(conversation, counterpart.name);
  if (!counterpart.name) {
    // Chat bubbles may have no recognizable header: take the name from the other person's messages.
    counterpart.name = [...messages].reverse().find((m) => m.from === 'them' && m.author)?.author || '';
  }
  const lastIncoming = [...messages].reverse().find((m) => m.from === 'them')?.text || '';
  return {
    kind: 'message',
    key: conversationKey(conversation, counterpart.name),
    author: counterpart.name,
    authorHeadline: counterpart.headline,
    authorProfile: counterpart.profile,
    text: formatTranscript(messages, counterpart.name),
    lastIncoming,
    replyTo: null,
    imageUrls: [],
    linkPreview: null,
    existingComments: [],
    hasSeeMore: false,
    pageUrl: location.href,
    found: messages.length > 0,
  };
}
