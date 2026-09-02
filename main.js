const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// A realistic desktop Chrome user-agent. Google's sign-in flow inspects the
// user-agent and refuses to work with one it doesn't recognise, so this is
// the session-wide default. The renderer overrides it per sidebar panel --
// Gmail, Calendar and Drive are asked to identify as a phone so Google
// serves their responsive layout instead of the desktop one.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const tabsFile = path.join(app.getPath('userData'), 'tabs.json');

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
  mainWindow = createWindow();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (updateReadyToInstall) {
    autoUpdater.quitAndInstall();
  } else {
    app.quit();
  }
});
