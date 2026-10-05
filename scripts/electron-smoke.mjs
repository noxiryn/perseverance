#!/usr/bin/env node
/**
 * Launch the real Electron app (built dist/) and verify it boots without errors.
 * Run under a display, e.g.: xvfb-run -a node scripts/electron-smoke.mjs --out shot.png
 */
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : 'electron-shot.png';

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root, '--no-sandbox', '--disable-gpu-sandbox'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
const errors = [];
const win = await app.firstWindow();
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);
const info = await win.evaluate(async () => {
  const a = window.__app;
  const d = window.desktop;
  const t = a.templates.get('tpl-crimson-thumbnail');
  const doc = await t.build();
  a.useEditor.getState().openDocument(doc, { label: 'Template' });
  return {
    desktop: !!d,
    platform: d?.platform,
    version: d?.version,
    url: location.href.slice(0, 60),
    tools: a.tools.list().length,
    panels: a.panels.list().length,
    commands: a.commands.list().length,
    fonts: a.fonts.list().length,
  };
});
await win.waitForTimeout(4000);
await win.setViewportSize?.({ width: 1600, height: 960 }).catch(() => {});
await win.screenshot({ path: out });
console.log('INFO', JSON.stringify(info));
await app.close();
if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('ELECTRON OK');
