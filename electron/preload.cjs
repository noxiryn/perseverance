/* Perseverance — preload. Exposes a minimal, explicit API to the renderer (contextIsolation on, sandboxed). */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

function on(channel, cb) {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function isData(d) {
  return typeof d === 'string' || d instanceof ArrayBuffer || ArrayBuffer.isView(d);
}

function checkPath(p) {
  if (typeof p !== 'string' || !p) throw new TypeError('path must be a non-empty string');
}

function checkData(d) {
  if (!isData(d)) throw new TypeError('data must be an ArrayBuffer or a string');
}

function deliver(listeners, value) {
  for (const cb of [...listeners]) {
    try {
      cb(value);
    } catch (e) {
      console.error(e);
    }
  }
}

// Files opened from the OS can arrive before the UI subscribes (cold start from an Explorer
// double-click): queue them until the first onOpenFile listener exists.
const openQueue = [];
const openListeners = new Set();
let flushScheduled = false;
function flushOpen() {
  flushScheduled = false;
  while (openQueue.length && openListeners.size) deliver(openListeners, openQueue.shift());
}
ipcRenderer.on('desktop:open-file', (_e, file) => {
  openQueue.push(file);
  if (openListeners.size) flushOpen();
});

// Close requests are acknowledged immediately: the main process offers a force quit when the page is
// hung (no ack) and closes right away when nothing listens.
const closeListeners = new Set();
ipcRenderer.on('desktop:close-requested', () => {
  ipcRenderer.send('desktop:close-ack', closeListeners.size > 0);
  deliver(closeListeners, undefined);
});

// Sandboxed preloads cannot require local files; the main process passes the version via argv.
let version = 'dev';
const vArg = process.argv.find((a) => a.startsWith('--app-version='));
if (vArg && /^[\w.+-]{1,40}$/.test(vArg.split('=')[1])) version = vArg.split('=')[1];

function sanitizeOpenOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return { title: typeof o.title === 'string' ? o.title : undefined, filters: Array.isArray(o.filters) ? o.filters : undefined, multiple: o.multiple === true };
}

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  version,
  openFiles: (opts) => ipcRenderer.invoke('desktop:open-files', sanitizeOpenOpts(opts)),
  saveFile: (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    checkData(o.data);
    return ipcRenderer.invoke('desktop:save-file', {
      title: typeof o.title === 'string' ? o.title : undefined,
      defaultPath: typeof o.defaultPath === 'string' ? o.defaultPath : undefined,
      filters: Array.isArray(o.filters) ? o.filters : undefined,
      data: o.data,
    });
  },
  writeFile: (p, data) => {
    checkPath(p);
    checkData(data);
    return ipcRenderer.invoke('desktop:write-file', p, data);
  },
  readFile: (p) => {
    checkPath(p);
    return ipcRenderer.invoke('desktop:read-file', p);
  },
  userDataPath: () => ipcRenderer.invoke('desktop:user-data'),
  isMaximized: () => ipcRenderer.invoke('desktop:is-maximized'),
  showItemInFolder: (p) => {
    if (typeof p === 'string') ipcRenderer.send('desktop:show-item', p);
  },
  openExternal: (url) => {
    if (typeof url === 'string') ipcRenderer.send('desktop:open-external', url);
  },
  setTitle: (t) => ipcRenderer.send('desktop:set-title', String(t)),
  setDocumentEdited: (v) => ipcRenderer.send('desktop:set-edited', !!v),
  confirmClose: (ok) => ipcRenderer.send('desktop:confirm-close', !!ok),
  minimize: () => ipcRenderer.send('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.send('desktop:toggle-maximize'),
  close: () => ipcRenderer.send('desktop:close'),
  setZoomFactor: (f) => {
    const z = Math.max(0.5, Math.min(2, Number(f) || 1));
    webFrame.setZoomFactor(z);
    // The native caption buttons (titleBarOverlay) follow the title bar's zoomed height.
    ipcRenderer.send('desktop:zoom-changed', z);
  },
  onOpenFile: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function');
    openListeners.add(cb);
    if (openQueue.length && !flushScheduled) {
      flushScheduled = true;
      setTimeout(flushOpen, 0);
    }
    return () => openListeners.delete(cb);
  },
  onCloseRequested: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('callback must be a function');
    closeListeners.add(cb);
    return () => closeListeners.delete(cb);
  },
  onMaximizeChange: (cb) => on('desktop:maximize', cb),
});
