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
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  setWindowFullscreen: (on) => ipcRenderer.invoke('window-fullscreen', on),
  newWindow: (isPrivate) => ipcRenderer.invoke('new-window', { private: !!isPrivate }),
  windowInfo: () => ipcRenderer.invoke('window-info'),
  extensions: {
    list: () => ipcRenderer.invoke('extensions-list'),
    addFolder: () => ipcRenderer.invoke('extensions-add-folder'),
    addCrx: () => ipcRenderer.invoke('extensions-add-crx'),
    reload: (path) => ipcRenderer.invoke('extensions-reload', path),
    toggle: (path, on) => ipcRenderer.invoke('extensions-toggle', path, on),
    remove: (path) => ipcRenderer.invoke('extensions-remove', path),
    onChange: (fn) => ipcRenderer.on('extensions-changed', () => fn())
  },
  news: {
    get: () => ipcRenderer.invoke('news-get'),
    setTopics: (topics) => ipcRenderer.invoke('news-topics-set', topics)
  },
  // Where the user right-clicked, so the renderer can draw the menu there.
  onContextMenu: (callback) => {
    ipcRenderer.on('context-menu', (event, payload) => callback(payload));
  },
  clearData: (kind) => ipcRenderer.invoke('clear-data', kind),
  bookmarks: {
    list: () => ipcRenderer.invoke('bookmarks-list'),
    add: (url, title, icon) => ipcRenderer.invoke('bookmarks-add', url, title, icon),
    remove: (url) => ipcRenderer.invoke('bookmarks-remove', url),
    onBookmarkUrl: (callback) => {
      ipcRenderer.on('bookmark-url', (event, url) => callback(url));
    }
  },
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
