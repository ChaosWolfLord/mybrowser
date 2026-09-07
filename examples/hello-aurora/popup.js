// This runs when you click the toolbar button. It is a real page, so it can
// use the extension APIs directly.
(async () => {
  const { lastPage } = await chrome.storage.local.get('lastPage');
  const tabs = await chrome.tabs.query({});

  document.getElementById('title').textContent = lastPage ? (lastPage.title || lastPage.url) : 'nothing yet';
  document.getElementById('links').textContent = lastPage ? lastPage.links : '—';
  document.getElementById('tabs').textContent = tabs.length;
})();
