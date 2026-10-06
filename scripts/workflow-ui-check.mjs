#!/usr/bin/env node
/**
 * Regression check for the thumbnail-workflow / UI release fixes, driven through the real UI in
 * headless Chromium against a running dev server or `vite preview`:
 *
 *   e2e-flows-1     Pose Studio "Head" render / a bust image replacing a template placeholder whose
 *                   box runs past the canvas: the face stays on the canvas, where the placeholder's
 *                   head was (fit.ts 'cut').
 *   e2e-flows-4     Looks in Layer mode on a text layer only change that layer's pixels; Document
 *                   is the default; a look's clip layer targets the layer it styles (Remove takes only
 *                   that look); an adjustment layer blocks Layer mode (no whole-document fallback);
 *                   Document-mode Remove keeps Layer looks.
 *   e2e-flows-5     Ctrl+= while typing keeps editing; Ctrl+J commits the typed text, then duplicates;
 *                   Ctrl+I / Ctrl+U do nothing and Ctrl+B / Ctrl+I toggle faux bold / italic while typing.
 *   e2e-flows-6     A .psd (image/vnd.adobe.photoshop) dropped on a selected placeholder opens as a
 *                   document — no "Replace" hint while dragging, no menu; a PNG still gets both (and
 *                   Escape closes the menu).
 *   app-logic-diff-3 Escape in a colour popover inside Edit ▸ Fill closes only the popover (also from
 *                   its hex field, focus back on the swatch); a second Escape closes the dialog. With
 *                   the command palette over a popover, Escape closes the palette first.
 *   first-user-1    Move-tool double-click on the glyphs of every text layer of the templates with
 *                   full-canvas textures above their text (Sunburst, Noir, Horror, Group Banner, Anime)
 *                   and of Gothic / Crimson opens that layer (a faint layer may give way to the solid
 *                   title above it) — before, the textures stopped the pick and nothing opened.
 *   first-user-2    Gothic Paper Poster: retitling leaves no "Birdcage" behind (the offset ghost is the
 *                   Title's drop shadow, not a second text layer).
 *   first-user-3    Libraries ▸ Backgrounds ▸ double-click Gradient Backdrop with the character
 *                   selected: placed behind the character, above the template's background group.
 *   first-user-4    Centered titles keep their centre when retyped (Sunburst "Ro" / "Shadow Realm").
 *   first-user-5    1366×768 window, UI scale 150 %: the UI is scaled only as far as it stays
 *                   ≥ 1024×640 (110 %), Preferences says so, and Layers rows are visible in the dock.
 *
 *   npx vite --port 5300 &   node scripts/workflow-ui-check.mjs --url http://localhost:5300 [--out dir] [--only e2e-flows-1,...]
 *
 * Prints one PASS/FAIL line per check and "WORKFLOW-UI OK" when all pass; exit code 1 otherwise.
 */
import { chromium } from 'playwright-core';
import { writePsdBuffer } from 'ag-psd';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};
const url = arg('url', 'http://localhost:5173');
const outDir = arg('out', 'screenshots-tmp/workflow-ui');
const only = typeof arg('only', '') === 'string' && arg('only', '') ? String(arg('only', '')).split(',') : null;
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource.*404|willReadFrequently/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const wait = (ms) => page.waitForTimeout(ms);
const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
};
const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
await page.evaluate(() => localStorage.removeItem('perseverance.looks'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
await wait(800);

/* ---------------- helpers ---------------- */

async function closeAll() {
  await page.evaluate(() => {
    window.__app.useUI.setState({ dialogs: [] });
    const st = window.__app.useEditor.getState();
    for (const id of Object.keys(st.sessions)) st.closeDocument(id);
  });
  await wait(200);
}

/** File ▸ New from Template, click the card whose text matches. */
async function openTemplate(name) {
  await closeAll();
  await page.evaluate(() => window.__app.runCommand('file.newFromTemplate'));
  await page.locator('.templates-card').filter({ hasText: new RegExp(name) }).first().click();
  await page.waitForFunction(() => window.__app.useUI.getState().dialogs.length === 0 && !!window.__app.useEditor.getState().activeDocId, null, { timeout: 60000 });
  await wait(1500);
}

/** Active layer: box on the canvas, its opaque pixels' extent and how many are on the canvas. */
const activeInfo = (redOnly = false) =>
  page.evaluate((redOnly) => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const l = s.doc.layers[s.activeLayerId];
    const t = l.transform;
    const h = l.height * Math.abs(t.scaleY);
    const top = t.y + l.height / 2 - h / 2;
    const k = h / l.height;
    const bmp = window.__app.bitmaps.get(l.bitmapId);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let tot = 0, on = 0, y0 = Infinity, y1 = -Infinity;
    for (let y = 0; y < c.height; y++) {
      const dy = top + (y + 0.5) * k;
      for (let xx = 0; xx < c.width; xx++) {
        const i = (y * c.width + xx) * 4;
        if (d[i + 3] <= 128) continue;
        if (redOnly && !(d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90)) continue;
        tot++;
        if (dy >= 0 && dy < s.doc.height) on++;
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    return { name: l.name, placeholder: !!l.meta?.placeholder, docH: s.doc.height, top, contentTop: top + y0 * k, contentBottom: top + (y1 + 1) * k, onCanvas: tot ? on / tot : 0 };
  }, redOnly);

/* ---------------- e2e-flows-1 ---------------- */

async function flows1() {
  await openTemplate('Sunburst');
  const ph = await activeInfo();
  await page.evaluate(() => window.__app.runCommand('roblox.poseStudio'));
  await page.waitForSelector('.ui-dialog button:has-text("Add to Document")', { timeout: 60000 });
  await wait(2500);
  await page.locator('.ui-dialog button').filter({ hasText: /^Head$/ }).first().click();
  await wait(1500);
  await page.getByRole('button', { name: /Add to Document/ }).click();
  await page.waitForFunction(() => window.__app.useUI.getState().dialogs.length === 0, null, { timeout: 120000 });
  await wait(1500);
  const r = await activeInfo();
  await shot('flows1-pose-head');
  check(
    'e2e-flows-1 (Pose Studio Head)',
    r.onCanvas > 0.97 && Math.abs(r.contentTop - ph.contentTop) < 40 && !r.placeholder,
    `placeholder content top ${Math.round(ph.contentTop)}, render content ${Math.round(r.contentTop)}..${Math.round(r.contentBottom)} on a ${r.docH}px canvas, ${Math.round(r.onCanvas * 100)}% on canvas`,
  );

  // A bust image (head drawn red, torso cut by the bottom edge) via Replace Character ▸ Choose Image.
  // Also one whose bottom fades out (common in GFX renders) with transparent rows under it: its cut
  // isn't detected from the pixels, the geometry (wide image, box past the canvas) catches it.
  const pngs = await page.evaluate(() => {
    const make = (fade) => {
      const c = document.createElement('canvas');
      c.width = 420;
      c.height = fade ? 423 : 420;
      const x = c.getContext('2d');
      x.fillStyle = '#2050c0';
      x.fillRect(50, 250, 320, 170);
      x.fillStyle = '#e03030';
      x.fillRect(120, 50, 180, 190);
      if (fade) {
        x.globalCompositeOperation = 'destination-out';
        const g = x.createLinearGradient(0, 360, 0, 420);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,1)');
        x.fillStyle = g;
        x.fillRect(0, 360, 420, 63);
      }
      return c.toDataURL('image/png').split(',')[1];
    };
    return { hard: make(false), faded: make(true) };
  });
  const files = {};
  for (const [k, v] of Object.entries(pngs)) {
    files[k] = path.join(outDir, `bust-${k}.png`);
    fs.writeFileSync(files[k], Buffer.from(v, 'base64'));
  }
  for (const [tpl, kind] of [
    ['Gothic', 'hard'],
    ['Noir', 'hard'],
    ['Sunburst', 'faded'],
    ['Crimson', 'faded'],
  ]) {
    const file = files[kind];
    await openTemplate(tpl);
    const before = await activeInfo();
    await page.evaluate(() => window.__app.runCommand('roblox.replaceCharacter'));
    await page.waitForSelector('.ui-dialog', { timeout: 10000 });
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Choose Image/ }).click()]);
    await fc.setFiles(file);
    await page.waitForFunction(() => window.__app.useUI.getState().dialogs.length === 0, null, { timeout: 30000 });
    await wait(1000);
    const head = await activeInfo(true);
    await shot(`flows1-bust-${kind}-${tpl}`);
    check(
      `e2e-flows-1 (${kind === 'faded' ? 'faded ' : ''}bust on ${tpl})`,
      head.onCanvas > 0.99 && head.contentTop >= before.contentTop - 10 && head.contentTop < before.contentTop + 0.25 * (head.docH - before.contentTop),
      `placeholder head at ${Math.round(before.contentTop)}, bust head ${Math.round(head.contentTop)}..${Math.round(head.contentBottom)} (${Math.round(head.onCanvas * 100)}% on canvas)`,
    );
  }
}

/* ---------------- e2e-flows-4 ---------------- */

/** Viewport pixels (base64 PNG, toasts hidden) for before/after comparisons. */
const viewportShot = async () => {
  const style = await page.addStyleTag({ content: '.shell-toasts { visibility: hidden !important; }' });
  const png = (await page.locator('[data-viewport]').screenshot()).toString('base64');
  await style.evaluate((el) => el.remove());
  return png;
};

async function diffFraction(a, b) {
  return page.evaluate(
    async ({ a, b }) => {
      const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${s}`; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
      const da = px(ia), db = px(ib);
      let n = 0;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
      return n / (da.length / 4);
    },
    { a, b },
  );
}

async function flows4() {
  await openTemplate('Crimson');
  const tab = page.locator('.shell-group-tab').filter({ hasText: /^Looks$/ }).first();
  await tab.click();
  await wait(400);
  const defaultTarget = await page.locator('.looks-seg button[aria-selected="true"]').innerText();
  // Select the "Name" text layer, Looks ▸ Layer, then Noir Newspaper.
  const nameId = await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const l = Object.values(s.doc.layers).find((x) => x.type === 'text' && x.name === 'Name');
    st.setActiveLayer(l.id);
    window.__app.runCommand('view.fit');
    return l.id;
  });
  await page.locator('.looks-seg button').filter({ hasText: /Layer/ }).click();
  await wait(1200);
  const before = await viewportShot();
  await page.locator('.looks-card[data-look-id="noir-newspaper"]').click();
  await page.waitForFunction(() => {
    const st = window.__app.useEditor.getState();
    return st.sessions[st.activeDocId].history.entries.some((e) => /Look/.test(e.label));
  }, null, { timeout: 30000 });
  await wait(1500);
  const after = await viewportShot();
  const changed = await diffFraction(before, after);
  const tree = await page.evaluate((nameId) => {
    const st = window.__app.useEditor.getState();
    const d = st.sessions[st.activeDocId].doc;
    const rootLookGroups = d.rootIds.filter((id) => d.layers[id].type === 'group' && typeof d.layers[id].meta?.lookId === 'string').length;
    const clips = Object.values(d.layers).filter((l) => l.meta?.lookPart === 'clip');
    return { rootLookGroups, clips: clips.length, allClippedToName: clips.every((l) => l.clipped && l.meta.lookTargetId === nameId) };
  }, nameId);
  await shot('flows4-layer-look-on-text');
  check(
    'e2e-flows-4 (Layer look on text)',
    /Document/.test(defaultTarget) && tree.rootLookGroups === 0 && tree.clips > 0 && tree.allClippedToName && changed < 0.2,
    `default target "${defaultTarget.trim()}", root look groups ${tree.rootLookGroups}, clip layers ${tree.clips} (all on "Name": ${tree.allClippedToName}), ${(changed * 100).toFixed(1)}% of the view changed`,
  );
  // Ctrl+Z restores the document in one step.
  await page.evaluate(() => window.__app.runCommand('edit.undo'));
  await wait(1200);
  const undone = await diffFraction(before, await viewportShot());
  check('e2e-flows-4 (undo)', undone < 0.01, `${(undone * 100).toFixed(2)}% differs from before after one undo`);

  // Layer looks on the title and on the character; selecting one of the title's clip layers targets
  // the title, and Remove look removes only the title's look.
  const looksState = () =>
    page.evaluate(() => {
      const st = window.__app.useEditor.getState();
      const d = st.sessions[st.activeDocId].doc;
      const clips = Object.values(d.layers).filter((l) => l.meta?.lookPart === 'clip').map((l) => d.layers[l.meta.lookTargetId]?.name);
      const groups = Object.values(d.layers).filter((l) => l.type === 'group' && typeof l.meta?.lookId === 'string').length;
      return { clips, groups };
    });
  const setActive = (pred) =>
    page.evaluate((pred) => {
      const st = window.__app.useEditor.getState();
      const s = st.sessions[st.activeDocId];
      const l = Object.values(s.doc.layers).find(new Function('l', 'doc', `return (${pred})(l, doc)`).bind(null));
      st.setActiveLayer(l.id);
      return l.name;
    }, pred);
  const applyCard = async (id) => {
    const n = await page.evaluate(() => { const st = window.__app.useEditor.getState(); return st.sessions[st.activeDocId].history.index; });
    await page.locator(`.looks-card[data-look-id="${id}"]`).click();
    await page.waitForFunction((n) => { const st = window.__app.useEditor.getState(); return st.sessions[st.activeDocId].history.index > n; }, n, { timeout: 30000 });
    await wait(600);
  };
  await setActive("(l) => l.type === 'text' && l.name === 'Name'");
  await applyCard('noir-newspaper');
  await setActive('(l) => l.meta?.placeholder === true');
  await applyCard('sunburst-halftone');
  const s0 = await looksState();
  const clipName = await setActive(`(l, doc) => l.meta?.lookPart === 'clip' && l.meta.lookTargetId === ${JSON.stringify(nameId)}`);
  await wait(400);
  const label = (await page.locator('.looks-target').innerText()).trim();
  await page.locator('.looks-foot button').filter({ hasText: 'Remove look' }).click();
  await wait(800);
  const s1 = await looksState();
  const nameClips = (st) => st.clips.filter((n) => n === 'Name').length;
  check(
    'e2e-flows-4 (clip layer targets its layer)',
    label === 'Name' && nameClips(s0) > 0 && nameClips(s1) === 0 && s1.clips.length === s0.clips.length - nameClips(s0) && s1.clips.length > 0 && s1.groups === 0,
    `selected "${clipName}" → target "${label}"; clips ${JSON.stringify(s0.clips)} → ${JSON.stringify(s1.clips)}, look groups ${s1.groups}`,
  );

  // An adjustment layer in Layer mode: nothing to style — no whole-document fallback.
  await setActive("(l) => l.type === 'adjustment'");
  await wait(400);
  const adjLabel = (await page.locator('.looks-target').innerText()).trim();
  const cardOff = await page.locator('.looks-card[data-look-id="glitch-signal"]').isDisabled();
  const removeOff = await page.locator('.looks-foot button').filter({ hasText: 'Remove look' }).isDisabled();
  await shot('flows4-layer-mode-adjustment');
  check('e2e-flows-4 (adjustment layer blocks Layer mode)', /Pick a layer/.test(adjLabel) && cardOff && removeOff, `target "${adjLabel}", cards disabled ${cardOff}, Remove disabled ${removeOff}`);

  // Document mode (title's look back with Ctrl+Z): a document look on top — it restyles the
  // character, so the character's Layer look is replaced — then Remove look keeps the title's.
  await page.evaluate(() => window.__app.runCommand('edit.undo'));
  await wait(600);
  await page.locator('.looks-seg button').filter({ hasText: /Document/ }).click();
  await wait(400);
  await applyCard('glitch-signal');
  const s2 = await looksState();
  await page.locator('.looks-foot button').filter({ hasText: 'Remove look' }).click();
  await wait(800);
  const s3 = await looksState();
  check(
    'e2e-flows-4 (Document Remove keeps Layer looks)',
    s2.groups > 0 && s3.groups === 0 && nameClips(s2) === nameClips(s0) && nameClips(s3) === nameClips(s0),
    `look groups ${s2.groups} → ${s3.groups}, the title's Layer-look clips ${nameClips(s0)} → ${nameClips(s2)} → ${nameClips(s3)}`,
  );
}

/* ---------------- e2e-flows-5 ---------------- */

async function flows5() {
  const state = () =>
    page.evaluate(() => {
      const e = window.__app.useEditor.getState();
      const s = e.sessions[e.activeDocId];
      const ta = document.querySelector('textarea.type-ime');
      const texts = Object.values(s.doc.layers).filter((x) => x.type === 'text').map((x) => x.text.content);
      return { zoom: s.view.zoom, layers: Object.keys(s.doc.layers).length, editing: !!ta && document.activeElement === ta, texts, hist: s.history.entries.slice(0, s.history.index + 1).map((h) => h.label) };
    });
  const startEditing = async () => {
    await page.evaluate(() => window.__app.runCommand('view.fit'));
    await wait(300);
    const p = await page.evaluate(() => {
      const st = window.__app.useEditor.getState();
      const s = st.sessions[st.activeDocId];
      const l = Object.values(s.doc.layers).find((x) => x.type === 'text' && x.name === 'Name');
      st.setActiveLayer(l.id);
      st.setTool('type');
      const el = document.querySelector('[data-viewport]');
      const r = el.getBoundingClientRect();
      const v = s.view;
      const z = v.zoom || 1;
      const ox = r.width / 2 + v.panX - (s.doc.width * z) / 2;
      const oy = r.height / 2 + v.panY - (s.doc.height * z) / 2;
      return { x: r.left + ox + (l.transform.x + 40) * z, y: r.top + oy + (l.transform.y + 30) * z };
    });
    await page.mouse.click(p.x, p.y);
    await wait(300);
    await page.keyboard.press('End');
    await page.keyboard.type('S');
  };

  await openTemplate('Crimson');
  await startEditing();
  const a0 = await state();
  await page.keyboard.press('Control+Equal');
  await wait(300);
  const a1 = await state();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Q');
  await wait(200);
  const a2 = await state();
  check(
    'e2e-flows-5 (Ctrl+= keeps editing)',
    a0.editing && a1.editing && a1.zoom > a0.zoom && a2.editing && a2.layers === a0.layers && a2.texts.includes('YOUR NAMEQ'),
    `editing ${a0.editing}→${a1.editing}, zoom ${a0.zoom.toFixed(3)}→${a1.zoom.toFixed(3)}, after Backspace+Q: texts include "YOUR NAMEQ" ${a2.texts.includes('YOUR NAMEQ')}, layers ${a0.layers}→${a2.layers}`,
  );
  await page.keyboard.press('Escape');
  await wait(200);

  await openTemplate('Crimson');
  await startEditing();
  const b0 = await state();
  await page.keyboard.press('Control+j');
  await wait(400);
  const b1 = await state();
  const kept = b1.texts.filter((t) => t === 'YOUR NAMES').length;
  check(
    'e2e-flows-5 (Ctrl+J commits, then duplicates)',
    !b1.editing && b1.layers === b0.layers + 1 && kept === 2 && b1.hist.slice(-2).join(' > ') === 'Edit Type Layer > Duplicate Layer',
    `layers ${b0.layers}→${b1.layers}, "YOUR NAMES" in ${kept} layers, history …${b1.hist.slice(-2).join(' > ')}`,
  );

  // Ctrl+I / Ctrl+U (Invert, Hue/Saturation) are disabled while typing; Ctrl+B / Ctrl+I are faux
  // bold / italic on the edited text. Editing goes on and Backspace still deletes a character.
  await openTemplate('Crimson');
  await startEditing();
  const c0 = await state();
  const faux = () => page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const l = Object.values(s.doc.layers).find((x) => x.type === 'text' && x.name === 'Name');
    return { bold: !!l.text.fauxBold, italic: !!l.text.fauxItalic };
  });
  const f0 = await faux();
  await page.keyboard.press('Control+i');
  await wait(300);
  await page.keyboard.press('Control+u');
  await wait(300);
  await page.keyboard.press('Shift+Control+b');
  await wait(300);
  const c1 = await state();
  const dialogs = await page.evaluate(() => window.__app.useUI.getState().dialogs.length);
  const f1 = await faux();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Z');
  await wait(200);
  const c2 = await state();
  check(
    'e2e-flows-5 (Ctrl+I / Ctrl+U / Shift+Ctrl+B keep editing)',
    c1.editing && c2.editing && dialogs === 0 && !c1.hist.some((h) => /Invert|Hue|Auto Color/.test(h)) && c2.layers === c0.layers && c2.texts.includes('YOUR NAMEZ') && f1.italic !== f0.italic && f1.bold !== f0.bold,
    `editing ${c0.editing}→${c1.editing}→${c2.editing}, dialogs ${dialogs}, history …${c1.hist.slice(-2).join(' > ')}, faux bold ${f0.bold}→${f1.bold} italic ${f0.italic}→${f1.italic}, after Backspace+Z "YOUR NAMEZ" ${c2.texts.includes('YOUR NAMEZ')}, layers ${c0.layers}→${c2.layers}`,
  );
  await page.keyboard.press('Escape');
  await wait(200);
}

/* ---------------- e2e-flows-6 ---------------- */

function makePsd() {
  const W = 120, H = 80;
  const img = (r, g, b, w = W, h = H) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([r, g, b, 255], i * 4);
    return { width: w, height: h, data: d };
  };
  const psd = { width: W, height: H, imageData: img(200, 30, 30), children: [
    { name: 'Red BG', left: 0, top: 0, right: W, bottom: H, imageData: img(200, 30, 30) },
    { name: 'Blue box', left: 30, top: 20, right: 90, bottom: 60, imageData: img(20, 40, 220, 60, 40) },
  ] };
  return Buffer.from(writePsdBuffer(psd, { generateThumbnail: false })).toString('base64');
}

async function dropFile(b64, name, type) {
  const dt = await page.evaluateHandle(
    ({ b64, name, type }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      return dt;
    },
    { b64, name, type },
  );
  const loc = page.locator('[data-viewport]');
  const bb = await loc.boundingBox();
  const o = { dataTransfer: dt, clientX: bb.x + bb.width / 2, clientY: bb.y + bb.height / 2 };
  await loc.dispatchEvent('dragenter', o);
  await loc.dispatchEvent('dragover', o);
  await wait(150);
  // The drop overlay's lines while the file is over the window.
  const hints = await page.locator('.shell-drop .shell-drop-hint').allInnerTexts();
  await loc.dispatchEvent('drop', o);
  await wait(1500);
  return hints;
}

async function flows6() {
  await openTemplate('Crimson');
  const docs = () => page.evaluate(() => Object.values(window.__app.useEditor.getState().sessions).map((s) => s.doc.name));
  const before = await docs();
  const psdHints = await dropFile(makePsd(), 'poster.psd', 'image/vnd.adobe.photoshop');
  const menu = await page.locator('.ui-menu').count();
  const after = await docs();
  await shot('flows6-psd-drop');
  check(
    'e2e-flows-6 (PSD drop opens a document)',
    menu === 0 && after.length === before.length + 1 && psdHints.length > 0 && !psdHints.some((h) => /replace/i.test(h)),
    `drag hints ${JSON.stringify(psdHints)}, menu shown: ${menu > 0}, documents ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  );

  // A PNG on the placeholder still offers Replace; Escape closes just the menu.
  await openTemplate('Crimson');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; c.getContext('2d').fillRect(5, 5, 30, 30); return c.toDataURL('image/png').split(',')[1]; });
  const pngHints = await dropFile(png, 'render.png', 'image/png');
  const items = await page.locator('.ui-menu .ui-menu-item').allInnerTexts();
  await page.keyboard.press('Escape');
  await wait(200);
  const open = await page.locator('.ui-menu').count();
  check(
    'e2e-flows-6 (PNG drop offers Replace)',
    pngHints.some((h) => /replace/i.test(h)) && items.some((t) => /Replace Placeholder Character/.test(t)) && open === 0,
    `drag hints ${JSON.stringify(pngHints)}, menu ${JSON.stringify(items.map((t) => t.trim()))}, open after Escape: ${open > 0}`,
  );
}

/* ---------------- app-logic-diff-3 ---------------- */

async function escPopover() {
  await closeAll();
  await page.evaluate(() => window.__app.openDemoDocument());
  await wait(1200);
  await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const r = Object.values(s.doc.layers).find((l) => l.type === 'raster' && !l.locks.all && !l.locks.pixels);
    if (r) st.setActiveLayer(r.id);
    window.__app.runCommand('edit.fill');
  });
  await page.waitForSelector('.ui-dialog select', { timeout: 10000 });
  await page.locator('.ui-dialog select').first().selectOption('color');
  await wait(200);
  const ui = () => page.evaluate(() => ({ popover: !!document.querySelector('.ui-popover'), dialog: !!document.querySelector('.ui-dialog') }));
  await page.locator('.ui-dialog .ui-swatch').first().click();
  await wait(200);
  const opened = await ui();
  await page.keyboard.press('Escape');
  await wait(200);
  const esc1 = await ui();
  // Again, with focus in the popover's hex field (which stops key propagation).
  await page.locator('.ui-dialog .ui-swatch').first().click();
  await wait(200);
  await page.locator('.ui-popover input').first().focus();
  await page.keyboard.press('Escape');
  await wait(200);
  const esc2 = await ui();
  // Focus is back on the swatch that opened the picker (it used to land on <body>).
  const focusOnSwatch = await page.evaluate(() => document.activeElement?.classList.contains('ui-swatch') && !!document.activeElement.closest('.ui-dialog'));
  const contents = await page.locator('.ui-dialog select').first().inputValue().catch(() => null);
  await page.keyboard.press('Escape');
  await wait(200);
  const esc3 = await ui();
  check(
    'app-logic-diff-3 (Escape in Fill colour popover)',
    opened.popover && !esc1.popover && esc1.dialog && !esc2.popover && esc2.dialog && focusOnSwatch && contents === 'color' && !esc3.dialog,
    `open ${JSON.stringify(opened)} → Esc ${JSON.stringify(esc1)} → Esc from hex ${JSON.stringify(esc2)} (focus back on the swatch: ${focusOnSwatch}, contents "${contents}") → Esc ${JSON.stringify(esc3)}`,
  );

  // Ctrl+K over an open popover (brush presets): the first Escape closes the palette, the second
  // the popover.
  await page.evaluate(() => window.__app.useEditor.getState().setTool('brush'));
  await wait(300);
  const pal = () => page.evaluate(() => ({ popover: !!document.querySelector('.ui-popover'), palette: window.__app.useUI.getState().commandPaletteOpen }));
  await page.locator('.paint-picker-btn').first().click();
  await wait(300);
  await page.keyboard.press('Control+k');
  await wait(400);
  const p0 = await pal();
  await page.keyboard.press('Escape');
  await wait(300);
  const p1 = await pal();
  await page.keyboard.press('Escape');
  await wait(300);
  const p2 = await pal();
  check(
    'app-logic-diff-3 (Escape with the command palette over a popover)',
    p0.popover && p0.palette && p1.popover && !p1.palette && !p2.popover && !p2.palette,
    `open ${JSON.stringify(p0)} → Esc ${JSON.stringify(p1)} → Esc ${JSON.stringify(p2)}`,
  );
}

/* ---------------- first-user (release gate) ---------------- */

/** Make a raster the active layer, Move tool, nothing being edited. */
async function moveToolOnRaster() {
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const r = Object.values(s.doc.layers).find((l) => l.type === 'raster');
    if (r) st.setActiveLayer(r.id);
    st.setTool('move');
  });
  await wait(80);
}

/** Screen points on the ink of a layer: pixels that change strongly when it is hidden (solid runs only). */
async function inkPoints(layerId, n = 3) {
  // Only the document on screen (toasts and overlays outside it change too), with no toast over it.
  const rect = await page.evaluate(() => {
    window.__app.useUI.setState({ toasts: [] });
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const vp = document.querySelector('[data-viewport]').getBoundingClientRect();
    const v = s.view;
    const x0 = vp.x + vp.width / 2 + v.panX - (s.doc.width * v.zoom) / 2;
    const y0 = vp.y + vp.height / 2 + v.panY - (s.doc.height * v.zoom) / 2;
    const x = Math.max(vp.x, x0), y = Math.max(vp.y, y0);
    const r = Math.min(vp.x + vp.width, x0 + s.doc.width * v.zoom), b = Math.min(vp.y + vp.height, y0 + s.doc.height * v.zoom);
    return { x: Math.ceil(x), y: Math.ceil(y), width: Math.floor(r - Math.ceil(x)), height: Math.floor(b - Math.ceil(y)) };
  });
  await wait(150);
  const a = (await page.screenshot({ clip: rect })).toString('base64');
  await page.evaluate((id) => window.__app.useEditor.getState().preview((d) => void (d.layers[id].visible = false)), layerId);
  await wait(900);
  const b = (await page.screenshot({ clip: rect })).toString('base64');
  await page.evaluate(() => window.__app.useEditor.getState().cancelPreview());
  await wait(700);
  return page.evaluate(
    async ({ a, b, rect, n }) => {
      const dec = async (s) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext('2d');
        x.drawImage(bmp, 0, 0);
        return x.getImageData(0, 0, bmp.width, bmp.height);
      };
      const A = await dec(a), B = await dec(b), W = A.width, H = A.height;
      const strong = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        strong[i] = Math.abs(A.data[j] - B.data[j]) + Math.abs(A.data[j + 1] - B.data[j + 1]) + Math.abs(A.data[j + 2] - B.data[j + 2]) > 90 ? 1 : 0;
      }
      const solid = [];
      for (let y = 3; y < H - 3; y++)
        for (let x = 3; x < W - 3; x++) {
          const i = y * W + x;
          if (strong[i] && strong[i - 2] && strong[i + 2] && strong[i - 2 * W] && strong[i + 2 * W]) solid.push([x, y]);
        }
      solid.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const pts = [];
      for (let k = 0; k < n && solid.length; k++) pts.push(solid[Math.floor(((k + 0.5) / n) * solid.length)]);
      return pts.map(([x, y]) => [x + rect.x, y + rect.y]);
    },
    { a, b, rect, n },
  );
}

async function firstUser1() {
  const names = ['Sunburst Halftone Icon', 'Noir Newspaper Thumbnail', 'Horror Fog', 'Group Banner', 'Anime Action', 'Gothic Paper Poster', 'Crimson Film Thumbnail'];
  let total = 0;
  const bad = [];
  for (const name of names) {
    await openTemplate(name);
    const texts = await page.evaluate(() => {
      const st = window.__app.useEditor.getState();
      const s = st.sessions[st.activeDocId];
      const du = window.__app.documentUtils;
      return Object.values(s.doc.layers)
        .filter((l) => l.type === 'text' && !l.locks.all && du.isEffectivelyVisible(s.doc, l.id))
        .map((l) => ({ id: l.id, name: l.name, faint: du.isFaintLayer ? du.isFaintLayer(l) : l.opacity * (l.fillOpacity ?? 1) < 0.5 }));
    });
    const solidNames = new Set(texts.filter((t) => !t.faint).map((t) => t.name));
    for (const t of texts) {
      const pts = await inkPoints(t.id, 3);
      for (const [x, y] of pts) {
        await moveToolOnRaster();
        await page.mouse.dblclick(x, y);
        await wait(350);
        const opened = await page.evaluate(() => {
          const st = window.__app.useEditor.getState();
          const s = st.sessions[st.activeDocId];
          return st.activeTool === 'type' ? s.doc.layers[s.activeLayerId]?.name : 'nothing';
        });
        total++;
        const ok = opened === t.name || (t.faint && solidNames.has(opened));
        if (!ok) bad.push(`${name}: ${t.name} → ${opened}`);
        if (opened !== 'nothing') {
          await page.keyboard.press('Escape');
          await wait(120);
        }
      }
    }
  }
  check('first-user-1 (double-click opens the text under the pointer, through texture overlays)', total >= 30 && !bad.length, `${total - bad.length}/${total} clicks right${bad.length ? `; wrong: ${bad.slice(0, 8).join(' | ')}` : ''}`);
}

/** Retitle the active document's layer named `layerName` with the Type tool (T, click its ink, select all, type, commit). */
async function retitle(layerName, text) {
  const id = await page.evaluate((n) => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    return Object.values(s.doc.layers).find((l) => l.name === n && l.type === 'text')?.id;
  }, layerName);
  const [pt] = await inkPoints(id, 1);
  await moveToolOnRaster();
  await page.keyboard.press('t');
  await wait(100);
  await page.mouse.click(pt[0], pt[1]);
  await wait(300);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Control+Enter');
  await wait(500);
  return id;
}

async function firstUser2() {
  await openTemplate('Gothic Paper Poster');
  const before = await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    const texts = Object.values(s.doc.layers).filter((l) => l.type === 'text' && /Birdcage/.test(l.text.content));
    return { n: texts.length, shadow: texts.map((l) => l.effects.filter((e) => e.enabled && e.effectId === 'drop-shadow').length) };
  });
  const id = await retitle('Title', 'Owl');
  const after = await page.evaluate((id) => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    return {
      title: s.doc.layers[id].text.content,
      left: Object.values(s.doc.layers).filter((l) => l.type === 'text' && /Birdcage/.test(l.text.content)).map((l) => l.name),
      shadow: s.doc.layers[id].effects.some((e) => e.enabled && e.effectId === 'drop-shadow'),
    };
  }, id);
  await shot('first-user-2-gothic-owl');
  check(
    'first-user-2 (Gothic retitle leaves no old "Birdcage" ghost)',
    before.n === 1 && before.shadow[0] === 1 && after.title === 'Owl' && after.left.length === 0 && after.shadow,
    `before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`,
  );
}

async function firstUser3() {
  await openTemplate('Gothic Paper Poster');
  const order = () =>
    page.evaluate(() => {
      const st = window.__app.useEditor.getState();
      const s = st.sessions[st.activeDocId];
      return s.doc.rootIds.map((id) => s.doc.layers[id].name);
    });
  const before = await order();
  const activeName = await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    return s.doc.layers[s.activeLayerId]?.name;
  });
  await page.getByText('Libraries', { exact: true }).first().click();
  await wait(500);
  await page.locator('.assets-chip', { hasText: 'Backgrounds' }).first().click();
  await wait(1200);
  await page.locator('.assets-card', { hasText: 'Gradient Backdrop' }).first().dblclick();
  await wait(1500);
  const after = await order();
  await shot('first-user-3-backdrop');
  const gi = after.indexOf('Gradient Backdrop');
  const ci = after.indexOf(activeName);
  check(
    'first-user-3 (a Backgrounds asset goes behind the character, above the template background)',
    gi === 1 && after[0] === before[0] && ci > gi,
    `active ${activeName}; ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  );
}

async function firstUser4() {
  await openTemplate('Sunburst Halftone Icon');
  const box = (id) =>
    page.evaluate((id) => {
      const st = window.__app.useEditor.getState();
      const s = st.sessions[st.activeDocId];
      const l = s.doc.layers[id];
      return { x: l.transform.x, align: l.text.align, content: l.text.content };
    }, id);
  const id = await page.evaluate(() => {
    const st = window.__app.useEditor.getState();
    const s = st.sessions[st.activeDocId];
    return Object.values(s.doc.layers).find((l) => l.name === 'Title' && l.type === 'text')?.id;
  });
  // Centre from the rendered ink (doc px) before and after retyping.
  const centre = async () => {
    const xs = (await inkPoints(id, 9)).map((p) => p[0]);
    return { min: Math.min(...xs), max: Math.max(...xs) };
  };
  const b0 = await box(id);
  const c0 = await centre();
  await retitle('Title', 'Shadow Realm');
  const b1 = await box(id);
  const c1 = await centre();
  await shot('first-user-4-sunburst');
  const mid0 = (c0.min + c0.max) / 2;
  const mid1 = (c1.min + c1.max) / 2;
  check(
    'first-user-4 (a retyped centered title keeps its centre)',
    b0.align === 'center' && b1.content === 'Shadow Realm' && Math.abs(mid1 - mid0) <= 12 && b1.x < b0.x,
    `align ${b0.align}; x ${b0.x} → ${b1.x}; ink centre ${mid0.toFixed(1)} → ${mid1.toFixed(1)} (screen px)`,
  );
}

async function firstUser5() {
  // The finding's path: a 1366×768 window at 100 %, then Preferences ▸ UI scale ▸ 150 % while working.
  const small = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  small.on('pageerror', (e) => errors.push(`pageerror (1366): ${e.message}`));
  await small.goto(url, { waitUntil: 'networkidle' });
  await small.waitForFunction(() => !!window.__app && !!document.querySelector('.shell-root'), null, { timeout: 60000 });
  await small.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('perseverance.prefs') || '{}');
    delete p.uiScale;
    localStorage.setItem('perseverance.prefs', JSON.stringify(p));
    localStorage.removeItem('perseverance.workspace');
  });
  await small.reload({ waitUntil: 'networkidle' });
  await small.waitForFunction(() => !!window.__app && !!document.querySelector('.shell-root'), null, { timeout: 60000 });
  await small.waitForTimeout(1200);
  await small.evaluate(async () => {
    const a = window.__app;
    a.useUI.setState({ dialogs: [] });
    const doc = await a.templates.get('tpl-gothic-paper').build();
    a.useEditor.getState().openDocument(doc, { label: 'Template' });
  });
  await small.waitForTimeout(1500);
  await small.evaluate(() => window.__app.runCommand('edit.preferences'));
  await small.waitForTimeout(500);
  await small.locator('.ui-dialog select').first().selectOption('1.5');
  await small.waitForTimeout(900);
  const note = await small.evaluate(() => document.querySelector('[data-ui-scale-note]')?.textContent ?? '');
  const opts = await small.evaluate(() => [...document.querySelectorAll('.ui-dialog select option')].map((o) => o.textContent).filter((t) => /%/.test(t)));
  await small.keyboard.press('Escape');
  await small.waitForTimeout(1200);
  const st = await small.evaluate(() => {
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--shell-ui-scale')) || 1;
    const groups = document.querySelector('.shell-dock-groups');
    const g = groups.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.layers-row')].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.height > 0 && b.top >= g.top - 1 && b.bottom <= g.bottom + 1;
    }).length;
    const s = window.__app.useEditor.getState().sessions[window.__app.useEditor.getState().activeDocId];
    const vp = document.querySelector('[data-viewport]').getBoundingClientRect();
    // The document fits the canvas area again (visual px; CSS zoom scales the view).
    const docW = s.doc.width * s.view.zoom * zoom, docH = s.doc.height * s.view.zoom * zoom;
    return { zoom, rows, scroll: groups.scrollHeight - groups.clientHeight, cssW: Math.round(innerWidth / zoom), cssH: Math.round(innerHeight / zoom), fits: docW <= vp.width + 1 && docH <= vp.height + 1 };
  });
  await small.screenshot({ path: path.join(outDir, 'first-user-5-1366-150.png') });
  await small.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('perseverance.prefs') || '{}');
    delete p.uiScale;
    localStorage.setItem('perseverance.prefs', JSON.stringify(p));
  });
  await small.close();
  check(
    'first-user-5 (150 % on 1366×768 is applied only as far as the UI stays ≥ 1024×640; Layers rows visible)',
    st.zoom === 1.1 && st.cssW >= 1024 && st.cssH >= 640 && st.rows >= 3 && st.fits && /Using 110%/.test(note) && opts.some((o) => /150% \(needs a larger window\)/.test(o)),
    `${JSON.stringify(st)}; note "${note.slice(0, 80)}"; options ${JSON.stringify(opts)}`,
  );
}

const all = {
  'e2e-flows-1': flows1,
  'e2e-flows-4': flows4,
  'e2e-flows-5': flows5,
  'e2e-flows-6': flows6,
  'app-logic-diff-3': escPopover,
  'first-user-1': firstUser1,
  'first-user-2': firstUser2,
  'first-user-3': firstUser3,
  'first-user-4': firstUser4,
  'first-user-5': firstUser5,
};
for (const [id, fn] of Object.entries(all)) {
  if (only && !only.includes(id)) continue;
  try {
    await fn();
  } catch (e) {
    check(id, false, `threw: ${e.message.split('\n')[0]}`);
    await shot(`error-${id}`).catch(() => {});
  }
}
await browser.close();
if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);
const ok = results.length > 0 && results.every((r) => r.ok) && !errors.length;
console.log(ok ? 'WORKFLOW-UI OK' : 'WORKFLOW-UI FAILED');
process.exit(ok ? 0 : 1);
