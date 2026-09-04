const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between web pages and Node: saving/restoring your tab
// list, and being told when something asked to open a URL in a new window
// so the renderer can turn it into a tab. Nothing else from Node or
// Electron is exposed to any page (including Google's), by design.
contextBridge.exposeInMainWorld('tabStore', {
  save: (urls) => ipcRenderer.invoke('save-tabs', urls),
  load: () => ipcRenderer.invoke('load-tabs'),
  // Only the URL string crosses over -- never the event object, which
  // would hand the page a reference back into IPC.
  onOpenUrl: (callback) => {
    ipcRenderer.on('open-url', (event, url) => callback(url));
  },
  // Shortcuts pressed while a page had focus, replayed from main.
  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (event, name) => callback(name));
  },
  history: {
    add: (url, title) => ipcRenderer.invoke('history-add', url, title),
    query: (text, limit) => ipcRenderer.invoke('history-query', text, limit),
    remove: (url) => ipcRenderer.invoke('history-remove', url),
    clear: () => ipcRenderer.invoke('history-clear')
  },
  showAppMenu: () => ipcRenderer.invoke('app-menu'),
  clearData: (kind) => ipcRenderer.invoke('clear-data', kind),
  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    set: (key, value) => ipcRenderer.invoke('settings-set', key, value),
    reset: () => ipcRenderer.invoke('settings-reset')
  },
  onSessionCleared: (callback) => {
    ipcRenderer.on('session-cleared', () => callback());
  },
  downloads: {
    list: () => ipcRenderer.invoke('downloads-list'),
    open: (id) => ipcRenderer.invoke('download-open', id),
    show: (id) => ipcRenderer.invoke('download-show', id),
    cancel: (id) => ipcRenderer.invoke('download-cancel', id),
    clear: () => ipcRenderer.invoke('downloads-clear'),
    onChange: (callback) => {
      ipcRenderer.on('downloads-changed', (event, list) => callback(list));
    }
  }
});
