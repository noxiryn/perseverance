#!/usr/bin/env node
/**
 * Saving / crash recovery / opening files in the REAL Electron app (production build in dist/) — the
 * paths where user work used to be lost (docs/status/release-review.json):
 *
 *  crash   crash (SIGKILL) with an autosaved project, then reopen it by double-click (argv): the
 *          recovery offer still appears; "Later", Save and Close on the reopened copy keep the crash
 *          entry (app-logic-diff-1). The next start offers it again, but as older than the version
 *          saved since: unticked, Enter doesn't recover it, Recover opens a separate unsaved copy and
 *          the newer file is never replaced (gate-fix-diff-review-1). New unsaved work + another crash:
 *          that copy is newer than the file, so Recover adds it to the open copy as an undoable step
 *          that saves back to the file. Entries carry their list info ('meta' store,
 *          gate-fix-diff-review-2).
 *  quit    the native "Quit Anyway" (close again while the unsaved-changes prompt is open) and a
 *          Windows session end keep the autosaved copy and the next start offers it — with an edit
 *          made after the last autosave; the in-app Discard deletes it (packaged-app-5,
 *          electron-security-2, app-logic-diff-2).
 *  forced  default 2-minute autosave interval, nothing autosaved yet: the UI breaks (a dialog throws)
 *          and the user closes → "Quit Anyway": the page writes its copy first and the next start
 *          offers the edit; a busy page (no answer to the close request) gets the honest "may be
 *          lost" text and Quit Anyway doesn't hang on it.
 *  drop    a .pgfx dropped from the file manager (native drag) opens with its path: Save writes in
 *          place, it joins Open Recent, dropping it again switches to its tab; a File built by page
 *          script gets no path (packaged-app-2, electron-security-3).
 *  name    Save As stores the chosen file name inside the file; reopening names the tab after the
 *          file (packaged-app-1).
 *  fonts   a friend's project with an embedded font this machine lacks: the autosave entry carries the
 *          font, so after a crash + Recover the text still uses it (no fallback, no warning) and Save
 *          writes it back into the project; Save as Template keeps it too, also after a restart
 *          (app-logic-diff-4).
 *  overwrite  Save As onto a project open in another tab is refused (choose another name), and the
 *          proposed name for a document without a file skips it ("A copy.pgfx"): two tabs never share
 *          one file.
 *
 *   npx vite build && xvfb-run -a -s "-screen 0 1600x960x24" node scripts/electron-recovery-check.mjs \
 *     [--app <dir with electron/, package.json, dist/>] [--tmp dir] [--only crash,quit,forced,drop,name,fonts,overwrite] [--shot offer.png]
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
const only = String(arg('only', 'crash,quit,forced,drop,name,fonts,overwrite')).split(',');
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

/**
 * Launch with an isolated profile and test doubles for native dialogs (answers queued per test).
 * `defaultAutosave`: keep the app's own 2-minute interval (otherwise every 15 s tick autosaves).
 */
async function launch(profile, extraArgs = [], { defaultAutosave = false } = {}) {
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
  if (!defaultAutosave)
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
        // No version: whatever the app created (2: 'docs' + 'meta'). Closed right away so it never
        // blocks the app's own upgrade.
        const r = indexedDB.open('perseverance-recovery');
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('docs')) {
            db.close();
            return res([]);
          }
          const stores = db.objectStoreNames.contains('meta') ? ['docs', 'meta'] : ['docs'];
          const t = db.transaction(stores);
          const q = t.objectStore('docs').getAll();
          const m = stores.length > 1 ? t.objectStore('meta').getAllKeys() : null;
          t.oncomplete = () => {
            db.close();
            const metaKeys = m ? new Set(m.result) : null;
            res(
              q.result.map((e) => {
                const n = new DataView(e.data).getUint32(6, true);
                const hdr = JSON.parse(new TextDecoder().decode(new Uint8Array(e.data, 10, n)));
                return {
                  key: e.id,
                  launch: e.launchId ?? null,
                  guides: hdr.document.guides.length,
                  path: e.filePath ?? null,
                  fonts: (hdr.fonts ?? []).map((f) => f.family),
                  // The recovery list reads only 'meta': every entry needs its info row.
                  meta: metaKeys ? metaKeys.has(e.id) : null,
                };
              }),
            );
          };
          t.onerror = () => {
            db.close();
            res([]);
          };
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
/** Families of the fonts embedded in .pgfx bytes. */
function pgfxFonts(bytes) {
  const b = Buffer.from(bytes);
  const n = b.readUInt32LE(6);
  return (JSON.parse(b.subarray(10, 10 + n).toString('utf8')).fonts ?? []).map((f) => f.family);
}
/** A .pgfx with no bitmaps and the given embedded font files (src/io/container.ts layout). */
function packPgfx(header, fonts) {
  let offset = 0;
  const entries = fonts.map((f) => {
    const e = { family: f.family, weight: f.weight, style: f.style, fileName: f.fileName, format: f.format, offset, length: f.data.length };
    offset += f.data.length;
    return e;
  });
  const json = Buffer.from(JSON.stringify({ ...header, bitmaps: [], fonts: entries }), 'utf8');
  const pre = Buffer.alloc(10);
  pre.write('PGFX', 0, 'latin1');
  pre.writeUInt16LE(1, 4);
  pre.writeUInt32LE(json.length, 6);
  return Buffer.concat([pre, json, ...fonts.map((f) => f.data)]);
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
/**
 * End the app. Never hangs: a document left dirty (e.g. after a failed check) would keep app.close()
 * waiting on the unsaved-changes prompt, so the process is killed after a moment.
 */
async function exitApp(ctx) {
  await Promise.race([ctx.app.close().catch(() => {}), wait(5000)]);
  try {
    ctx.app.process().kill('SIGKILL');
  } catch {
    /* already gone */
  }
  await Promise.race([ctx.exited, wait(3000)]);
}
/** The open copy of `file` reaches `pred` (sessions poll; slow on a loaded machine). */
const sessionOn = (page, file, pred, timeout = 15000) => poll(async () => (await sessions(page)).find((s) => s.path === file && pred(s)), timeout);

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
  check('autosave wrote the unsaved work (data + list info)', !!crashEntry && crashEntry.meta === true, crashEntry);
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
  await sessionOn(c.page, poster, (s) => !s.dirty);
  await run(c.page, 'file.close');
  await poll(async () => (await sessions(c.page)).length === 0 && (await idb(c.page)).length === 1, 10000);
  const afterClose = await idb(c.page);
  check('Save and Close on the reopened copy keep the crash entry', afterClose.length === 1 && afterClose[0].guides === 5, afterClose);
  check('the file holds the saved state (1 guide)', pgfxHeader(poster).guides.length === 1, pgfxHeader(poster).guides.length);
  await closeWindow(c.app);
  await Promise.race([c.exited, wait(8000)]);

  // Next double-click: offered again — but the file was saved after that autosave (1 guide on disk, newer
  // than the 5-guide copy). The copy must never be bound to the file again: unticked, labelled older
  // than the saved version, Enter doesn't recover it, and Recover opens it as a separate unsaved copy, so
  // a Save can't quietly replace the newer file (gate-fix-diff-review-1).
  c = await launch('cfg-crash', [poster]);
  await poll(async () => /Recover unsaved documents\?/.test(await dialogText(c.page)), 10000);
  await poll(async () => (await sessions(c.page)).some((s) => s.path === poster), 8000);
  await wait(500);
  const text3 = await dialogText(c.page);
  const ticked3 = await c.page.evaluate(() => [...document.querySelectorAll('.ui-dialog .io-recover-item input[type=checkbox]')].map((x) => x.checked));
  check(
    'offered again on the next start, as older than the version saved since (unticked, not “Open now as”)',
    /older than the version of the project you saved since/.test(text3) && /Older than the version you saved/.test(text3) && !/Open now as/.test(text3) && ticked3.length === 1 && !ticked3[0],
    { text: text3.slice(0, 320), ticked3 },
  );
  await c.page.keyboard.press('Enter');
  await wait(800);
  const afterEnter = await sessions(c.page);
  check(
    'Enter does not recover the older copy',
    /Recover unsaved documents\?/.test(await dialogText(c.page)) && afterEnter.length === 1 && afterEnter[0].guides === 1 && !afterEnter[0].dirty,
    afterEnter,
  );
  await c.page.click('.ui-dialog .io-recover-item input[type=checkbox]');
  await clickDialogButton(c.page, 'Recover');
  const copy = await poll(async () => (await sessions(c.page)).find((s) => s.path === null && s.guides === 5), 15000);
  const all3 = await sessions(c.page);
  const open3 = all3.find((s) => s.path === poster);
  check(
    'Recover opens it as a separate unsaved copy; the open project is untouched',
    !!copy && copy.dirty && /^Poster \(autosaved .+\)$/.test(copy.name) && all3.length === 2 && open3?.guides === 1 && !open3.dirty && open3.last !== 'Recover Autosaved Changes',
    all3,
  );
  // Save on the copy asks where (cancelled here): the newer file is never replaced.
  await c.page.evaluate((id) => window.__app.useEditor.getState().setActiveDoc(id), copy?.id);
  const savesBefore = (await T_(c.app)).saves.length;
  await run(c.page, 'file.save');
  await poll(async () => (await T_(c.app)).saves.length > savesBefore, 8000);
  check('Save on the copy goes through Save As; the file keeps the newer work (1 guide)', (await T_(c.app)).saves.length > savesBefore && pgfxHeader(poster).guides.length === 1, {
    saves: (await T_(c.app)).saves,
    guides: pgfxHeader(poster).guides.length,
  });
  const kept3 = await idb(c.page);
  check('the copy is kept under this launch without the file; the old entry is gone', kept3.length === 1 && kept3[0].guides === 5 && kept3[0].path === null && kept3[0].meta !== false, kept3);
  check('no page errors (older copy)', c.errors.length === 0, c.errors.slice(0, 3));
  // Throw the copy away, then make new unsaved work on the project and crash again.
  const copyId = copy?.id;
  await c.page.evaluate((id) => {
    const ed = window.__app.useEditor.getState();
    ed.markSaved(id); // close without the prompt
    ed.closeDocument(id);
  }, copyId);
  await poll(async () => (await idb(c.page)).length === 0, 10000);
  await c.page.evaluate(() => {
    const ed = window.__app.useEditor.getState();
    const s = Object.values(ed.sessions)[0];
    if (s) ed.setActiveDoc(s.doc.id);
  });
  await addGuides(c.page, 2);
  const crash2 = await poll(async () => (await idb(c.page)).find((e) => e.guides === 3 && e.path === poster), 40000, 1000);
  check('autosave wrote the new unsaved work on the project (3 guides)', !!crash2, crash2);
  c.app.process().kill('SIGKILL');
  await wait(1500);

  // Double-click again: this entry is newer than the file. Recover adds it to the open copy as one
  // undoable step that saves back to the file (app-logic-diff-1).
  c = await launch('cfg-crash', [poster]);
  await poll(async () => /Recover unsaved documents\?/.test(await dialogText(c.page)), 10000);
  await poll(async () => (await sessions(c.page)).some((s) => s.path === poster), 8000);
  await wait(500);
  const text4 = await dialogText(c.page);
  const ticked4 = await c.page.evaluate(() => [...document.querySelectorAll('.ui-dialog .io-recover-item input[type=checkbox]')].map((x) => x.checked));
  check('a copy newer than the file is offered ticked, “Open now as” the open project', /Open now as “Poster”/.test(text4) && !/Older than/.test(text4) && ticked4.join() === 'true', { text: text4.slice(0, 260), ticked4 });
  await clickDialogButton(c.page, 'Recover');
  // Decoding and applying the 13 MB entry takes 1–2 s (more on a loaded machine).
  await sessionOn(c.page, poster, (s) => s.last === 'Recover Autosaved Changes');
  const rec = await sessions(c.page);
  const onFile = rec.filter((s) => s.path === poster);
  check('Recover adds the changes to the open copy (one tab, dirty, undoable step)', rec.length === 1 && onFile.length === 1 && onFile[0].guides === 3 && onFile[0].dirty && onFile[0].last === 'Recover Autosaved Changes', rec);
  await c.page.evaluate(() => window.__app.useEditor.getState().undo());
  const undone = (await sessions(c.page)).find((s) => s.path === poster);
  await c.page.evaluate(() => window.__app.useEditor.getState().redo());
  check('Undo goes back to the file’s version', undone?.guides === 1 && !undone.dirty, undone);
  await run(c.page, 'file.save');
  await poll(async () => pgfxHeader(poster).guides.length === 3 && (await idb(c.page)).length === 0, 15000);
  const saved = pgfxHeader(poster);
  const left = await idb(c.page);
  check('Save writes the recovered work to the file; no entry left', saved.guides.length === 3 && left.length === 0, { guides: saved.guides.length, left });
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
  return { offered: !!offered, entries: entries.length, guides: entries.map((e) => e.guides) };
}

if (only.includes('quit')) {
  // Close → in-app prompt → close again after a moment → native "Quit without answering…" → Quit Anyway.
  let c = await dirtyAutosaved('cfg-stuck');
  check('dirty document autosaved (stuck)', !!c.entry);
  await closeWindow(c.app);
  const inApp = await poll(() => c.page.evaluate(() => document.body.innerText.includes('Save changes before closing?')), 6000);
  await wait(300);
  await addGuides(c.page, 1); // an edit after the copy (the prompt is open; the 15 s tick hasn't run)
  await wait(1400);
  await answerBox(c.app, 0); // "Wait" first, to read what the prompt says…
  await closeWindow(c.app);
  const box = await poll(async () => (await T_(c.app)).boxes.find((b) => /Quit without answering/.test(b.message)), 4000);
  await wait(300);
  await answerBox(c.app, 1); // …then Quit Anyway
  await closeWindow(c.app);
  const code = await Promise.race([c.exited, wait(15000).then(() => 'timeout')]);
  check(
    'Quit Anyway exits; its prompt says changes are not saved and an autosave is tried first',
    inApp && code !== 'timeout' && /not saved to their files/.test(box?.detail ?? '') && /first tries to autosave/.test(box?.detail ?? ''),
    { inApp, code, box: box?.detail },
  );
  if (code === 'timeout') await exitApp(c);
  let r = await offeredOnRelaunch('cfg-stuck');
  check('after Quit Anyway the next start offers the autosaved copy, with the last edit', r.offered && r.entries === 1 && r.guides[0] === 4, r);

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
/* forced quits with the default autosave interval                          */
/* ======================================================================== */
if (only.includes('forced')) {
  // The UI breaks right after an edit (a dialog throws while rendering: the window goes blank), long
  // before the 2-minute autosave. The user closes → "Quit Perseverance?" → Quit Anyway.
  let c = await launch('cfg-uicrash', [], { defaultAutosave: true });
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page);
  await addGuides(c.page, 3);
  await wait(1500);
  await c.page.evaluate(() => {
    window.__app.useUI.setState((st) => ({
      dialogs: [...st.dialogs, { id: 'boom', component: () => { throw new Error('simulated UI crash'); }, props: {} }],
    }));
  });
  await wait(800);
  const broken = await c.page.evaluate(() => ({ shell: !!document.querySelector('.shell-root'), dirty: Object.values(window.__app.useEditor.getState().sessions).some((s) => s.dirty) }));
  const before = await idb(c.page);
  check('UI crash with an unsaved edit, nothing autosaved yet (default interval)', !broken.shell && broken.dirty && before.length === 0, { broken, before });
  await answerBox(c.app, 1); // Quit Anyway
  await closeWindow(c.app);
  const box = await poll(async () => (await T_(c.app).catch(() => null))?.boxes.find((b) => /Quit Perseverance/.test(b.message)), 6000);
  const code = await Promise.race([c.exited, wait(20000).then(() => 'timeout')]);
  check('Quit Anyway (UI crash) exits; the prompt says an autosave is tried first', code !== 'timeout' && /first tries to autosave/.test(box?.detail ?? ''), { code, box: box?.detail });
  if (code === 'timeout') await exitApp(c);
  let r = await offeredOnRelaunch('cfg-uicrash');
  check('after Quit Anyway (UI crash) the next start offers the edit', r.offered && r.entries === 1 && r.guides[0] === 3, r);

  // A busy page (a long task: no answer to the close request) → "not responding" → Quit Anyway. It
  // can't write a copy, so the prompt must not promise one, and the quit must not wait on it for long.
  c = await launch('cfg-busy', [], { defaultAutosave: true });
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page);
  await addGuides(c.page, 2);
  await answerBox(c.app, 1); // Quit Anyway
  await c.page.evaluate(() => {
    setTimeout(() => {
      const t = Date.now();
      while (Date.now() - t < 25000);
    }, 0);
  });
  await wait(200);
  const t0 = Date.now();
  await closeWindow(c.app);
  // Read the prompt while the app is still there (it quits ~2 s after "Quit Anyway").
  const boxB = await poll(async () => (await T_(c.app).catch(() => null))?.boxes.find((b) => /not responding/.test(b.message)), 6000, 100);
  const codeB = await Promise.race([c.exited, wait(25000).then(() => 'timeout')]);
  const quitMs = Date.now() - t0;
  // 1.5 s for the close request + ≤ 2 s for the page to start writing + ≤ 5 s for a wedged window to go.
  check(
    'busy page: Quit Anyway exits without waiting for the page; the prompt says changes may be lost',
    codeB !== 'timeout' && quitMs < 14000 && /may be lost/.test(boxB?.detail ?? '') && !/first tries to autosave/.test(boxB?.detail ?? ''),
    { codeB, quitMs, box: boxB?.detail },
  );
  if (codeB === 'timeout') await exitApp(c);
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
  // Reading + granting + decoding a big project takes a moment (more on a loaded machine).
  await poll(async () => (await sessions(c.page)).length === 1, 15000);
  let s = await sessions(c.page);
  const recent = await c.page.evaluate(() => JSON.parse(localStorage.getItem('perseverance.recent') || '[]').map((e) => e.path));
  check('a dropped .pgfx opens with its path and joins Open Recent', s.length === 1 && s[0].path === poster && s[0].name === 'Poster' && recent.includes(poster), { s, recent });
  const before = fs.readFileSync(poster);
  const savesBefore = (await T_(c.app)).saves.length;
  await addGuides(c.page, 2);
  await run(c.page, 'file.save');
  await poll(async () => pgfxHeader(poster).guides.length === 2, 10000);
  const savesAfter = (await T_(c.app)).saves.length;
  check('Save writes the dropped file in place (no Save As dialog)', savesAfter === savesBefore && !before.equals(fs.readFileSync(poster)) && pgfxHeader(poster).guides.length === 2, { dialogs: savesAfter - savesBefore });
  await nativeDrop(poster);
  const switched = await poll(() => c.page.evaluate(() => document.body.innerText.includes('is already open')), 15000);
  await wait(500);
  s = await sessions(c.page);
  check('dropping it again switches to its tab (no second copy)', switched && s.length === 1, { switched, s });
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

/* ======================================================================== */
/* a shared project's embedded font survives a crash and Save as Template  */
/* ======================================================================== */
if (only.includes('fonts')) {
  const dir = path.join(T, 'fonts');
  fs.mkdirSync(dir, { recursive: true });
  const friend = path.join(dir, 'Friend Poster.pgfx');
  // A friend's project: one text layer in "FriendFont", which is neither bundled nor installed here.
  const fontFile = path.join(root, 'node_modules', '@fontsource', 'allura', 'files', 'allura-latin-400-normal.woff2');
  const fontState = (page) =>
    page.evaluate(() => ({
      registered: window.__app.fonts.list().some((f) => f.family === 'FriendFont'),
      loaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'FriendFont' && f.status === 'loaded'),
    }));
  const trackToasts = (page) =>
    page.evaluate(() => {
      window.__toasts = [];
      window.__app.useUI.subscribe((st, prev) => {
        for (const t of st.toasts) if (!prev.toasts.includes(t)) window.__toasts.push(`${t.kind}: ${t.message}`);
      });
    });
  const toasts = (page) => page.evaluate(() => window.__toasts.slice());
  const fontWarnings = (list) => list.filter((t) => /FriendFont/.test(t) && /missing|not installed|fallback|isn.t available|unavailable/i.test(t));

  let c = await launch('cfg-fonts');
  await wait(1500);
  await dismissDialogs(c.page);
  const docJson = await c.page.evaluate(() => {
    const { createDocument, makeTextLayer } = window.__app.documentUtils;
    const d = createDocument({ name: 'Friend Poster', width: 800, height: 450, background: '#ffffff' });
    const t = makeTextLayer({ name: 'Title', text: { content: 'Friend Title', fontFamily: 'FriendFont', fontSize: 96 }, x: 60, y: 120 });
    d.layers[t.id] = t;
    d.rootIds = [t.id];
    return d;
  });
  fs.writeFileSync(
    friend,
    packPgfx({ version: 1, app: 'Perseverance (check)', savedAt: new Date().toISOString(), document: docJson }, [
      { family: 'FriendFont', weight: 400, style: 'normal', fileName: 'FriendFont.woff2', format: 'woff2', data: fs.readFileSync(fontFile) },
    ]),
  );
  const before = await fontState(c.page);
  await c.app.evaluate((_e, p) => globalThis.__t.openQueue.push(p), friend);
  await run(c.page, 'file.open');
  await poll(async () => (await sessions(c.page)).length === 1, 8000);
  const opened = await poll(async () => (await fontState(c.page)).loaded, 8000);
  check('opening the shared project registers its embedded font for the session', !before.registered && opened, { before, after: await fontState(c.page) });
  await c.page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    st.commit('Edit Text', (d) => {
      const l = Object.values(d.layers).find((x) => x.type === 'text');
      l.text.content = 'Edited Title';
    });
  });
  const entry = await poll(async () => (await idb(c.page)).find((e) => e.path === friend), 40000, 1000);
  check('the autosave entry carries the session-only font', entry?.fonts.includes('FriendFont'), entry);
  c.app.process().kill('SIGKILL');
  await wait(1500);

  c = await launch('cfg-fonts');
  await trackToasts(c.page);
  await poll(async () => /Recover unsaved documents\?/.test(await dialogText(c.page)), 10000);
  const atStart = await fontState(c.page);
  await clickDialogButton(c.page, 'Recover');
  await poll(async () => (await sessions(c.page)).length === 1, 8000);
  const back = await poll(async () => (await fontState(c.page)).loaded, 8000);
  await wait(3500); // the missing-font report waits for installed fonts (up to 3 s)
  const tl = await toasts(c.page);
  check('after a crash + Recover the text still has its font (no fallback, no warning)', !atStart.registered && back && fontWarnings(tl).length === 0, { atStart, toasts: tl });
  await run(c.page, 'file.save');
  await poll(async () => pgfxHeader(friend).layers && Object.values(pgfxHeader(friend).layers).some((l) => l.text?.content === 'Edited Title'), 8000);
  check('Save writes the recovered work with the font still embedded', pgfxFonts(fs.readFileSync(friend)).includes('FriendFont'), pgfxFonts(fs.readFileSync(friend)));

  // Save as Template keeps the font; a restart (font gone from the session) still has it.
  await run(c.page, 'file.saveAsTemplate');
  await poll(async () => (await dialogText(c.page)).includes('Save as Template'), 6000);
  await c.page.keyboard.press('Enter');
  const tplId = await poll(() => c.page.evaluate(() => window.__app.templates.list().find((t) => t.id.startsWith('user-tpl:'))?.id), 8000);
  const tplBytes = await c.page.evaluate(
    (id) =>
      new Promise((res) => {
        const r = indexedDB.open('perseverance-templates', 1);
        r.onsuccess = () => {
          const q = r.result.transaction('templates').objectStore('templates').get(id);
          q.onsuccess = () => res(q.result ? Array.from(new Uint8Array(q.result)) : null);
        };
        r.onerror = () => res(null);
      }),
    tplId,
  );
  check('Save as Template embeds the font', !!tplBytes && pgfxFonts(Uint8Array.from(tplBytes)).includes('FriendFont'), tplBytes ? pgfxFonts(Uint8Array.from(tplBytes)) : null);
  check('no page errors (fonts scenario)', c.errors.length === 0, c.errors.slice(0, 3));
  await closeWindow(c.app);
  await Promise.race([c.exited, wait(8000)]);

  c = await launch('cfg-fonts');
  await wait(1500);
  await dismissDialogs(c.page);
  const fresh = await fontState(c.page);
  await trackToasts(c.page);
  const fromTpl = await c.page.evaluate(async (id) => {
    const doc = await window.__app.templates.get(id).build();
    return Object.values(doc.layers).find((l) => l.type === 'text')?.text.fontFamily ?? null;
  }, tplId);
  const tplFont = await poll(async () => (await fontState(c.page)).loaded, 8000);
  check('after a restart the template brings its font back', !fresh.registered && fromTpl === 'FriendFont' && tplFont, { fresh, fromTpl, after: await fontState(c.page) });
  await exitApp(c);
}

/* ======================================================================== */
/* Save As onto a project open in another tab                               */
/* ======================================================================== */
if (only.includes('overwrite')) {
  const dir = path.join(T, 'overwrite');
  fs.mkdirSync(dir, { recursive: true });
  const A = path.join(dir, 'A.pgfx');
  const B = path.join(dir, 'B.pgfx');
  const c = await launch('cfg-overwrite');
  await wait(1500);
  await dismissDialogs(c.page);
  await openTemplate(c.page);
  await queueSave(c.app, A);
  await run(c.page, 'file.saveAs');
  await poll(async () => fs.existsSync(A) && pgfxHeader(A).name === 'A', 10000);
  const aBytes = fs.readFileSync(A);
  // A second document also called "A", without a file.
  await c.page.evaluate(() => {
    const { createDocument } = window.__app.documentUtils;
    window.__app.useEditor.getState().openDocument(createDocument({ name: 'A', width: 640, height: 360, background: '#202020' }), { label: 'New' });
  });
  await wait(300);
  const savesBefore = (await T_(c.app)).saves.length;
  await queueSave(c.app, A); // the user picks A.pgfx anyway…
  await answerBox(c.app, 1); // …"Choose Another Name"…
  await run(c.page, 'file.saveAs'); // …and then cancels the second dialog
  await poll(async () => (await T_(c.app)).saves.length >= savesBefore + 2, 8000);
  await wait(300);
  const t = await T_(c.app);
  const proposed = t.saves.slice(savesBefore);
  const box = t.boxes.find((b) => /is open in another tab/.test(b.message));
  const s1 = await sessions(c.page);
  check(
    'Save As onto the project open in another tab is refused (asks for another name); the file is untouched',
    !!box && fs.readFileSync(A).equals(aBytes) && s1.filter((s) => s.path === A).length === 1 && s1.some((s) => s.path === null),
    { box: box?.message, s1 },
  );
  check('the proposed names skip the open file ("A copy.pgfx")', proposed.length === 2 && proposed.every((p) => p === path.join(dir, 'A copy.pgfx')), proposed);
  await queueSave(c.app, B);
  await run(c.page, 'file.saveAs');
  await poll(async () => fs.existsSync(B), 8000);
  await wait(500);
  const s2 = await sessions(c.page);
  check('another name saves normally: two tabs, two files', s2.length === 2 && s2.some((s) => s.path === A && !s.dirty) && s2.some((s) => s.path === B && !s.dirty), s2);
  check('no page errors (overwrite scenario)', c.errors.length === 0, c.errors.slice(0, 3));
  await exitApp(c);
}

finish();
