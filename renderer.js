// Both strings are built from the Chromium this app is actually running,
// read off our own window's user-agent (this window is on the default
// session, so it still carries Electron's real one). Hardcoding a version
// is what made Google serve an old Gmail: the number stops being true and
// nothing tells you.
const CHROME_MAJOR = (navigator.userAgent.match(/Chrome\/(\d+)/) || [null, '140'])[1];

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36';

// Android Chrome. Google picks a layout from the user-agent rather than
// from the width it actually has. This buys a narrow-column layout, but for
// Gmail and Calendar what it actually buys is their cut-down mobile web
// interface, which reads as "old" -- so only Drive defaults to it.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + CHROME_MAJOR + '.0.0.0 Mobile Safari/537.36';

const webviewContainer = document.getElementById('webview-container');
const tabstrip = document.getElementById('tabstrip');
const addressInput = document.getElementById('address-input');
const backBtn = document.getElementById('back-btn');
const fwdBtn = document.getElementById('fwd-btn');
const reloadBtn = document.getElementById('reload-btn');
const findbar = document.getElementById('findbar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const loadbar = document.getElementById('loadbar');

let tabs = [];      // { id, webview, tabEl, titleEl, iconEl, pendingUrl }
let activeId = null;
let nextId = 1;
const closedTabs = [];   // URLs of recently closed tabs, for Ctrl+Shift+T
let findActive = false;

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

// Pages that live inside the shell instead of being fetched. They render
// in a panel that already has the IPC bridge, because a <webview> carries
// no preload by design and could never reach it -- so settings could not be
// a real website here even if we wanted it to be.
const INTERNAL_PAGES = {
  settings: {
    title: 'Settings',
    panelId: 'page-settings',
    sentinel: 'about:settings',
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%23C98A3E' stroke-width='2'/%3E%3Ccircle cx='12' cy='12' r='3.2' fill='%23C98A3E'/%3E%3C/svg%3E"
  },
  guide: {
    title: 'Inside My Browser',
    panelId: 'page-guide',
    sentinel: 'about:guide',
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cdefs%3E%3ClinearGradient id='o' x1='0.18' y1='0' x2='0.86' y2='1'%3E%3Cstop offset='0' stop-color='%23F2A63F'/%3E%3Cstop offset='0.52' stop-color='%2357AC9C'/%3E%3Cstop offset='1' stop-color='%239585DC'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='12' cy='12' r='9' fill='url(%23o)'/%3E%3C/svg%3E"
  }
};

function internalKindOf(url) {
  return Object.keys(INTERNAL_PAGES).find((k) => INTERNAL_PAGES[k].sentinel === url) || null;
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

// A Google results page is shown as just the thing you searched for. The
// real URL is "https://www.google.com/search?q=pizza" plus a tail of
// tracking parameters, none of which tells you anything you did not type.
function googleQueryOf(url) {
  try {
    const u = new URL(url);
    if (!/^(www\.)?google(\.[a-z]{2,3})+$/i.test(u.hostname)) return null;
    if (u.pathname !== '/search') return null;
    return u.searchParams.get('q');
  } catch (err) {
    return null;
  }
}

function displayUrl(url) {
  if (isNewTabUrl(url)) return '';
  if (internalKindOf(url)) return '';
  const query = googleQueryOf(url);
  return query === null ? url : query;
}

function currentUrlOf(tab) {
  if (tab.internal) return INTERNAL_PAGES[tab.internal].sentinel;
  if (tab.pendingUrl) return tab.pendingUrl;
  try {
    return tab.webview.getURL() || tab.webview.getAttribute('src') || 'newtab.html';
  } catch (err) {
    return 'newtab.html';
  }
}

function attachWebviewEvents(tab) {
  const id = tab.id;
  const webview = tab.webview;
  const tabEl = tab.tabEl;
  const titleEl = tab.titleEl;
  const iconEl = tab.iconEl;

  webview.addEventListener('page-title-updated', (e) => {
    titleEl.textContent = e.title || 'New tab';
    // A page's title arrives after its navigation, so this is the second
    // half of recording a visit: same URL, now with something readable.
    recordVisit(currentUrlOf(tab), e.title);
  });
  webview.addEventListener('did-navigate', (e) => {
    if (activeId === id) addressInput.value = displayUrl(e.url);
    updateNavButtons();
    persistTabs();
    recordVisit(e.url, '');
    if (activeId === id) updateStar();
  });
  webview.addEventListener('did-navigate-in-page', (e) => {
    if (activeId === id) addressInput.value = displayUrl(e.url);
    updateNavButtons();
    persistTabs();
  });
  webview.addEventListener('did-start-loading', () => {
    tabEl.classList.add('loading');
    if (activeId === id) setBusy(true);
  });
  webview.addEventListener('did-stop-loading', () => {
    tabEl.classList.remove('loading');
    updateNavButtons();
    if (activeId === id) setBusy(false);
  });
  webview.addEventListener('did-fail-load', () => {
    tabEl.classList.remove('loading');
    if (activeId === id) setBusy(false);
  });
  webview.addEventListener('page-favicon-updated', (e) => {
    const icon = e.favicons && e.favicons[0];
    if (!icon) return;
    iconEl.src = icon;
    iconEl.classList.add('shown');
    backfillBookmarkIcon(currentUrlOf(tab), icon);
  });
  webview.addEventListener('dom-ready', () => applyTabZoom(tab));
  webview.addEventListener('found-in-page', (e) => {
    if (activeId !== id || !e.result) return;
    const matches = e.result.matches;
    findCount.textContent = matches ? e.result.activeMatchOrdinal + '/' + matches : 'No results';
    findCount.classList.toggle('none', !matches);
  });
}

function createTab(url, options) {
  const opts = options || {};
  const id = nextId++;
  const spec = opts.internal ? INTERNAL_PAGES[opts.internal] : null;
  const target = spec ? spec.sentinel : (url || 'newtab.html');

  let webview = null;
  const panel = spec ? document.getElementById(spec.panelId) : null;

  if (!spec) {
    webview = document.createElement('webview');
    webview.setAttribute('partition', 'persist:main');
    webview.setAttribute('useragent', CHROME_UA);
    allowPopups(webview);
    hardenAgainstDetection(webview);
    // A deferred tab is created empty and only fetches its page when you
    // first look at it. Restoring a session used to load every tab at once,
    // which is most of why a cold start felt slow.
    if (!opts.defer) webview.setAttribute('src', target);
    webviewContainer.appendChild(webview);
  }

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  const titleEl = document.createElement('span');
  titleEl.className = 'title';
  titleEl.textContent = spec ? spec.title : (opts.defer ? labelFor(target) : 'New tab');
  const closeEl = document.createElement('span');
  closeEl.className = 'closebtn';
  closeEl.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const iconEl = document.createElement('img');
  iconEl.className = 'favicon';
  if (spec) {
    iconEl.src = spec.icon;
    iconEl.classList.add('shown');
  }
  const spinEl = document.createElement('span');
  spinEl.className = 'spinner';
  tabEl.appendChild(iconEl);
  tabEl.appendChild(spinEl);
  tabEl.appendChild(titleEl);
  tabEl.appendChild(closeEl);
  tabstrip.appendChild(tabEl);

  const tab = {
    id,
    webview,
    panel,
    internal: opts.internal || null,
    tabEl,
    titleEl,
    iconEl,
    pendingUrl: (!spec && opts.defer) ? target : null
  };
  tabs.push(tab);

  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.closebtn')) return;
    setActiveTab(id);
  });
  closeEl.addEventListener('click', () => closeTab(id));
  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(id); }
  });

  if (webview) attachWebviewEvents(tab);

  if (!opts.silent) {
    setActiveTab(id);
    persistTabs();
  }
  return tab;
}

// ---------- Session persistence: remember tabs across restarts ----------

function openInternalTab(kind) {
  const existing = tabs.find((t) => t.internal === kind);
  if (existing) {
    setActiveTab(existing.id);
    return existing;
  }
  return createTab(null, { internal: kind });
}

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
    if (t.webview) t.webview.classList.toggle('active', isActive);
    if (t.panel) t.panel.classList.toggle('active', isActive);
    t.tabEl.classList.toggle('active', isActive);
  });
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;

  if (tab.internal) {
    addressInput.value = '';
    updateNavButtons();
    setBusy(false);
    updateStar();
    if (tab.internal === 'settings') renderSettings();
    return;
  }

  // First look at a deferred tab is when it actually loads.
  if (tab.pendingUrl) {
    const target = tab.pendingUrl;
    tab.pendingUrl = null;
    tab.webview.setAttribute('src', target);
  }

  const url = currentUrlOf(tab);
  addressInput.value = displayUrl(url);
  updateNavButtons();
  setBusy(tab.tabEl.classList.contains('loading'));
  updateStar();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  const closedUrl = currentUrlOf(tab);
  if (!isNewTabUrl(closedUrl) && !tab.internal) {
    closedTabs.push(closedUrl);
    if (closedTabs.length > 25) closedTabs.shift();
  }
  if (tab.webview) tab.webview.remove();
  if (tab.panel) tab.panel.classList.remove('active');
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
  if (!tab.webview) {
    backBtn.disabled = true;
    fwdBtn.disabled = true;
    return;
  }
  try {
    backBtn.disabled = !tab.webview.canGoBack();
    fwdBtn.disabled = !tab.webview.canGoForward();
  } catch (err) {
    // webview not attached yet
  }
}

// ---------- Address bar + nav controls ----------

addressInput.addEventListener('keydown', (e) => {
  const open = suggestEl.classList.contains('open');

  if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    highlightSuggestion((suggestIndex + 1) % suggestions.length);
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    highlightSuggestion((suggestIndex - 1 + suggestions.length) % suggestions.length);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    hideSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const picked = suggestIndex >= 0 ? suggestions[suggestIndex] : null;
    navigateTo(picked ? picked.url : normalizeInput(addressInput.value));
  }
});

backBtn.addEventListener('click', () => activeTab()?.webview?.goBack());
fwdBtn.addEventListener('click', () => activeTab()?.webview?.goForward());
reloadBtn.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  // Reloading an internal page means rebuilding it from current state.
  if (tab.internal === 'settings') renderSettings();
  else tab.webview?.reload();
});

document.getElementById('new-tab-btn').addEventListener('click', () => createTab());

// Anything that asked for a new window and wasn't allowed to open one (see
// POPUP_ALLOWLIST in main.js) arrives here instead and becomes a tab.
window.tabStore?.onOpenUrl?.((url) => createTab(url));

// ---------- History ----------

const historyApi = window.tabStore && window.tabStore.history;

function recordVisit(url, title) {
  if (!historyApi || !url) return;
  historyApi.add(url, title || '').catch(() => {});
}

function relativeTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function setBusy(on) {
  loadbar.classList.toggle('on', on);
}

function navigateTo(url) {
  const tab = activeTab();
  hideSuggestions();
  addressInput.blur();
  // Typing an address while an internal page is showing opens a real tab,
  // rather than trying to turn the settings page into a website.
  if (!tab || !tab.webview) {
    createTab(url);
    return;
  }
  // loadURL rejects with ERR_ABORTED (-3) whenever a navigation is
  // superseded -- a redirect, or you typing a new address before the last
  // one settled. The page still loads; the rejection is only noise, but an
  // unhandled one surfaces as a scary GUEST_VIEW_MANAGER_CALL stack.
  tab.webview.loadURL(url).catch(() => {});
}

// ---------- Address bar suggestions ----------

const suggestEl = document.getElementById('suggest');
let suggestions = [];
let suggestIndex = -1;

function hideSuggestions() {
  suggestEl.classList.remove('open');
  suggestions = [];
  suggestIndex = -1;
}

function highlightSuggestion(i) {
  suggestIndex = i;
  Array.from(suggestEl.children).forEach((row, n) => {
    row.classList.toggle('sel', n === i);
  });
}

function showSuggestions(list) {
  suggestions = list;
  suggestIndex = -1;
  if (!list.length) return hideSuggestions();

  suggestEl.innerHTML = '';
  list.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'suggest-row';

    const title = document.createElement('span');
    title.className = 'suggest-title';
    title.textContent = entry.title || entry.url;

    const url = document.createElement('span');
    url.className = 'suggest-url';
    url.textContent = entry.url;

    row.appendChild(title);
    row.appendChild(url);
    // mousedown, not click: the input's blur would tear the list down
    // before a click ever landed.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      navigateTo(entry.url);
    });
    row.addEventListener('mouseenter', () => highlightSuggestion(i));
    suggestEl.appendChild(row);
  });
  suggestEl.classList.add('open');
}

async function refreshSuggestions() {
  if (!historyApi) return;
  const text = addressInput.value.trim();
  if (!text) return hideSuggestions();
  try {
    showSuggestions(await historyApi.query(text, 8));
  } catch (err) {
    hideSuggestions();
  }
}

addressInput.addEventListener('input', refreshSuggestions);
addressInput.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 120);
  const tab = activeTab();
  if (tab) addressInput.value = displayUrl(currentUrlOf(tab));
});

addressInput.addEventListener('focus', () => {
  // Hiding the URL is fine until you want to copy or edit it, so focus
  // puts the real one back.
  const tab = activeTab();
  if (tab) {
    const real = currentUrlOf(tab);
    if (!isNewTabUrl(real) && displayUrl(real) !== real) {
      addressInput.value = real;
      addressInput.select();
    }
  }
  if (addressInput.value.trim()) refreshSuggestions();
});

// ---------- History overlay (Ctrl+H) ----------

const historyOverlay = document.getElementById('history-overlay');
const historySearch = document.getElementById('history-search');
const historyList = document.getElementById('history-list');

async function refreshHistoryList() {
  if (!historyApi) return;
  let rows = [];
  try {
    rows = await historyApi.query(historySearch.value, 300);
  } catch (err) {
    rows = [];
  }

  historyList.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    empty.textContent = historySearch.value
      ? 'Nothing matching that.'
      : 'No history yet.';
    historyList.appendChild(empty);
    return;
  }

  rows.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'hist-row';

    const main = document.createElement('div');
    main.className = 'hist-main';
    const title = document.createElement('span');
    title.className = 'hist-title';
    title.textContent = entry.title || entry.url;
    const url = document.createElement('span');
    url.className = 'hist-url';
    url.textContent = entry.url;
    main.appendChild(title);
    main.appendChild(url);

    const when = document.createElement('span');
    when.className = 'hist-when';
    when.textContent = relativeTime(entry.visitedAt || Date.now());

    const del = document.createElement('button');
    del.className = 'hist-del';
    del.textContent = '\u00d7';
    del.title = 'Remove from history';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await historyApi.remove(entry.url);
      refreshHistoryList();
    });

    row.appendChild(main);
    row.appendChild(when);
    row.appendChild(del);
    row.addEventListener('click', () => {
      closeHistory();
      createTab(entry.url);
    });
    historyList.appendChild(row);
  });
}

function openHistory() {
  downloadsOverlay.classList.remove('open');
  historyOverlay.classList.add('open');
  historySearch.value = '';
  refreshHistoryList();
  historySearch.focus();
}

function closeHistory() {
  historyOverlay.classList.remove('open');
}

function toggleHistory() {
  if (historyOverlay.classList.contains('open')) closeHistory();
  else openHistory();
}

historySearch.addEventListener('input', refreshHistoryList);
document.getElementById('history-close').addEventListener('click', closeHistory);
document.getElementById('history-clear').addEventListener('click', async () => {
  await historyApi.clear();
  refreshHistoryList();
});

// ---------- Bookmarks ----------

const bookmarksApi = window.tabStore && window.tabStore.bookmarks;
const bookmarksBar = document.getElementById('bookmarks');
const starBtn = document.getElementById('star-btn');
let bookmarkList = [];
let uiSettings = {};

// Only real web pages: not the new-tab page, not an internal page.
function canBookmark(url) {
  return /^https?:\/\//i.test(url || '');
}

function isBookmarked(url) {
  return bookmarkList.some((b) => b.url === url);
}

function updateStar() {
  const tab = activeTab();
  const url = tab ? currentUrlOf(tab) : '';
  const allowed = canBookmark(url);
  const saved = allowed && isBookmarked(url);
  starBtn.disabled = !allowed;
  starBtn.classList.toggle('on', saved);
  starBtn.title = saved ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
}

function applyBookmarksBar() {
  // Nothing saved means no empty strip taking up room.
  const show = uiSettings.showBookmarksBar !== false && bookmarkList.length > 0;
  bookmarksBar.classList.toggle('on', show);
}

function renderBookmarks() {
  bookmarksBar.innerHTML = '';
  bookmarkList.forEach((b) => {
    const chip = document.createElement('div');
    chip.className = 'bm';
    chip.title = b.url;

    if (b.icon) {
      const icon = document.createElement('img');
      icon.className = 'bm-icon';
      icon.src = b.icon;
      // A favicon URL can rot; fall back to the dot rather than a gap.
      icon.addEventListener('error', () => {
        icon.remove();
        chip.classList.add('no-icon');
      });
      chip.appendChild(icon);
    } else {
      chip.classList.add('no-icon');
    }

    const label = document.createElement('span');
    label.className = 'bm-title';
    label.textContent = b.title || labelFor(b.url);

    const remove = document.createElement('span');
    remove.className = 'bm-x';
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      bookmarkList = await bookmarksApi.remove(b.url);
      renderBookmarks();
      updateStar();
    });

    chip.appendChild(label);
    chip.appendChild(remove);
    chip.addEventListener('click', () => navigateTo(b.url));
    bookmarksBar.appendChild(chip);
  });
  applyBookmarksBar();
}

async function refreshBookmarks() {
  if (!bookmarksApi) return;
  try {
    bookmarkList = await bookmarksApi.list();
  } catch (err) {
    bookmarkList = [];
  }
  renderBookmarks();
  updateStar();
}

// A bookmark saved without an icon picks one up the next time you visit
// the page, so the bar fills in on its own rather than staying dotted.
async function backfillBookmarkIcon(url, icon) {
  if (!bookmarksApi || !icon || !canBookmark(url)) return;
  const entry = bookmarkList.find((b) => b.url === url);
  if (!entry || entry.icon) return;
  bookmarkList = await bookmarksApi.add(url, entry.title, icon);
  renderBookmarks();
}

async function toggleBookmark(explicitUrl) {
  if (!bookmarksApi) return;
  const tab = activeTab();
  const url = explicitUrl || (tab ? currentUrlOf(tab) : '');
  if (!canBookmark(url)) return;

  if (isBookmarked(url)) {
    bookmarkList = await bookmarksApi.remove(url);
  } else {
    // Bookmarking what you are looking at borrows that tab's title and
    // icon; a link bookmarked from the right-click menu has neither.
    const own = !explicitUrl && tab;
    const title = own ? tab.titleEl.textContent : '';
    const icon = own && tab.iconEl.classList.contains('shown') ? tab.iconEl.src : '';
    bookmarkList = await bookmarksApi.add(url, title, icon);
  }
  renderBookmarks();
  updateStar();
}

starBtn.addEventListener('click', () => toggleBookmark());
if (bookmarksApi && bookmarksApi.onBookmarkUrl) {
  bookmarksApi.onBookmarkUrl((url) => toggleBookmark(url));
}

// ---------- Settings ----------

const settingsApi = window.tabStore && window.tabStore.settings;
const settingsList = document.getElementById('settings-list');

// Described rather than hardcoded, so a new switch is one entry here plus
// one key in DEFAULT_SETTINGS in main.js.
const SETTINGS_SECTIONS = [
  {
    title: 'Blocking',
    items: [
      {
        key: 'blockTrackers',
        label: 'Block trackers and ads',
        hint: 'Refuses known tracking, analytics and ad hosts before the request leaves your machine. Also the biggest thing you can do for page speed.'
      },
      {
        key: 'stripTrackingParams',
        label: 'Strip tracking parameters from links',
        hint: 'Removes utm_*, fbclid, gclid and similar tags from addresses you open. The page is identical; the tag only ties the visit back to where you came from.'
      }
    ]
  },
  {
    title: 'Connection',
    items: [
      {
        key: 'httpsOnly',
        label: 'Always try HTTPS first',
        hint: 'Upgrades plain http:// pages to https://. Local addresses are exempt so development servers still work.'
      },
      {
        key: 'sendDoNotTrack',
        label: 'Send Do Not Track and Global Privacy Control',
        hint: 'Adds DNT and Sec-GPC to every request. Most sites ignore DNT, but Sec-GPC carries actual legal weight in some places.'
      },
      {
        key: 'trimReferrer',
        label: 'Trim referrers between sites',
        hint: 'Tells a site you came from another site, but not which page. Off by default because it breaks images on sites that check the referrer.'
      },
      {
        key: 'blockWebRTCLeak',
        label: 'Hide your local address from WebRTC',
        hint: 'Without this a page can use WebRTC to discover your machine on the local network, even through a VPN.'
      }
    ]
  },
  {
    title: 'What sites may ask for',
    items: [
      {
        key: 'allowNotifications',
        label: 'Allow notifications',
        hint: 'Everything not listed here is refused outright and never prompts: location, camera, microphone, MIDI, USB and serial.'
      },
      {
        key: 'allowClipboard',
        label: 'Allow reading the clipboard'
      }
    ]
  },
  {
    title: 'Appearance',
    items: [
      {
        key: 'showBookmarksBar',
        label: 'Show the bookmarks bar',
        hint: 'The strip under the address bar. It hides itself when you have no bookmarks saved.'
      }
    ]
  },
  {
    title: 'On exit',
    items: [
      {
        key: 'clearHistoryOnExit',
        label: 'Clear browsing history when the browser closes',
        hint: 'Does not sign you out; cookies are untouched.'
      }
    ]
  }
];

function makeSwitch(on, onToggle) {
  const el = document.createElement('button');
  el.className = 'sw' + (on ? ' on' : '');
  el.setAttribute('role', 'switch');
  el.setAttribute('aria-checked', on ? 'true' : 'false');
  el.addEventListener('click', () => onToggle(!el.classList.contains('on')));
  return el;
}

function settingsRow(item, values) {
  const row = document.createElement('div');
  row.className = 'set-row';

  const main = document.createElement('div');
  main.className = 'set-main';
  const label = document.createElement('div');
  label.className = 'set-label';
  label.textContent = item.label;
  main.appendChild(label);

  if (item.hint) {
    const hint = document.createElement('div');
    hint.className = 'set-hint';
    hint.textContent = item.hint;
    main.appendChild(hint);
  }

  const sw = makeSwitch(values[item.key], async (next) => {
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    await settingsApi.set(item.key, next);
    uiSettings[item.key] = next;
    applyBookmarksBar();
  });

  row.appendChild(main);
  row.appendChild(sw);
  return row;
}

function dataActions() {
  const wrap = document.createElement('div');
  wrap.className = 'set-actions';
  const add = (label, kind) => {
    const b = document.createElement('button');
    b.className = 'overlay-btn';
    b.textContent = label;
    b.addEventListener('click', () => window.tabStore.clearData(kind));
    wrap.appendChild(b);
  };
  add('Sign out of all sites', 'signout');
  add('Clear cache', 'cache');
  add('Clear history', 'history');
  return wrap;
}

async function renderSettings() {
  if (!settingsApi) return;
  let state;
  try {
    state = await settingsApi.get();
  } catch (err) {
    return;
  }

  uiSettings = state.values;
  applyBookmarksBar();

  settingsList.innerHTML = '';
  SETTINGS_SECTIONS.forEach((section) => {
    const head = document.createElement('div');
    head.className = 'set-section';
    head.textContent = section.title;
    settingsList.appendChild(head);
    section.items.forEach((item) => {
      settingsList.appendChild(settingsRow(item, state.values));
    });
  });

  const head = document.createElement('div');
  head.className = 'set-section';
  head.textContent = 'Clear data now';
  settingsList.appendChild(head);
  settingsList.appendChild(dataActions());

  if (state.blocked > 0) {
    const tally = document.createElement('div');
    tally.className = 'set-hint';
    tally.style.padding = '14px 10px 4px 10px';
    tally.innerHTML = 'Blocked <b>' + state.blocked +
      '</b> tracking requests since this browser started.';
    settingsList.appendChild(tally);
  }
}

function openSettings() {
  openInternalTab('settings');
}

document.getElementById('settings-reset').addEventListener('click', async () => {
  await settingsApi.reset();
  renderSettings();
});

// ---------- Downloads ----------

const downloadsApi = window.tabStore && window.tabStore.downloads;
const downloadsOverlay = document.getElementById('downloads-overlay');
const downloadsList = document.getElementById('downloads-list');
const downloadsDot = document.getElementById('downloads-dot');

function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return (i === 0 ? value : value.toFixed(1)) + ' ' + units[i];
}

function describeDownload(d) {
  if (d.state === 'progressing') {
    return d.total > 0
      ? formatBytes(d.received) + ' of ' + formatBytes(d.total)
      : formatBytes(d.received) + ' so far';
  }
  if (d.state === 'paused') return 'Paused at ' + formatBytes(d.received);
  if (d.state === 'completed') {
    return d.risky
      ? formatBytes(d.received) + ' \u2014 opens in Explorer, not run here'
      : formatBytes(d.received) + ' \u2014 saved to Downloads';
  }
  if (d.state === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function makeButton(label, onClick) {
  const b = document.createElement('button');
  b.className = 'overlay-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderDownloads(list) {
  const active = list.some((d) => d.state === 'progressing' || d.state === 'paused');
  downloadsDot.classList.toggle('on', active);

  downloadsList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    empty.textContent = 'Nothing downloaded yet.';
    downloadsList.appendChild(empty);
    return;
  }

  list.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'dl-row';

    const main = document.createElement('div');
    main.className = 'dl-main';

    const name = document.createElement('span');
    name.className = 'dl-name';
    name.textContent = d.filename;

    const sub = document.createElement('span');
    sub.className = 'dl-sub';
    if (d.state === 'interrupted' || d.state === 'cancelled') sub.classList.add('failed');
    if (d.state === 'completed' && d.risky) sub.classList.add('dl-risky');
    sub.textContent = describeDownload(d);

    main.appendChild(name);
    main.appendChild(sub);

    if (d.state === 'progressing' || d.state === 'paused') {
      const bar = document.createElement('div');
      bar.className = 'dl-bar';
      const fill = document.createElement('div');
      fill.className = 'dl-fill';
      fill.style.width = d.total > 0 ? Math.round((d.received / d.total) * 100) + '%' : '0%';
      bar.appendChild(fill);
      main.appendChild(bar);
    }

    row.appendChild(main);

    if (d.state === 'completed') {
      row.appendChild(makeButton(d.risky ? 'Show' : 'Open', () => downloadsApi.open(d.id)));
      row.appendChild(makeButton('Folder', () => downloadsApi.show(d.id)));
    } else if (d.state === 'progressing' || d.state === 'paused') {
      row.appendChild(makeButton('Cancel', () => downloadsApi.cancel(d.id)));
    }

    downloadsList.appendChild(row);
  });
}

async function refreshDownloads() {
  if (!downloadsApi) return;
  try {
    renderDownloads(await downloadsApi.list());
  } catch (err) {
    renderDownloads([]);
  }
}

function closeDownloads() {
  downloadsOverlay.classList.remove('open');
}

function openDownloads() {
  closeHistory();
  downloadsOverlay.classList.add('open');
  refreshDownloads();
}

function toggleDownloads() {
  if (downloadsOverlay.classList.contains('open')) closeDownloads();
  else openDownloads();
}

if (downloadsApi) {
  // Main pushes the whole list on every change, so the panel and the
  // activity dot stay right whether or not the panel is open.
  downloadsApi.onChange(renderDownloads);
  refreshDownloads();
}

document.getElementById('downloads-btn').addEventListener('click', toggleDownloads);
document.getElementById('menu-btn').addEventListener('click', () => {
  window.tabStore?.showAppMenu?.();
});

// After a sign-out the panels are still showing the signed-in pages they
// loaded earlier, so send everything back to the network to pick up the
// now-empty session.
window.tabStore?.onSessionCleared?.(() => {
  Object.keys(sbPanels).forEach((name) => {
    if (!panelLoaded[name]) return;
    try { sbPanels[name].reload(); } catch (err) {}
  });
  const tab = activeTab();
  if (tab) {
    try { tab.webview.reload(); } catch (err) {}
  }
});
document.getElementById('downloads-close').addEventListener('click', closeDownloads);
document.getElementById('downloads-clear').addEventListener('click', async () => {
  renderDownloads(await downloadsApi.clear());
});

// ---------- Find in page ----------

function runFind(text, options) {
  const tab = activeTab();
  if (!tab || !tab.webview) return;
  if (!text) {
    findCount.textContent = '';
    try { tab.webview.stopFindInPage('clearSelection'); } catch (err) {}
    return;
  }
  try { tab.webview.findInPage(text, options); } catch (err) {}
}

function openFind() {
  findbar.classList.add('open');
  findActive = true;
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind(findInput.value, { findNext: false });
}

function closeFind() {
  if (!findActive) return;
  findbar.classList.remove('open');
  findActive = false;
  findCount.textContent = '';
  findCount.classList.remove('none');
  const tab = activeTab();
  if (tab) {
    try { tab.webview.stopFindInPage('clearSelection'); } catch (err) {}
  }
}

findInput.addEventListener('input', () => runFind(findInput.value, { findNext: false }));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runFind(findInput.value, { findNext: true, forward: !e.shiftKey });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
document.getElementById('find-next')
  .addEventListener('click', () => runFind(findInput.value, { findNext: true, forward: true }));
document.getElementById('find-prev')
  .addEventListener('click', () => runFind(findInput.value, { findNext: true, forward: false }));
document.getElementById('find-close').addEventListener('click', closeFind);

// ---------- Page zoom, remembered per site ----------

const tabZoom = readPref('tabZoom', {});

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return null;
  }
}

function applyTabZoom(tab) {
  if (!tab.webview) return;
  const origin = originOf(currentUrlOf(tab));
  const factor = (origin && tabZoom[origin]) || 1;
  try { tab.webview.setZoomFactor(factor); } catch (err) {}
}

function nudgeTabZoom(delta) {
  const tab = activeTab();
  if (!tab || !tab.webview) return;
  const origin = originOf(currentUrlOf(tab));
  if (!origin) return; // nothing to key a preference off, e.g. the new-tab page
  const current = tabZoom[origin] || 1;
  const next = delta === 0
    ? 1
    : Math.min(3, Math.max(0.25, Math.round((current + delta) * 20) / 20));
  tabZoom[origin] = next;
  writePref('tabZoom', tabZoom);
  try { tab.webview.setZoomFactor(next); } catch (err) {}
}

function cycleTab(direction) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeId);
  const next = (idx + direction + tabs.length) % tabs.length;
  setActiveTab(tabs[next].id);
}

function reopenClosedTab() {
  const url = closedTabs.pop();
  if (url) createTab(url);
}

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

// Which interface each app is asked for. Gmail and Calendar take the
// desktop one: on a current Chromium that is the real, modern Gmail, while
// their phone interface is a cut-down legacy view. Drive keeps the phone
// interface because it genuinely reads well in a narrow column.
const PANEL_UA = {
  gmail: 'desktop',
  calendar: 'desktop',
  drive: 'phone',
  youtube: 'desktop',
  assistant: 'desktop'
};

// How much CSS width each app needs before its layout stops being cramped.
// Gmail and Calendar lay out a fixed-width desktop UI that does not reflow,
// so the only way to fit one into a narrow panel is to scale it down. An
// app absent from this table is responsive and is left at 100%.
const FIT_TARGETS = { gmail: 900, calendar: 820 };

const MIN_FIT = 0.35;   // below this the text stops being readable at all
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 300;
const MAX_WIDTH = 1000;

const zoomLabel = document.getElementById('zoom-label');
const dragShield = document.getElementById('drag-shield');
const resizeHandle = document.getElementById('sidebar-resize');

// A per-app manual override. Absent means "fit it automatically", which is
// the default for everything.
const zoomOverride = readPref('sidebarZoom', {});
const panelLoaded = {};
let currentApp = 'gmail';
let sidebarWidth = DEFAULT_WIDTH;

function uaFor(name) {
  return PANEL_UA[name] === 'phone' ? MOBILE_UA : CHROME_UA;
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

// The scale that makes this app's layout fit the panel as it is right now.
function fitFactor(name) {
  const target = FIT_TARGETS[name];
  if (!target) return 1;
  return Math.min(1, Math.max(MIN_FIT, sidebarWidth / target));
}

function zoomFor(name) {
  const manual = zoomOverride[name];
  return typeof manual === 'number' ? manual : fitFactor(name);
}

function applyZoom(name) {
  const factor = zoomFor(name);
  try {
    sbPanels[name].setZoomFactor(factor);
  } catch (err) {
    // Not attached yet -- its dom-ready handler will apply this shortly.
  }
  if (name === currentApp) {
    const auto = typeof zoomOverride[name] !== 'number';
    zoomLabel.textContent = Math.round(factor * 100) + '%';
    zoomLabel.classList.toggle('auto', auto);
    zoomLabel.title = auto
      ? 'Fitted to the panel automatically'
      : 'Set by hand - click to go back to automatic';
  }
}

// Re-fitting on every mousemove of a drag would mean a zoom call per pixel,
// so the work is collapsed into one pass per animation frame.
let fitQueued = false;
function refitPanels() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    Object.keys(sbPanels).forEach((name) => {
      if (panelLoaded[name]) applyZoom(name);
    });
  });
}

function applyWidth(px) {
  sidebarWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
  document.documentElement.style.setProperty('--sidebar-w', sidebarWidth + 'px');
  refitPanels();
}

function setZoom(name, factor) {
  zoomOverride[name] = Math.min(1.5, Math.max(0.25, Math.round(factor * 20) / 20));
  writePref('sidebarZoom', zoomOverride);
  applyZoom(name);
}

// Back to following the panel width.
function clearZoom(name) {
  delete zoomOverride[name];
  writePref('sidebarZoom', zoomOverride);
  applyZoom(name);
}

applyWidth(readPref('sidebarWidth', DEFAULT_WIDTH));

document.getElementById('zoom-in').addEventListener('click', () => {
  setZoom(currentApp, zoomFor(currentApp) + 0.05);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  setZoom(currentApp, zoomFor(currentApp) - 0.05);
});
zoomLabel.addEventListener('click', () => clearZoom(currentApp));

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
    // Picking an app out of the collapsed rail should open it, not just
    // highlight something you cannot see.
    if (sidebar.classList.contains('collapsed')) setSidebarCollapsed(false);
    ensurePanelLoaded(app);
    applyZoom(app);
  });
});

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  writePref('sidebarCollapsed', collapsed);
  // Width changed, so anything being fitted to it needs recomputing.
  if (!collapsed) refitPanels();
}

function toggleSidebar() {
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}

document.getElementById('sidebar-collapse').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
setSidebarCollapsed(readPref('sidebarCollapsed', false));

// ---------- Keyboard shortcuts ----------

// A key pressed while a page has focus never reaches this window, so
// main.js intercepts the ones we care about and replays them here by name.
// Both routes land in the same dispatcher.
const SHORTCUTS = {
  'new-tab': () => createTab(),
  'reopen-tab': reopenClosedTab,
  'close-tab': () => { if (activeId) closeTab(activeId); },
  'focus-address': () => { addressInput.focus(); addressInput.select(); },
  find: openFind,
  history: toggleHistory,
  downloads: toggleDownloads,
  settings: openSettings,
  guide: () => openInternalTab('guide'),
  bookmark: () => toggleBookmark(),
  escape: () => { closeFind(); closeHistory(); closeDownloads(); },
  'next-tab': () => cycleTab(1),
  'prev-tab': () => cycleTab(-1),
  'zoom-in': () => nudgeTabZoom(0.1),
  'zoom-out': () => nudgeTabZoom(-0.1),
  'zoom-reset': () => nudgeTabZoom(0)
};

function runShortcut(name) {
  const fn = SHORTCUTS[name];
  if (fn) fn();
}

window.tabStore?.onShortcut?.(runShortcut);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeFind(); closeHistory(); closeDownloads(); return; }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();

  let name = null;
  if (key === 't') name = e.shiftKey ? 'reopen-tab' : 'new-tab';
  else if (key === 'w') name = 'close-tab';
  else if (key === 'l') name = 'focus-address';
  else if (key === 'f') name = 'find';
  else if (key === 'h') name = 'history';
  else if (key === 'j') name = 'downloads';
  else if (key === ',') name = 'settings';
  else if (key === 'd') name = 'bookmark';
  else if (key === 'tab') name = e.shiftKey ? 'prev-tab' : 'next-tab';
  else if (key === '=' || key === '+') name = 'zoom-in';
  else if (key === '-') name = 'zoom-out';
  else if (key === '0') name = 'zoom-reset';
  if (!name) return;

  e.preventDefault();
  runShortcut(name);
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
      const kind = internalKindOf(url);
      if (kind) {
        createTab(null, { internal: kind, silent: true });
        return;
      }
      const clean = isNewTabUrl(url) ? 'newtab.html' : url;
      createTab(clean, { defer: i !== 0, silent: true });
    });
    setActiveTab(tabs[0].id);
    persistTabs();
  } else {
    createTab('newtab.html');
  }

  if (settingsApi) {
    try {
      uiSettings = (await settingsApi.get()).values;
    } catch (err) {
      uiSettings = {};
    }
  }
  await refreshBookmarks();

  // The sidebar's first panel waits for the shell to go idle, so it never
  // competes with the page you actually opened the browser to see.
  const whenIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
  whenIdle(() => ensurePanelLoaded(currentApp));
})();
