const { app, BrowserWindow, session, ipcMain, Menu, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Built from the Chromium actually inside this Electron, never hardcoded.
// Google serves Gmail and Calendar a stripped-down legacy interface to any
// browser it considers out of date, and a pinned version string silently
// becomes out of date -- a literal "Chrome/128" was still being sent long
// after Chrome 128 was ancient, which is exactly how you end up staring at
// an old Gmail. Claiming a version the engine cannot back would be worse
// than claiming an old one, so this tracks the engine.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36';

const tabsFile = path.join(app.getPath('userData'), 'tabs.json');
const historyFile = path.join(app.getPath('userData'), 'history.json');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const bookmarksFile = path.join(app.getPath('userData'), 'bookmarks.json');

let mainWindow = null;
let mainSession = null;
let updateReadyToInstall = false;

// ---------- Security policy ----------

// Popups are denied everywhere except Google's sign-in, which genuinely
// needs one. Anything else that tries to open a window is routed into a
// normal tab instead, where it is visible, inspectable and closable.
const POPUP_ALLOWLIST = [
  /^https:\/\/accounts\.google\.com\//i,
  /^https:\/\/accounts\.youtube\.com\//i
];

// Third-party tracking, analytics and ad hosts, refused at the network
// layer. This is a privacy measure first, but it is also the single
// biggest available win for page-load speed: on a typical page most of the
// wait is other people's analytics. Trim this list if a site you actually
// need misbehaves.
const BLOCKED_HOSTS = [
  'doubleclick.net', '2mdn.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adservice.google.com', 'analytics.google.com',
  'connect.facebook.net', 'facebook.net', 'ads-twitter.com',
  'scorecardresearch.com', 'quantserve.com', 'moatads.com',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'criteo.com',
  'taboola.com', 'outbrain.com', 'demdex.net', 'everesttech.net', 'bluekai.com',
  'hotjar.com', 'mixpanel.com', 'amplitude.com', 'segment.io', 'fullstory.com',
  'branch.io', 'appsflyer.com', 'adsrvr.org', 'casalemedia.com'
];

// This runs for every single request the browser makes -- a busy page is
// hundreds of them -- so it has to stay cheap. `new URL()` was doing a full
// parse per request just to read the host; a regex is enough.
function hostOf(url) {
  // The (?:...@)? skips any user:pass@ before the host. Without it a
  // tracker evades the blocklist just by embedding userinfo in the URL.
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// Verdicts are cached per host: a page pulls repeatedly from the same
// handful of domains, so the list scan should happen once each, not once
// per request.
const trackerVerdicts = new Map();

function isTracker(url) {
  const host = hostOf(url);
  if (!host) return false;

  let verdict = trackerVerdicts.get(host);
  if (verdict === undefined) {
    verdict = BLOCKED_HOSTS.some((bad) => host === bad || host.endsWith('.' + bad));
    if (trackerVerdicts.size > 5000) trackerVerdicts.clear();
    trackerVerdicts.set(host, verdict);
  }
  return verdict;
}

// Plain http:// is upgraded to https:// for top-level navigation. Loopback
// is exempt so local dev servers still work.
function shouldUpgrade(details) {
  if (details.resourceType !== 'mainFrame') return false;
  if (!details.url.startsWith('http://')) return false;
  const host = hostOf(details.url);
  return host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.localhost');
}

function applyNetworkPolicy(sess) {
  syncRequestHandler(sess);
  syncHeaderHandler(sess);

  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permissionAllowed(permission));
  });

  // The request handler above covers prompts; this covers the synchronous
  // checks a page makes to see whether it already holds a permission.
  sess.setPermissionCheckHandler((webContents, permission) => {
    return permissionAllowed(permission);
  });
}

// ---------- Settings ----------
// Every protection below is a switch rather than a hardcoded policy, and a
// switch that is off costs nothing: the request handlers it needs are torn
// down entirely instead of running and deciding to do nothing.

const DEFAULT_SETTINGS = {
  blockTrackers: true,
  httpsOnly: true,
  stripTrackingParams: true,
  sendDoNotTrack: true,
  trimReferrer: false,        // off by default: breaks hotlink-protected images
  blockWebRTCLeak: true,
  allowNotifications: true,
  allowClipboard: true,
  clearHistoryOnExit: false,
  showBookmarksBar: true
};

let settings = Object.assign({}, DEFAULT_SETTINGS);
let blockedCount = 0;

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    // Only keys we already know, and only booleans: a stale or hand-edited
    // file cannot introduce anything the rest of this file does not expect.
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      if (typeof raw[key] === 'boolean') settings[key] = raw[key];
    });
  } catch (err) {
    // No file yet, or unreadable: defaults stand.
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// Campaign and click identifiers. Stripping these changes nothing about the
// page you get; they exist to tie your visit back to wherever you came from.
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'twclid', 'igshid',
  'mc_eid', 'mc_cid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_id', 'oly_enc_id',
  'yclid', 'ttclid', 'ref_src', 'si'
];

function stripTrackingParams(url) {
  if (url.indexOf('?') === -1) return null;   // nothing to strip, skip the parse
  try {
    const u = new URL(url);
    let removed = false;
    for (const param of TRACKING_PARAMS) {
      if (u.searchParams.has(param)) {
        u.searchParams.delete(param);
        removed = true;
      }
    }
    // Returning null when nothing changed matters: redirecting a request to
    // its own URL would loop forever.
    return removed ? u.toString() : null;
  } catch (err) {
    return null;
  }
}

function permissionAllowed(permission) {
  if (permission === 'notifications') return settings.allowNotifications;
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
    return settings.allowClipboard;
  }
  return false;   // geolocation, camera, microphone, MIDI, USB, serial...
}

// Without this a page can use WebRTC to learn your machine's local network
// address even through a VPN. The policy confines it to the public one.
function applyWebRTCPolicy(contents) {
  try {
    contents.setWebRTCIPHandlingPolicy(
      settings.blockWebRTCLeak ? 'default_public_interface_only' : 'default'
    );
  } catch (err) {
    // Not every webContents supports it; not worth failing over.
  }
}

function syncRequestHandler(sess) {
  const wanted = settings.blockTrackers || settings.httpsOnly || settings.stripTrackingParams;
  if (!wanted) return sess.webRequest.onBeforeRequest(null);

  sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (settings.blockTrackers && isTracker(details.url)) {
      blockedCount++;
      return callback({ cancel: true });
    }
    if (settings.httpsOnly && shouldUpgrade(details)) {
      return callback({ redirectURL: details.url.replace(/^http:/i, 'https:') });
    }
    if (settings.stripTrackingParams && details.resourceType === 'mainFrame') {
      const cleaned = stripTrackingParams(details.url);
      if (cleaned) return callback({ redirectURL: cleaned });
    }
    callback({});
  });
}

function syncHeaderHandler(sess) {
  const wanted = settings.sendDoNotTrack || settings.trimReferrer;
  if (!wanted) return sess.webRequest.onBeforeSendHeaders(null);

  sess.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = details.requestHeaders;

    if (settings.sendDoNotTrack) {
      headers.DNT = '1';
      headers['Sec-GPC'] = '1';   // the one with actual legal weight in some places
    }

    if (settings.trimReferrer && headers.Referer) {
      const from = hostOf(headers.Referer);
      const to = hostOf(details.url);
      if (from && to && from !== to) {
        // Cross-site, so send the origin and not the exact page you were on.
        try {
          headers.Referer = new URL(headers.Referer).origin + '/';
        } catch (err) {
          delete headers.Referer;
        }
      }
    }

    callback({ requestHeaders: headers });
  });
}

function applySettings() {
  if (!mainSession) return;
  syncRequestHandler(mainSession);
  syncHeaderHandler(mainSession);
  require('electron').webContents.getAllWebContents().forEach(applyWebRTCPolicy);
}

ipcMain.handle('settings-get', () => ({
  values: Object.assign({}, settings),
  defaults: Object.assign({}, DEFAULT_SETTINGS),
  blocked: blockedCount
}));

ipcMain.handle('settings-set', (event, key, value) => {
  // Renderer input: accept only known keys with boolean values.
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return null;
  if (typeof value !== 'boolean') return null;
  settings[key] = value;
  saveSettings();
  applySettings();
  return Object.assign({}, settings);
});

ipcMain.handle('clear-data', (event, kind) => {
  if (kind !== 'signout' && kind !== 'cache' && kind !== 'history') return;
  return clearData(kind);
});

ipcMain.handle('settings-reset', () => {
  settings = Object.assign({}, DEFAULT_SETTINGS);
  saveSettings();
  applySettings();
  return Object.assign({}, settings);
});

// ---------- Bookmarks ----------

const BOOKMARK_LIMIT = 500;
let bookmarks = [];      // newest first: { url, title, addedAt }

// A favicon ends up in an <img src>, so only the two shapes the page's
// CSP will actually load are kept. Anything else becomes no icon at all
// rather than a broken request.
function cleanIcon(icon) {
  if (typeof icon !== 'string') return '';
  if (icon.length > 8192) return '';
  return /^(https:\/\/|data:image\/)/i.test(icon) ? icon : '';
}

function loadBookmarks() {
  try {
    const raw = JSON.parse(fs.readFileSync(bookmarksFile, 'utf-8'));
    if (!Array.isArray(raw)) return;
    // Same rule as settings: only entries shaped the way this code expects.
    bookmarks = raw
      .filter((b) => b && typeof b.url === 'string' && /^https?:\/\//i.test(b.url))
      .map((b) => ({
        url: b.url,
        title: typeof b.title === 'string' ? b.title : b.url,
        icon: cleanIcon(b.icon),
        addedAt: typeof b.addedAt === 'number' ? b.addedAt : Date.now()
      }))
      .slice(0, BOOKMARK_LIMIT);
  } catch (err) {
    bookmarks = [];
  }
}

function saveBookmarks() {
  try {
    fs.writeFileSync(bookmarksFile, JSON.stringify(bookmarks, null, 2));
  } catch (err) {
    console.error('Failed to save bookmarks:', err);
  }
}

ipcMain.handle('bookmarks-list', () => bookmarks.slice());

ipcMain.handle('bookmarks-add', (event, url, title, icon) => {
  // Only real web pages: never the new-tab page or an internal page.
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return bookmarks.slice();
  // Already bookmarked: this is the chance to fill in an icon it was saved
  // without, which is how bookmarks made before icons existed get one.
  const existing = bookmarks.find((b) => b.url === url);
  if (existing) {
    const found = cleanIcon(icon);
    if (found && !existing.icon) {
      existing.icon = found;
      saveBookmarks();
    }
    return bookmarks.slice();
  }

  if (!bookmarks.some((b) => b.url === url)) {
    bookmarks.unshift({
      url,
      title: (typeof title === 'string' && title.trim()) ? title.trim() : url,
      icon: cleanIcon(icon),
      addedAt: Date.now()
    });
    if (bookmarks.length > BOOKMARK_LIMIT) bookmarks.length = BOOKMARK_LIMIT;
    saveBookmarks();
  }
  return bookmarks.slice();
});

ipcMain.handle('bookmarks-remove', (event, url) => {
  bookmarks = bookmarks.filter((b) => b.url !== url);
  saveBookmarks();
  return bookmarks.slice();
});

// ---------- Right-click menu ----------
// Electron ships no context menu whatsoever, so without this there is no
// copy, no paste, and no open-in-new-tab anywhere in the browser.

function canGo(contents, direction) {
  try {
    const nav = contents.navigationHistory;
    if (nav) return direction === 'back' ? nav.canGoBack() : nav.canGoForward();
    return direction === 'back' ? contents.canGoBack() : contents.canGoForward();
  } catch (err) {
    return false;
  }
}

function openInTab(url) {
  if (mainWindow && /^https?:\/\//i.test(url)) mainWindow.webContents.send('open-url', url);
}

function buildContextMenu(contents, params) {
  const items = [];
  const sel = (params.selectionText || '').trim();

  if (params.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => openInTab(params.linkURL) });
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    items.push({
      label: 'Bookmark link',
      click: () => {
        if (mainWindow) mainWindow.webContents.send('bookmark-url', params.linkURL);
      }
    });
    items.push({ type: 'separator' });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Open image in new tab', click: () => openInTab(params.srcURL) });
    items.push({ label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) });
    items.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
    items.push({ type: 'separator' });
  }

  if (params.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
                { type: 'separator' }, { role: 'selectAll' });
  } else if (sel) {
    items.push({ role: 'copy' });
    const short = sel.length > 30 ? sel.slice(0, 30) + '...' : sel;
    items.push({
      label: `Search Google for "${short}"`,
      click: () => openInTab('https://www.google.com/search?q=' + encodeURIComponent(sel))
    });
    items.push({ type: 'separator' }, { role: 'selectAll' });
  } else if (!params.linkURL && params.mediaType !== 'image') {
    items.push({ label: 'Back', enabled: canGo(contents, 'back'), click: () => contents.goBack() });
    items.push({ label: 'Forward', enabled: canGo(contents, 'forward'), click: () => contents.goForward() });
    items.push({ label: 'Reload', click: () => contents.reload() });
    items.push({ type: 'separator' });
    items.push({ label: 'Copy page address', click: () => clipboard.writeText(contents.getURL()) });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) });

  return Menu.buildFromTemplate(items);
}

// Applied to every webContents the app ever creates, including each
// <webview>. This is the part that matters most: `webviewTag` is on, so
// without it a compromised page could try to attach a webview of its own
// carrying Node privileges.
function hardenWebContents(contents) {
  applyWebRTCPolicy(contents);

  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    // Keep every panel and tab on the one session we control.
    params.partition = 'persist:main';
  });

  // Keyboard events inside a <webview> never reach the shell page, so
  // without this every shortcut would die the moment you clicked into a
  // page. Matched keys are swallowed here and replayed to the renderer.
  if (contents.getType() === 'webview') {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !mainWindow) return;
      const mod = input.control || input.meta;
      const key = (input.key || '').toLowerCase();

      if (key === 'escape') {
        // Forwarded but not swallowed -- pages use Escape too.
        mainWindow.webContents.send('shortcut', 'escape');
        return;
      }
      if (!mod) return;

      let name = null;
      if (key === 't') name = input.shift ? 'reopen-tab' : 'new-tab';
      else if (key === 'w') name = 'close-tab';
      else if (key === 'l') name = 'focus-address';
      else if (key === 'f') name = 'find';
      else if (key === 'h') name = 'history';
      else if (key === 'j') name = 'downloads';
      else if (key === ',') name = 'settings';
      else if (key === 'd') name = 'bookmark';
      else if (key === 'tab') name = input.shift ? 'prev-tab' : 'next-tab';
      else if (key === '=' || key === '+') name = 'zoom-in';
      else if (key === '-') name = 'zoom-out';
      else if (key === '0') name = 'zoom-reset';
      if (!name) return;

      event.preventDefault();
      mainWindow.webContents.send('shortcut', name);
    });
  }

  contents.on('context-menu', (event, params) => {
    buildContextMenu(contents, params).popup();
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (POPUP_ALLOWLIST.some((re) => re.test(url))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
        }
      };
    }
    // Everything else becomes a tab. The old renderer listened for the
    // webview 'new-window' event to do this, which Electron removed in
    // v22 -- so until now, target=_blank links quietly did nothing at all.
    if (/^https?:\/\//i.test(url) && mainWindow) {
      mainWindow.webContents.send('open-url', url);
    }
    return { action: 'deny' };
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1E1B18',
    icon: path.join(__dirname, 'icon.ico'),
    // Painting only once the shell is ready removes the white flash and
    // the several hundred ms of empty window frame on startup.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');

  // Every webview uses partition="persist:main", which maps to this same
  // session. Signing into Google once keeps you signed in everywhere in the
  // app, across restarts, just like a normal browser profile.
  mainSession = session.fromPartition('persist:main');
  mainSession.setUserAgent(CHROME_UA);
  applyNetworkPolicy(mainSession);
  mainSession.on('will-download', handleDownload);

  // The shell window itself must never navigate away from index.html; if
  // something drives it elsewhere, that is the entire UI gone.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  return win;
}

// ---------- Tab session persistence (renderer asks main to read/write) ----------

ipcMain.handle('save-tabs', (event, urls) => {
  try {
    fs.writeFileSync(tabsFile, JSON.stringify(urls));
  } catch (err) {
    console.error('Failed to save tabs:', err);
  }
});

ipcMain.handle('load-tabs', () => {
  try {
    return JSON.parse(fs.readFileSync(tabsFile, 'utf-8'));
  } catch (err) {
    return null;
  }
});

// ---------- Browsing history ----------
// Kept in memory and flushed to disk on a timer. A busy session would
// otherwise rewrite the whole file on every single navigation.

const HISTORY_LIMIT = 5000;
let history = [];        // newest first: { url, title, visitedAt, visits }
let historyDirty = false;

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
    if (Array.isArray(raw)) history = raw;
  } catch (err) {
    history = [];
  }
}

function flushHistory() {
  if (!historyDirty) return;
  historyDirty = false;
  try {
    fs.writeFileSync(historyFile, JSON.stringify(history));
  } catch (err) {
    console.error('Failed to save history:', err);
  }
}

function addHistory(url, title) {
  // Only real web pages: no file://, no about:blank, no new-tab page.
  if (!/^https?:\/\//i.test(url)) return;

  const now = Date.now();
  const idx = history.findIndex((h) => h.url === url);

  if (idx !== -1) {
    const entry = history.splice(idx, 1)[0];
    // A page's title arrives after its navigation, so the same URL gets
    // recorded twice within a moment. Don't let that count as two visits.
    if (now - (entry.visitedAt || 0) > 5000) entry.visits = (entry.visits || 1) + 1;
    entry.visitedAt = now;
    if (title) entry.title = title;
    history.unshift(entry);
  } else {
    history.unshift({ url, title: title || url, visitedAt: now, visits: 1 });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  }
  historyDirty = true;
}

// Ranks a history entry against what has been typed. Matching the start of
// the hostname counts for most: typing "git" almost always means the site
// you know, not some page with "git" buried in its title.
function scoreEntry(entry, needle) {
  const url = entry.url.toLowerCase();
  const title = (entry.title || '').toLowerCase();
  const inUrl = url.indexOf(needle);
  const inTitle = title.indexOf(needle);
  if (inUrl === -1 && inTitle === -1) return -1;

  const host = url.replace(/^https?:\/\/(www\.)?/, '');
  let score = 0;
  if (host.startsWith(needle)) score += 100;
  else if (inUrl === 0) score += 60;
  else if (inUrl > 0) score += 20;
  if (inTitle === 0) score += 30;
  else if (inTitle > 0) score += 10;

  score += Math.min(entry.visits || 1, 20);
  const ageDays = (Date.now() - (entry.visitedAt || 0)) / 86400000;
  score += Math.max(0, 15 - ageDays);
  return score;
}

function queryHistory(text, limit) {
  const max = limit || 8;
  const needle = (text || '').trim().toLowerCase();
  if (!needle) return history.slice(0, max);
  return history
    .map((entry) => ({ entry, score: scoreEntry(entry, needle) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((row) => row.entry);
}

ipcMain.handle('history-add', (event, url, title) => addHistory(url, title));
ipcMain.handle('history-query', (event, text, limit) => queryHistory(text, limit));
ipcMain.handle('history-remove', (event, url) => {
  history = history.filter((h) => h.url !== url);
  historyDirty = true;
});
ipcMain.handle('history-clear', () => {
  history = [];
  historyDirty = true;
  flushHistory();
});

// ---------- Downloads ----------
// Files save straight to the Downloads folder, the way a normal browser
// behaves, with progress reported to the renderer.

const downloads = [];          // newest first
const downloadItems = new Map();
let downloadSeq = 1;

// Opening one of these would execute it. The browser will reveal them in
// Explorer instead, so running one is always a deliberate act outside the
// browser rather than one click inside it.
const RISKY_EXTENSIONS = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js',
  '.jar', '.reg', '.hta', '.cpl', '.msc', '.lnk', '.pif', '.dll'
];

function isRisky(filePath) {
  return RISKY_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

// Never silently overwrite something already in Downloads.
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, base + ' (' + n + ')' + ext);
    n += 1;
  }
  return candidate;
}

function publicDownload(d) {
  return {
    id: d.id,
    filename: d.filename,
    savePath: d.savePath,
    url: d.url,
    total: d.total,
    received: d.received,
    state: d.state,
    risky: isRisky(d.savePath)
  };
}

function broadcastDownloads() {
  if (mainWindow) {
    mainWindow.webContents.send('downloads-changed', downloads.map(publicDownload));
  }
}

function handleDownload(event, item) {
  const savePath = uniquePath(app.getPath('downloads'), item.getFilename());
  item.setSavePath(savePath);

  const record = {
    id: downloadSeq++,
    filename: path.basename(savePath),
    savePath,
    url: item.getURL(),
    total: item.getTotalBytes(),
    received: 0,
    state: 'progressing'
  };
  downloads.unshift(record);
  if (downloads.length > 100) downloads.length = 100;
  downloadItems.set(record.id, item);
  broadcastDownloads();

  item.on('updated', (e, state) => {
    record.received = item.getReceivedBytes();
    record.total = item.getTotalBytes();
    record.state = state === 'interrupted'
      ? 'interrupted'
      : (item.isPaused() ? 'paused' : 'progressing');
    broadcastDownloads();
  });

  item.once('done', (e, state) => {
    record.received = item.getReceivedBytes();
    record.state = state;   // completed | cancelled | interrupted
    downloadItems.delete(record.id);
    broadcastDownloads();
  });
}

function findDownload(id) {
  return downloads.find((d) => d.id === id);
}

ipcMain.handle('downloads-list', () => downloads.map(publicDownload));

ipcMain.handle('download-open', (event, id) => {
  const d = findDownload(id);
  if (!d || d.state !== 'completed') return false;
  // Executables are revealed, never launched, no matter what was clicked.
  if (isRisky(d.savePath)) {
    shell.showItemInFolder(d.savePath);
    return false;
  }
  shell.openPath(d.savePath);
  return true;
});

ipcMain.handle('download-show', (event, id) => {
  const d = findDownload(id);
  if (d) shell.showItemInFolder(d.savePath);
});

ipcMain.handle('download-cancel', (event, id) => {
  const item = downloadItems.get(id);
  if (item) item.cancel();
});

ipcMain.handle('downloads-clear', () => {
  for (let i = downloads.length - 1; i >= 0; i--) {
    if (downloads[i].state !== 'progressing' && downloads[i].state !== 'paused') {
      downloads.splice(i, 1);
    }
  }
  broadcastDownloads();
  return downloads.map(publicDownload);
});

// ---------- App menu ----------
// The one place to clear things. Every destructive item confirms first and
// says plainly what it will and will not remove.

function sendShortcut(name) {
  if (mainWindow) mainWindow.webContents.send('shortcut', name);
}

async function clearData(kind) {
  const sess = session.fromPartition('persist:main');

  if (kind === 'cache') {
    await sess.clearCache();
    return;
  }

  const spec = kind === 'signout'
    ? {
        message: 'Sign out of all sites?',
        detail: 'Cookies and logins for Google, YouTube and Claude will be '
          + 'removed from this browser, because all panels share one session. '
          + 'Your history, saved tabs and preferences are kept, and nothing '
          + 'changes on the accounts themselves.',
        button: 'Sign out'
      }
    : {
        message: 'Clear browsing history?',
        detail: 'Every recorded visit is deleted, and the address bar will '
          + 'stop suggesting them. This does not sign you out of anything.',
        button: 'Clear history'
      };

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [spec.button, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: spec.message,
    detail: spec.detail
  });
  if (response !== 0) return;

  if (kind === 'signout') {
    await sess.clearStorageData();
    await sess.clearCache();
    if (mainWindow) mainWindow.webContents.send('session-cleared');
  } else {
    history = [];
    historyDirty = true;
    flushHistory();
  }
}

ipcMain.handle('app-menu', () => {
  Menu.buildFromTemplate([
    { label: 'Settings', accelerator: 'Ctrl+,', click: () => sendShortcut('settings') },
    { type: 'separator' },
    { label: 'History', accelerator: 'Ctrl+H', click: () => sendShortcut('history') },
    { label: 'Downloads', accelerator: 'Ctrl+J', click: () => sendShortcut('downloads') },
    { type: 'separator' },
    { label: 'Sign out of all sites\u2026', click: () => clearData('signout') },
    { label: 'Clear cache', click: () => clearData('cache') },
    { label: 'Clear browsing history\u2026', click: () => clearData('history') }
  ]).popup();
});

// ---------- Silent background auto-update ----------
// Checks the GitHub releases of ChaosWolfLord/mybrowser on launch and every
// few hours. Updates download quietly in the background. Rather than
// yanking the app out from under you mid-session, an update is applied the
// next time you close the window, not the instant it finishes downloading.

// Running from a source checkout, the checkout itself is the shipping
// vehicle: pull in the background and the new code runs next launch. This
// exists because Smart App Control on this machine blocks building the
// installer at all, so there is no packaged artefact to update.
function updateFromGit() {
  const repo = __dirname;
  if (!fs.existsSync(path.join(repo, '.git'))) return;

  // --ff-only on purpose: if the checkout has diverged or has local edits,
  // the pull fails loudly instead of touching your work.
  execFile('git', ['pull', '--ff-only'], { cwd: repo, windowsHide: true, timeout: 60000 },
    (err, stdout, stderr) => {
      if (err) {
        console.error('Update check failed:', String(stderr || err.message).trim());
        return;
      }
      const out = String(stdout);
      if (/Already up to date/i.test(out)) return;
      console.log('Updated from git. The new version runs next time you open the browser.');

      // Dependencies only need reinstalling when the manifest actually moved.
      if (/package(-lock)?\.json/.test(out)) {
        execFile('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'],
          { cwd: repo, windowsHide: true, shell: true, timeout: 5 * 60 * 1000 },
          (e) => { if (e) console.error('Dependency update failed:', e.message); });
      }
    });
}

function setupAutoUpdate() {
  if (!app.isPackaged) {
    // Deferred off the startup path, same as the packaged check below.
    setTimeout(updateFromGit, 30 * 1000);
    setInterval(updateFromGit, 4 * 60 * 60 * 1000);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we control exactly when, below

  autoUpdater.on('update-downloaded', () => {
    updateReadyToInstall = true;
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  // Deferred off the startup path: this used to fire while the window was
  // still painting, competing for the network with the pages you actually
  // wanted to see.
  setTimeout(() => autoUpdater.checkForUpdates(), 30 * 1000);
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
}

app.on('web-contents-created', (event, contents) => hardenWebContents(contents));

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // Never bypass a bad certificate, for any host, for any reason.
  event.preventDefault();
  callback(false);
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.chaoswolflord.mybrowser');
  loadSettings();
  loadBookmarks();
  loadHistory();
  setInterval(flushHistory, 15 * 1000);
  mainWindow = createWindow();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('before-quit', () => {
  if (settings.clearHistoryOnExit) history = [];
  historyDirty = true;
  flushHistory();
});

app.on('window-all-closed', () => {
  flushHistory();
  if (process.platform === 'darwin') return;
  if (updateReadyToInstall) {
    autoUpdater.quitAndInstall();
  } else {
    app.quit();
  }
});
