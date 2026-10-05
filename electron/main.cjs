/* Perseverance — Electron main process. */
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const PROJECT_EXT = 'pgfx';

/** @type {BrowserWindow | null} */
let win = null;
/** Files requested before the window was ready (Explorer double-click / CLI args). */
const pendingOpen = [];
let allowClose = false;

nativeTheme.themeSource = 'dark';

function fileArgs(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && /\.(pgfx|png|jpe?g|webp|gif|bmp|psd)$/i.test(a));
}

async function readOpened(p) {
  const buf = await fs.readFile(p);
  return { path: p, name: path.basename(p), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

async function sendOpen(p) {
  if (!win || win.webContents.isLoading()) {
    pendingOpen.push(p);
    return;
  }
  try {
    win.webContents.send('desktop:open-file', await readOpened(p));
  } catch (e) {
    console.error('open failed', e);
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#121212',
    title: 'Perseverance',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    // Native window buttons drawn over our custom title bar (Windows/Linux). macOS keeps traffic lights.
    ...(isMac
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : { titleBarOverlay: { color: '#161616', symbolColor: '#bdbdbd', height: 32 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (!isDev) win.maximize();
  });

  win.on('maximize', () => win.webContents.send('desktop:maximize', true));
  win.on('unmaximize', () => win.webContents.send('desktop:maximize', false));

  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('desktop:close-requested');
  });

  win.webContents.on('did-finish-load', async () => {
    while (pendingOpen.length) await sendOpen(pendingOpen.shift());
  });

  // Never navigate away from the app; open external links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(process.env.VITE_DEV_SERVER_URL) : url.startsWith('file://');
    if (!allowed) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/* ---------------- IPC ---------------- */

function toBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(new Uint8Array(data));
}

ipcMain.handle('desktop:open-files', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: opts.filters,
    properties: ['openFile', ...(opts.multiple ? ['multiSelections'] : [])],
  });
  if (res.canceled) return [];
  return Promise.all(res.filePaths.map(readOpened));
});

ipcMain.handle('desktop:save-file', async (_e, opts) => {
  const res = await dialog.showSaveDialog(win, {
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, toBuffer(opts.data));
  app.addRecentDocument(res.filePath);
  return res.filePath;
});

ipcMain.handle('desktop:write-file', async (_e, p, data) => {
  await fs.writeFile(p, toBuffer(data));
});

ipcMain.handle('desktop:read-file', async (_e, p) => {
  const buf = await fs.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('desktop:user-data', () => app.getPath('userData'));
ipcMain.handle('desktop:is-maximized', () => !!win && win.isMaximized());

ipcMain.on('desktop:show-item', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('desktop:open-external', (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});
ipcMain.on('desktop:set-title', (_e, t) => win && win.setTitle(String(t)));
ipcMain.on('desktop:set-edited', (_e, v) => win && win.setDocumentEdited(!!v));
ipcMain.on('desktop:confirm-close', (_e, ok) => {
  if (ok && win) {
    allowClose = true;
    win.close();
  }
});
ipcMain.on('desktop:minimize', () => win && win.minimize());
ipcMain.on('desktop:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('desktop:close', () => win && win.close());

/* ---------------- lifecycle ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    fileArgs(argv).forEach(sendOpen);
  });

  // macOS: files opened via Finder / dock
  app.on('open-file', (e, p) => {
    e.preventDefault();
    sendOpen(p);
  });

  app.whenReady().then(() => {
    // The app ships its own in-window menu bar. On macOS a minimal native menu is still needed for
    // the app menu and text-field editing (Cmd+C/V/X/A/Z inside inputs), but without accelerators
    // that steal Photoshop shortcuts (e.g. Cmd+M → Curves, Cmd+H → Extras, Cmd+W handled in-app).
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          {
            label: 'Edit',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          { label: 'Window', submenu: [{ label: 'Minimize', click: () => win && win.minimize() }, { role: 'zoom' }, { role: 'front' }] },
        ]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    // Allow the Local Font Access API (system fonts in the font picker) and clipboard reads.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      ['local-fonts', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission),
    );

    fileArgs(process.argv).forEach((p) => pendingOpen.push(p));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { PROJECT_EXT };
