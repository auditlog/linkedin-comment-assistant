// Content script on linkedin.com, "zero footprint" (since 0.3.0):
// - adds NOTHING to LinkedIn's page (LinkedIn's User Agreement 8.2 forbids overlays
//   that modify the Services' appearance, and DOM markers make extensions detectable),
// - when the user focuses a comment/reply editor, reads that post and reports it to the
//   background; an open side panel picks it up ("follow mode"),
// - since 0.4.0 the same for LinkedIn messaging: focusing a message box reports the
//   conversation (kind: "message"); inserted replies are never sent,
// - on explicit request from the side panel: inserts the comment, expands "…more",
//   or returns the selected text.
// Runs in every LinkedIn frame (all_frames): messaging lives in an iframe since 2026-11.
// Chat bubbles on /feed live in an open shadow root (#interop-outlet): events are retargeted
// to the shadow host, so the real target comes from composedPath() and the focused element
// from walking shadowRoot.activeElement.
// See also: src/background.js (stores the bound post), src/sidepanel/sidepanel.js.

import { isCommentEditor, editorRoot, extractPost, insertIntoEditor, findPostContainer, extractReplyTarget } from './linkedin-dom.js';
import { isMessageEditor, extractConversation, findConversation, extractCounterpart, conversationKey } from './linkedin-messaging.js';
import { targetIdentity, sourceRevision } from '../lib/context.js';

// Wait a moment after focus, so tabbing or clicking through several boxes binds only the last one.
const FOCUS_SETTLE_MS = 350;

/** token -> editor element; WeakRef so detached editors can be garbage-collected */
const editors = new Map();
let tokenCounter = 0;
let focusTimer = null;

function tokenFor(editor) {
  for (const [token, ref] of editors) {
    if (ref.deref() === editor) return token;
  }
  const token = `ed-${Date.now().toString(36)}-${++tokenCounter}`;
  editors.set(token, new WeakRef(editor));
  return token;
}

/** Comment box or message box? (null for other editors, e.g. "start a post"). */
function editorKind(el) {
  if (!(el instanceof Element) || !el.isContentEditable) return null;
  const editor = editorRoot(el);
  if (!editor) return null;
  if (isMessageEditor(editor)) return 'message';
  if (isCommentEditor(editor)) return 'comment';
  return null;
}

/** The focused element, looking inside open shadow roots. */
function deepActiveElement() {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** All elements matching `selector`, including those inside open shadow roots. */
function deepQueryAll(selector, root = document) {
  const found = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) found.push(...deepQueryAll(selector, el.shadowRoot));
  }
  return found;
}

// Open shadow roots of the page, nested ones included (LinkedIn chat bubbles live in one).
function openShadowRoots(root = document) {
  const roots = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) roots.push(el.shadowRoot, ...openShadowRoots(el.shadowRoot));
  }
  return roots;
}

/**
 * Text the user selected in this frame. A selection inside a shadow root may not
 * show up in window.getSelection(), so open shadow roots are checked as well
 * (ShadowRoot.getSelection exists in Chromium).
 * @returns {string}
 */
function selectedText() {
  const text = String(window.getSelection() || '').trim();
  if (text) return text;
  for (const root of openShadowRoots()) {
    const inner = String(root.getSelection?.() || '').trim();
    if (inner) return inner;
  }
  return '';
}

async function reportPost(editor, { expand = false } = {}) {
  const post = isMessageEditor(editor)
    ? extractConversation(editor)
    : { kind: 'comment', ...(await extractPost(editor, { expand })) };
  return { ...post, editorToken: tokenFor(editor) };
}

document.addEventListener(
  'focusin',
  (event) => {
    // Inside a shadow root event.target is the shadow host; the real target is first in the path.
    const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
    if (!editorKind(target)) return;
    const editor = editorRoot(target);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(async () => {
      if (!editor.isConnected || !editor.contains(deepActiveElement())) return;
      try {
        const post = await reportPost(editor);
        if (!editor.isConnected || !editor.contains(deepActiveElement())) return;
        await chrome.runtime.sendMessage({ type: 'lca:bind', post });
      } catch (error) {
        // Typical cause: the extension was reloaded and this tab still runs the old script.
        console.debug('[LCA] bind failed (reload the LinkedIn tab after updating the extension)', error);
      }
    }, FOCUS_SETTLE_MS);
  },
  true,
);

// --- requests from the side panel ------------------------------------------

function findEditorForPost(postKey, expectedTarget) {
  // Fallback when the original editor was re-rendered: any comment editor inside the same post.
  const candidates = new Set();
  for (const el of deepQueryAll('[contenteditable="true"]')) {
    if (!isCommentEditor(el)) continue;
    const container = findPostContainer(el);
    if (!container) continue;
    const urnHolder = container.closest('[data-urn], [data-id]') || container;
    const urn = urnHolder.getAttribute('data-urn') || urnHolder.getAttribute('data-id') || '';
    if (urn && urn === postKey) {
      const replyTo = extractReplyTarget(editorRoot(el), container);
      if (!expectedTarget || targetIdentity({ key: postKey, replyTo }) === expectedTarget) candidates.add(editorRoot(el));
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function findEditorForConversation(key) {
  for (const el of deepQueryAll('[contenteditable="true"]')) {
    const editor = editorRoot(el);
    if (!editor || !isMessageEditor(editor)) continue;
    const conversation = findConversation(editor);
    if (conversation && conversationKey(conversation, extractCounterpart(conversation).name) === key) return editor;
  }
  return null;
}

function resolveEditor(message) {
  const editor = editors.get(message.editorToken)?.deref();
  if (editor && editor.isConnected) return editor;
  return message.postKey?.startsWith('msg:') ? findEditorForConversation(message.postKey) : findEditorForPost(message.postKey, message.expectedTarget);
}

async function verifyEditor(message, { checkSource = true } = {}) {
  const editor = resolveEditor(message);
  if (!editor) return { ok: false, reason: 'editor-missing' };
  const post = await reportPost(editor);
  if (!editor.isConnected || (message.expectedTarget && targetIdentity(post) !== message.expectedTarget)
    || (checkSource && message.expectedRevision && sourceRevision(post) !== message.expectedRevision)) {
    return { ok: false, reason: 'context-changed' };
  }
  return { ok: true, editor };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'lca:insert') {
    verifyEditor(message).then((result) => {
      if (!result.ok) return sendResponse(result);
      const { editor } = result;
      // Message boxes: never generate Enter-to-send or submit events.
      const ok = insertIntoEditor(editor, message.text, { lineBreaks: isMessageEditor(editor) ? 'soft' : 'paragraph' });
      sendResponse({ ok, reason: ok ? null : 'insert-failed' });
    }).catch(() => sendResponse({ ok: false, reason: 'context-changed' }));
    return true;
  }
  if (message?.type === 'lca:expand') {
    // Explicit user action in the panel: click "…more" in this post and read it again.
    verifyEditor(message, { checkSource: false })
      .then((result) => result.ok ? reportPost(result.editor, { expand: true }) : Promise.reject(new Error(result.reason)))
      .then((post) => sendResponse({ ok: true, post }))
      .catch((error) => sendResponse({ ok: false, reason: String(error) }));
    return true; // async response
  }
  if (message?.type === 'lca:getSelection') {
    // The script runs in every LinkedIn frame and the first reply wins: a frame with a
    // selection answers at once, the top frame answers "nothing selected" a bit later.
    const text = selectedText();
    if (text) {
      sendResponse({ text, pageUrl: location.href });
      return false;
    }
    if (window !== window.top) return false;
    setTimeout(() => sendResponse({ text: '', pageUrl: location.href }), 200);
    return true;
  }
  return false;
});
