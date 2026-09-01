const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between web pages and Node: saving/restoring your tab
// list between sessions. Nothing else from Node or Electron is exposed to
// any page (including Google's), by design.
contextBridge.exposeInMainWorld('tabStore', {
  save: (urls) => ipcRenderer.invoke('save-tabs', urls),
  load: () => ipcRenderer.invoke('load-tabs')
});
