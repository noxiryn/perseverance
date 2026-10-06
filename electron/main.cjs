/* Perseverance — Electron main process. */
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const lib = require('./lib.cjs');

const { PROJECT_EXT, THEME } = lib;
/** Vite dev server (scripts/electron-dev.cjs). Never in a packaged app, and only on this machine. */
const DEV_URL = lib.devServerUrl(process.env.VITE_DEV_SERVER_URL, app.isPackaged);
const isDev = !!DEV_URL;
const isMac = process.platform === 'darwin';
const INDEX_HTML = path.join(__dirname, '..', 'dist', 'index.html');
/** The page URL, '%', '#', '?' and non-ASCII in the install folder escaped (see lib.fileUrlOf: not loadFile). */
const INDEX_URL = lib.fileUrlOf(INDEX_HTML);
/** The only folder the page may load file:// resources from (its own bundle, inside app.asar). */
const DIST_DIR = path.dirname(INDEX_HTML);
/** The renderer must acknowledge a close request within this time, or the user is offered a force quit. */
const CLOSE_ACK_TIMEOUT_MS = Number(process.env.PERSEVERANCE_CLOSE_TIMEOUT_MS) || 4000;
const CLOSE_RETRY_TIMEOUT_MS = 10000;
/**
 * The renderer acknowledged a close request but the user clicks close again this long afterwards:
 * its unsaved-changes prompt may be lost or stuck, so a native "Quit Anyway" is offered.
 */
const REPEAT_CLOSE_MS = Number(process.env.PERSEVERANCE_REPEAT_CLOSE_MS) || 3000;
/** After the user chose to close/quit, a window that still hasn't gone away is destroyed. */
const FORCE_CLOSE_MS = 5000;
/** After we kill a hung renderer to reload it, the editor must be back within this time (else: crash prompt). */
const RELOAD_TIMEOUT_MS = Number(process.env.PERSEVERANCE_RELOAD_TIMEOUT_MS) || 15000;
/**
 * Only these permissions are ever granted, and only to the app's own page: system fonts in the font
 * picker, clipboard image paste/copy, and View ▸ Full Screen (HTML fullscreen API).
 */
const ALLOWED_PERMISSIONS = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);

/** @type {BrowserWindow | null} */
let win = null;
/** @type {ReturnType<typeof lib.createLogger>} */
let log = lib.createLogger(earlyLogFile());
/** @type {lib.FileGrants} */
let grants = new lib.FileGrants(null);
let windowStateFile = null;

/* Close guard state. */
let forceClose = false; // the next 'close' goes through (renderer agreed or the user forced it)
let quitRequested = false; // app.quit() (Cmd+Q / installer) is waiting on the close guard
let rendererEdited = false; // any unsaved document (reported by the renderer)
let rendererGone = false; // the render process crashed / was killed
let rendererReady = false; // the page finished loading and can receive 'desktop:open-file'
let expectedKill = false; // we killed a hung renderer ourselves to reload it, don't report it as a crash
let reloadTimer = null; // safety net for expectedKill: the reload must finish loading in time
/** The page's loads: a failed one shows Chromium's error page, which is not the editor (see lib.createLoadState). */
let pageLoad = lib.createLoadState();
const closeReq = { pending: false, acked: false, ackedAt: 0, timer: null, fallbackShown: false, forcing: false };
let forceTimer = null;
/** One native prompt at a time (close fallback / crash / unresponsive). @type {AbortController | null} */
let promptAbort = null;
/** What the open prompt is about ('unresponsive' is the one a recovered renderer takes back). */
let promptKind = null;
let crashTimes = [];

nativeTheme.themeSource = 'dark';
// Every renderer is sandboxed (also covers windows created by future code). Skipped when the user had
// to start the app with --no-sandbox (Linux without user namespaces, root): enableSandbox() would
// force the sandbox on helper processes again and the app could not start at all. The window still
// sets `sandbox: true` itself.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('com.noxiryn.perseverance');
// Pose Studio / model import need WebGL. Without a usable GPU (blocklisted driver, VM, remote desktop)
// Chromium no longer falls back to software WebGL unless this is set. "Unsafe" refers to exposing the
// SwiftShader JIT to untrusted web content; this window only ever runs the app's own bundle (no remote
// pages: navigation and popups are blocked, CSP script-src 'self'). Hardware GPUs are still preferred.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

/* ---------------- crash logging ---------------- */

/** userData/logs/main.log, available before 'ready' so early failures are recorded too. */
function earlyLogFile() {
  try {
    return path.join(app.getPath('userData'), 'logs', 'main.log');
  } catch {
    return null;
  }
}

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

/* ---------------- helpers ---------------- */

function liveWindow() {
  return win && !win.isDestroyed() ? win : null;
}

function isAppUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (!isDev) return lib.fileUrlIs(url, INDEX_HTML);
  try {
    return new URL(url).origin === new URL(DEV_URL).origin;
  } catch {
    return false;
  }
}

/** Load the editor page (first load, and "Try Again" after a failed load). */
function loadApp(w) {
  w.loadURL(isDev ? DEV_URL : INDEX_URL).catch(() => {
    /* reported by 'did-fail-load' */
  });
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

/** Open a link in the user's browser: only the allow-listed https pages (lib.isExternalUrl), else logged. */
function openExternalSafe(url) {
  if (lib.isExternalUrl(url)) shell.openExternal(url).catch((e) => log.warn('openExternal failed', e));
  else log.warn('blocked external url', String(url).slice(0, 200));
}

/** Show a native prompt that a newer prompt / renderer answer can dismiss. Resolves -1 when dismissed. */
async function prompt(options, kind = null) {
  promptAbort?.abort();
  const ac = new AbortController();
  promptAbort = ac;
  promptKind = kind;
  try {
    const w = liveWindow();
    const opts = { noLink: true, ...options, signal: ac.signal };
    const { response } = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
    return ac.signal.aborted ? -1 : response;
  } catch (e) {
    log.warn('prompt failed', e);
    return -1;
  } finally {
    if (promptAbort === ac) {
      promptAbort = null;
      promptKind = null;
    }
  }
}

function dismissPrompt() {
  promptAbort?.abort();
  promptAbort = null;
  promptKind = null;
}

/* ---------------- files ---------------- */

async function readOpened(p) {
  const buf = await fs.readFile(p);
  // Projects (by extension or content) may be saved back in place; images/PSDs are only read.
  const write = path.extname(p).slice(1).toLowerCase() === PROJECT_EXT || lib.hasPgfxMagic(buf);
  grants.grant(p, { write });
  return { path: p, name: path.basename(p), data: lib.toArrayBuffer(buf) };
}

/** Read a file the OS handed us and send it to the renderer (which queues it until the UI listens). */
async function deliverOpen(p) {
  const w = liveWindow();
  if (!w) return;
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

/**
 * Files requested before the page could receive them (Explorer double-click / CLI args / Finder) wait
 * here until 'did-finish-load'. Readiness is our own flag, not `webContents.isLoading()`: that can still
 * be true inside 'did-finish-load', which used to re-queue the file in a tight loop and starve the main
 * process (a cold start with a file argument never finished loading).
 */
const openQueue = lib.createOpenQueue({
  ready: () => !!liveWindow() && rendererReady && !rendererGone,
  deliver: deliverOpen,
});

function sendOpen(p) {
  if (!openQueue.open(p) && !liveWindow() && app.isReady()) createWindow();
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
  Object.assign(closeReq, { pending: false, acked: false, ackedAt: 0, timer: null, fallbackShown: false, forcing: false });
}

/** Bring the window back so a prompt about unsaved work can be seen (minimized / hidden on macOS). */
function revealWindow(w) {
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
}

/** Close the window (and quit when that was requested) without asking the renderer again. */
function closeNow() {
  resetClose();
  dismissPrompt();
  forceClose = true;
  const w = liveWindow();
  if (quitRequested || !w) app.quit();
  else w.close();
  // A wedged renderer can stall the window teardown: make sure the user's decision really happens.
  clearTimeout(forceTimer);
  forceTimer = setTimeout(() => {
    forceTimer = null;
    const still = liveWindow();
    if (still && still === w) {
      log.warn('window did not close in time; destroying it');
      still.destroy();
    }
    if (quitRequested) {
      log.warn('quit did not finish in time; exiting');
      app.exit(0);
    }
  }, FORCE_CLOSE_MS);
}

function cancelClose() {
  if (closeReq.fallbackShown) dismissPrompt(); // the renderer answered: drop our "Quit Anyway" prompt
  resetClose();
  quitRequested = false;
}

function requestClose() {
  const w = liveWindow();
  if (!w) return;
  if (rendererGone || pageLoad.failed || w.webContents.isCrashed()) {
    // Nothing left to save in a dead renderer or on Chromium's error page (autosave offers recovery on
    // next launch), and nobody there would answer a close request.
    closeNow();
    return;
  }
  // The renderer's unsaved-changes prompt must be visible (e.g. closed from the taskbar while minimized).
  if (rendererEdited || closeReq.pending) revealWindow(w);
  if (closeReq.pending) {
    if (closeReq.fallbackShown || closeReq.forcing) return; // a prompt is open / "Quit Anyway" is under way
    if (closeReq.acked) {
      // Closing again while the renderer's prompt is (supposedly) open: after a moment, offer a way
      // out in case that prompt is lost or stuck. A quick double click just keeps the prompt.
      if (Date.now() - closeReq.ackedAt >= REPEAT_CLOSE_MS) void closeFallback('stuck');
      return;
    }
    if (!closeReq.timer) void closeFallback();
    return;
  }
  closeReq.pending = true;
  closeReq.acked = false;
  w.webContents.send('desktop:close-requested');
  closeReq.timer = setTimeout(closeFallback, CLOSE_ACK_TIMEOUT_MS);
}

/**
 * What a forced quit does with unsaved work. The page deletes its autosaved copies only when the user
 * picks Discard in its own prompt (src/io/autosave discardRecoveryFor); every other way out keeps them.
 * After "Quit Anyway" the page is first asked to bring them up to date (quitAnyway → flushRecovery):
 * a page that still runs (its prompt is lost or stuck, or the UI broke) writes the latest state, a busy
 * or hung one can't — then only the last regular autosave (every few minutes) is there.
 */
const RECOVERY_NOTE = {
  answering: 'If you quit now, unsaved changes are not saved to their files. Perseverance first tries to autosave them, and the next start offers to recover the autosaved copy (if autosave is on).',
  busy: 'If you quit now, unsaved changes are not saved, and changes made since the last autosave may be lost. The next start offers the last autosaved copy, if there is one.',
};

/** A page that doesn't even start writing its copies within this time is busy or hung: not waited for. */
const FLUSH_START_MS = 2000;
/** Upper bound for writing the copies of very large documents. */
const FLUSH_MAX_MS = 20000;
let flushSeq = 0;
/** @type {Map<number, { started: () => void, finish: (result: string) => void }>} */
const flushWaiters = new Map();

/**
 * Ask the page to write the autosaved copies of its unsaved documents now (preload 'desktop:flush-recovery'
 * → src/io/autosave flushRecovery). Resolves when they are stored, or when the page doesn't answer, goes
 * away or takes too long: never rejects. The result is only logged.
 */
function flushRecovery() {
  const w = liveWindow();
  if (!w || rendererGone || pageLoad.failed || w.webContents.isCrashed()) return Promise.resolve('no page');
  const wc = w.webContents;
  const id = ++flushSeq;
  return new Promise((resolve) => {
    const gone = () => finish('page gone');
    const startTimer = setTimeout(() => finish('no answer'), FLUSH_START_MS);
    const maxTimer = setTimeout(() => finish('timed out'), FLUSH_MAX_MS);
    function finish(result) {
      if (!flushWaiters.has(id)) return;
      flushWaiters.delete(id);
      clearTimeout(startTimer);
      clearTimeout(maxTimer);
      for (const ev of ['render-process-gone', 'did-start-loading', 'destroyed']) wc.removeListener(ev, gone);
      resolve(result);
    }
    flushWaiters.set(id, { started: () => clearTimeout(startTimer), finish });
    for (const ev of ['render-process-gone', 'did-start-loading', 'destroyed']) wc.once(ev, gone);
    try {
      wc.send('desktop:flush-recovery', id);
    } catch {
      finish('page gone');
    }
  });
}

/**
 * The user picked "Quit Anyway" in a native prompt: the page first brings its autosaved copies up to
 * date, then the window closes. Closing again meanwhile is ignored; the page's own answer still counts
 * (Cancel in its prompt keeps the window, Save/Discard closes it).
 */
async function quitAnyway() {
  closeReq.forcing = true;
  const result = await flushRecovery();
  log.info(`forced quit: autosaved copies ${result}`);
  // resetClose() clears `forcing` when the page answered meanwhile (cancelClose) or was reloaded; a page
  // that crashed while writing has nothing more to save.
  if (closeReq.forcing || result === 'page gone') closeNow();
}

/**
 * Native way out of the close guard. 'no-ack': the renderer didn't acknowledge the close request (busy
 * or broken). 'stuck': it did, but the user keeps trying to close while its prompt is open.
 */
async function closeFallback(reason = 'no-ack') {
  if (reason === 'no-ack') closeReq.timer = null;
  if (!closeReq.pending || closeReq.fallbackShown || closeReq.forcing) return;
  if (reason === 'no-ack' && closeReq.acked) return;
  const stuck = reason === 'stuck';
  closeReq.fallbackShown = true;
  log.warn(stuck ? 'close requested again while the unsaved-changes prompt is open' : 'close request not acknowledged by the renderer');
  const lost = rendererEdited ? ` ${stuck ? RECOVERY_NOTE.answering : RECOVERY_NOTE.busy}` : '';
  const r = await prompt({
    type: 'warning',
    title: 'Perseverance',
    message: stuck ? 'Quit without answering the editor?' : 'Perseverance is not responding',
    detail: stuck
      ? `The editor is asking what to do with unsaved changes. Answer it in the window, or quit now.${lost}`
      : `The window did not answer the close request.${lost}`,
    buttons: ['Wait', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
  });
  closeReq.fallbackShown = false;
  // Dismissed (-1) or settled meanwhile: the renderer answered or acknowledged.
  if (r === -1 || !closeReq.pending || (!stuck && closeReq.acked)) return;
  if (r === 1) void quitAnyway();
  else if (!closeReq.acked) closeReq.timer = setTimeout(closeFallback, CLOSE_RETRY_TIMEOUT_MS);
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
    detail: `The editor could not confirm your unsaved changes. ${RECOVERY_NOTE.answering}`,
    buttons: ['Cancel', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
  });
  if (r === 1) void quitAnyway();
  else if (r === 0) cancelClose();
}

/* ---------------- crash resilience ---------------- */

async function onRenderGone(details) {
  rendererGone = true;
  rendererReady = false;
  pageLoad.abandon(); // a failure of the load it was running is the crash prompt's to report
  resetClose();
  log.error('render process gone', details);
  if (forceClose) return;
  // A crash or reload abandons a pending Cmd+Q: the next plain window close must not quit the app.
  quitRequested = false;
  if (expectedKill) {
    // We killed a hung renderer to reload it (onUnresponsive). Reload only now that the old process is
    // gone: a reload started before that is lost together with the dying process (blank window).
    const w = liveWindow();
    if (w) setImmediate(() => liveWindow() === w && w.webContents.reload());
    return;
  }
  if (details.reason === 'clean-exit') return;
  await crashPrompt(details);
}

async function crashPrompt(details) {
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60000).concat(now);
  if (!liveWindow()) return;
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

function clearReloadWatch() {
  clearTimeout(reloadTimer);
  reloadTimer = null;
  expectedKill = false;
}

/** Kill a hung renderer and reload the page once its process is gone (see onRenderGone). */
function reloadHungRenderer(w) {
  resetClose();
  quitRequested = false;
  expectedKill = true;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (!expectedKill || liveWindow() !== w) return;
    // The kill or the reload didn't take: never leave a blank window without a way forward.
    expectedKill = false;
    log.warn('the editor did not come back after reloading a hung renderer');
    void crashPrompt({ reason: 'the editor did not restart' });
  }, RELOAD_TIMEOUT_MS);
  pageLoad.abandon(); // the dying page's own load may still report a failure: the reload speaks for it
  w.webContents.forcefullyCrashRenderer();
}

/**
 * The editor page itself failed to load (blocked, missing or unreadable bundle). Never leave a blank
 * window without a word: say what failed and where the log is, and offer to try again or quit.
 */
async function onLoadFailed(w, code, desc, url) {
  if (!w.isVisible()) w.show();
  const r = await prompt({
    type: 'error',
    title: 'Perseverance',
    message: 'The editor could not be loaded',
    detail:
      `${desc || 'Load failed'} (${code}) for ${String(url).slice(0, 300)}.` +
      (log.file ? `\n\nDetails are in the log file:\n${log.file}` : '') +
      '\n\nReinstalling Perseverance may help.',
    buttons: ['Try Again', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (liveWindow() !== w) return;
  if (r === 0) loadApp(w);
  else if (r === 1) closeNow();
}

async function onUnresponsive() {
  log.warn('renderer unresponsive');
  if (closeReq.fallbackShown || expectedKill) return; // already offering "Quit Anyway" / already reloading
  const r = await prompt({
    type: 'warning',
    title: 'Perseverance',
    message: 'Perseverance is not responding',
    detail: 'A long operation may still be running. You can wait, or reload the editor (autosave offers to recover your documents).',
    buttons: ['Wait', 'Reload', 'Quit'],
    defaultId: 0,
    cancelId: 0,
  }, 'unresponsive');
  const w = liveWindow();
  if (!w) return;
  if (r === 1) reloadHungRenderer(w);
  else if (r === 2) closeNow();
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
  rendererReady = false;
  pageLoad = lib.createLoadState();
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
  // Windows log off / shut down: never block it (autosave keeps unsaved work for recovery).
  // Windows asks whether it may end the session: never refuse, but let the page bring its autosaved
  // copies up to date while Windows asks the other apps (nothing waits for it).
  w.on('query-session-end', () => {
    log.info('session end requested');
    void flushRecovery();
  });
  w.on('session-end', () => {
    log.info('session end');
    forceClose = true;
    saveWindowState();
  });
  w.on('closed', () => {
    clearTimeout(stateTimer);
    clearReloadWatch();
    if (win === w) win = null;
    resetClose();
    dismissPrompt();
  });

  const wc = w.webContents;
  wc.on('did-start-loading', () => {
    // A reload resets the renderer: forget half-finished close requests (and a quit waiting on one).
    pageLoad.start();
    rendererReady = false;
    resetClose();
    quitRequested = false;
  });
  wc.on('did-finish-load', () => {
    // After a failed load this is Chromium's error page, not the editor: it can't take files (they stay
    // queued for "Try Again"), and a reload that ended here did not bring the editor back.
    if (!pageLoad.finish()) return;
    rendererGone = false;
    rendererReady = true;
    clearReloadWatch();
    void openQueue.flush();
  });
  wc.on('render-process-gone', (_e, details) => void onRenderGone(details));
  w.on('unresponsive', () => void onUnresponsive());
  w.on('responsive', () => {
    // Only the "not responding" prompt is about this (never the close fallback, a crash or a load error).
    if (promptKind === 'unresponsive') dismissPrompt();
  });
  wc.on('preload-error', (_e, p, error) => log.error('preload error', p, error));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    const failure = pageLoad.fail(code, isMainFrame);
    if (!failure) return; // a subframe, or ERR_ABORTED (a newer navigation/reload superseded this one)
    log.error('did-fail-load', code, desc, url);
    // The load of a renderer that crashed or that we are killing is reported by the crash prompt / the
    // reload that follows; a closing window needs no prompt. Anything else, also the reload after a crash
    // or a hang (a new renderer), is told here.
    if (failure !== 'report' || forceClose) return;
    clearReloadWatch(); // the hung-renderer reload got its answer: no "did not restart" prompt on top
    void onLoadFailed(w, code, desc, url);
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

  loadApp(w);
}

/* ---------------- web contents policy ---------------- */

app.on('web-contents-created', (_e, contents) => {
  // Never navigate away from the app and never open a window. A popup (window.open / target=_blank) goes
  // to the browser only when it is one of the allow-listed pages; a navigation of the app window is never
  // handed on (the app opens links with desktop.openExternal, which has the same allowlist).
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    log.warn('blocked navigation', String(url).slice(0, 200));
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
  // Only project / image / PSD types, and always at least one: ensureExtension() then guarantees the
  // written file has one of them, even when the user types "x.bat".
  const filters = lib.saveFilters(opts.filters);
  if (!filters) throw new TypeError(`saveFile can only save ${lib.SAVE_EXTS.join('/')} files`);
  const w = liveWindow();
  // The page's defaultPath never reaches the dialog as an arbitrary path (UNC probe / NTLM leak, a
  // pre-filled startup folder): a file the user chose before, or else just a file name.
  const dlg = { title: str(opts.title, 200), defaultPath: lib.saveDefaultPath(opts.defaultPath, grants), filters };
  // Projects open in the page's other tabs are never replaced: two tabs would share one file, and the
  // other tab's work — still shown as saved — would no longer be on disk.
  const busy = new Set(
    (Array.isArray(opts.busyPaths) ? opts.busyPaths.slice(0, 1000) : []).filter((p) => lib.isSafeAbsPath(p)).map((p) => lib.pathKey(p)),
  );
  let chosen = '';
  let target = '';
  for (;;) {
    const res = w ? await dialog.showSaveDialog(w, dlg) : await dialog.showSaveDialog(dlg);
    if (res.canceled || !res.filePath) return null;
    chosen = res.filePath;
    // GTK/macOS dialogs may return "name" without the filter's extension: fix it before writing.
    target = lib.ensureExtension(chosen, filters);
    if (!busy.has(lib.pathKey(target))) break;
    const r = await prompt({
      type: 'warning',
      title: 'Save As',
      message: `“${path.basename(target)}” is open in another tab.`,
      detail: 'Saving here would replace the project you have open there. Choose another name, or close that tab first.',
      buttons: ['Cancel', 'Choose Another Name'],
      defaultId: 1,
      cancelId: 0,
    });
    if (r !== 1) return null;
    // The dialog again, in the folder the user just picked, proposing "<name> copy".
    const ext = path.extname(target);
    dlg.defaultPath = path.join(path.dirname(target), `${path.basename(target, ext)} copy${ext}`);
  }
  if (target !== chosen) {
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
  // Checked before the file is touched at all: no FIFOs/devices that block the I/O pool, no network
  // paths (a UNC path would make Windows connect out and offer the user's NTLM hash).
  if (!grants.canRead(p)) throw denied(`reading ${path.basename(p)} was not chosen via a dialog`);
  const buf = await fs.readFile(p);
  return lib.toArrayBuffer(buf);
});

/** Files a drop on the window may open with their path (projects, PSDs, images: what File ▸ Open takes). */
const DROP_OPEN_EXTS = new Set([PROJECT_EXT, 'psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

/**
 * A file dropped on the window from Explorer/Finder: grant it like a file the OS handed over, so it
 * opens like File ▸ Open (Save in place, Open Recent, an open project switches to its tab). The path
 * comes from the preload (webUtils.getPathForFile on the dropped File — page script can't forge it);
 * as a second line of defence the file must be a regular local file holding exactly the bytes the page
 * read, so even a compromised renderer can't gain access to a file it doesn't already have. Returns the
 * path, or null.
 */
handle('desktop:grant-dropped', async (_e, p, data) => {
  assertPath(p); // absolute, no UNC/network paths — checked before the file is touched
  const dropped = lib.toBuffer(data);
  const st = await fs.stat(p).catch(() => null);
  if (!st || !st.isFile() || st.size !== dropped.length) return null; // no FIFOs/devices/folders
  const buf = await fs.readFile(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!buf.equals(dropped) || !(DROP_OPEN_EXTS.has(ext) || lib.hasPgfxMagic(buf))) return null;
  // The same grant as an Explorer double-click (readOpened): write access only for projects.
  grants.grant(p, { write: ext === PROJECT_EXT || lib.hasPgfxMagic(buf) });
  if (ext === PROJECT_EXT) app.addRecentDocument(p);
  return p;
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
  if (!closeReq.pending || closeReq.acked || closeReq.forcing) return;
  closeReq.acked = true;
  closeReq.ackedAt = Date.now();
  clearTimeout(closeReq.timer);
  closeReq.timer = null;
  if (closeReq.fallbackShown) dismissPrompt();
  if (handled === false) void closeUnguarded();
});
listen('desktop:flush-recovery-reply', (_e, id, stage, left) => {
  const waiter = flushWaiters.get(id);
  if (!waiter) return;
  if (stage === 'started') waiter.started();
  else if (stage === 'done') waiter.finish(left === 0 ? 'written' : left > 0 ? `written, ${left} not kept` : 'failed');
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
    } else if (app.isReady() && !files.length) {
      createWindow(); // macOS: the app is still running without a window
    }
    files.forEach((p) => sendOpen(p));
  });

  // macOS: files opened via Finder / the dock (may fire before 'ready').
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (typeof p === 'string' && lib.isSafeAbsPath(p)) sendOpen(p);
  });

  app.on('before-quit', () => {
    if (!forceClose) quitRequested = true;
  });

  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') log.warn('child process gone', details);
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    if (!log.file) log = lib.createLogger(path.join(userData, 'logs', 'main.log'));
    grants = new lib.FileGrants(path.join(userData, 'file-access.json'));
    windowStateFile = path.join(userData, 'window-state.json');
    log.info(`start v${app.getVersion()} ${process.platform} electron ${process.versions.electron}`);
    if (process.env.VITE_DEV_SERVER_URL && !isDev) log.warn('ignoring VITE_DEV_SERVER_URL (packaged app, or not a server on this machine)');

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

    // The page loads from file:// and Electron grants file:// pages extra privileges (fetch/XHR of other
    // file:// URLs), which CSP 'self' does not stop: without this filter a compromised page could read
    // any local file. Only the app's own bundle may be loaded; every other file:// request (including
    // UNC hosts) is cancelled. All schemes are filtered because file:// patterns ignore the URL's host.
    let blockedFileLogs = 0;
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
      if (!/^file:/i.test(details.url) || lib.fileUrlInside(details.url, DIST_DIR)) return cb({});
      if (blockedFileLogs++ < 50) log.warn('blocked file request', details.url.slice(0, 300));
      cb({ cancel: true });
    });

    lib.fileArgs(process.argv, { skip: argSkip }).forEach((p) => openQueue.open(p));
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
