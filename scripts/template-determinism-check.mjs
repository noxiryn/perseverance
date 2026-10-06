#!/usr/bin/env node
/**
 * Template determinism check: every template must render the same pixels whatever was built or
 * rendered before it in the session (start-screen previews, other templates, a different order).
 * A template's document is built, its fonts awaited, the render caches dropped, and the full
 * composite hashed, in several fresh pages:
 *   - forward: all templates in registry order;
 *   - reverse: all templates in reverse order;
 *   - previews: every start-screen / dialog preview (low-resolution builds) first, then all templates;
 *   - alone (skip with --quick): each template first thing in a fresh page;
 *   - late asset fonts: each template built as soon as a fresh page is up, while the font files of
 *     the text-drawing asset generators (src/assets/lib/fonts.ts ASSET_FACES — newspaper clippings,
 *     film frame, polaroid, comic burst — minus families templates use for their own text) arrive
 *     --late-asset-fonts ms late (default 3000; 0 skips): nothing may be generated with fallback fonts.
 * Any template whose hash differs between runs fails the check (exit 1).
 *
 *   npx vite --port 5403 &   node scripts/template-determinism-check.mjs --url http://localhost:5403/ [--quick] [--js] [--only a,b] [--late-asset-fonts ms]
 *
 * --js forces the JavaScript blur kernels (the WebAssembly ones must give the same bytes anyway).
 * Needs a dev server (imports /src modules).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};
const url = arg('url', 'http://localhost:5173/');
const quick = !!arg('quick', false);
const forceJs = !!arg('js', false);
const only = typeof arg('only', '') === 'string' && arg('only', '') ? String(arg('only')).split(',') : null;
const lateAssetFonts = Number(arg('late-asset-fonts', 3000)) || 0;
// Font files of the asset generators' faces (@fontsource names files "<family-slug>-<subset>-<weight>-<style>…").
const here = path.dirname(fileURLToPath(import.meta.url));
// Only faces no template text uses (a template waits for its own fonts, which would cover the delay).
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', ...f.split('/')), 'utf8');
const templateFamilies = new Set([...src('templates/fonts.ts').matchAll(/'([^']+)'/g)].map((m) => m[1]));
const assetFaces = [...src('assets/lib/fonts.ts').matchAll(/\['([^']+)', (\d{3}), '(normal|italic)'\]/g)]
  .filter((m) => !templateFamilies.has(m[1]))
  .map((m) => `${m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-')}-[a-z0-9-]+-${m[2]}-${m[3]}`);
const assetFontFiles = new RegExp(`/(${assetFaces.join('|')})[^/]*\\.(woff2?|ttf|otf)(\\?|$)`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

/** Fresh page: optionally render every template preview first, then hash the given templates in order. */
async function run(ids, { previews = false, fontDelay = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (fontDelay > 0)
    await page.route(assetFontFiles, async (route) => {
      await new Promise((r) => setTimeout(r, fontDelay));
      await route.continue();
    });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.setDefaultTimeout(600_000);
  // With late fonts, build as soon as the app is up (like a template picked right away on the
  // start screen), not after the network went idle.
  await page.goto(url, { waitUntil: fontDelay > 0 ? 'domcontentloaded' : 'networkidle' });
  await page.waitForFunction(() => !!window.__app);
  const res = await page.evaluate(
    async ({ ids, previews, forceJs }) => {
      const C = await import('/src/render/compositor.ts');
      const U = await import('/src/io/util.ts');
      const P = await import('/src/templates/previews.ts');
      const { templates, setBlurBackend } = window.__app;
      if (forceJs) setBlurBackend('js');
      const hash = (d) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < d.length; i++) {
          h ^= d[i];
          h = Math.imul(h, 16777619) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      };
      if (previews) for (const t of templates.list()) await P.loadTemplatePreview(t.id);
      const out = {};
      for (const id of ids) {
        const doc = await templates.get(id).build();
        await U.ensureFontsFor(doc);
        C.invalidateRenderCache();
        const cv = C.renderDocument(doc, { background: true });
        const k = document.createElement('canvas');
        k.width = cv.width;
        k.height = cv.height;
        const g = k.getContext('2d', { willReadFrequently: true });
        g.drawImage(cv, 0, 0);
        out[id] = hash(g.getImageData(0, 0, k.width, k.height).data);
      }
      return out;
    },
    { ids, previews, forceJs },
  );
  await page.close();
  return { res, errors };
}

const probe = await browser.newPage();
await probe.goto(url, { waitUntil: 'networkidle' });
await probe.waitForFunction(() => !!window.__app);
const all = await probe.evaluate(() => window.__app.templates.list().filter((t) => t.category !== 'Mine').map((t) => t.id));
await probe.close();
const ids = only ? all.filter((id) => only.includes(id)) : all;

const runs = {};
const errors = [];
const record = (name, r) => {
  runs[name] = r.res;
  errors.push(...r.errors.map((e) => `[${name}] ${e}`));
};
record('forward', await run(ids));
record('reverse', await run([...ids].reverse()));
record('previews', await run(ids, { previews: true }));
if (!quick) {
  const alone = {};
  for (const id of ids) {
    const r = await run([id]);
    alone[id] = r.res[id];
    errors.push(...r.errors.map((e) => `[alone ${id}] ${e}`));
  }
  runs.alone = alone;
}
if (lateAssetFonts > 0) {
  if (!assetFaces.length) errors.push('no asset font faces found in src/assets/lib/fonts.ts');
  const late = {};
  for (const id of ids) {
    const r = await run([id], { fontDelay: lateAssetFonts });
    late[id] = r.res[id];
    errors.push(...r.errors.map((e) => `[late-asset-fonts ${id}] ${e}`));
  }
  runs['late-fonts'] = late;
}
await browser.close();

const names = Object.keys(runs);
let bad = 0;
for (const id of ids) {
  const hs = names.map((n) => runs[n][id]);
  const same = hs.every((h) => h === hs[0]);
  if (!same) bad++;
  console.log(`${same ? 'ok  ' : 'DIFF'} ${id.padEnd(28)} ${names.map((n, i) => `${n}=${hs[i]}`).join(' ')}`);
}
if (errors.length) console.error(`\n${errors.length} page errors:\n${errors.slice(0, 20).join('\n')}`);
if (bad || errors.length) {
  console.error(`\nTEMPLATE DETERMINISM FAILED: ${bad} template(s) render differently depending on what ran before`);
  process.exit(1);
}
console.log(`\nTEMPLATES DETERMINISTIC (${ids.length} templates, runs: ${names.join(', ')}${forceJs ? ', JS blur' : ''})`);
