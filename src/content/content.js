// Content script on linkedin.com, "zero footprint" (since 0.3.0):
// - adds NOTHING to LinkedIn's page (LinkedIn's User Agreement 8.2 forbids overlays
//   that modify the Services' appearance, and DOM markers make extensions detectable),
// - when the user focuses a comment/reply editor, reads that post and reports it to the
//   background; an open side panel picks it up ("follow mode"),
// - on explicit request from the side panel: inserts the comment, expands "…more",
//   or returns the selected text.
// See also: src/background.js (stores the bound post), src/sidepanel/sidepanel.js.

import { isCommentEditor, editorRoot, extractPost, insertIntoEditor, findPostContainer } from './linkedin-dom.js';

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

async function reportPost(editor, { expand = false } = {}) {
  const post = await extractPost(editor, { expand });
  return { ...post, editorToken: tokenFor(editor) };
}

document.addEventListener(
  'focusin',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !isCommentEditor(target)) return;
    const editor = editorRoot(target);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(async () => {
      if (!editor.isConnected || !editor.contains(document.activeElement)) return;
      try {
        await chrome.runtime.sendMessage({ type: 'lca:bind', post: await reportPost(editor) });
      } catch (error) {
        // Typical cause: the extension was reloaded and this tab still runs the old script.
        console.debug('[LCA] bind failed (reload the LinkedIn tab after updating the extension)', error);
      }
    }, FOCUS_SETTLE_MS);
  },
  true,
);

// --- requests from the side panel ------------------------------------------

function findEditorForPost(postKey) {
  // Fallback when the original editor was re-rendered: any comment editor inside the same post.
  for (const el of document.querySelectorAll('[contenteditable="true"]')) {
    if (!isCommentEditor(el)) continue;
    const container = findPostContainer(el);
    if (!container) continue;
    const urnHolder = container.closest('[data-urn], [data-id]') || container;
    const urn = urnHolder.getAttribute('data-urn') || urnHolder.getAttribute('data-id') || '';
    if (urn && urn === postKey) return editorRoot(el);
  }
  return null;
}

function resolveEditor(message) {
  const editor = editors.get(message.editorToken)?.deref();
  if (editor && editor.isConnected) return editor;
  return findEditorForPost(message.postKey);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'lca:insert') {
    const editor = resolveEditor(message);
    if (!editor) {
      sendResponse({ ok: false, reason: 'editor-missing' });
      return false;
    }
    const ok = insertIntoEditor(editor, message.text);
    sendResponse({ ok, reason: ok ? null : 'insert-failed' });
    return false;
  }
  if (message?.type === 'lca:expand') {
    // Explicit user action in the panel: click "…more" in this post and read it again.
    const editor = resolveEditor(message);
    if (!editor) {
      sendResponse({ ok: false, reason: 'editor-missing' });
      return false;
    }
    reportPost(editor, { expand: true })
      .then((post) => sendResponse({ ok: true, post }))
      .catch((error) => sendResponse({ ok: false, reason: String(error) }));
    return true; // async response
  }
  if (message?.type === 'lca:getSelection') {
    sendResponse({ text: String(window.getSelection() || '').trim(), pageUrl: location.href });
    return false;
  }
  return false;
});
