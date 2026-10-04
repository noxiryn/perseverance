#!/usr/bin/env node
/**
 * Renders build/icon.svg to the PNG icons used by electron-builder and the web favicon:
 *   build/icon.png (1024x1024)  → electron-builder derives .ico/.icns from it
 *   public/favicon.png (256x256)
 * Requires Chromium (playwright-core). Set CHROME_PATH to override the executable.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage();

async function render(size, out) {
  const data = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      return c.toDataURL('image/png');
    },
    { svg, size },
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
  console.log('wrote', path.relative(root, out));
}

await render(1024, path.join(root, 'build', 'icon.png'));
await render(256, path.join(root, 'public', 'favicon.png'));
await browser.close();
