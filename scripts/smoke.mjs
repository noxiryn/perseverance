#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the editor in headless Chromium against a running dev server
 * (or `vite preview`), exercising templates, every command, every tool and every panel while
 * collecting console errors and exceptions. Screenshots go to --out (default screenshots-tmp/).
 *
 *   npx vite --port 5300 &   node scripts/smoke.mjs --url http://localhost:5300 [--out dir] [--quick]
 *
 * Exit code 1 if any page error / console error was captured.
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

/* ---------- render checks (pixel cases, through window.__app.renderDocument) ---------- */
// Each case builds a small document and returns failure messages (empty when the pixels are right).
const RENDER_CHECKS = {
  // An adjustment layer with a blend mode keeps the alpha of what it adjusts (also at
  // semi-transparent pixels, clipped or not) and blends the unpremultiplied colours.
  'adjustment blend keeps alpha': () => {
    const a = window.__app;
    const D = a.documentUtils;
    const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    const setLum = (c, l) => {
      const d = l - lum(c);
      const o = c.map((v) => v + d);
      const L = lum(o),
        n = Math.min(...o),
        x = Math.max(...o);
      const k = Math.min(n < 0 ? L / (L - n) : 1, x > 1 ? (1 - L) / (x - L) : 1);
      return o.map((v) => L + (v - L) * k);
    };
    const hard = (b, s) => (s <= 0.5 ? 2 * b * s : b + (2 * s - 1) - b * (2 * s - 1));
    const expect = {
      multiply: (b, s) => b.map((v, i) => v * s[i]),
      overlay: (b, s) => b.map((v, i) => hard(s[i], v)),
      color: (b, s) => setLum(s, lum(b)),
    };
    const build = (mode, clipped) => {
      const doc = D.createDocument({ width: 100, height: 100, background: null });
      const r = D.makeRasterLayer({ bitmapId: a.bitmaps.create(100, 100, 'rgba(200,120,60,0.5)'), width: 100, height: 100 });
      doc.layers[r.id] = r;
      doc.rootIds = [r.id];
      if (mode) {
        const adj = D.makeAdjustmentLayer({ filterId: 'invert' });
        adj.clipped = clipped;
        adj.blendMode = mode;
        doc.layers[adj.id] = adj;
        doc.rootIds.push(adj.id);
      }
      return doc;
    };
    const px = (doc) => Array.from(a.renderDocument(doc, { background: false }).getContext('2d').getImageData(50, 50, 1, 1).data);
    const base = px(build(null));
    const cb = base.slice(0, 3).map((v) => v / 255);
    const cs = cb.map((v) => 1 - v);
    const fails = [];
    for (const mode of Object.keys(expect)) {
      const want = expect[mode](cb, cs).map((v) => Math.round(255 * v));
      for (const clipped of [false, true]) {
        const got = px(build(mode, clipped));
        const bad = got[3] !== base[3] || want.some((v, i) => Math.abs(v - got[i]) > 2);
        if (bad) fails.push(`${mode}${clipped ? ' (clipped)' : ''}: got ${got}, want ${want},${base[3]}`);
      }
    }
    return fails;
  },
};
for (const [name, fn] of Object.entries(RENDER_CHECKS)) {
  const fails = await run(`render-check:${name}`, fn);
  if (fails === null) continue;
  for (const f of fails) errors.push(`[render-check:${name}] ${f}`);
  console.log(`render check ${fails.length ? 'FAILED' : 'ok'}: ${name}`);
}

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
