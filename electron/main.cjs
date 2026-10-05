/* Perseverance — Electron main process. */
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const lib = require('./lib.cjs');

const { PROJECT_EXT, THEME } = lib;
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const isMac = process.platform === 'darwin';
const INDEX_HTML = path.join(__dirname, '..', 'dist', 'index.html');
/** The renderer must acknowledge a close request within this time, or the user is offered a force quit. */
const CLOSE_ACK_TIMEOUT_MS = Number(process.env.PERSEVERANCE_CLOSE_TIMEOUT_MS) || 4000;
const CLOSE_RETRY_TIMEOUT_MS = 10000;
/**
 * Only these permissions are ever granted, and only to the app's own page: system fonts in the font
 * picker, clipboard image paste/copy, and View ▸ Full Screen (HTML fullscreen API).
 */
const ALLOWED_PERMISSIONS = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

/** @type {BrowserWindow | null} */
let win = null;
/** Files requested before the window could receive them (Explorer double-click / CLI args / Finder). */
const pendingOpen = [];
/** @type {ReturnType<typeof lib.createLogger>} */
let log = lib.createLogger(null);
/** @type {lib.FileGrants} */
let grants = new lib.FileGrants(null);
let windowStateFile = null;

/* Close guard state. */
let forceClose = false; // the next 'close' goes through (renderer agreed or the user forced it)
let quitRequested = false; // app.quit() (Cmd+Q / installer) is waiting on the close guard
let rendererEdited = false; // any unsaved document (reported by the renderer)
let rendererGone = false; // the render process crashed / was killed
let expectedKill = false; // we killed a hung renderer ourselves (reload), don't report it as a crash
const closeReq = { pending: false, acked: false, timer: null, fallbackShown: false };
/** One native prompt at a time (close fallback / crash / unresponsive). @type {AbortController | null} */
let promptAbort = null;
let crashTimes = [];

nativeTheme.themeSource = 'dark';
// Every renderer is sandboxed (also covers windows created by future code). Skipped when the user had
// to start the app with --no-sandbox (Linux without user namespaces, root): enableSandbox() would
// force the sandbox on helper processes again and the app could not start at all. The window still
// sets `sandbox: true` itself.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('com.noxiryn.perseverance');

/* ---------------- crash logging ---------------- */

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

/* ---------------- helpers ---------------- */

function liveWindow() {
  return win && !win.isDestroyed() ? win : null;
}

function isAppUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    if (isDev) {
      const dev = new URL(process.env.VITE_DEV_SERVER_URL);
      return new URL(url).origin === dev.origin;
    }
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    return lib.pathKey(fileURLToPath(u)) === lib.pathKey(INDEX_HTML);
  } catch {
    return false;
  }
}

/** IPC must come from the app page in our window (not an iframe, not a navigated-away page). */
function trusted(e) {
  const w = liveWindow();
  if (!w || e.sender !== w.webContents) return false;
  const frame = e.senderFrame;
  return !!frame && frame === w.webContents.mainFrame && isAppUrl(frame.url);
}

function denied(what) {
  const err = new Error(`ENOTGRANTED: ${what}`);
  err.code = 'ENOTGRANTED';
  return err;
}

function str(v, max = 1000) {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function openExternalSafe(url) {
  if (lib.isExternalUrl(url)) shell.openExternal(url).catch((e) => log.warn('openExternal failed', e));
  else log.warn('blocked external url', String(url).slice(0, 200));
}

/** Show a native prompt that a newer prompt / renderer answer can dismiss. Resolves -1 when dismissed. */
async function prompt(options) {
  promptAbort?.abort();
  const ac = new AbortController();
  promptAbort = ac;
  try {
    const w = liveWindow();
    const opts = { noLink: true, ...options, signal: ac.signal };
    const { response } = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return ac.signal.aborted ? -1 : response;
  } catch (e) {
    log.warn('prompt failed', e);
    return -1;
  } finally {
    if (promptAbort === ac) promptAbort = null;
  }
}

function dismissPrompt() {
  promptAbort?.abort();
  promptAbort = null;
}

/* ---------------- files ---------------- */

async function readOpened(p) {
  const buf = await fs.readFile(p);
  // Projects (by extension or content) may be saved back in place; images/PSDs are only read.
  const write = path.extname(p).slice(1).toLowerCase() === PROJECT_EXT || lib.hasPgfxMagic(buf);
  grants.grant(p, { write });
  return { path: p, name: path.basename(p), data: lib.toArrayBuffer(buf) };
}

async function sendOpen(p) {
  const w = liveWindow();
  if (!w || w.webContents.isLoading() || rendererGone) {
    if (!pendingOpen.includes(p)) pendingOpen.push(p);
    if (!w && app.isReady()) createWindow();
    return;
  }
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) throw new Error('not a file');
    w.webContents.send('desktop:open-file', await readOpened(p));
    if (path.extname(p).slice(1).toLowerCase() === PROJECT_EXT) app.addRecentDocument(p);
  } catch (e) {
    log.warn('open failed', p, e);
    void prompt({ type: 'error', title: 'Perseverance', message: 'Could not open file', detail: `${p}\n\n${(e && e.message) || e}`, buttons: ['OK'] });
  }
}

async function flushPendingOpen() {
  while (pendingOpen.length) await sendOpen(pendingOpen.shift());
}

/* ---------------- window state ---------------- */

let stateTimer = null;

function saveWindowState() {
  const w = liveWindow();
  if (!w || !windowStateFile) return;
  clearTimeout(stateTimer);
  stateTimer = null;
  const b = w.getNormalBounds();
  // Full screen is not restored (it is a temporary View mode).
  const state = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() };
  lib.atomicWriteSync(windowStateFile, JSON.stringify(state));
}

function scheduleSaveWindowState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(saveWindowState, 500);
}

/* ---------------- close guard ---------------- */

function resetClose() {
  clearTimeout(closeReq.timer);
  Object.assign(closeReq, { pending: false, acked: false, timer: null, fallbackShown: false });
}

/** Close the window (and quit when that was requested) without asking the renderer again. */
function closeNow() {
  resetClose();
  dismissPrompt();
  forceClose = true;
  const w = liveWindow();
  if (quitRequested || !w) app.quit();
  else w.close();
}

function cancelClose() {
  resetClose();
  quitRequested = false;
}

function requestClose() {
  const w = liveWindow();
  if (!w) return;
  if (rendererGone || w.webContents.isCrashed()) {
    // Nothing left to save in a dead renderer (autosave offers recovery on next launch).
    closeNow();
    return;
  }
  if (closeReq.pending) {
    w.focus();
    if (closeReq.fallbackShown || closeReq.acked) return;
    if (!closeReq.timer) void closeFallback();
    return;
  }
  closeReq.pending = true;
  closeReq.acked = false;
  w.webContents.send('desktop:close-requested');
  closeReq.timer = setTimeout(closeFallback, CLOSE_ACK_TIMEOUT_MS);
}

/** The renderer didn't acknowledge the close request: it is busy or broken. Don't trap the user. */
async function closeFallback() {
  closeReq.timer = null;
  if (!closeReq.pending || closeReq.acked) return;
  closeReq.fallbackShown = true;
  log.warn('close request not acknowledged by the renderer');
  const r = await prompt({
    type: 'warning',
    title: 'Perseverance',
    message: 'Perseverance is not responding',
    detail: rendererEdited
      ? 'The window did not answer the close request. If you quit now, unsaved changes are lost (autosave may offer to recover them on the next launch).'
      : 'The window did not answer the close request.',
    buttons: ['Wait', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
  });
  closeReq.fallbackShown = false;
  if (r === -1 || !closeReq.pending || closeReq.acked) return; // the renderer answered meanwhile
  if (r === 1) closeNow();
  else closeReq.timer = setTimeout(closeFallback, CLOSE_RETRY_TIMEOUT_MS);
}

/** The renderer is alive but has no close handler (e.g. the UI failed to start). */
async function closeUnguarded() {
  if (!rendererEdited) {
    closeNow();
    return;
  }
  const r = await prompt({
    type: 'warning',
    title: 'Perseverance',
    message: 'Quit Perseverance?',
    detail: 'The editor could not confirm your unsaved changes. If you quit now they are lost (autosave may offer to recover them on the next launch).',
    buttons: ['Cancel', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
  });
  if (r === 1) closeNow();
  else if (r === 0) cancelClose();
}

/* ---------------- crash resilience ---------------- */

async function onRenderGone(details) {
  rendererGone = true;
  resetClose();
  log.error('render process gone', details);
  if (details.reason === 'clean-exit' || forceClose || expectedKill) return;
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60000).concat(now);
  const w = liveWindow();
  if (!w) return;
  const r = await prompt({
    type: 'error',
    title: 'Perseverance',
    message: 'The editor window stopped unexpectedly',
    detail:
      `Reason: ${details.reason}${details.exitCode ? ` (code ${details.exitCode})` : ''}.` +
      (crashTimes.length > 2 ? ' This happened several times in the last minute.' : '') +
      ' Reload to continue — autosave offers to recover your documents.',
    buttons: ['Reload', 'Quit'],
    defaultId: 0,
    cancelId: 0,
  });
  if (r === 1) closeNow();
  else if (r === 0 && liveWindow()) win.webContents.reload();
}

async function onUnresponsive() {
  log.warn('renderer unresponsive');
  if (closeReq.fallbackShown) return; // the close fallback already offers "Quit Anyway"
  const r = await prompt({
    type: 'warning',
    title: 'Perseverance',
    message: 'Perseverance is not responding',
    detail: 'A long operation may still be running. You can wait, or reload the editor (autosave offers to recover your documents).',
    buttons: ['Wait', 'Reload', 'Quit'],
    defaultId: 0,
    cancelId: 0,
  });
  const w = liveWindow();
  if (!w) return;
  if (r === 1) {
    resetClose();
    expectedKill = true;
    w.webContents.forcefullyCrashRenderer();
    w.webContents.reload();
  } else if (r === 2) closeNow();
}

/* ---------------- window ---------------- */

function createWindow() {
  const displays = (() => {
    try {
      const primary = screen.getPrimaryDisplay();
      return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
    } catch {
      return [];
    }
  })();
  const saved = windowStateFile ? lib.readJsonSync(windowStateFile, null) : null;
  const bounds = lib.initialBounds(saved, displays);
  rendererGone = false;
  forceClose = false;
  resetClose();

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: lib.MIN_SIZE.width,
    minHeight: lib.MIN_SIZE.height,
    show: false,
    backgroundColor: THEME.background,
    title: 'Perseverance',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    // Native window buttons drawn over our custom title bar (Windows/Linux). macOS keeps traffic lights.
    ...(isMac
      ? { trafficLightPosition: { x: 12, y: 9 } }
      : { titleBarOverlay: { color: THEME.titleBar, symbolColor: THEME.symbols, height: lib.overlayHeight(1) } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });
  const w = win;

  w.once('ready-to-show', () => {
    // First launch: maximized (production). Afterwards: whatever the user left it as.
    const maximize = bounds.maximized ?? !isDev;
    if (maximize) w.maximize();
    w.show();
  });

  w.on('maximize', () => {
    w.webContents.send('desktop:maximize', true);
    scheduleSaveWindowState();
  });
  w.on('unmaximize', () => {
    w.webContents.send('desktop:maximize', false);
    scheduleSaveWindowState();
  });
  w.on('resize', scheduleSaveWindowState);
  w.on('move', scheduleSaveWindowState);

  w.on('close', (e) => {
    if (forceClose) {
      saveWindowState();
      return;
    }
    e.preventDefault();
    requestClose();
  });
  w.on('closed', () => {
    clearTimeout(stateTimer);
    if (win === w) win = null;
    resetClose();
    dismissPrompt();
  });

  const wc = w.webContents;
  wc.on('did-start-loading', () => {
    // A reload resets the renderer: forget half-finished close requests.
    resetClose();
  });
  wc.on('did-finish-load', () => {
    rendererGone = false;
    expectedKill = false;
    void flushPendingOpen();
  });
  wc.on('render-process-gone', (_e, details) => void onRenderGone(details));
  w.on('unresponsive', () => void onUnresponsive());
  w.on('responsive', () => {
    if (!closeReq.fallbackShown) dismissPrompt();
  });
  wc.on('preload-error', (_e, p, error) => log.error('preload error', p, error));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 (ERR_ABORTED) only means a newer navigation/reload superseded this one.
    if (isMainFrame && code !== -3) log.error('did-fail-load', code, desc, url);
  });
  let consoleLines = 0;
  wc.on('console-message', (...args) => {
    // Electron ≥35 passes one event object; older versions (event, level, message, line, source).
    const ev = args[0] ?? {};
    const level = typeof ev.level === 'string' ? ev.level : args[1] === 3 ? 'error' : String(args[1]);
    if (level !== 'error' || consoleLines >= 200) return;
    consoleLines++;
    const message = typeof ev.message === 'string' ? ev.message : args[2];
    const source = typeof ev.sourceId === 'string' ? ev.sourceId : args[4];
    const line = ev.lineNumber ?? args[3];
    log.warn('renderer console error', `${message} (${source}:${line})`);
  });

  if (isDev) w.loadURL(process.env.VITE_DEV_SERVER_URL);
  else w.loadFile(INDEX_HTML);
}

/* ---------------- web contents policy ---------------- */

app.on('web-contents-created', (_e, contents) => {
  // Never navigate away from the app; open external links in the browser.
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (lib.isExternalUrl(url)) openExternalSafe(url);
    else log.warn('blocked navigation', String(url).slice(0, 200));
  });
  contents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

/* ---------------- IPC ---------------- */

/** ipcMain.handle with sender validation. */
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw denied(`${channel} from an untrusted frame`);
    return fn(e, ...args);
  });
}

/** ipcMain.on with sender validation; malformed messages are dropped. */
function listen(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!trusted(e)) {
      log.warn('dropped IPC from untrusted frame', channel);
      return;
    }
    try {
      fn(e, ...args);
    } catch (err) {
      log.warn(`IPC ${channel} failed`, err);
    }
  });
}

function assertPath(p) {
  if (!lib.isSafeAbsPath(p)) throw new TypeError('path must be an absolute file path');
}

handle('desktop:open-files', async (_e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const res = await dialog.showOpenDialog(liveWindow(), {
    title: str(o.title, 200),
    filters: lib.sanitizeFilters(o.filters),
    properties: ['openFile', ...(o.multiple === true ? ['multiSelections'] : [])],
  });
  if (res.canceled) return [];
  const out = [];
  for (const p of res.filePaths) out.push(await readOpened(p));
  return out;
});

handle('desktop:save-file', async (_e, opts) => {
  if (!opts || typeof opts !== 'object') throw new TypeError('saveFile options required');
  const data = lib.toBuffer(opts.data); // validate before showing the dialog
  const filters = lib.sanitizeFilters(opts.filters);
  const w = liveWindow();
  const dlg = { title: str(opts.title, 200), defaultPath: str(opts.defaultPath, 32767), filters };
  const res = w ? await dialog.showSaveDialog(w, dlg) : await dialog.showSaveDialog(dlg);
  if (res.canceled || !res.filePath) return null;
  // GTK/macOS dialogs may return "name" without the filter's extension: fix it before writing.
  const target = lib.ensureExtension(res.filePath, filters);
  if (target !== res.filePath) {
    const exists = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const r = await prompt({
        type: 'question',
        title: 'Save As',
        message: `“${path.basename(target)}” already exists. Replace it?`,
        buttons: ['Cancel', 'Replace'],
        defaultId: 0,
        cancelId: 0,
      });
      if (r !== 1) return null;
    }
  }
  await lib.atomicWrite(target, data);
  grants.grant(target, { write: true });
  app.addRecentDocument(target);
  return target;
});

handle('desktop:write-file', async (_e, p, data) => {
  assertPath(p);
  const buf = lib.toBuffer(data);
  if (!grants.canWrite(p)) throw denied(`writing ${path.basename(p)} was not chosen via a dialog`);
  await lib.atomicWrite(p, buf);
  grants.grant(p, { write: true }); // refresh recency
});

handle('desktop:read-file', async (_e, p) => {
  assertPath(p);
  if (!grants.canRead(p)) {
    // Recent-file entries from before access grants existed: Perseverance projects may still be read.
    const isProject = path.extname(p).slice(1).toLowerCase() === PROJECT_EXT && (await lib.fileHasPgfxMagic(p));
    if (!isProject) throw denied(`reading ${path.basename(p)} was not chosen via a dialog`);
  }
  const buf = await fs.readFile(p);
  return lib.toArrayBuffer(buf);
});

handle('desktop:user-data', () => app.getPath('userData'));
handle('desktop:is-maximized', () => !!liveWindow() && win.isMaximized());

listen('desktop:show-item', (_e, p) => {
  if (!lib.isSafeAbsPath(p)) return;
  // Only files the user opened/saved, and the app's data folder (Help ▸ Open Data Folder).
  const userData = lib.pathKey(app.getPath('userData'));
  const k = lib.pathKey(p);
  if (grants.canRead(p) || k === userData || k.startsWith(userData + path.sep)) shell.showItemInFolder(p);
});
listen('desktop:open-external', (_e, url) => openExternalSafe(url));
listen('desktop:set-title', (_e, t) => {
  if (typeof t === 'string') win.setTitle(t.slice(0, 300));
});
listen('desktop:set-edited', (_e, v) => {
  rendererEdited = v === true;
  win.setDocumentEdited(rendererEdited);
});
listen('desktop:close-ack', (_e, handled) => {
  if (!closeReq.pending || closeReq.acked) return;
  closeReq.acked = true;
  clearTimeout(closeReq.timer);
  closeReq.timer = null;
  if (closeReq.fallbackShown) dismissPrompt();
  if (handled === false) void closeUnguarded();
});
listen('desktop:confirm-close', (_e, ok) => {
  if (typeof ok !== 'boolean' || !closeReq.pending) return;
  if (ok) closeNow();
  else cancelClose();
});
listen('desktop:zoom-changed', (_e, f) => {
  if (!isMac && typeof f === 'number' && typeof win.setTitleBarOverlay === 'function') {
    win.setTitleBarOverlay({ color: THEME.titleBar, symbolColor: THEME.symbols, height: lib.overlayHeight(f) });
  }
});
listen('desktop:minimize', () => win.minimize());
listen('desktop:toggle-maximize', () => {
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
listen('desktop:close', () => win.close());

/* ---------------- lifecycle ---------------- */

const argSkip = process.defaultApp ? 2 : 1;
const gotLock = app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() });
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, workingDirectory, additionalData) => {
    // Prefer the argv/cwd the second instance sent itself (Chromium may rewrite `argv` on Windows).
    const data = additionalData && typeof additionalData === 'object' ? additionalData : {};
    const files = Array.isArray(data.argv)
      ? lib.fileArgs(data.argv, { skip: argSkip, cwd: typeof data.cwd === 'string' ? data.cwd : workingDirectory })
      : lib.fileArgs(argv, { skip: argSkip, cwd: workingDirectory });
    log.info('second instance', files);
    const w = liveWindow();
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
    files.forEach((p) => void sendOpen(p));
  });

  // macOS: files opened via Finder / the dock (may fire before 'ready').
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (typeof p === 'string' && lib.isSafeAbsPath(p)) void sendOpen(p);
  });

  app.on('before-quit', () => {
    if (!forceClose) quitRequested = true;
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') log.warn('child process gone', details);
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    log = lib.createLogger(path.join(userData, 'logs', 'main.log'));
    grants = new lib.FileGrants(path.join(userData, 'file-access.json'));
    windowStateFile = path.join(userData, 'window-state.json');
    log.info(`start v${app.getVersion()} ${process.platform} electron ${process.versions.electron}`);

    // The app ships its own in-window menu bar. On macOS a minimal native menu is still needed for
    // the app menu and text-field editing (Cmd+C/V/X/A/Z inside inputs), but without accelerators
    // that steal Photoshop shortcuts (e.g. Cmd+M → Curves, Cmd+H → Extras, Cmd+W handled in-app).
    if (isMac) {
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
          { label: 'Window', submenu: [{ label: 'Minimize', click: () => liveWindow()?.minimize() }, { role: 'zoom' }, { role: 'front' }] },
        ]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    // Local Font Access (system fonts in the font picker) and clipboard reads — nothing else, and only
    // for the app page itself.
    const ses = session.defaultSession;
    const ownPage = (wc) => !!wc && !!liveWindow() && wc === win.webContents && isAppUrl(wc.getURL());
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission) && ownPage(wc)));
    ses.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMISSIONS.has(permission) && ownPage(wc));
    ses.setDevicePermissionHandler(() => false);

    lib.fileArgs(process.argv, { skip: argSkip }).forEach((p) => pendingOpen.push(p));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac || quitRequested) app.quit();
  });
}

module.exports = { PROJECT_EXT };
