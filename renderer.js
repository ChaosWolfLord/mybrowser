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
// Filled in at boot. Only the first ordinary window owns tabs.json, and a
// private window records nothing anywhere.
let windowInfo = { isPrimary: true, isPrivate: false };

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
    title: 'Inside Aurora',
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
  webview.addEventListener('dom-ready', () => {
    applyTabZoom(tab);
    sendNewsTo(webview);
  });
  webview.addEventListener('enter-html-full-screen', () => setPageFullscreen(tab, true));
  webview.addEventListener('leave-html-full-screen', () => setPageFullscreen(tab, false));
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
  tabEl.className = 'tab' + (opts.pinned ? ' pinned' : '');
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
    pinned: !!opts.pinned,
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
  tabEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.closebtn')) return;
    startTabDrag(tab, e);
  });

  if (webview) attachWebviewEvents(tab);

  if (!opts.silent) {
    setActiveTab(id);
    persistTabs();
  }
  return tab;
}

// ---------- Pinning, reordering, duplicating ----------

// Pinned tabs are held at the front. sort is stable, so everything keeps
// its relative order within its own group.
function reflowTabs() {
  tabs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  tabs.forEach((t) => tabstrip.appendChild(t.tabEl));
  persistTabs();
}

function togglePin(tab) {
  tab.pinned = !tab.pinned;
  tab.tabEl.classList.toggle('pinned', tab.pinned);
  reflowTabs();
}

function duplicateTab(tab) {
  createTab(currentUrlOf(tab));
}

function closeOtherTabs(keepId) {
  // Pinned tabs survive this: they are pinned precisely so they stay.
  tabs.slice().forEach((t) => {
    if (t.id !== keepId && !t.pinned) closeTab(t.id);
  });
}

// Dragging a tab. The shield goes up because the pointer can easily leave
// the strip and cross a page, which would otherwise swallow the events.
function startTabDrag(tab, downEvent) {
  const startX = downEvent.clientX;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) {
      if (Math.abs(e.clientX - startX) < 5) return;
      dragging = true;
      tab.tabEl.classList.add('dragging');
      dragShield.classList.add('active', 'plain');
    }

    // Only ever reorder within its own group, so a drag can't unpin a tab.
    const group = tabs.filter((t) => !!t.pinned === !!tab.pinned);
    const others = group.filter((t) => t !== tab);

    let index = 0;
    others.forEach((other) => {
      const r = other.tabEl.getBoundingClientRect();
      if (e.clientX > r.left + r.width / 2) index += 1;
    });

    const reordered = others.slice();
    reordered.splice(index, 0, tab);
    if (reordered.every((t, i) => t === group[i])) return;   // nothing moved

    const pinnedGroup = tab.pinned ? reordered : tabs.filter((t) => t.pinned);
    const looseGroup = tab.pinned ? tabs.filter((t) => !t.pinned) : reordered;
    tabs = pinnedGroup.concat(looseGroup);
    tabs.forEach((t) => tabstrip.appendChild(t.tabEl));
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (!dragging) return;
    tab.tabEl.classList.remove('dragging');
    dragShield.classList.remove('active', 'plain');
    persistTabs();
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
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
  // A second window must not fight the first over the same file, and a
  // private window is not supposed to leave anything behind.
  if (!windowInfo.isPrimary || windowInfo.isPrivate) return;

  const entries = tabs.map((t) => {
    const url = currentUrlOf(t);
    return { url: isNewTabUrl(url) ? 'newtab.html' : url, pinned: !!t.pinned };
  });
  window.tabStore?.save(entries);
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

// Window buttons, since the window is frameless.
const winControl = (action) => window.tabStore?.windowControl?.(action);
document.getElementById('win-min').addEventListener('click', () => winControl('minimize'));
document.getElementById('win-max').addEventListener('click', () => winControl('maximize'));
document.getElementById('win-close').addEventListener('click', () => winControl('close'));

// Anything that asked for a new window and wasn't allowed to open one (see
// POPUP_ALLOWLIST in main.js) arrives here instead and becomes a tab.
window.tabStore?.onOpenUrl?.((url) => createTab(url));

// ---------- History ----------

const historyApi = window.tabStore && window.tabStore.history;

function recordVisit(url, title) {
  if (!historyApi || !url || windowInfo.isPrivate) return;
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
let newsTopics = [];

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
        key: 'blockAds',
        label: 'Block ads',
        hint: 'Uses EasyList and EasyPrivacy — the same public filter lists uBlock and AdBlock Plus use — to refuse ads and trackers before the request leaves your machine. They update themselves every few days.'
      },
      { type: 'adblock' },
      {
        key: 'blockTrackers',
        label: 'Block known tracker hosts',
        hint: 'A short built-in list, separate from the filter lists above and kept because it works even before those have downloaded.'
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
      },
      {
        key: 'allowSecurityKeys',
        label: 'Allow passkeys and security keys',
        hint: 'Off, so the Windows “Choose a passkey” box never appears — sites fall back to a password instead. Turn it on if you actually sign in with a passkey or a security key. Pages already open keep the old setting until you reload them.'
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
    title: 'Extensions',
    items: [{ type: 'extensions' }]
  },
  {
    title: 'New tab page',
    items: [
      {
        key: 'showNews',
        label: 'Show a news feed',
        hint: 'Headlines from Google News, under the search box on every new tab.'
      },
      { type: 'topics' }
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

// What the ad blocker is actually doing right now, under its switch.
function adblockRow() {
  const row = document.createElement('div');
  row.className = 'set-row adblock-row';
  row.id = 'adblock-row';

  const main = document.createElement('div');
  main.className = 'set-main';

  const status = document.createElement('div');
  status.className = 'set-hint';
  status.id = 'adblock-status';
  status.textContent = 'Checking…';
  main.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'set-actions';
  actions.style.paddingLeft = '0';

  const update = document.createElement('button');
  update.className = 'overlay-btn';
  update.id = 'adblock-update';
  update.textContent = 'Update filter lists';
  update.addEventListener('click', async () => {
    update.disabled = true;
    await window.tabStore.adblock.update();
    update.disabled = false;
    refreshAdblockStatus();
  });

  actions.appendChild(update);
  main.appendChild(actions);
  row.appendChild(main);
  return row;
}

function whenAgo(ms) {
  if (!ms) return 'never';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + ' minutes ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

async function refreshAdblockStatus() {
  const el = document.getElementById('adblock-status');
  if (!window.tabStore.adblock) return;
  let s;
  try {
    s = await window.tabStore.adblock.status();
  } catch (err) {
    return;
  }

  // The summary tiles at the top of the page draw their ad numbers from here.
  const setStat = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  setStat('stat-ads', s.enabled ? (s.blocked || 0).toLocaleString() : 'off');
  setStat('stat-rules', s.rules ? s.rules.toLocaleString() : '—');

  if (!el) return;
  if (!s.enabled) {
    el.textContent = 'Off. The filter lists stay on disk, so turning it back on is instant.';
    return;
  }
  const parts = [s.note];
  if (s.hiding) parts.push(s.hiding.toLocaleString() + ' hiding rules');
  if (s.rules) parts.push('updated ' + whenAgo(s.updatedAt));
  parts.push('blocked ' + s.blocked.toLocaleString() + ' since this browser started');
  el.textContent = parts.join(' · ');
}

// The one setting that is not a switch.
function topicsRow() {
  const row = document.createElement('div');
  row.className = 'set-row';

  const main = document.createElement('div');
  main.className = 'set-main';

  const label = document.createElement('div');
  label.className = 'set-label';
  label.textContent = 'Topics';

  const hint = document.createElement('div');
  hint.className = 'set-hint';
  hint.textContent = 'What the feed follows, separated by commas. Up to six.';

  const input = document.createElement('input');
  input.className = 'set-input';
  input.id = 'news-topics-input';   // there is more than one .set-input now
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'Roblox, Minecraft, LEGO';
  input.value = newsTopics.join(', ');

  // Saving only on blur lost the edit if you typed and then closed the
  // window: the blur fires, but the message to the main process does not
  // finish before the window is gone. Typing now saves on its own shortly
  // after you stop, so the change is already on disk by the time you close
  // anything.
  let saveTimer = null;

  const save = async (rewrite) => {
    const wanted = input.value.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      newsTopics = await window.tabStore.news.setTopics(wanted);
    } catch (err) {
      return;   // keep what is on screen rather than blanking the field
    }
    // Only when you have finished. Rewriting the box mid-word would move the
    // caret out from under you.
    if (rewrite) input.value = newsTopics.join(', ');
  };

  input.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(false), 900);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  input.addEventListener('blur', () => {
    clearTimeout(saveTimer);
    // Now it is safe to show what was actually kept, so a trimmed or
    // duplicate topic is visible.
    save(true);
  });

  main.appendChild(label);
  main.appendChild(hint);
  main.appendChild(input);
  row.appendChild(main);
  return row;
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

  try {
    newsTopics = (await window.tabStore.news.get()).topics || [];
  } catch (err) {
    newsTopics = [];
  }

  settingsList.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'set-wrap';
  settingsList.appendChild(wrap);

  wrap.appendChild(settingsSummary(state));

  SETTINGS_SECTIONS.forEach((section) => {
    wrap.appendChild(sectionCard(section.title, section.items.map((item) => {
      if (item.type === 'adblock') return adblockRow();
      if (item.type === 'topics') return topicsRow();
      if (item.type === 'extensions') return extensionsRow();
      return settingsRow(item, state.values);
    })));
  });

  // The one-off "clear data" section, given the same card treatment.
  wrap.appendChild(sectionCard('Clear data now', [dataActions()]));

  renderExtensionSettings();
  refreshAdblockStatus();
}

// Line icons, one per section, drawn in the accent colour. viewBox 24.
const SECTION_ICONS = {
  'Blocking': '<path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/>',
  'Connection': '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  'What sites may ask for': '<path d="M6 8a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 004 0"/>',
  'Appearance': '<circle cx="8" cy="8" r="2.3"/><line x1="10.3" y1="8" x2="20" y2="8"/><line x1="4" y1="8" x2="5.7" y2="8"/><circle cx="15" cy="16" r="2.3"/><line x1="4" y1="16" x2="12.7" y2="16"/><line x1="17.3" y1="16" x2="20" y2="16"/>',
  'Extensions': '<path d="M10 4a1.5 1.5 0 013 0v1.5H15A1 1 0 0116 6.5V9h1.5a1.5 1.5 0 010 3H16v3.5a1 1 0 01-1 1h-3V17a1.5 1.5 0 00-3 0v-.5H5.5a1 1 0 01-1-1V12H6a1.5 1.5 0 000-3H4.5V6.5a1 1 0 011-1H10z"/>',
  'New tab page': '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>',
  'On exit': '<path d="M12 4v8"/><path d="M7.5 7a7 7 0 109 0"/>',
  'Clear data now': '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6.5 7l.9 12a1 1 0 001 1h7.2a1 1 0 001-1l.9-12"/>'
};

function sectionIcon(title) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = SECTION_ICONS[title] || '<circle cx="12" cy="12" r="8"/>';
  return svg;
}

// A titled card: an icon-badged header, then the rows.
function sectionCard(title, rows) {
  const card = document.createElement('section');
  card.className = 'set-card';

  const head = document.createElement('div');
  head.className = 'set-card-head';

  const badge = document.createElement('span');
  badge.className = 'set-badge';
  badge.appendChild(sectionIcon(title));
  head.appendChild(badge);

  const heading = document.createElement('h2');
  heading.className = 'set-card-title';
  heading.textContent = title;
  head.appendChild(heading);

  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'set-card-body';
  rows.forEach((r) => body.appendChild(r));
  card.appendChild(body);
  return card;
}

// The banner at the top: what the browser has done for you this session.
function settingsSummary(state) {
  const el = document.createElement('div');
  el.className = 'set-summary';
  el.id = 'set-summary';

  const blocked = state.blocked || 0;
  el.innerHTML =
    '<div class="set-summary-glow"></div>' +
    '<div class="set-summary-row">' +
      '<div class="set-stat"><div class="set-stat-num" id="stat-trackers">' + blocked.toLocaleString() + '</div>' +
        '<div class="set-stat-label">trackers blocked</div></div>' +
      '<div class="set-stat"><div class="set-stat-num" id="stat-ads">—</div>' +
        '<div class="set-stat-label">ads blocked</div></div>' +
      '<div class="set-stat"><div class="set-stat-num" id="stat-rules">—</div>' +
        '<div class="set-stat-label">filter rules</div></div>' +
    '</div>' +
    '<div class="set-summary-note">since this browser started</div>';
  return el;
}

function openSettings() {
  openInternalTab('settings');
}

// The settings page is one long list, so a menu item that means "the
// extensions part" has to actually take you there.
function scrollToSettingsSection(title) {
  const go = () => {
    const head = Array.prototype.find.call(
      document.querySelectorAll('.set-section'),
      (el) => el.textContent === title
    );
    if (head) head.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  // The list is rebuilt asynchronously when the page opens.
  setTimeout(go, 120);
  setTimeout(go, 500);
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
document.getElementById('menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (menuOpen) closeMenu();
  else openAppMenu();
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
  const wasCollapsed = sidebar.classList.contains('collapsed');
  sidebar.classList.toggle('collapsed', collapsed);
  writePref('sidebarCollapsed', collapsed);
  if (!collapsed) {
    // Opening it is the moment the panel is worth loading, since boot no
    // longer loads one behind a closed sidebar.
    if (wasCollapsed) ensurePanelLoaded(currentApp);
    // Width changed, so anything being fitted to it needs recomputing.
    refitPanels();
  }
}

function toggleSidebar() {
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}

document.getElementById('sidebar-collapse').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
setSidebarCollapsed(readPref('sidebarCollapsed', false));

// ---------- Extensions ----------
// Electron runs an extension's content scripts and service worker but draws
// none of its interface, so the toolbar button and the popup are ours. The
// popup itself has to be a <webview>: it is a chrome-extension:// page and
// needs the real extension APIs, which only a guest on that session gets.

const extbar = document.getElementById('extbar');
const extPopup = document.getElementById('extpopup');
const extPopupView = document.getElementById('extpopup-view');
const extensionsApi = window.tabStore && window.tabStore.extensions;
let extensions = [];
let openExtensionId = null;

function closeExtensionPopup() {
  if (!openExtensionId) return;
  openExtensionId = null;
  extPopup.hidden = true;
  // Blanked rather than left loaded, so a popup is not quietly running in
  // the background with a tab's worth of privileges.
  try { extPopupView.setAttribute('src', 'about:blank'); } catch (err) {}
  Array.prototype.forEach.call(extbar.children, (b) => b.classList.remove('open'));
}

function openExtensionPopup(ext, button) {
  if (openExtensionId === ext.id) return closeExtensionPopup();
  closeExtensionPopup();
  if (!ext.id || !ext.popup) return;

  openExtensionId = ext.id;
  button.classList.add('open');

  const rect = button.getBoundingClientRect();
  extPopup.style.top = Math.round(rect.bottom + 6) + 'px';
  // Kept on screen when the button is near the right edge.
  const width = 380;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  extPopup.style.left = Math.round(left) + 'px';
  extPopup.style.width = width + 'px';

  extPopupView.setAttribute('src', 'chrome-extension://' + ext.id + '/' + ext.popup.replace(/^\/+/, ''));
  extPopup.hidden = false;
}

function renderExtensionBar() {
  extbar.textContent = '';
  // Extensions are loaded into the ordinary session only, so in a private
  // window there is nothing behind these buttons -- and a popup would be
  // forced onto the private partition, where the extension does not exist.
  const shown = windowInfo.isPrivate
    ? []
    : extensions.filter((e) => e.enabled && e.id && e.hasAction);

  shown.forEach((ext) => {
    const button = document.createElement('button');
    button.className = 'extbtn';
    button.title = ext.title || ext.name;

    if (ext.icon) {
      const img = document.createElement('img');
      img.src = ext.icon;
      img.alt = '';
      button.appendChild(img);
    } else {
      // No icon in the manifest: fall back to the initial, which at least
      // tells two extensions apart.
      const letter = document.createElement('span');
      letter.className = 'extletter';
      letter.textContent = (ext.name || '?').trim().charAt(0).toUpperCase();
      button.appendChild(letter);
    }

    if (ext.popup) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        openExtensionPopup(ext, button);
      });
    } else {
      // No popup declared. Chrome would fire an onClicked event here, which
      // Electron does not deliver, so say so rather than do nothing.
      button.classList.add('inert');
      button.title = ext.name + ' has no popup to open.';
    }

    extbar.appendChild(button);
  });

  extbar.hidden = shown.length === 0;
}

async function refreshExtensions() {
  if (!extensionsApi) return;
  try {
    extensions = await extensionsApi.list();
  } catch (err) {
    extensions = [];
  }
  renderExtensionBar();
  if (typeof renderExtensionSettings === 'function') renderExtensionSettings();
}

// Clicking anywhere else, or leaving the window, closes the popup -- the
// same way the menu behaves.
document.addEventListener('mousedown', (e) => {
  if (!openExtensionId) return;
  if (extPopup.contains(e.target) || extbar.contains(e.target)) return;
  closeExtensionPopup();
});
window.addEventListener('blur', closeExtensionPopup);

if (extensionsApi && extensionsApi.onChange) extensionsApi.onChange(refreshExtensions);
if (window.tabStore && window.tabStore.adblock) {
  window.tabStore.adblock.onChange(() => refreshAdblockStatus());
}

// The extensions list on the settings page. Rebuilt in place rather than by
// re-rendering the whole page, so toggling one does not scroll you away.
function extensionsRow() {
  const wrap = document.createElement('div');
  wrap.className = 'set-extensions';
  wrap.id = 'set-extensions';

  const list = document.createElement('div');
  list.className = 'extlist';
  list.id = 'extlist';
  wrap.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'set-actions';

  const note = document.createElement('div');
  note.className = 'set-hint extnote';

  const say = (text, bad) => {
    note.textContent = text;
    note.classList.toggle('bad', !!bad);
  };

  const addFolder = document.createElement('button');
  addFolder.className = 'overlay-btn';
  addFolder.textContent = 'Add a folder\u2026';
  addFolder.title = 'For an extension you are writing. It runs from where it sits, so you can edit and reload it.';
  addFolder.addEventListener('click', async () => {
    const r = await extensionsApi.addFolder();
    if (r && r.error) say(r.error, true);
    else if (r && r.ok) say('Added.');
  });

  const addCrx = document.createElement('button');
  addCrx.className = 'overlay-btn';
  addCrx.textContent = 'Add a .crx file\u2026';
  addCrx.title = 'A Chrome Web Store extension you have already downloaded.';
  addCrx.addEventListener('click', async () => {
    say('Unpacking\u2026');
    const r = await extensionsApi.addCrx();
    if (r && r.error) say(r.error, true);
    else if (r && r.ok) say('Added.');
    else say('');
  });

  actions.appendChild(addFolder);
  actions.appendChild(addCrx);
  wrap.appendChild(actions);

  // The store's own Install button only talks to Chrome, so the way in is
  // to browse the store normally and paste the address of the page.
  const storeHint = document.createElement('div');
  storeHint.className = 'set-hint';
  storeHint.style.padding = '14px 10px 0 10px';
  storeHint.textContent = 'Or paste a Chrome Web Store link. Its own Install button only works in Chrome, so browse the store in a tab, copy the address of the extension’s page, and paste it here.';
  wrap.appendChild(storeHint);

  const storeRow = document.createElement('div');
  storeRow.className = 'set-actions storerow';

  const storeInput = document.createElement('input');
  storeInput.className = 'set-input';
  storeInput.id = 'store-url-input';
  storeInput.type = 'text';
  storeInput.spellcheck = false;
  storeInput.placeholder = 'https://chromewebstore.google.com/detail/…';

  const storeAdd = document.createElement('button');
  storeAdd.className = 'overlay-btn';
  storeAdd.textContent = 'Install';

  const install = async () => {
    const text = storeInput.value.trim();
    if (!text) return;
    storeAdd.disabled = true;
    say('Downloading…');
    const r = await extensionsApi.addStore(text);
    storeAdd.disabled = false;
    if (r && r.ok) {
      storeInput.value = '';
      say('Installed ' + (r.name || 'it') + '.');
    } else {
      say((r && r.error) || 'That did not work.', true);
    }
  };

  storeAdd.addEventListener('click', install);
  storeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); install(); }
  });

  const openStore = document.createElement('button');
  openStore.className = 'overlay-btn';
  openStore.textContent = 'Browse the store';
  openStore.addEventListener('click', () => {
    createTab('https://chromewebstore.google.com/category/extensions');
  });

  storeRow.appendChild(storeInput);
  storeRow.appendChild(storeAdd);
  storeRow.appendChild(openStore);
  wrap.appendChild(storeRow);

  wrap.appendChild(note);

  return wrap;
}

function renderExtensionSettings() {
  const list = document.getElementById('extlist');
  if (!list) return;
  list.textContent = '';

  if (!extensions.length) {
    const empty = document.createElement('div');
    empty.className = 'set-hint';
    empty.style.padding = '4px 10px 10px 10px';
    empty.textContent = 'Nothing installed yet.';
    list.appendChild(empty);
    return;
  }

  extensions.forEach((ext) => {
    const row = document.createElement('div');
    row.className = 'extrow' + (ext.enabled ? '' : ' off') + (ext.broken ? ' broken' : '');

    const icon = document.createElement('div');
    icon.className = 'exticon';
    if (ext.icon) {
      const img = document.createElement('img');
      img.src = ext.icon;
      img.alt = '';
      icon.appendChild(img);
    } else {
      icon.textContent = (ext.name || '?').trim().charAt(0).toUpperCase();
    }
    row.appendChild(icon);

    const main = document.createElement('div');
    main.className = 'extmain';

    const name = document.createElement('div');
    name.className = 'extname';
    name.textContent = ext.name + (ext.version ? '  ' + ext.version : '');
    main.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'set-hint';
    desc.textContent = ext.description || '';
    main.appendChild(desc);

    const where = document.createElement('div');
    where.className = 'extpath';
    // Folder extensions show their path because that is the thing you are
    // editing; unpacked ones live in the profile and the path is noise.
    where.textContent = ext.owned ? 'Unpacked into this browser\u2019s profile' : ext.path;
    main.appendChild(where);

    row.appendChild(main);

    const buttons = document.createElement('div');
    buttons.className = 'extbtns';

    if (!ext.owned) {
      const reload = document.createElement('button');
      reload.className = 'overlay-btn';
      reload.textContent = 'Reload';
      reload.title = 'Load it again from disk, after you have changed the code.';
      reload.addEventListener('click', async () => {
        reload.textContent = 'Reloading\u2026';
        const r = await extensionsApi.reload(ext.path);
        reload.textContent = 'Reload';
        const note = document.querySelector('.extnote');
        if (note) {
          note.textContent = r && r.error ? r.error : 'Reloaded ' + ext.name + '.';
          note.classList.toggle('bad', !!(r && r.error));
        }
      });
      buttons.appendChild(reload);
    }

    const toggle = document.createElement('button');
    toggle.className = 'overlay-btn';
    toggle.textContent = ext.enabled ? 'Turn off' : 'Turn on';
    toggle.addEventListener('click', () => extensionsApi.toggle(ext.path, !ext.enabled));
    buttons.appendChild(toggle);

    const remove = document.createElement('button');
    remove.className = 'overlay-btn danger';
    remove.textContent = 'Remove';
    remove.title = ext.owned
      ? 'Deletes the unpacked copy from this browser.'
      : 'Unregisters it. Your folder is left alone.';
    remove.addEventListener('click', () => extensionsApi.remove(ext.path));
    buttons.appendChild(remove);

    row.appendChild(buttons);
    list.appendChild(row);
  });
}

// ---------- Feeding the new tab page ----------

// That page has no preload and its policy blocks network calls, so it
// cannot fetch anything itself. executeJavaScript is the one way across --
// the same route the webdriver mask already uses.
async function sendNewsTo(webview) {
  const api = window.tabStore && window.tabStore.news;
  if (!api) return;
  try {
    if (!isNewTabUrl(webview.getURL())) return;
    const payload = await api.get();
    await webview.executeJavaScript(
      'window.__setNews && window.__setNews(' + JSON.stringify(payload) + ')'
    );
  } catch (err) {
    // Offline, or the tab went away mid-fetch. The page just shows no feed.
  }
}

// ---------- Fullscreen, printing, devtools ----------

// Lifting the page out of the layout and hiding the chrome, plus taking the
// OS window fullscreen so a video really does fill the screen.
function setPageFullscreen(tab, on) {
  if (!tab.webview) return;
  document.body.classList.toggle('fullscreen', on);
  tab.webview.classList.toggle('fs', on);
  window.tabStore?.setWindowFullscreen?.(on);
  if (on) closeMenu();
}

function printPage() {
  const tab = activeTab();
  if (!tab || !tab.webview) return;
  try {
    const printing = tab.webview.print();
    if (printing && typeof printing.catch === 'function') printing.catch(() => {});
  } catch (err) {
    // No printer, or the page refused; nothing useful to do about it here.
  }
}

function openTabDevTools() {
  const tab = activeTab();
  if (!tab || !tab.webview) return;
  try { tab.webview.openDevTools(); } catch (err) {}
}

// ---------- Menus ----------
// Both the toolbar menu and every right-click menu are drawn here, in the
// browser's own styling. Electron's native menu is a grey Windows menu that
// looks like it belongs to a different program.

const menuEl = document.getElementById('menu');
let menuOpen = false;

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  menuEl.classList.remove('open');
  menuEl.innerHTML = '';
  dragShield.classList.remove('active', 'plain');
}

function showMenu(items, x, y, options) {
  const opts = options || {};
  closeMenu();
  menuEl.innerHTML = '';

  items.forEach((item) => {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menuEl.appendChild(sep);
      return;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'menu-item' + (item.danger ? ' danger' : '');
    row.setAttribute('role', 'menuitem');
    if (item.enabled === false) row.disabled = true;

    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.label;
    row.appendChild(label);

    if (item.accel) {
      const accel = document.createElement('span');
      accel.className = 'menu-accel';
      accel.textContent = item.accel;
      row.appendChild(accel);
    }

    row.addEventListener('click', () => {
      closeMenu();
      if (item.click) item.click();
    });
    menuEl.appendChild(row);
  });

  // Shown at the origin first so it can be measured, then moved to where it
  // actually fits -- a menu opened near an edge has to come back inside.
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  menuEl.classList.add('open');
  menuOpen = true;

  // A click meant to dismiss the menu usually lands on a page, which is its
  // own renderer and never tells this window. The shield catches it.
  dragShield.classList.add('active', 'plain');

  const rect = menuEl.getBoundingClientRect();
  const wantLeft = opts.anchorRight ? x - rect.width : x;
  const left = Math.max(6, Math.min(wantLeft, window.innerWidth - rect.width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6));
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';

  const first = menuEl.querySelector('.menu-item:not(:disabled)');
  if (first) first.focus();
}

dragShield.addEventListener('mousedown', () => closeMenu());
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

function copyText(text) {
  if (text) window.tabStore?.clipboardWrite?.(String(text));
}

// ---------- The toolbar menu ----------

function openAppMenu() {
  const anchor = document.getElementById('menu-btn').getBoundingClientRect();
  showMenu([
    { label: 'Settings', accel: 'Ctrl+,', click: openSettings },
    {
      label: 'Extensions',
      // Same page, but findable: nobody thinks to look under Settings for
      // the thing they want to install.
      click: () => { openSettings(); scrollToSettingsSection('Extensions'); }
    },
    { label: 'Inside Aurora', click: () => openInternalTab('guide') },
    { type: 'separator' },
    { label: 'History', accel: 'Ctrl+H', click: toggleHistory },
    { label: 'Downloads', accel: 'Ctrl+J', click: toggleDownloads },
    { type: 'separator' },
    { label: 'Sign out of all sites\u2026', danger: true, click: () => window.tabStore?.clearData('signout') },
    { label: 'Clear cache', click: () => window.tabStore?.clearData('cache') },
    { label: 'Clear browsing history\u2026', danger: true, click: () => window.tabStore?.clearData('history') }
  ], anchor.right, anchor.bottom + 6, { anchorRight: true });
}

// ---------- Right-click menus ----------

// main.js sends the id of the webContents that was clicked; this finds the
// element it belongs to, which is what the menu gets positioned over.
function webviewById(wcId) {
  const all = tabs.map((t) => t.webview).filter(Boolean).concat(Object.values(sbPanels));
  return all.find((wv) => {
    try {
      return wv.getWebContentsId() === wcId;
    } catch (err) {
      return false;   // not attached yet
    }
  }) || null;
}

// Click coordinates arrive in the page's own pixels, so a zoomed panel
// needs them scaled or the menu lands away from the pointer.
function zoomOf(wv) {
  try {
    const z = wv.getZoomFactor();
    return typeof z === 'number' && z > 0 ? z : 1;
  } catch (err) {
    return 1;
  }
}

function contextItemsFor(wv, p) {
  const items = [];
  const call = (fn) => { try { fn(); } catch (err) {} };

  if (p.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => createTab(p.linkURL) });
    items.push({ label: 'Copy link address', click: () => copyText(p.linkURL) });
    items.push({ label: 'Bookmark link', click: () => toggleBookmark(p.linkURL) });
    items.push({ type: 'separator' });
  }

  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Open image in new tab', click: () => createTab(p.srcURL) });
    items.push({ label: 'Copy image', click: () => call(() => wv.copyImageAt(p.x, p.y)) });
    items.push({ label: 'Copy image address', click: () => copyText(p.srcURL) });
    items.push({ type: 'separator' });
  }

  if (p.isEditable) {
    items.push({ label: 'Undo', accel: 'Ctrl+Z', enabled: p.editFlags.canUndo, click: () => call(() => wv.undo()) });
    items.push({ label: 'Redo', accel: 'Ctrl+Y', enabled: p.editFlags.canRedo, click: () => call(() => wv.redo()) });
    items.push({ type: 'separator' });
    items.push({ label: 'Cut', accel: 'Ctrl+X', enabled: p.editFlags.canCut, click: () => call(() => wv.cut()) });
    items.push({ label: 'Copy', accel: 'Ctrl+C', enabled: p.editFlags.canCopy, click: () => call(() => wv.copy()) });
    items.push({ label: 'Paste', accel: 'Ctrl+V', enabled: p.editFlags.canPaste, click: () => call(() => wv.paste()) });
    items.push({ type: 'separator' });
    items.push({ label: 'Select all', accel: 'Ctrl+A', click: () => call(() => wv.selectAll()) });
  } else if (p.selectionText) {
    items.push({ label: 'Copy', accel: 'Ctrl+C', click: () => call(() => wv.copy()) });
    const short = p.selectionText.length > 26
      ? p.selectionText.slice(0, 26) + '\u2026'
      : p.selectionText;
    items.push({
      label: 'Search Google for "' + short + '"',
      click: () => createTab('https://www.google.com/search?q=' + encodeURIComponent(p.selectionText))
    });
    items.push({ type: 'separator' });
    items.push({ label: 'Select all', accel: 'Ctrl+A', click: () => call(() => wv.selectAll()) });
  } else if (!p.linkURL && p.mediaType !== 'image') {
    let back = false;
    let forward = false;
    try { back = wv.canGoBack(); forward = wv.canGoForward(); } catch (err) {}
    items.push({ label: 'Back', enabled: back, click: () => call(() => wv.goBack()) });
    items.push({ label: 'Forward', enabled: forward, click: () => call(() => wv.goForward()) });
    items.push({ label: 'Reload', accel: 'Ctrl+R', click: () => call(() => wv.reload()) });
    items.push({ type: 'separator' });
    items.push({ label: 'Copy page address', click: () => call(() => copyText(wv.getURL())) });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Inspect element', click: () => call(() => wv.inspectElement(p.x, p.y)) });
  return items;
}

window.tabStore?.onContextMenu?.((payload) => {
  const p = payload && payload.params;
  if (!p) return;

  const wv = webviewById(payload.wcId);

  if (!wv) {
    // The click was on the shell rather than a page. Work out what it landed
    // on: this is also how right-clicking a tab is handled, rather than a DOM
    // listener, which would fire alongside this one and open two menus.
    const under = document.elementFromPoint(p.x, p.y);
    const tabEl = under && under.closest ? under.closest('.tab') : null;
    const tab = tabEl ? tabs.find((t) => t.tabEl === tabEl) : null;

    if (tab) {
      showMenu([
        { label: tab.pinned ? 'Unpin tab' : 'Pin tab', click: () => togglePin(tab) },
        { label: 'Duplicate tab', click: () => duplicateTab(tab) },
        { type: 'separator' },
        { label: 'Close tab', accel: 'Ctrl+W', click: () => closeTab(tab.id) },
        {
          label: 'Close other tabs',
          enabled: tabs.filter((t) => !t.pinned || t.id === tab.id).length > 1,
          click: () => closeOtherTabs(tab.id)
        }
      ], p.x, p.y);
      return;
    }

    // Settings, the guide, or the chrome itself: no webview to act on.
    const selected = String(window.getSelection() || '').trim();
    if (!selected) return;
    showMenu([{ label: 'Copy', accel: 'Ctrl+C', click: () => copyText(selected) }], p.x, p.y);
    return;
  }

  const rect = wv.getBoundingClientRect();
  const zoom = zoomOf(wv);
  showMenu(contextItemsFor(wv, p), rect.left + p.x * zoom, rect.top + p.y * zoom);
});

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
  escape: () => { closeMenu(); closeFind(); closeHistory(); closeDownloads(); },
  'next-tab': () => cycleTab(1),
  'prev-tab': () => cycleTab(-1),
  'zoom-in': () => nudgeTabZoom(0.1),
  'zoom-out': () => nudgeTabZoom(-0.1),
  'zoom-reset': () => nudgeTabZoom(0),
  print: printPage,
  'new-window': () => window.tabStore?.newWindow?.(false),
  'new-private-window': () => window.tabStore?.newWindow?.(true),
  devtools: openTabDevTools
};

function runShortcut(name) {
  const fn = SHORTCUTS[name];
  if (fn) fn();
}

window.tabStore?.onShortcut?.(runShortcut);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); closeFind(); closeHistory(); closeDownloads(); return; }

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
  else if (key === 'p') name = 'print';
  else if (key === 'n') name = e.shiftKey ? 'new-private-window' : 'new-window';
  else if (key === 'i' && e.shiftKey) name = 'devtools';
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
  try {
    windowInfo = await window.tabStore.windowInfo();
  } catch (err) {
    windowInfo = { isPrimary: true, isPrivate: false };
  }
  document.body.classList.toggle('private', !!windowInfo.isPrivate);

  let saved = null;
  try {
    saved = await window.tabStore.load();
  } catch (err) {
    saved = null;
  }

  // A second window, or a private one, starts empty rather than cloning
  // whatever the first window had open.
  if (!windowInfo.isPrimary || windowInfo.isPrivate) saved = null;

  if (Array.isArray(saved) && saved.length > 0) {
    // Only the tab you were last looking at loads now; the rest fill in
    // when you click them. Entries used to be plain strings, so both shapes
    // are accepted.
    saved.forEach((entry, i) => {
      const url = typeof entry === 'string' ? entry : (entry && entry.url);
      const pinned = typeof entry === 'object' && entry ? !!entry.pinned : false;
      if (!url) return;

      const kind = internalKindOf(url);
      if (kind) {
        createTab(null, { internal: kind, silent: true });
        return;
      }
      const clean = isNewTabUrl(url) ? 'newtab.html' : url;
      createTab(clean, { defer: i !== 0, silent: true, pinned });
    });
    reflowTabs();
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
  await refreshExtensions();

  // The sidebar's first panel waits for the shell to go idle, so it never
  // competes with the page you actually opened the browser to see -- and it
  // is skipped entirely while the sidebar is collapsed. Loading Gmail behind
  // a closed sidebar bought nothing and cost a real page load, which is also
  // how a Google sign-in page ended up running unattended at every launch.
  if (!sidebar.classList.contains('collapsed')) {
    const whenIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 250));
    whenIdle(() => ensurePanelLoaded(currentApp));
  }
})();
