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

// Google's sign-in flow often opens a small popup window. Electron's
// <webview> silently blocks all popups unless this is set.
function allowPopups(webview) {
  webview.setAttribute('allowpopups', 'true');
}

// Masks a couple of signals sites use to detect automated/embedded
// browsers. This is an attempt to work around Google's "this browser
// may not be secure" block — it may not always succeed, since Google
// actively updates its detection over time.
function hardenAgainstDetection(webview) {
  webview.addEventListener('dom-ready', () => {
    webview
      .executeJavaScript(
        "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
      )
      .catch(() => {});
  });
}

function isNewTabUrl(url) {
  return !!url && url.endsWith('newtab.html');
}

function createTab(url) {
  const id = nextId++;

  const webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:main');
  webview.setAttribute('useragent', CHROME_UA);
  allowPopups(webview);
  hardenAgainstDetection(webview);
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
    if (activeId === id) addressInput.value = isNewTabUrl(e.url) ? '' : e.url;
    updateNavButtons();
    persistTabs();
  });
  webview.addEventListener('did-navigate-in-page', (e) => {
    if (activeId === id) addressInput.value = isNewTabUrl(e.url) ? '' : e.url;
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
  // A new tab's resolved URL is a file:// path into whichever folder this
  // copy happens to live in, which is wrong the moment the app is packaged
  // (newtab.html then lives inside app.asar). Store the bare relative name
  // instead so it resolves correctly either way.
  const urls = tabs.map((t) => {
    const url = t.webview.getURL() || t.webview.getAttribute('src') || 'newtab.html';
    return isNewTabUrl(url) ? 'newtab.html' : url;
  });
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
    const url = tab.webview.getURL() || '';
    addressInput.value = isNewTabUrl(url) ? '' : url;
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

// ---------- Sidebar sizing: width and per-app zoom, both remembered ----------

// Each app wants a different amount of room. Gmail, Calendar and Drive pick
// their layout from browser identity rather than the width they actually
// have, so they lay out a full desktop UI and need zooming out to fit it;
// YouTube and Claude are genuinely responsive and read fine at 100%. These
// are only starting points -- drag the sidebar's left edge to resize it, use
// the zoom controls underneath to retune any app, and both are remembered.
const DEFAULT_ZOOM = { gmail: 0.8, calendar: 0.8, drive: 0.8, youtube: 1, assistant: 1 };
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 300;
const MAX_WIDTH = 1000;

function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Losing a saved preference shouldn't take the sidebar down with it.
  }
}

const zoomLabel = document.getElementById('zoom-label');
const dragShield = document.getElementById('drag-shield');
const resizeHandle = document.getElementById('sidebar-resize');

const zoomByApp = Object.assign({}, DEFAULT_ZOOM, readPref('sidebarZoom', {}));
let currentApp = 'gmail';
let sidebarWidth = DEFAULT_WIDTH;

function applyWidth(px) {
  sidebarWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
  document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth}px`);
}

function applyZoom(name) {
  const factor = zoomByApp[name] || 1;
  try {
    sbPanels[name].setZoomFactor(factor);
  } catch (err) {
    // Not attached yet -- its dom-ready handler will apply this shortly.
  }
  if (name === currentApp) zoomLabel.textContent = `${Math.round(factor * 100)}%`;
}

function setZoom(name, factor) {
  zoomByApp[name] = Math.min(1.5, Math.max(0.4, Math.round(factor * 20) / 20));
  writePref('sidebarZoom', zoomByApp);
  applyZoom(name);
}

applyWidth(readPref('sidebarWidth', DEFAULT_WIDTH));

Object.entries(sbPanels).forEach(([name, wv]) => {
  allowPopups(wv);
  hardenAgainstDetection(wv);
  // Navigating inside a panel resets its zoom, so reapply on every load.
  wv.addEventListener('dom-ready', () => applyZoom(name));
});

document.getElementById('zoom-in').addEventListener('click', () => {
  setZoom(currentApp, (zoomByApp[currentApp] || 1) + 0.05);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  setZoom(currentApp, (zoomByApp[currentApp] || 1) - 0.05);
});
zoomLabel.addEventListener('click', () => {
  setZoom(currentApp, DEFAULT_ZOOM[currentApp] || 1);
});

// Dragging the sidebar's edge. Each <webview> is its own renderer and
// swallows mouse events, so without a transparent shield laid over them for
// the duration, the drag would die the moment the pointer crossed a page.
resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = sidebarWidth;

  const onMove = (ev) => applyWidth(startWidth + (startX - ev.clientX));
  const onUp = () => {
    dragShield.classList.remove('active');
    resizeHandle.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    writePref('sidebarWidth', sidebarWidth);
  };

  dragShield.classList.add('active');
  resizeHandle.classList.add('dragging');
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

sbTabs.forEach((el) => {
  el.addEventListener('click', () => {
    const app = el.dataset.app;
    currentApp = app;
    sbTabs.forEach((t) => t.classList.toggle('active', t === el));
    Object.entries(sbPanels).forEach(([name, wv]) => {
      wv.classList.toggle('active', name === app);
    });
    applyZoom(app);
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
    saved.forEach((url) => createTab(isNewTabUrl(url) ? 'newtab.html' : url));
  } else {
    createTab('newtab.html');
  }
})();
