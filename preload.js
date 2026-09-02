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
  }
});
