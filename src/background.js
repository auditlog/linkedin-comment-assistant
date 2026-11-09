// Service worker: panel behavior and the "bound post" shared with the side panel.
// The content script reports the post whose comment box the user focused
// (follow mode); it is stored in chrome.storage.session (memory only, cleared
// when the browser closes) and an open side panel reacts to the change.
// See also: src/content/content.js (sender), src/sidepanel/sidepanel.js (consumer).

// Toolbar icon and the Alt+Shift+L shortcut (_execute_action) open the panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('[LCA] setPanelBehavior failed', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'lca:bind') {
    const boundPost = {
      ...message.post,
      tabId: sender.tab?.id ?? null,
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
