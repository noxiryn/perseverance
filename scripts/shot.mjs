#!/usr/bin/env node
/**
 * Screenshot helper for visual checks.
 *
 *   node scripts/shot.mjs --url http://localhost:5173 --out shot.png [--w 1600 --h 960]
 *        [--eval "path/to/setup.js"] [--wait 1500]
 *
 * --eval runs a JS file in the page after load (it can use window.__app — see src/main.tsx —
 * e.g. `await __app.runCommand('file.new')`). The script may be async (top-level await is
 * wrapped). Console errors from the page are printed to stderr.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);

const url = args.url ?? 'http://localhost:5173';
const out = args.out ?? 'shot.png';
const w = Number(args.w ?? 1600);
const h = Number(args.h ?? 960);
const wait = Number(args.wait ?? 1200);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
if (args.eval) {
  const code = fs.readFileSync(args.eval, 'utf8');
  try {
    const res = await page.evaluate(`(async () => { ${code}\n })()`);
    if (res !== undefined) console.log('eval result:', JSON.stringify(res)?.slice(0, 2000));
  } catch (e) {
    errors.push(`eval error: ${e.message}`);
  }
}
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
await browser.close();
if (errors.length) console.error('PAGE ERRORS:\n' + errors.join('\n'));
console.log(`saved ${out}`);
