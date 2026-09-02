const { app, BrowserWindow, session, ipcMain, Menu, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
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

let mainWindow = null;
let updateReadyToInstall = false;

// ---------- Security policy ----------

// Anything absent from this list is refused outright: geolocation, camera,
// microphone, MIDI, USB, serial. Nothing this browser is for needs them,
// and a page that asks for them is a page worth being suspicious of.
const ALLOWED_PERMISSIONS = [
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write'
];

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

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (err) {
    return '';
  }
}

function isTracker(url) {
  const host = hostOf(url);
  if (!host) return false;
  return BLOCKED_HOSTS.some((bad) => host === bad || host.endsWith('.' + bad));
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
  sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isTracker(details.url)) return callback({ cancel: true });
    if (shouldUpgrade(details)) {
      return callback({ redirectURL: details.url.replace(/^http:/i, 'https:') });
    }
    callback({});
  });

  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });

  // The request handler above covers prompts; this covers the synchronous
  // checks a page makes to see whether it already holds a permission.
  sess.setPermissionCheckHandler((webContents, permission) => {
    return ALLOWED_PERMISSIONS.includes(permission);
  });
}

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
  const mainSession = session.fromPartition('persist:main');
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

function setupAutoUpdate() {
  if (!app.isPackaged) return; // skip in `npm start` -- there's no build to update

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
  loadHistory();
  setInterval(flushHistory, 15 * 1000);
  mainWindow = createWindow();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('before-quit', flushHistory);

app.on('window-all-closed', () => {
  flushHistory();
  if (process.platform === 'darwin') return;
  if (updateReadyToInstall) {
    autoUpdater.quitAndInstall();
  } else {
    app.quit();
  }
});
