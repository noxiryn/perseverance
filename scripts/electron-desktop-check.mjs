#!/usr/bin/env node
/**
 * Desktop hardening check: drives the REAL Electron app (production build in dist/) and verifies the
 * main-process contract — file access policy, Save As extension fix, crash-safe large writes,
 * second-instance file forwarding, cold-start file open, close guard (dirty / hung / crashed
 * renderer), window-state persistence, navigation/external-link/permission policy, the titlebar
 * overlay following the UI zoom, and zero console errors / CSP violations / Electron security warnings.
 *
 *   npx vite build && xvfb-run -a -s "-screen 0 1600x960x24" node scripts/electron-desktop-check.mjs \
 *     [--out shot.png] [--tmp dir] [--full]
 *
 * --full also opens every template/panel, drags every tool and runs every safe command inside Electron
 * (the browser smoke test's coverage, but under the app's real CSP and file:// origin).
 * Linux only (isolates userData with XDG_CONFIG_HOME). Exit code 1 on any failure.
 */
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};
const out = arg('out', 'electron-desktop-check.png');
const full = !!arg('full', false);
const T = arg('tmp', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'perseverance-desktop-'));
fs.rmSync(T, { recursive: true, force: true });
const FILES = path.join(T, 'files');
const CFG = path.join(T, 'cfg');
fs.mkdirSync(FILES, { recursive: true });
fs.mkdirSync(CFG, { recursive: true });

const env = { ...process.env, XDG_CONFIG_HOME: CFG, PERSEVERANCE_CLOSE_TIMEOUT_MS: '1500' };
delete env.ELECTRON_DISABLE_SECURITY_WARNINGS; // we want to see them
delete env.VITE_DEV_SERVER_URL;

const results = [];
const measurements = {};
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeout = 8000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.race([fn().catch(() => undefined), wait(3000).then(() => undefined)]);
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await wait(every);
  }
}

/** Launch the app with main-process test doubles for native dialogs / shell. */
async function launch(extraArgs = []) {
  const app = await electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox', ...extraArgs], env, cwd: T });
  const exited = new Promise((r) => app.process().once('exit', (code) => r(code)));
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, dialog, shell, ipcMain }) => {
    const t = (globalThis.__t = { console: [], boxes: [], boxAnswers: [], saveQueue: [], saves: [], external: [], revealed: [], ipc: [] });
    for (const ch of ['desktop:close-ack', 'desktop:confirm-close']) ipcMain.on(ch, (_e, v) => t.ipc.push(`${ch}=${v}@${Date.now()}`));
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.on('console-message', (e) => t.console.push({ level: e.level, message: e.message, source: e.sourceId }));
    dialog.showSaveDialog = async (...a) => {
      t.saves.push((a.length > 1 ? a[1] : a[0])?.defaultPath ?? null);
      const p = t.saveQueue.shift();
      return p ? { canceled: false, filePath: p } : { canceled: true, filePath: '' };
    };
    dialog.showMessageBox = async (...a) => {
      const o = a.length > 1 ? a[1] : a[0];
      t.boxes.push({ message: o.message, buttons: o.buttons, at: Date.now() });
      return { response: t.boxAnswers.length ? t.boxAnswers.shift() : (o.cancelId ?? 0), checkboxChecked: false };
    };
    shell.openExternal = async (url) => void t.external.push(url);
    shell.showItemInFolder = (p) => void t.revealed.push(p);
  });
  return { app, page, exited };
}

const main = (app, fn, a) => app.evaluate(fn, a);
const T_ = (app) => main(app, () => globalThis.__t);
const queueSave = (app, p) => main(app, (_e, p) => globalThis.__t.saveQueue.push(p), p);
const answerBox = (app, n) => main(app, (_e, n) => globalThis.__t.boxAnswers.push(n), n);
const windowCount = (app) => main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0);
const closeWindow = (app) => main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
const sessions = (page) =>
  page.evaluate(() => Object.values(window.__app.useEditor.getState().sessions).map((s) => ({ id: s.doc.id, name: s.doc.name, path: s.filePath ?? null, dirty: !!s.dirty })));

async function installCspProbe(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}

async function waitReady(page) {
  await page.waitForFunction(() => !!window.__app && !!document.querySelector('.shell-root'), null, { timeout: 30000 });
  await wait(800);
}

async function openTemplate(page, id = 'tpl-crimson-thumbnail') {
  await page.evaluate(async (tid) => {
    const a = window.__app;
    const doc = await a.templates.get(tid).build();
    a.useEditor.getState().openDocument(doc, { label: 'Template' });
  }, id);
  await wait(600);
}

async function makeDirty(page) {
  await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    st.commit('Desktop check edit', (d) => {
      d.guides.push({ id: `g-${Date.now()}`, orientation: 'horizontal', position: 24 });
    });
  });
}

/** Wait for an in-app dialog showing `text`, then click its `button`. Uses evaluate polling (not
 * waitForSelector): after a blocked navigation Playwright keeps waiting for it and selector waits hang. */
async function answerPrompt(page, text, button, timeout = 6000) {
  const found = await poll(() => page.evaluate((t) => document.body.innerText.includes(t), text), timeout);
  if (!found) return false;
  return page.evaluate((label) => {
    const btn = [...document.querySelectorAll('button')].reverse().find((b) => b.textContent.trim() === label);
    btn?.click();
    return !!btn;
  }, button);
}

const sameBytes = (a, b) => Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;

/* ======================================================================== */
/* Phase A                                                                   */
/* ======================================================================== */
let { app, page, exited } = await launch();
await installCspProbe(page);
await page.reload();
await waitReady(page);

const info = await page.evaluate(() => ({ desktop: !!window.desktop, platform: window.desktop?.platform, version: window.desktop?.version, url: location.href }));
const userData = await main(app, ({ app }) => app.getPath('userData'));
check('desktop bridge present', info.desktop && /index\.html$/.test(info.url), info);
const prefs = await main(app, ({ BrowserWindow }) => {
  const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
  return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webviewTag: p.webviewTag, webSecurity: p.webSecurity };
});
check('webPreferences locked down', prefs.contextIsolation === true && prefs.sandbox === true && !prefs.nodeIntegration && !prefs.webviewTag && prefs.webSecurity !== false, prefs);
check('renderer has no Node', await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'));

/* ---- Save As without extension ---- */
await openTemplate(page);
const poster = path.join(FILES, 'Poster.pgfx');
await queueSave(app, path.join(FILES, 'Poster'));
await page.evaluate(() => window.__app.commands.get('file.saveAs').run());
await poll(async () => fs.existsSync(poster));
let ss = await sessions(page);
check('Save As appends .pgfx when the name has no extension', fs.existsSync(poster) && !fs.existsSync(path.join(FILES, 'Poster')) && ss.some((s) => s.path === poster && s.name === 'Poster' && !s.dirty), { files: fs.readdirSync(FILES), sessions: ss });
check('saved file is a PGFX container', fs.existsSync(poster) && fs.readFileSync(poster).subarray(0, 4).toString() === 'PGFX');
const title = await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
check('window title follows the document', /Poster/.test(title), title);

/* ---- Save As onto an existing file after the extension fix asks first ---- */
await queueSave(app, path.join(FILES, 'Poster'));
const mtime0 = fs.statSync(poster).mtimeMs;
const cancelled = await page.evaluate(async () => {
  const d = window.desktop;
  return d.saveFile({ title: 'Save As', defaultPath: 'Poster.pgfx', filters: [{ name: 'Perseverance Project', extensions: ['pgfx'] }], data: 'nope' });
});
let t = await T_(app);
check('extension fix never silently overwrites an existing file', cancelled === null && fs.statSync(poster).mtimeMs === mtime0 && t.boxes.some((b) => /already exists/.test(b.message)), { cancelled });

/* ---- read/write round trip ---- */
const rt = await page.evaluate(async (p) => {
  const d = window.desktop;
  const a = await d.readFile(p);
  const u = new Uint8Array(a);
  const mod = new Uint8Array(u.length + 3);
  mod.set(u);
  mod.set([1, 2, 3], u.length);
  await d.writeFile(p, mod.buffer);
  const b = new Uint8Array(await d.readFile(p));
  await d.writeFile(p, a);
  return { size: u.length, size2: b.length, tail: [...b.slice(-3)] };
}, poster);
check('writeFile/readFile round trip on a saved path', rt.size2 === rt.size + 3 && rt.tail.join() === '1,2,3' && fs.statSync(poster).size === rt.size, rt);
check('no temp files left after writes', fs.readdirSync(FILES).every((f) => !f.endsWith('.tmp')), fs.readdirSync(FILES));

/* ---- access policy ---- */
const evil = path.join(FILES, 'evil.txt');
const legacy = path.join(FILES, 'legacy.pgfx');
fs.copyFileSync(poster, legacy);
fs.writeFileSync(path.join(FILES, 'fake.pgfx'), 'not a project');
const denials = await page.evaluate(
  async ({ evil, poster, legacy, files, userData }) => {
    const d = window.desktop;
    const attempt = async (fn) => {
      try {
        const r = await fn();
        return `ALLOWED${r && r.byteLength !== undefined ? ` (${r.byteLength} bytes)` : ''}`;
      } catch (e) {
        return `denied: ${String(e.message).replace(/^Error invoking remote method '[^']+': /, '').slice(0, 90)}`;
      }
    };
    return {
      writeUnchosen: await attempt(() => d.writeFile(evil, 'pwned')),
      readSystemFile: await attempt(() => d.readFile('/etc/hostname')),
      readTraversal: await attempt(() => d.readFile(`${files}/../cfg/Perseverance/file-access.json`)),
      writeGrantsFile: await attempt(() => d.writeFile(`${userData}/file-access.json`, '{}')),
      readRelative: await attempt(() => d.readFile('Poster.pgfx')),
      writeBadData: await attempt(() => d.writeFile(poster, { length: 1 })),
      writeNumberPath: await attempt(() => d.writeFile(42, 'x')),
      readFakeProject: await attempt(() => d.readFile(`${files}/fake.pgfx`)),
      writeLegacy: await attempt(() => d.writeFile(legacy, 'x')),
      readLegacyProject: await attempt(() => d.readFile(legacy)),
      revealSystemFile: (d.showItemInFolder('/etc/hostname'), 'sent'),
    };
  },
  { evil, poster, legacy, files: FILES, userData },
);
const mustDeny = ['writeUnchosen', 'readSystemFile', 'readTraversal', 'writeGrantsFile', 'readRelative', 'writeBadData', 'writeNumberPath', 'readFakeProject', 'writeLegacy'];
check('paths the user never chose are refused', mustDeny.every((k) => denials[k].startsWith('denied')) && !fs.existsSync(evil), denials);
check('projects from an older recent list stay readable (read-only)', denials.readLegacyProject.startsWith('ALLOWED') && sameBytes(legacy, poster));
await wait(200);
t = await T_(app);
check('showItemInFolder limited to chosen files / data folder', !t.revealed.includes('/etc/hostname'), t.revealed);

/* ---- Save to an ungranted project path falls back to Save As ---- */
const savesBefore = (await T_(app)).saves.length;
await page.evaluate((p) => {
  const st = window.__app.useEditor.getState();
  st.setFilePath(st.activeDocId, p, false);
}, legacy);
await queueSave(app, path.join(FILES, 'Resaved'));
await page.evaluate(() => window.__app.commands.get('file.save').run());
await poll(async () => fs.existsSync(path.join(FILES, 'Resaved.pgfx')));
t = await T_(app);
check('Save on a path without write access goes through Save As', fs.existsSync(path.join(FILES, 'Resaved.pgfx')) && sameBytes(legacy, poster) && t.saves.length === savesBefore + 1 && t.saves.at(-1) === legacy, { saves: t.saves.slice(savesBefore) });

/* ---- second instance forwards (relative) argv ---- */
const second = path.join(FILES, 'Second Copy.pgfx');
fs.copyFileSync(poster, second);
const t2 = Date.now();
const child = spawn(electronPath, [root, path.relative(T, second), '--no-sandbox'], { cwd: T, env, stdio: 'ignore' });
const childCode = await new Promise((r) => child.on('exit', r));
const opened = await poll(async () => (await sessions(page)).find((s) => s.path === second), 10000);
measurements.secondInstanceMs = Date.now() - t2;
check('second instance exits and forwards its file (relative path, spaces)', childCode === 0 && !!opened, { childCode, opened, ms: measurements.secondInstanceMs });
const w2 = await page.evaluate((p) => window.desktop.writeFile(p, new ArrayBuffer(0)).then(() => 'ok', (e) => e.message), second);
fs.copyFileSync(poster, second);
check('a project opened from the OS can be saved back in place', w2 === 'ok', w2);

/* ---- external links, popups, navigation ---- */
await page.evaluate(() => {
  const d = window.desktop;
  d.openExternal('file:///etc/passwd');
  d.openExternal('javascript:alert(1)');
  d.openExternal('smb://evil/share');
  d.openExternal('https://example.com/ok');
  window.open('https://example.org/popup');
  window.open('file:///etc/hostname');
});
await wait(600);
t = await T_(app);
check('openExternal / window.open only hand http(s) to the browser', JSON.stringify(t.external) === JSON.stringify(['https://example.com/ok', 'https://example.org/popup']), t.external);
check('window.open never creates a window', (await windowCount(app)) === 1);

/* ---- permissions ---- */
const perms = await page.evaluate(async () => {
  const r = {};
  try {
    const f = await window.queryLocalFonts();
    r.localFonts = `granted (${f.length} fonts)`;
  } catch (e) {
    r.localFonts = `denied ${e.name}`;
  }
  r.notifications = await Notification.requestPermission();
  r.geolocation = await new Promise((res) =>
    navigator.geolocation.getCurrentPosition(
      () => res('granted'),
      (e) => res(`denied (${e.code})`),
      { timeout: 4000 },
    ),
  );
  try {
    await navigator.clipboard.writeText('perseverance-check');
    r.clipboardWrite = 'granted';
  } catch (e) {
    r.clipboardWrite = `denied ${e.name}`;
  }
  try {
    await document.documentElement.requestFullscreen();
    r.fullscreen = document.fullscreenElement ? 'granted' : 'no-op';
    await document.exitFullscreen();
  } catch (e) {
    r.fullscreen = `denied ${e.name}`;
  }
  try {
    await navigator.requestMIDIAccess({ sysex: true });
    r.midi = 'granted';
  } catch (e) {
    r.midi = `denied ${e.name}`;
  }
  return r;
});
check(
  'permissions: fonts/clipboard/fullscreen granted, everything else denied',
  perms.localFonts.startsWith('granted') && perms.clipboardWrite === 'granted' && perms.fullscreen === 'granted' && perms.notifications === 'denied' && perms.geolocation.startsWith('denied') && perms.midi.startsWith('denied'),
  perms,
);
await wait(400);

/* ---- UI zoom bridge + caption overlay height ---- */
const zoom = await page.evaluate(async () => {
  const measure = () => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:env(titlebar-area-height, 0px)';
    document.body.append(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return Math.round(h * 100) / 100;
  };
  const before = { dpr: devicePixelRatio, overlay: measure() };
  window.desktop.setZoomFactor(1.25);
  await new Promise((r) => setTimeout(r, 400));
  const zoomed = { dpr: devicePixelRatio, overlay: measure() };
  window.desktop.setZoomFactor(1);
  await new Promise((r) => setTimeout(r, 400));
  return { before, zoomed, reset: devicePixelRatio };
});
measurements.zoom = zoom;
check('setZoomFactor zooms the page and the caption overlay follows', Math.abs(zoom.zoomed.dpr / zoom.before.dpr - 1.25) < 0.01 && zoom.reset === zoom.before.dpr && // env() is reported in whole CSS px: 39 DIP at 125% → 31.2 → 32 (an overlay stuck at 31 DIP would read 25).
  (zoom.before.overlay === 0 || (zoom.zoomed.overlay * 1.25 >= 38 && zoom.zoomed.overlay * 1.25 <= 41)), zoom);

/* ---- large files ---- */
await queueSave(app, path.join(FILES, 'big.bin'));
const big = await page.evaluate(async () => {
  const d = window.desktop;
  const p = await d.saveFile({ title: 'big', defaultPath: 'big.bin', filters: [{ name: 'All files', extensions: ['*'] }], data: 'x' });
  const res = { path: p };
  for (const mb of [100, 300]) {
    const b = new Uint8Array(mb * 1024 * 1024);
    for (let i = 0; i < b.length; i += 4096) b[i] = (i >> 12) & 255;
    b[b.length - 1] = 77;
    let t = performance.now();
    await d.writeFile(p, b.buffer);
    res[`write${mb}MB`] = Math.round(performance.now() - t);
    t = performance.now();
    const r = new Uint8Array(await d.readFile(p));
    res[`read${mb}MB`] = Math.round(performance.now() - t);
    res[`ok${mb}`] = r.length === b.length && r[4096 * 5] === 5 && r[r.length - 1] === 77;
  }
  return res;
});
measurements.largeFiles = big;
check('300 MB write/read round trip', big.ok100 && big.ok300 && fs.statSync(path.join(FILES, 'big.bin')).size === 300 * 1024 * 1024, big);
fs.rmSync(path.join(FILES, 'big.bin'), { force: true });

/* ---- close guard: dirty document → prompt → Cancel keeps the window ---- */
await makeDirty(page);
await closeWindow(app);
let prompted = await answerPrompt(page, 'Save changes before closing?', 'Cancel');
await wait(500);
const diag = async () => ({
  ipc: (await T_(app)).ipc.slice(-6),
  boxes: (await T_(app)).boxes.slice(-3).map((b) => b.message),
  dialogs: await page.evaluate(() => window.__app.useUI.getState().dialogs.map((d) => d.props?.message ?? d.props?.title ?? '?')).catch((e) => e.message),
  sessions: await sessions(page).catch((e) => e.message),
});
check('close with unsaved changes asks; Cancel keeps the app open', prompted && (await windowCount(app)) === 1, prompted ? '' : await diag());

/* ---- close guard: busy renderer → "not responding" fallback, then the normal prompt ---- */
await page.evaluate(() =>
  setTimeout(() => {
    const t = Date.now();
    while (Date.now() - t < 4500);
  }, 30),
);
await wait(150);
const boxesBefore = (await T_(app)).boxes.length;
const tBusy = Date.now();
await closeWindow(app);
const fallback = await poll(async () => (await T_(app)).boxes.slice(boxesBefore).find((b) => b.message === 'Perseverance is not responding'), 6000);
measurements.closeFallbackMs = fallback ? fallback.at - tBusy : null;
prompted = await answerPrompt(page, 'Save changes before closing?', 'Cancel', 15000);
await wait(400);
check('busy renderer: force-quit offer after the ack timeout, renderer prompt once free', !!fallback && fallback.buttons.includes('Quit Anyway') && prompted && (await windowCount(app)) === 1, { fallbackAfterMs: measurements.closeFallbackMs, ...(fallback && prompted ? {} : await diag()) });

/* ---- unresponsive handler ---- */
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'));
await wait(300);
t = await T_(app);
const unresp = t.boxes.at(-1);
check('unresponsive window offers Wait / Reload / Quit', unresp && unresp.message === 'Perseverance is not responding' && unresp.buttons.join() === 'Wait,Reload,Quit', unresp);

/* ---- renderer crash → Reload ---- */
await answerBox(app, 0);
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
const reloaded = await poll(
  () => main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('!!(window.__app && document.querySelector(".shell-root"))')),
  20000,
  300,
);
t = await T_(app);
check('renderer crash offers Reload and the editor comes back', !!reloaded && t.boxes.some((b) => b.message === 'The editor window stopped unexpectedly'), { reloaded });

/* ---- remember window bounds, then a hung renderer + close → "Quit Anyway" really quits ---- */
await main(app, ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w.isMaximized()) w.unmaximize();
  w.setBounds({ x: 60, y: 40, width: 1280, height: 780 });
});
await wait(900);
const boundsA = await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('setTimeout(() => { for (;;); }, 30); 1'));
await wait(200);
await answerBox(app, 1); // "Quit Anyway"
const tHung = Date.now();
await closeWindow(app).catch(() => {});
const code = await Promise.race([exited, wait(12000).then(() => 'timeout')]);
measurements.hungQuitMs = Date.now() - tHung;
check('hung renderer never traps the user (Quit Anyway exits)', code !== 'timeout', { exitCode: code, ms: measurements.hungQuitMs });
if (code === 'timeout') await app.close().catch(() => {});
const stateFile = path.join(userData, 'window-state.json');
const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
check('window state written to userData', !!saved && saved.width === boundsA.width && saved.height === boundsA.height, { saved, boundsA });
const consoleA = t.console;

/* ======================================================================== */
/* Phase B: relaunch with a file argument (cold start from Explorer)        */
/* ======================================================================== */
const cold = path.join(FILES, 'cold.pgfx');
fs.copyFileSync(poster, cold);
({ app, page, exited } = await launch([cold]));
await waitReady(page);
const coldDoc = await poll(async () => (await sessions(page)).find((s) => s.path === cold), 10000);
check('cold start with a .pgfx argument opens it', !!coldDoc, coldDoc);
const boundsB = await main(app, ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return { ...w.getBounds(), maximized: w.isMaximized() };
});
check('window size/position restored', boundsB.width === boundsA.width && boundsB.height === boundsA.height && Math.abs(boundsB.x - boundsA.x) <= 2 && Math.abs(boundsB.y - boundsA.y) <= 40 && !boundsB.maximized, { boundsA, boundsB });

// Dismiss crash-recovery offers from phase A's forced quit (expected), then reload with the CSP probe.
await page.evaluate(() => window.__app.useUI.setState({ dialogs: [] }));
await installCspProbe(page);
await page.reload();
await waitReady(page);
await page.evaluate(() => window.__app.useUI.setState({ dialogs: [] }));

const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('perseverance.recent') ?? '[]').map((e) => e.path));
const idx = recent.indexOf(poster);
check('recent files keep native paths', idx >= 0, recent);
if (idx >= 0) {
  await page.evaluate((i) => window.__app.commands.get(`file.openRecent.${i}`).run(), idx);
  const reopened = await poll(async () => (await sessions(page)).find((s) => s.path === poster), 8000);
  check('Open Recent works after a relaunch (persisted grants)', !!reopened, reopened);
  const w3 = await page.evaluate((p) => window.desktop.readFile(p).then((b) => window.desktop.writeFile(p, b)).then(() => 'ok', (e) => e.message), poster);
  check('a recent project can be saved in place after a relaunch', w3 === 'ok', w3);
}
const grantsFile = path.join(userData, 'file-access.json');
const grants = fs.existsSync(grantsFile) ? JSON.parse(fs.readFileSync(grantsFile, 'utf8')).files : [];
check('grants persisted in userData (projects writable, nothing else)', grants.some((g) => g.path === poster && g.write) && !grants.some((g) => g.path === evil || g.path === legacy), grants.map((g) => `${path.basename(g.path)}:${g.write ? 'rw' : 'r'}`));

/* ---- broad coverage under the real CSP ---- */
const cov = await page.evaluate(async (fullRun) => {
  const a = window.__app;
  const errs = [];
  const tpls = a.templates.list().map((x) => x.id);
  for (const id of fullRun ? tpls : tpls.slice(0, 4)) {
    const doc = await a.templates.get(id).build();
    a.useEditor.getState().openDocument(doc, { label: 'Template' });
    await new Promise((r) => setTimeout(r, fullRun ? 900 : 1500));
  }
  for (const p of a.panels.list()) {
    a.useUI.getState().showPanel(p.id);
    await new Promise((r) => setTimeout(r, 120));
  }
  return { templates: fullRun ? tpls.length : 4, panels: a.panels.list().length, errs };
}, full);
if (full) {
  const DENY = /^(file\.(open|place|exit|close|closeAll|openRecent|save|saveAs|export|quickExportPng|exportPsd|importModel|fetchAvatar)|help\.openDataFolder|view\.fullscreen|roblox\.(importModel|fetchAvatar)|edit\.(copy|cut|paste|pasteInPlace|copyMerged))/;
  const vp = await page.evaluate(() => {
    const r = (document.querySelector('[data-viewport]') ?? document.querySelector('canvas'))?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  });
  let tools = 0;
  for (const id of await page.evaluate(() => window.__app.tools.list().map((x) => x.id))) {
    if (['hand', 'zoom'].includes(id) || !vp) continue;
    await page.evaluate((tid) => window.__app.useEditor.getState().setTool(tid), id);
    const cx = vp.x + vp.w * 0.45;
    const cy = vp.y + vp.h * 0.45;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) await page.mouse.move(cx + k * 12, cy + k * 7);
    await page.mouse.up();
    await page.keyboard.press('Escape');
    tools++;
  }
  let ran = 0;
  for (const id of await page.evaluate(() => window.__app.commands.list().map((c) => c.id))) {
    if (DENY.test(id)) continue;
    await page
      .evaluate(async (cid) => {
        const c = window.__app.commands.get(cid);
        if (c.enabled && !c.enabled()) return;
        await Promise.race([Promise.resolve(c.run()), new Promise((r) => setTimeout(r, 1500))]);
      }, id)
      .catch(() => {});
    ran++;
    await page.evaluate(() => {
      window.__app.useUI.setState({ dialogs: [], commandPaletteOpen: false });
      if (!window.__app.useEditor.getState().activeDocId) window.__app.openDemoDocument();
    });
  }
  cov.tools = tools;
  cov.commands = ran;
}
await wait(1500);
await page.screenshot({ path: out });
check('coverage run inside Electron', cov.panels > 5, cov);

const csp = await page.evaluate(() => window.__csp);
t = await T_(app);
const consoleAll = [...consoleA, ...t.console];
const errors = consoleAll.filter((m) => m.level === 'error');
const secWarnings = consoleAll.filter((m) => /Electron Security Warning/i.test(m.message));
const cspConsole = consoleAll.filter((m) => /Content Security Policy|Refused to/i.test(m.message));
check('no CSP violations', csp.length === 0 && cspConsole.length === 0, [...csp, ...cspConsole.map((m) => m.message)].slice(0, 8));
check('no Electron security warnings', secWarnings.length === 0, secWarnings.map((m) => m.message.slice(0, 120)));
check('no renderer console errors', errors.length === 0, errors.map((m) => `${m.message.slice(0, 160)} (${m.source}:)`).slice(0, 10));

/* ---- navigation is blocked (done last: a blocked navigation confuses Playwright's frame tracking) ---- */
await page.evaluate(() => {
  location.href = 'file:///etc/hostname';
});
await wait(600);
await page.evaluate(() => {
  location.href = 'https://example.net/nav';
});
await wait(800);
t = await T_(app);
const href = await page.evaluate(() => location.href);
check('the window never navigates away (http(s) goes to the browser)', /dist\/index\.html$/.test(href) && t.external.includes('https://example.net/nav') && (await page.evaluate(() => !!window.__app)), { href, external: t.external });

/* ---- normal quit: dirty → Discard ---- */
await makeDirty(page);
await closeWindow(app);
prompted = await answerPrompt(page, 'Save changes before closing?', 'Discard');
const codeB = await Promise.race([exited, wait(10000).then(() => 'timeout')]);
check('quit with unsaved changes → Discard exits', prompted && codeB !== 'timeout', { exitCode: codeB });
if (codeB === 'timeout') await app.close().catch(() => {});

const logFile = path.join(userData, 'logs', 'main.log');
const mainLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
check('main-process log written (crash + warnings recorded)', /render process gone/.test(mainLog) && /close request not acknowledged/.test(mainLog), logFile);

console.log('MEASUREMENTS', JSON.stringify(measurements));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
  process.exit(1);
}
console.log('DESKTOP CHECK OK');
process.exit(0);
