// Service worker: panel behavior and the "bound post" shared with the side panel.
// The content script reports the post whose comment box the user focused
// (follow mode); it is stored in chrome.storage.session (memory only, cleared
// when the browser closes) and an open side panel reacts to the change.
// See also: src/content/content.js (sender), src/sidepanel/sidepanel.js (consumer).

import { DraftRepository } from './lib/drafts.js';

const drafts = new DraftRepository(chrome.storage.session, chrome.storage.local);
drafts.prune().catch(() => {});

// Toolbar icon and the Alt+Shift+L shortcut (_execute_action) open the panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('[LCA] setPanelBehavior failed', error);
  });
});

// Alt+Shift+T ("translate-selection"): open the panel and leave a request for it.
// sidePanel.open() must run synchronously inside the command handler (it needs the
// user gesture); the panel then reads `translateRequest` on start or on change.
// See also: translateSelection() and handleTranslateRequest() in src/sidepanel/sidepanel.js.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'translate-selection' || tab?.id == null) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => console.warn('[LCA] sidePanel.open failed', error));
  // windowId: with panels open in several windows, only the one next to this tab takes it.
  chrome.storage.session.set({ translateRequest: { tabId: tab.id, windowId: tab.windowId, at: Date.now() } });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Keep storage writes alive even if the panel is closed immediately after typing.
  if (message?.type?.startsWith('lca:draft:')) {
    if (!sender.url?.startsWith(chrome.runtime.getURL('sidepanel.html'))) return false;
    const action = message.type.slice('lca:draft:'.length);
    const work = action === 'load' ? drafts.load(message.key)
      : action === 'save' ? drafts.save(message.key, message.draft, async () =>
        message.persistent === true && (await chrome.storage.local.get('settings')).settings?.persistDrafts === true)
      : action === 'clearPersistent' ? drafts.clearPersistent() : null;
    if (!work) return false;
    work.then((draft) => sendResponse({ ok: true, draft: draft ?? null }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'lca:bind') {
    const boundPost = {
      ...message.post,
      tabId: sender.tab?.id ?? null,
      windowId: sender.tab?.windowId ?? null,
      // LinkedIn messaging runs in an iframe (2026-11): requests must go back to this frame.
      frameId: sender.frameId ?? 0,
      boundAt: Date.now(),
    };
    chrome.storage.session
      .set({ boundPost })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
