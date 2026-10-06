#!/usr/bin/env node
/**
 * Saving / crash recovery / opening files in the REAL Electron app (production build in dist/) — the
 * paths where user work used to be lost (docs/status/release-review.json):
 *
 *  crash   crash (SIGKILL) with an autosaved project, then reopen it by double-click (argv): the
 *          recovery offer still appears; "Later", Save and Close on the reopened copy keep the crash
 *          entry; the next start offers it again and Recover adds it to the open copy as an undoable
 *          step that saves back to the file (app-logic-diff-1).
 *  quit    the native "Quit Anyway" (close again while the unsaved-changes prompt is open) and a
 *          Windows session end keep the autosaved copy and the next start offers it; the in-app
 *          Discard deletes it (packaged-app-5, electron-security-2, app-logic-diff-2).
 *  drop    a .pgfx dropped from the file manager (native drag) opens with its path: Save writes in
 *          place, it joins Open Recent, dropping it again switches to its tab; a File built by page
 *          script gets no path (packaged-app-2, electron-security-3).
 *  name    Save As stores the chosen file name inside the file; reopening names the tab after the
 *          file (packaged-app-1).
 *
 *   npx vite build && xvfb-run -a -s "-screen 0 1600x960x24" node scripts/electron-recovery-check.mjs \
 *     [--app <dir with electron/, package.json, dist/>] [--tmp dir] [--only crash,quit,drop,name] [--shot offer.png]
 *
 * Linux only (isolates userData with XDG_CONFIG_HOME). Exit code 1 on any failure.
 */
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const appDir = path.resolve(arg('app', root));
const only = String(arg('only', 'crash,quit,drop,name')).split(',');
const shot = arg('shot', null); // screenshot of the recovery offer (crash scenario)
const T = arg('tmp', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'perseverance-recovery-'));
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
function finish(crash) {
  if (crash) check('check script ran to the end', false, String((crash && crash.stack) || crash).split('\n').slice(0, 4).join(' | '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('FAILED:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
    process.exit(1);
  }
  console.log('RECOVERY CHECK OK');
  process.exit(0);
}
process.on('uncaughtException', (e) => finish(e));
process.on('unhandledRejection', (e) => finish(e));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeout = 8000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await wait(every);
  }
}

/** Launch with an isolated profile and test doubles for native dialogs (answers queued per test). */
async function launch(profile, extraArgs = []) {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(T, profile), PERSEVERANCE_CLOSE_TIMEOUT_MS: '1500', PERSEVERANCE_REPEAT_CLOSE_MS: '1500' };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_DISABLE_SECURITY_WARNINGS;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir, '--no-sandbox', ...extraArgs], env, cwd: T });
  const exited = new Promise((r) => app.process().once('exit', (code) => r(code)));
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ dialog }) => {
    const t = (globalThis.__t = { boxes: [], boxAnswers: [], saveQueue: [], saves: [], openQueue: [] });
    dialog.showSaveDialog = async (...a) => {
      t.saves.push((a.length > 1 ? a[1] : a[0])?.defaultPath ?? null);
      const p = t.saveQueue.shift();
      return p ? { canceled: false, filePath: p } : { canceled: true, filePath: '' };
    };
    dialog.showMessageBox = async (...a) => {
      const o = a.length > 1 ? a[1] : a[0];
      t.boxes.push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: t.boxAnswers.length ? t.boxAnswers.shift() : (o.cancelId ?? 0), checkboxChecked: false };
    };
    dialog.showOpenDialog = async () => {
      const p = t.openQueue.shift();
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
  });
  await page.waitForFunction(() => !!window.__app && !!document.querySelector('.shell-root'), null, { timeout: 30000 });
  await page.evaluate(() => {
    // Autosave every tick (the interval itself is 15 s).
    const prefs = JSON.parse(localStorage.getItem('perseverance.prefs') || '{}');
    prefs.autosaveMinutes = 0.01;
    localStorage.setItem('perseverance.prefs', JSON.stringify(prefs));
  });
  return { app, page, exited, errors };
}

const T_ = (app) => app.evaluate(() => globalThis.__t);
const queueSave = (app, p) => app.evaluate((_e, p) => globalThis.__t.saveQueue.push(p), p);
const answerBox = (app, n) => app.evaluate((_e, n) => globalThis.__t.boxAnswers.push(n), n);
const closeWindow = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
const run = (page, id) => page.evaluate((cid) => window.__app.commands.get(cid).run(), id);
const sessions = (page) =>
  page.evaluate(() =>
    Object.values(window.__app.useEditor.getState().sessions).map((s) => ({
      id: s.doc.id,
      name: s.doc.name,
      path: s.filePath ?? null,
      dirty: !!s.dirty,
      guides: s.doc.guides.length,
      last: s.history.entries[s.history.index]?.label,
    })),
  );
const dialogText = (page) => page.evaluate(() => [...document.querySelectorAll('.ui-dialog')].map((d) => d.innerText.replace(/\s+/g, ' ')).join(' | '));
const clickDialogButton = (page, label) =>
  page.evaluate((label) => {
    const b = [...document.querySelectorAll('.ui-dialog button')].find((x) => x.textContent.trim().startsWith(label));
    b?.click();
    return !!b;
  }, label);
/** Recovery entries in IndexedDB, with the guide count stored in each entry's .pgfx header. */
const idb = (page) =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('perseverance-recovery', 1);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('docs')) return res([]);
          const q = db.transaction('docs').objectStore('docs').getAll();
          q.onsuccess = () =>
            res(
              q.result.map((e) => {
                const n = new DataView(e.data).getUint32(6, true);
                const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(e.data, 10, n)));
                return { key: e.id, launch: e.launchId ?? null, guides: hdr.document.guides.length, path: e.filePath ?? null };
              }),
            );
        };
        r.onerror = () => res([]);
      }),
  );
/** Name and guide count stored in a .pgfx file. */
function pgfxHeader(p) {
  const b = fs.readFileSync(p);
  const n = b.readUInt32LE(6);
  return JSON.parse(b.subarray(10, 10 + n).toString('utf8')).document;
}
async function addGuides(page, n) {
  await page.evaluate((n) => {
    const ed = window.__app.useEditor.getState();
    for (let i = 0; i < n; i++)
      ed.commit(`Guide ${i}`, (d) => {
        d.guides.push({ id: `g${Date.now()}_${i}`, orientation: 'vertical', position: 40 + i * 30 });
      });
  }, n);
}
async function openTemplate(page, id = 'tpl-noir-thumbnail') {
  await page.evaluate(async (tid) => {
    const a = window.__app;
    const doc = await a.templates.get(tid).build();
    a.useEditor.getState().openDocument(doc, { label: 'Template' });
  }, id);
  await wait(500);
}
async function dismissDialogs(page) {
  await page.evaluate(() => window.__app.useUI.setState({ dialogs: [] }));
}
async function exitApp(ctx) {
  await ctx.app.close().catch(() => {});
}

/* ======================================================================== */
/* crash → reopen by double-click                                           */
/* ======================================================================== */
if (only.includes('crash')) {
  const poster = path.join(T, 'crash', 'Poster.pgfx');
  fs.mkdirSync(path.dirname(poster), { recursive: true });
  let c = await launch('cfg-crash');
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page);
  await queueSave(c.app, poster);
  await run(c.page, 'file.saveAs');
  await poll(async () => fs.existsSync(poster));
  await addGuides(c.page, 5);
  const crashEntry = await poll(async () => (await idb(c.page)).find((e) => e.guides === 5), 40000, 1000);
  check('autosave wrote the unsaved work', !!crashEntry, crashEntry);
  c.app.process().kill('SIGKILL');
  await wait(1500);

  // Double-click Poster.pgfx: the clean file opens with the same document id.
  c = await launch('cfg-crash', [poster]);
  const offered = await poll(async () => /Recover unsaved documents\?/.test(await dialogText(c.page)), 10000);
  await poll(async () => (await sessions(c.page)).some((s) => s.path === poster), 8000);
  await wait(500);
  const text1 = await dialogText(c.page);
  if (shot) await c.page.screenshot({ path: shot });
  check('reopened by double-click: the crash entry is still offered', offered && /Open now as “Poster”/.test(text1), text1.slice(0, 260));
  check('"Later" keeps it', await clickDialogButton(c.page, 'Later'));
  // Keep working on the reopened copy: edit, autosave, Save, Close.
  await addGuides(c.page, 1);
  await poll(async () => (await idb(c.page)).length >= 2, 45000, 1000);
  const afterAutosave = await idb(c.page);
  check('the next autosave writes its own entry, the crash entry is untouched', afterAutosave.some((e) => e.guides === 5) && afterAutosave.length === 2, afterAutosave);
  await run(c.page, 'file.save');
  await wait(1500);
  await run(c.page, 'file.close');
  await wait(1000);
  const afterClose = await idb(c.page);
  check('Save and Close on the reopened copy keep the crash entry', afterClose.length === 1 && afterClose[0].guides === 5, afterClose);
  check('the file holds the saved state (1 guide)', pgfxHeader(poster).guides.length === 1, pgfxHeader(poster).guides.length);
  await closeWindow(c.app);
  await Promise.race([c.exited, wait(8000)]);

  // Next double-click: offered again; Recover adds it to the open copy as one undoable step.
  c = await launch('cfg-crash', [poster]);
  await poll(async () => /Recover unsaved documents\?/.test(await dialogText(c.page)), 10000);
  await poll(async () => (await sessions(c.page)).some((s) => s.path === poster), 8000);
  await wait(500);
  check('offered again on the next start', /Recover unsaved documents\?/.test(await dialogText(c.page)));
  await clickDialogButton(c.page, 'Recover');
  await wait(1500);
  const rec = await sessions(c.page);
  const onFile = rec.filter((s) => s.path === poster);
  check('Recover adds the changes to the open copy (one tab, dirty, undoable step)', onFile.length === 1 && onFile[0].guides === 5 && onFile[0].dirty && onFile[0].last === 'Recover Autosaved Changes', rec);
  await c.page.evaluate(() => window.__app.useEditor.getState().undo());
  const undone = (await sessions(c.page)).find((s) => s.path === poster);
  await c.page.evaluate(() => window.__app.useEditor.getState().redo());
  check('Undo goes back to the file’s version', undone?.guides === 1 && !undone.dirty, undone);
  await run(c.page, 'file.save');
  await wait(1500);
  const saved = pgfxHeader(poster);
  const left = await idb(c.page);
  check('Save writes the recovered work to the file; no entry left', saved.guides.length === 5 && left.length === 0, { guides: saved.guides.length, left });
  check('no page errors (crash scenario)', c.errors.length === 0, c.errors.slice(0, 3));
  await exitApp(c);
}

/* ======================================================================== */
/* Quit Anyway / session end keep the autosave; Discard deletes it          */
/* ======================================================================== */
async function dirtyAutosaved(profile) {
  const c = await launch(profile);
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page);
  await addGuides(c.page, 3);
  const entry = await poll(async () => (await idb(c.page)).find((e) => e.guides === 3), 40000, 1000);
  return { ...c, entry };
}
async function offeredOnRelaunch(profile) {
  const c = await launch(profile);
  const offered = await poll(async () => /Recover unsaved documents\?/.test(await dialogText(c.page)), 6000);
  const entries = await idb(c.page);
  await exitApp(c);
  return { offered: !!offered, entries: entries.length };
}

if (only.includes('quit')) {
  // Close → in-app prompt → close again after a moment → native "Quit without answering…" → Quit Anyway.
  let c = await dirtyAutosaved('cfg-stuck');
  check('dirty document autosaved (stuck)', !!c.entry);
  await closeWindow(c.app);
  const inApp = await poll(() => c.page.evaluate(() => document.body.innerText.includes('Save changes before closing?')), 6000);
  await wait(1700);
  await answerBox(c.app, 1); // Quit Anyway
  await closeWindow(c.app);
  const code = await Promise.race([c.exited, wait(10000).then(() => 'timeout')]);
  const box = (await T_(c.app).catch(() => ({ boxes: [] }))).boxes?.find((b) => /Quit without answering/.test(b.message));
  check('Quit Anyway exits', inApp && code !== 'timeout', { inApp, code, box: box?.detail });
  if (code === 'timeout') await exitApp(c);
  let r = await offeredOnRelaunch('cfg-stuck');
  check('after Quit Anyway the next start offers the autosaved copy (as the prompt says)', r.offered && r.entries === 1, r);

  // Windows log off / shut down (session-end, then the window closes).
  c = await dirtyAutosaved('cfg-session');
  check('dirty document autosaved (session end)', !!c.entry);
  await c.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.emit('session-end');
    w.close();
  });
  const codeS = await Promise.race([c.exited, wait(8000).then(() => 'timeout')]);
  if (codeS === 'timeout') await exitApp(c);
  r = await offeredOnRelaunch('cfg-session');
  check('after a Windows session end the next start offers the autosaved copy', codeS !== 'timeout' && r.offered && r.entries === 1, { codeS, ...r });

  // The in-app Discard: the user chose to throw the changes away.
  c = await dirtyAutosaved('cfg-discard');
  check('dirty document autosaved (discard)', !!c.entry);
  await closeWindow(c.app);
  await poll(() => c.page.evaluate(() => document.body.innerText.includes('Save changes before closing?')), 6000);
  await clickDialogButton(c.page, 'Discard');
  const codeD = await Promise.race([c.exited, wait(8000).then(() => 'timeout')]);
  if (codeD === 'timeout') await exitApp(c);
  r = await offeredOnRelaunch('cfg-discard');
  check('Discard deletes the autosaved copy (not offered, nothing stored)', codeD !== 'timeout' && !r.offered && r.entries === 0, { codeD, ...r });
}

/* ======================================================================== */
/* drop a .pgfx from the file manager                                       */
/* ======================================================================== */
if (only.includes('drop')) {
  const dir = path.join(T, 'drop');
  fs.mkdirSync(dir, { recursive: true });
  const poster = path.join(dir, 'Poster.pgfx');
  const c = await launch('cfg-drop');
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page);
  await queueSave(c.app, poster);
  await run(c.page, 'file.saveAs');
  await poll(async () => fs.existsSync(poster));
  await c.page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    for (const id of [...st.docOrder]) st.closeDocument(id);
    localStorage.setItem('perseverance.recent', '[]');
  });
  await wait(300);
  const cdp = await c.app.context().newCDPSession(c.page);
  const nativeDrop = async (file) => {
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x: 800, y: 480, data });
      await wait(80);
    }
    await wait(1500);
  };
  await nativeDrop(poster);
  let s = await sessions(c.page);
  const recent = await c.page.evaluate(() => JSON.parse(localStorage.getItem('perseverance.recent') || '[]').map((e) => e.path));
  check('a dropped .pgfx opens with its path and joins Open Recent', s.length === 1 && s[0].path === poster && s[0].name === 'Poster' && recent.includes(poster), { s, recent });
  const before = fs.readFileSync(poster);
  const savesBefore = (await T_(c.app)).saves.length;
  await addGuides(c.page, 2);
  await run(c.page, 'file.save');
  await wait(1500);
  const savesAfter = (await T_(c.app)).saves.length;
  check('Save writes the dropped file in place (no Save As dialog)', savesAfter === savesBefore && !before.equals(fs.readFileSync(poster)) && pgfxHeader(poster).guides.length === 2, { dialogs: savesAfter - savesBefore });
  await nativeDrop(poster);
  s = await sessions(c.page);
  check('dropping it again switches to its tab (no second copy)', s.length === 1, s);
  // Page script can't obtain a grant: a File it built has no path.
  const forged = await c.page.evaluate(async (p) => {
    const f = new File([new Uint8Array([0x50, 0x47, 0x46, 0x58])], 'Poster.pgfx');
    const viaBridge = await window.desktop.grantDroppedFile(f, await f.arrayBuffer());
    const write = await window.desktop.writeFile(p.replace(/Poster\.pgfx$/, 'Other.pgfx'), new ArrayBuffer(4)).then(() => 'written', (e) => e.message);
    return { viaBridge, write };
  }, poster);
  check('a File built by page script gets no path / grant', forged.viaBridge === null && /ENOTGRANTED/.test(forged.write), forged);
  check('no page errors (drop scenario)', c.errors.length === 0, c.errors.slice(0, 3));
  await exitApp(c);
}

/* ======================================================================== */
/* Save As stores the file name                                             */
/* ======================================================================== */
if (only.includes('name')) {
  const dir = path.join(T, 'name');
  fs.mkdirSync(dir, { recursive: true });
  const poster = path.join(dir, 'My Poster.pgfx');
  const c = await launch('cfg-name');
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page, 'tpl-crimson-thumbnail');
  await queueSave(c.app, poster);
  await run(c.page, 'file.saveAs');
  await poll(async () => fs.existsSync(poster) && pgfxHeader(poster).name === 'My Poster', 8000);
  const after = (await sessions(c.page))[0];
  check('Save As: the tab and the file take the chosen name', after?.name === 'My Poster' && !after.dirty && pgfxHeader(poster).name === 'My Poster', { tab: after?.name, file: pgfxHeader(poster).name });
  await run(c.page, 'file.close');
  await wait(500);
  await c.app.evaluate((_e, p) => globalThis.__t.openQueue.push(p), poster);
  await run(c.page, 'file.open');
  await poll(async () => (await sessions(c.page)).length === 1, 8000);
  const reopened = (await sessions(c.page))[0];
  const title = await c.page.title();
  check('reopened, the tab and window title follow the file name', reopened?.name === 'My Poster' && /^My Poster/.test(title), { name: reopened?.name, title });
  await exitApp(c);
}

finish();
