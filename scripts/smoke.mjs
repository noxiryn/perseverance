#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the editor in headless Chromium against a running dev server
 * (or `vite preview`), checking PSD export of clipped baked adjustments and exercising templates,
 * every command, every tool and every panel while collecting console errors and exceptions.
 * Screenshots go to --out (default screenshots-tmp/).
 *
 *   npx vite --port 5300 &   node scripts/smoke.mjs --url http://localhost:5300 [--out dir] [--quick]
 *
 * Exit code 1 if any check failed or any page error / console error was captured.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};
const url = arg('url', 'http://localhost:5173');
const outDir = arg('out', 'screenshots-tmp');
const quick = !!arg('quick', false);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
let step = 'load';
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|Failed to load resource.*404/.test(m.text())) errors.push(`[${step}] console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[${step}] pageerror: ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`));

const shot = async (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const run = async (name, fn, arg) => {
  step = name;
  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    errors.push(`[${name}] evaluate failed: ${e.message.split('\n')[0]}`);
    return null;
  }
};
const closeDialogs = () => run('close-dialogs', () => window.__app.useUI.setState({ dialogs: [], commandPaletteOpen: false }));
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(url, { waitUntil: 'networkidle' });
await wait(1500);
await shot('01-start');

/* ---------- PSD: clipped baked adjustments ---------- */
// A soft-edged base with a clipped adjustment Photoshop doesn't have must render the same (±1,
// premultiplied as stored) as the base with the exported baked layer clipped to it, and after a
// .psd write + read; a base below 100% fill can't be reproduced and is reported as approximate.
// Clipped layers between the base and the adjustment are read back at the base's alpha, so soft
// edges may round once more there (±2).
const psdFailures = await run('psd-bake-checks', async () => {
  const { bitmaps, documentUtils: D, renderDocument, loadPsd } = window.__app;
  const { buildPsd, psdToDocument, writePsd, readPsd } = await loadPsd();
  const W = 200;
  const H = 150;
  const canvas = (draw) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    draw(c.getContext('2d'));
    return c;
  };
  const raster = (doc, c, props) => {
    const l = Object.assign(D.makeRasterLayer({ name: props.name, bitmapId: bitmaps.add(c), width: W, height: H }), props);
    D.insertLayerDraft(doc, l, { parentId: null });
    return l;
  };
  const softBase = (g) => {
    const lg = g.createLinearGradient(0, 0, W, H);
    lg.addColorStop(0, '#ff3040');
    lg.addColorStop(0.5, '#30c060');
    lg.addColorStop(1, '#2040ff');
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-in';
    const rg = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, 70);
    rg.addColorStop(0, '#000');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
  };
  const paint = (g) => {
    g.fillStyle = 'rgba(250,220,40,0.8)';
    g.fillRect(W / 2, 0, W / 2, H);
  };
  // Stored (premultiplied) channels and alpha within ±1.
  const diff = (a, b) => {
    let m = 0;
    for (let i = 0; i < a.length; i += 4) {
      m = Math.max(m, Math.abs(a[i + 3] - b[i + 3]));
      for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(Math.round((a[i + k] * a[i + 3]) / 255) - Math.round((b[i + k] * b[i + 3]) / 255)));
    }
    return m;
  };
  const pixels = (doc) => renderDocument(doc, { background: false }).getContext('2d').getImageData(0, 0, W, H).data;
  const vignette = { filterId: 'vignette', params: { amount: 0.9, size: 0.3, feather: 0.6, color: '#300050' } };
  const duotone = { filterId: 'duotone', params: { shadow: '#102060', highlight: '#ffd080' } };
  const cases = [
    { name: 'vignette', adj: vignette },
    { name: 'duotone', adj: duotone },
    { name: 'duotone at 60%', adj: duotone, adjProps: { opacity: 0.6 } },
    { name: 'duotone over clipped paint', adj: duotone, paint: true },
    { name: 'duotone at 60% over clipped paint', adj: duotone, adjProps: { opacity: 0.6 }, paint: true, tol: 2 },
    { name: 'duotone, base with drop shadow', adj: duotone, baseProps: { effects: [{ id: 'fx', effectId: 'drop-shadow', enabled: true, params: { color: '#00ffff', blendMode: 'normal', opacity: 1, distance: 6, size: 10 } }] } },
    { name: 'duotone, base at 50% fill', adj: duotone, baseProps: { fillOpacity: 0.5 }, approx: true },
  ];
  const failures = [];
  for (const t of cases) {
    const doc = D.createDocument({ name: t.name, width: W, height: H, background: null });
    raster(doc, canvas(softBase), { name: 'Base', ...t.baseProps });
    if (t.paint) raster(doc, canvas(paint), { name: 'Paint', clipped: true });
    const adj = Object.assign(D.makeAdjustmentLayer({ name: 'Adjustment', ...t.adj }), { clipped: true }, t.adjProps);
    D.insertLayerDraft(doc, adj, { parentId: null });
    const built = buildPsd(doc, { bakeStyles: false });
    const approx = built.approxAdjustments.includes('Adjustment');
    if (!built.bakedAdjustments.includes('Adjustment')) failures.push(`${t.name}: not baked`);
    if (approx !== !!t.approx) failures.push(`${t.name}: reported ${approx ? 'approximate' : 'exact'}`);
    if (t.approx) continue;
    // The original document with the adjustment replaced by the baked layer, clipped onto the base.
    const pl = built.psd.children.find((c) => c.name === 'Adjustment');
    if (!pl?.canvas) {
      failures.push(`${t.name}: no baked pixels`);
      continue;
    }
    const rebuilt = structuredClone(doc);
    rebuilt.layers[adj.id] = Object.assign(
      D.makeRasterLayer({ name: 'Baked', bitmapId: bitmaps.add(pl.canvas), width: pl.canvas.width, height: pl.canvas.height, transform: { x: pl.left, y: pl.top } }),
      { id: adj.id, clipped: true, opacity: pl.opacity, blendMode: adj.blendMode, mask: adj.mask },
    );
    const want = pixels(doc);
    const d1 = diff(want, pixels(rebuilt));
    const tol = t.tol ?? 1;
    if (d1 > tol) failures.push(`${t.name}: baked layer clipped onto the base differs by ${d1}`);
    const d2 = diff(want, pixels(psdToDocument(readPsd(writePsd(built.psd, { noBackground: true })), 're-import').doc));
    if (d2 > tol) failures.push(`${t.name}: re-imported PSD differs by ${d2}`);
  }
  return failures;
});
for (const f of psdFailures ?? []) errors.push(`[psd-bake-checks] ${f}`);
console.log(`psd bake checks: ${!psdFailures ? 'not run' : psdFailures.length ? `${psdFailures.length} FAILED` : 'ok'}`);

/* ---------- registry inventory ---------- */
const inventory = await run('inventory', () => {
  const a = window.__app;
  const n = (r) => r.list().length;
  return {
    tools: a.tools.list().map((t) => t.id),
    panels: a.panels.list().map((p) => p.id),
    commands: n(a.commands),
    filters: n(a.filters),
    effects: a.effects.list().map((e) => e.id),
    assets: n(a.assets),
    shapePresets: n(a.shapePresets),
    gradientPresets: n(a.gradientPresets),
    palettes: n(a.palettes),
    brushPresets: n(a.brushPresets),
    looks: a.looks.list().map((l) => l.id),
    templates: a.templates.list().map((t) => t.id),
    docPresets: n(a.docPresets),
    fonts: n(a.fonts),
  };
});
console.log('INVENTORY', JSON.stringify(inventory, null, 1));

/* ---------- templates ---------- */
const templates = inventory?.templates ?? [];
for (const [i, id] of templates.entries()) {
  if (quick && i > 3) break;
  await run(`template:${id}`, async (tid) => {
    const t = window.__app.templates.get(tid);
    const doc = await t.build();
    window.__app.useEditor.getState().openDocument(doc, { label: 'New from Template' });
  }, id);
  await wait(2500);
  await shot(`10-template-${id}`);
}

/* ---------- demo doc ---------- */
await run('demo', () => window.__app.openDemoDocument());
await wait(1500);
await shot('20-demo');

/* ---------- panels ---------- */
for (const id of inventory?.panels ?? []) {
  await run(`panel:${id}`, (pid) => window.__app.useUI.getState().showPanel(pid), id);
  await wait(400);
  if (!quick) await shot(`30-panel-${id}`);
}
await run('panel-reset', () => window.__app.useUI.getState().setFlyout(null));

/* ---------- tools: activate + drag on the canvas ---------- */
const vp = await page.evaluate(() => {
  const el = document.querySelector('[data-viewport]') ?? document.querySelector('canvas');
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
});
for (const id of inventory?.tools ?? []) {
  if (['hand', 'zoom'].includes(id)) continue;
  await run(`tool:${id}`, (tid) => window.__app.useEditor.getState().setTool(tid), id);
  if (vp) {
    step = `drag:${id}`;
    const cx = vp.x + vp.w * 0.45,
      cy = vp.y + vp.h * 0.45;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(cx + k * 12, cy + k * 7);
    await page.mouse.up();
    await wait(150);
    await page.keyboard.press('Escape');
  }
  await wait(100);
}
await shot('40-after-tools');
await run('undo-all', () => {
  const st = window.__app.useEditor.getState();
  for (let i = 0; i < 40; i++) st.undo();
  for (let i = 0; i < 40; i++) st.redo();
});

/* ---------- commands ---------- */
const DENY = /^(file\.(open|place|exit|close|closeAll|openRecent|save|saveAs|export|quickExportPng|exportPsd|importModel|fetchAvatar)|help\.openDataFolder|view\.fullscreen|roblox\.(importModel|fetchAvatar)|edit\.(copy|cut|paste|pasteInPlace|copyMerged))/;
const cmdIds = await run('cmd-list', () => window.__app.commands.list().map((c) => c.id));
let ran = 0;
for (const id of cmdIds ?? []) {
  if (DENY.test(id)) continue;
  if (quick && ran > 40) break;
  await run(`cmd:${id}`, async (cid) => {
    const c = window.__app.commands.get(cid);
    if (c.enabled && !c.enabled()) return 'disabled';
    await Promise.race([Promise.resolve(c.run()), new Promise((r) => setTimeout(r, 1500))]);
  }, id);
  ran++;
  await wait(120);
  const hasDialog = await page.evaluate(() => window.__app.useUI.getState().dialogs.length > 0);
  if (hasDialog && !quick) await shot(`50-dialog-${id.replace(/[^a-z0-9.]/gi, '_')}`);
  await closeDialogs();
  // Some commands switch documents/close; make sure a document stays open.
  await run('ensure-doc', () => {
    const st = window.__app.useEditor.getState();
    if (!st.activeDocId) window.__app.openDemoDocument();
  });
}
console.log(`ran ${ran} commands`);
await wait(800);
await shot('60-final');

await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} ERRORS:\n` + errors.join('\n'));
  process.exit(1);
}
console.log('SMOKE OK');
