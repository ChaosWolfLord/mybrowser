// This file runs inside every page you visit. It gets the page's DOM but
// not the page's own variables -- they are kept in separate worlds, so a
// site cannot see or break what your extension is doing.

// Count the links on the page and hand the number to the popup.
const linkCount = document.querySelectorAll('a[href]').length;

chrome.storage.local.set({
  lastPage: { url: location.href, title: document.title, links: linkCount }
});
