#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the editor in headless Chromium against a running dev server
 * (or `vite preview`), checking a few compositing pixels (clipping groups, layer effects) and
 * exercising templates, every command, every tool and every panel while collecting console errors
 * and exceptions. Screenshots go to --out (default screenshots-tmp/).
 *
 *   npx vite --port 5300 &   node scripts/smoke.mjs --url http://localhost:5300 [--out dir] [--quick]
 *
 * Exit code 1 if any render check failed or any page error / console error was captured.
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

/* ---------- render checks (compositing pixels) ---------- */
const renderFailures = await run('render-checks', () => {
  const { bitmaps, documentUtils: D, renderDocument } = window.__app;
  const failures = [];
  const raster = (doc, color, props = {}) => {
    const c = document.createElement('canvas');
    c.width = doc.width;
    c.height = doc.height;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    const l = D.makeRasterLayer({ name: 'L', bitmapId: bitmaps.add(c), width: c.width, height: c.height });
    Object.assign(l, props);
    D.insertLayerDraft(doc, l, { parentId: null });
  };
  const check = (name, doc, want) => {
    const got = Array.from(renderDocument(doc, { background: false }).getContext('2d').getImageData(doc.width >> 1, doc.height >> 1, 1, 1).data);
    if (got.some((v, k) => Math.abs(v - want[k]) > 1)) failures.push(`${name}: got [${got}], expected [${want}]`);
  };
  const halfGray = 'rgba(128,128,128,0.5)';
  const clip = (name, base, clipped, want) => {
    const doc = D.createDocument({ name, width: 400, height: 300, background: null });
    raster(doc, halfGray, base);
    raster(doc, '#ff0000', { clipped: true, ...clipped });
    check(name, doc, want);
  };
  // A clipping group covers what its base covers (like Photoshop): an opaque layer clipped to a
  // 50%-alpha base shows its own colour at 50% alpha, whatever its blend mode or the base's fill.
  clip('clip onto 50% base', {}, {}, [255, 0, 0, 128]);
  clip('clip at 50% opacity', {}, { opacity: 0.5 }, [191, 64, 64, 128]);
  clip('clip multiply', {}, { blendMode: 'multiply' }, [128, 0, 0, 128]);
  clip('clip onto 0% fill base', { fillOpacity: 0 }, {}, [255, 0, 0, 128]);
  const overlay = (name, layer, params, want) => {
    const doc = D.createDocument({ name, width: 100, height: 100, background: null });
    raster(doc, halfGray, { ...layer, effects: [{ id: 'fx1', effectId: 'color-overlay', enabled: true, params: { color: '#ff0000', opacity: 1, ...params } }] });
    check(name, doc, want);
  };
  // Effects clipped to the content (overlays, inner shadow/glow, satin, inside stroke, bevel)
  // only recolour it, like Photoshop: a 50%-alpha pixel with an opaque colour overlay shows the
  // overlay's colour at 50% alpha, whatever the fill opacity or the overlay's blend mode.
  overlay('overlay on 50% pixel', {}, {}, [255, 0, 0, 128]);
  overlay('overlay at 50% opacity', {}, { opacity: 0.5 }, [191, 64, 64, 128]);
  overlay('overlay multiply', {}, { blendMode: 'multiply' }, [128, 0, 0, 128]);
  overlay('overlay at 50% fill', { fillOpacity: 0.5 }, {}, [255, 0, 0, 128]);
  overlay('overlay at 0% fill', { fillOpacity: 0 }, {}, [255, 0, 0, 128]);
  return failures;
});
for (const f of renderFailures ?? []) errors.push(`[render-checks] ${f}`);
console.log(`render checks: ${!renderFailures ? 'not run' : renderFailures.length ? `${renderFailures.length} FAILED` : 'ok'}`);

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
