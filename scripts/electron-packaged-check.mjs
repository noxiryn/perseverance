#!/usr/bin/env node
/**
 * Checks that only a PACKAGED app can show (app.isPackaged is true, asar + fuses), run against an
 * electron-builder build:
 *  - VITE_DEV_SERVER_URL in the user's environment is ignored: the app loads its own bundle from app.asar,
 *    never the URL (which would get the full desktop bridge), and logs that it ignored it.
 *  - the app starts from an install folder named like "100% Art #1 ?q Ünï 25%ad x%41y" (Windows profile
 *    names may contain '%'): the editor loads and its IPC is trusted.
 *
 *   npx vite build && npx electron-builder --linux dir --publish never
 *   xvfb-run -a -s "-screen 0 1600x960x24" node scripts/electron-packaged-check.mjs --bin release/linux-unpacked/perseverance [--tmp dir]
 *
 * Connects over the Chrome DevTools protocol: the release fuses (no --inspect) stop Playwright's Electron
 * launcher. Linux only (isolates userData with XDG_CONFIG_HOME). Exit code 1 on any failure.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const BIN = arg('bin', null);
if (!BIN || !fs.existsSync(BIN)) {
  console.error('usage: node scripts/electron-packaged-check.mjs --bin <packaged executable> [--tmp dir]');
  process.exit(2);
}
const T = arg('tmp', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'perseverance-packaged-'));
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();
function finish(crash) {
  if (crash) check('check script ran to the end', false, String((crash && crash.stack) || crash).split('\n').slice(0, 4).join(' | '));
  for (const c of children) c.kill('SIGKILL');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('FAILED:\n' + failed.map((f) => `  - ${f.name}`).join('\n'));
    process.exit(1);
  }
  console.log('PACKAGED CHECK OK');
  process.exit(0);
}
process.on('uncaughtException', (e) => finish(e));
process.on('unhandledRejection', (e) => finish(e));

let nextPort = 9400 + Math.floor(Math.random() * 400);
/** Start the packaged app and connect to its window over CDP. */
async function start(bin, name, extraEnv = {}) {
  const cfg = path.join(T, `cfg-${name}`);
  fs.mkdirSync(cfg, { recursive: true });
  const port = nextPort++;
  const env = { ...process.env, XDG_CONFIG_HOME: cfg, ...extraEnv };
  if (!('VITE_DEV_SERVER_URL' in extraEnv)) delete env.VITE_DEV_SERVER_URL;
  // Desktop sessions run with a UTF-8 locale. Under the bare C locale of a CI container a packaged
  // Electron can't start from a non-ASCII folder at all (exit 1 before main.cjs runs, any Electron app),
  // which would hide what this check is about.
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) env.LANG = 'C.UTF-8';
  const child = spawn(bin, ['--no-sandbox', `--remote-debugging-port=${port}`], { env, cwd: T, stdio: 'ignore' });
  children.add(child);
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await wait(500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  let page = null;
  for (let i = 0; i < 40 && browser && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0] ?? null;
    if (!page) await wait(250);
  }
  const ready = page
    ? await page
        .waitForFunction(() => !!window.__app && !!document.querySelector('.shell-root'), null, { timeout: 30000 })
        .then(() => true, () => false)
    : false;
  const log = () => {
    const f = path.join(cfg, 'Perseverance', 'logs', 'main.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };
  const stop = async () => {
    await browser?.close().catch(() => {});
    child.kill('SIGKILL');
    await Promise.race([exited, wait(3000)]);
    children.delete(child);
  };
  return { page, ready, log, stop };
}

const bridge = (page) =>
  page.evaluate(async () => {
    const r = { href: location.href, bridge: !!window.desktop };
    try {
      r.userData = await window.desktop.userDataPath();
    } catch (e) {
      r.userData = `ERR ${e.message}`;
    }
    return r;
  });

/* ---- VITE_DEV_SERVER_URL is ignored by a packaged app ---- */
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>not the app</title><script>window.__notTheApp = true</script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const devUrl = `http://127.0.0.1:${server.address().port}/`;
const a = await start(BIN, 'devurl', { VITE_DEV_SERVER_URL: devUrl });
const infoA = a.page ? await bridge(a.page).catch((e) => ({ err: e.message })) : { err: 'no window' };
await wait(500);
check(
  'VITE_DEV_SERVER_URL is ignored: the bundle loads from app.asar, the URL is never requested',
  a.ready && /\/resources\/app\.asar\/dist\/index\.html$/.test(infoA.href ?? '') && hits.length === 0 && !String(infoA.userData).startsWith('ERR'),
  { ...infoA, requests: hits.slice(0, 5) },
);
check('the ignored variable is logged', /ignoring VITE_DEV_SERVER_URL/.test(a.log()));
await a.stop();
server.close();

/* ---- installed in a folder with URL-special characters ---- */
const unpacked = path.dirname(path.resolve(BIN));
const inst = path.join(T, 'inst', '100% Art #1 ?q Ünï 25%ad x%41y', 'Perseverance');
fs.mkdirSync(path.dirname(inst), { recursive: true });
try {
  execFileSync('cp', ['-al', unpacked, inst]); // hard links: fast, same bytes (asar integrity unchanged)
} catch {
  fs.cpSync(unpacked, inst, { recursive: true });
}
const b = await start(path.join(inst, path.basename(BIN)), 'pct');
const infoB = b.page ? await bridge(b.page).catch((e) => ({ err: e.message })) : { err: 'no window' };
let hrefPath = null;
try {
  hrefPath = fileURLToPath(infoB.href);
} catch {
  /* chrome-error://… */
}
const ownBlocked = b
  .log()
  .split('\n')
  .filter((l) => /blocked file request|did-fail-load/.test(l));
check(
  'installed under "100% Art #1 ?q Ünï 25%ad x%41y": the editor loads from app.asar and IPC is trusted',
  b.ready && hrefPath === path.join(inst, 'resources', 'app.asar', 'dist', 'index.html') && !String(infoB.userData).startsWith('ERR') && ownBlocked.length === 0,
  { ...infoB, blocked: ownBlocked.slice(0, 3) },
);
await b.stop();

finish();
