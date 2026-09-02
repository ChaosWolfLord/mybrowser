// Desktop Chrome, the default everywhere. Google's sign-in flow checks the
// user-agent and refuses one it doesn't recognise.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Android Chrome. Gmail, Calendar and Drive pick their layout from the
// user-agent rather than from the width they actually have: told they are
// on a desktop they lay out a full desktop UI and overflow a narrow panel,
// and no amount of zooming fixes that -- it only shrinks the text. Told
// they are on a phone they serve the responsive layout, which is built for
// exactly this shape. YouTube and Claude are genuinely responsive and look
// right on the desktop string, so they keep it.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

const webviewContainer = document.getElementById('webview-container');
const tabstrip = document.getElementById('tabstrip');
const addressInput = document.getElementById('address-input');
const backBtn = document.getElementById('back-btn');
const fwdBtn = document.getElementById('fwd-btn');
const reloadBtn = document.getElementById('reload-btn');

let tabs = [];      // { id, webview, tabEl, titleEl, pendingUrl }
let activeId = null;
let nextId = 1;

// ---------- Preferences ----------

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

// ---------- Tabs ----------

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

// Google's sign-in flow opens a small popup. Electron's <webview> blocks
// popups silently unless this is set; main.js decides which ones are
// actually allowed through and turns the rest into tabs.
function allowPopups(webview) {
  webview.setAttribute('allowpopups', 'true');
}

// Masks a signal sites use to detect automated/embedded browsers, to work
// around Google's "this browser may not be secure" block. Google updates
// its detection over time, so this may not hold forever.
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

// A readable stand-in for a tab that hasn't been loaded yet.
function labelFor(url) {
  if (isNewTabUrl(url)) return 'New tab';
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch (err) {
    return url;
  }
}

function currentUrlOf(tab) {
  if (tab.pendingUrl) return tab.pendingUrl;
  try {
    return tab.webview.getURL() || tab.webview.getAttribute('src') || 'newtab.html';
  } catch (err) {
    return 'newtab.html';
  }
}

function createTab(url, options) {
  const opts = options || {};
  const id = nextId++;
  const target = url || 'newtab.html';

  const webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:main');
  webview.setAttribute('useragent', CHROME_UA);
  allowPopups(webview);
  hardenAgainstDetection(webview);
  // A deferred tab is created empty and only fetches its page when you
  // first look at it. Restoring a session used to load every tab at once,
  // which is most of why a cold start felt slow.
  if (!opts.defer) webview.setAttribute('src', target);
  webviewContainer.appendChild(webview);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const titleEl = document.createElement('span');
  titleEl.className = 'title';
  titleEl.textContent = opts.defer ? labelFor(target) : 'New tab';
  const closeEl = document.createElement('span');
  closeEl.className = 'closebtn';
  closeEl.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  tabEl.appendChild(titleEl);
  tabEl.appendChild(closeEl);
  tabstrip.appendChild(tabEl);

  const tab = { id, webview, tabEl, titleEl, pendingUrl: opts.defer ? target : null };
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

  if (!opts.silent) {
    setActiveTab(id);
    persistTabs();
  }
  return tab;
}

// ---------- Session persistence: remember tabs across restarts ----------

function persistTabs() {
  // A new tab's resolved URL is a file:// path into whichever folder this
  // copy happens to live in, which is wrong the moment the app is packaged
  // (newtab.html then lives inside app.asar). Store the bare relative name
  // instead so it resolves correctly either way.
  const urls = tabs.map((t) => {
    const url = currentUrlOf(t);
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
  if (!tab) return;

  // First look at a deferred tab is when it actually loads.
  if (tab.pendingUrl) {
    const target = tab.pendingUrl;
    tab.pendingUrl = null;
    tab.webview.setAttribute('src', target);
  }

  const url = currentUrlOf(tab);
  addressInput.value = isNewTabUrl(url) ? '' : url;
  updateNavButtons();
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

// Anything that asked for a new window and wasn't allowed to open one (see
// POPUP_ALLOWLIST in main.js) arrives here instead and becomes a tab.
window.tabStore?.onOpenUrl?.((url) => createTab(url));

// ---------- Sidebar ----------

const sidebar = document.getElementById('sidebar');
const sbTabs = document.querySelectorAll('.sbtab');
const sbPanels = {
  gmail: document.getElementById('panel-gmail'),
  calendar: document.getElementById('panel-calendar'),
  drive: document.getElementById('panel-drive'),
  youtube: document.getElementById('panel-youtube'),
  assistant: document.getElementById('panel-assistant')
};

const DEFAULT_LAYOUT = {
  gmail: 'phone',
  calendar: 'phone',
  drive: 'phone',
  youtube: 'desktop',
  assistant: 'desktop'
};
// The phone layout is sized for a narrow column already, so it wants no
// zooming out at all -- that was only ever a workaround for the desktop
// layout not fitting.
const DEFAULT_ZOOM = { gmail: 1, calendar: 1, drive: 1, youtube: 1, assistant: 1 };
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 300;
const MAX_WIDTH = 1000;

const zoomLabel = document.getElementById('zoom-label');
const layoutBtn = document.getElementById('layout-toggle');
const dragShield = document.getElementById('drag-shield');
const resizeHandle = document.getElementById('sidebar-resize');

const layoutByApp = Object.assign({}, DEFAULT_LAYOUT, readPref('sidebarLayout', {}));
const zoomByApp = Object.assign({}, DEFAULT_ZOOM, readPref('sidebarZoom', {}));
const panelLoaded = {};
let currentApp = 'gmail';
let sidebarWidth = DEFAULT_WIDTH;

function uaFor(name) {
  return layoutByApp[name] === 'phone' ? MOBILE_UA : CHROME_UA;
}

// Panels are empty until first opened. Loading all five Google apps at
// launch was the largest single cost in starting the browser.
function ensurePanelLoaded(name) {
  if (panelLoaded[name]) return;
  const wv = sbPanels[name];
  if (!wv || !wv.dataset.src) return;
  panelLoaded[name] = true;
  wv.setAttribute('useragent', uaFor(name));
  allowPopups(wv);
  hardenAgainstDetection(wv);
  wv.addEventListener('dom-ready', () => applyZoom(name));
  wv.setAttribute('src', wv.dataset.src);
}

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

function updateLayoutButton() {
  layoutBtn.textContent = layoutByApp[currentApp] === 'phone' ? 'Phone' : 'Desktop';
}

function setLayout(name, mode) {
  layoutByApp[name] = mode;
  writePref('sidebarLayout', layoutByApp);
  const wv = sbPanels[name];
  if (panelLoaded[name]) {
    // The user-agent is read at request time, so the panel has to go back
    // to the network for the new layout to take effect.
    try {
      wv.setUserAgent(uaFor(name));
      wv.reload();
    } catch (err) {
      // Panel not ready; the attribute below covers it.
    }
  }
  wv.setAttribute('useragent', uaFor(name));
  updateLayoutButton();
}

applyWidth(readPref('sidebarWidth', DEFAULT_WIDTH));
updateLayoutButton();

document.getElementById('zoom-in').addEventListener('click', () => {
  setZoom(currentApp, (zoomByApp[currentApp] || 1) + 0.05);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  setZoom(currentApp, (zoomByApp[currentApp] || 1) - 0.05);
});
zoomLabel.addEventListener('click', () => {
  setZoom(currentApp, DEFAULT_ZOOM[currentApp] || 1);
});
layoutBtn.addEventListener('click', () => {
  setLayout(currentApp, layoutByApp[currentApp] === 'phone' ? 'desktop' : 'phone');
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
    ensurePanelLoaded(app);
    applyZoom(app);
    updateLayoutButton();
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
    // Only the tab you were last looking at loads now; the rest fill in
    // when you click them.
    saved.forEach((url, i) => {
      const clean = isNewTabUrl(url) ? 'newtab.html' : url;
      createTab(clean, { defer: i !== 0, silent: true });
    });
    setActiveTab(tabs[0].id);
    persistTabs();
  } else {
    createTab('newtab.html');
  }

  // The sidebar's first panel waits for the shell to go idle, so it never
  // competes with the page you actually opened the browser to see.
  const whenIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
  whenIdle(() => ensurePanelLoaded(currentApp));
})();
