// The service worker. It has no page of its own; it wakes up when something
// needs it and sleeps again afterwards, so do not keep anything important
// only in a variable here -- use chrome.storage.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installedAt: new Date().toISOString() });
});
