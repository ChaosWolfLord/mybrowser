const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// A realistic desktop Chrome user-agent. Google's sign-in flow looks at the
// user-agent string and will refuse to work with an unrecognized one, so
// every webview in this app is set to present as regular desktop Chrome.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const tabsFile = path.join(app.getPath('userData'), 'tabs.json');

let mainWindow = null;
let updateReadyToInstall = false;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1E1B18',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  win.loadFile('index.html');

  // Every webview in the renderer uses partition="persist:main", which maps
  // to this same session. Signing into Google once keeps you signed in
  // everywhere in the app, across restarts, just like a normal browser profile.
  const mainSession = session.fromPartition('persist:main');
  mainSession.setUserAgent(CHROME_UA);

  mainSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['notifications', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
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
// Checks your GitHub releases (chaoswolf/my-browser) on launch and every few
// hours. Updates download quietly in the background. Rather than yanking the
// app out from under you mid-session, the update is applied the next time
// you naturally close the window, not the instant it finishes downloading.

function setupAutoUpdate() {
  if (!app.isPackaged) return; // skip in `npm start` dev mode — there's no build to update

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we control exactly when, below

  autoUpdater.on('update-downloaded', () => {
    updateReadyToInstall = true;
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000); // every 4 hours
}

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
