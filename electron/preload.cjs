/* Perseverance — preload. Exposes a minimal, explicit API to the renderer (contextIsolation on). */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

function on(channel, cb) {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Sandboxed preloads cannot require local files; the main process passes the version via argv.
let version = 'dev';
const vArg = process.argv.find((a) => a.startsWith('--app-version='));
if (vArg) version = vArg.split('=')[1];

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  version,
  openFiles: (opts) => ipcRenderer.invoke('desktop:open-files', opts),
  saveFile: (opts) => ipcRenderer.invoke('desktop:save-file', opts),
  writeFile: (p, data) => ipcRenderer.invoke('desktop:write-file', p, data),
  readFile: (p) => ipcRenderer.invoke('desktop:read-file', p),
  userDataPath: () => ipcRenderer.invoke('desktop:user-data'),
  isMaximized: () => ipcRenderer.invoke('desktop:is-maximized'),
  showItemInFolder: (p) => ipcRenderer.send('desktop:show-item', p),
  openExternal: (url) => ipcRenderer.send('desktop:open-external', url),
  setTitle: (t) => ipcRenderer.send('desktop:set-title', t),
  setDocumentEdited: (v) => ipcRenderer.send('desktop:set-edited', v),
  confirmClose: (ok) => ipcRenderer.send('desktop:confirm-close', ok),
  minimize: () => ipcRenderer.send('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.send('desktop:toggle-maximize'),
  close: () => ipcRenderer.send('desktop:close'),
  setZoomFactor: (f) => webFrame.setZoomFactor(Math.max(0.5, Math.min(2, Number(f) || 1))),
  onOpenFile: (cb) => on('desktop:open-file', cb),
  onCloseRequested: (cb) => on('desktop:close-requested', cb),
  onMaximizeChange: (cb) => on('desktop:maximize', cb),
});
