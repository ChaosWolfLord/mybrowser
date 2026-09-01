const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const webviewContainer = document.getElementById('webview-container');
const tabstrip = document.getElementById('tabstrip');
const addressInput = document.getElementById('address-input');
const backBtn = document.getElementById('back-btn');
const fwdBtn = document.getElementById('fwd-btn');
const reloadBtn = document.getElementById('reload-btn');

let tabs = [];      // { id, webview, tabEl, titleEl }
let activeId = null;
let nextId = 1;

function normalizeInput(raw) {
  const value = raw.trim();
  if (!value) return 'https://www.google.com';

  const looksLikeUrl =
    /^https?:\/\//i.test(value) ||
    /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(value) ||
    value.startsWith('file://');

  if (looksLikeUrl) {
    return /^https?:\/\/|^file:\/\//i.test(value) ? value : `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function createTab(url) {
  const id = nextId++;

  const webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:main');
  webview.setAttribute('useragent', CHROME_UA);
  webview.setAttribute('src', url || 'newtab.html');
  webviewContainer.appendChild(webview);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const titleEl = document.createElement('span');
  titleEl.className = 'title';
  titleEl.textContent = 'New tab';
  const closeEl = document.createElement('span');
  closeEl.className = 'closebtn';
  closeEl.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  tabEl.appendChild(titleEl);
  tabEl.appendChild(closeEl);
  tabstrip.appendChild(tabEl);

  const tab = { id, webview, tabEl, titleEl };
  tabs.push(tab);

  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.closebtn')) return;
    setActiveTab(id);
  });
  closeEl.addEventListener('click', () => closeTab(id));

  webview.addEventListener('page-title-updated', (e) => {
    titleEl.textContent = e.title || 'New tab';
  });
  webview.addEventListener('did-navigate', (e) => {
    if (activeId === id) addressInput.value = e.url;
    updateNavButtons();
    persistTabs();
  });
  webview.addEventListener('did-navigate-in-page', (e) => {
    if (activeId === id) addressInput.value = e.url;
    updateNavButtons();
    persistTabs();
  });
  webview.addEventListener('did-stop-loading', updateNavButtons);
  webview.addEventListener('new-window', (e) => {
    e.preventDefault();
    createTab(e.url);
  });

  setActiveTab(id);
  persistTabs();
  return tab;
}

// ---------- Session persistence: remember tabs across restarts ----------

function persistTabs() {
  const urls = tabs.map((t) => t.webview.getURL() || t.webview.getAttribute('src') || 'newtab.html');
  window.tabStore?.save(urls);
}

function setActiveTab(id) {
  activeId = id;
  tabs.forEach((t) => {
    const isActive = t.id === id;
    t.webview.classList.toggle('active', isActive);
    t.tabEl.classList.toggle('active', isActive);
  });
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    addressInput.value = tab.webview.getURL() || '';
    updateNavButtons();
  }
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  tab.webview.remove();
  tab.tabEl.remove();

  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (activeId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    setActiveTab(next.id);
  }
  persistTabs();
}

function activeTab() {
  return tabs.find((t) => t.id === activeId);
}

function updateNavButtons() {
  const tab = activeTab();
  if (!tab) return;
  try {
    backBtn.disabled = !tab.webview.canGoBack();
    fwdBtn.disabled = !tab.webview.canGoForward();
  } catch (err) {
    // webview not attached yet
  }
}

// ---------- Address bar + nav controls ----------

addressInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const tab = activeTab();
    if (tab) tab.webview.loadURL(normalizeInput(addressInput.value));
  }
});

backBtn.addEventListener('click', () => activeTab()?.webview.goBack());
fwdBtn.addEventListener('click', () => activeTab()?.webview.goForward());
reloadBtn.addEventListener('click', () => activeTab()?.webview.reload());

document.getElementById('new-tab-btn').addEventListener('click', () => createTab());

// ---------- Sidebar: Gmail / Calendar / Drive ----------

const sidebar = document.getElementById('sidebar');
const sbTabs = document.querySelectorAll('.sbtab');
const sbPanels = {
  gmail: document.getElementById('panel-gmail'),
  calendar: document.getElementById('panel-calendar'),
  drive: document.getElementById('panel-drive'),
  youtube: document.getElementById('panel-youtube'),
  assistant: document.getElementById('panel-assistant')
};

sbTabs.forEach((el) => {
  el.addEventListener('click', () => {
    const app = el.dataset.app;
    sbTabs.forEach((t) => t.classList.toggle('active', t === el));
    Object.entries(sbPanels).forEach(([name, wv]) => {
      wv.classList.toggle('active', name === app);
    });
  });
});

document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

// ---------- Keyboard shortcuts ----------

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 't') { e.preventDefault(); createTab(); }
  if (mod && e.key === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
  if (mod && e.key === 'l') { e.preventDefault(); addressInput.focus(); addressInput.select(); }
});

// ---------- Boot: restore your previous tabs, if any ----------

(async function boot() {
  let saved = null;
  try {
    saved = await window.tabStore.load();
  } catch (err) {
    saved = null;
  }

  if (Array.isArray(saved) && saved.length > 0) {
    saved.forEach((url) => createTab(url));
  } else {
    createTab('newtab.html');
  }
})();
