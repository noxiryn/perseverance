/**
 * Roblox: roblox-studs (classic stud texture), baseplate-grid, obby-checker.
 */
import type { AssetDef } from '../../registry';
import { hash2 } from '../../core/noise';
import { fillGrain } from '../lib/field';
import { P, defineAsset } from '../lib/params';
import { drawPerspectiveFloor } from '../lib/raster';
import type { RGB } from '../lib/util';
import { TAU, bool, cssRGB, makeRand, newCanvas, num, rgbOf, rgba, shade, str, unitOf } from '../lib/util';

/** One stud cell (size×size px) on a plastic surface of `base` color, lit from the top-left. */
export function studTile(size: number, base: RGB, shine: number, outlines: boolean): HTMLCanvasElement {
  const [c, ctx] = newCanvas(size, size);
  ctx.fillStyle = cssRGB(base);
  ctx.fillRect(0, 0, size, size);
  if (outlines) {
    // faint plate seams
    ctx.fillStyle = rgba(shade(base, -0.35), 0.35);
    ctx.fillRect(0, size - Math.max(1, size * 0.02), size, Math.max(1, size * 0.02));
    ctx.fillRect(size - Math.max(1, size * 0.02), 0, Math.max(1, size * 0.02), size);
    ctx.fillStyle = rgba(shade(base, 0.35), 0.25);
    ctx.fillRect(0, 0, size, Math.max(1, size * 0.015));
    ctx.fillRect(0, 0, Math.max(1, size * 0.015), size);
  }
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.3;
  const hgt = size * 0.075;
  // contact shadow cast to the bottom-right
  const sh = ctx.createRadialGradient(cx + hgt * 1.6, cy + hgt * 1.8, R * 0.6, cx + hgt * 1.6, cy + hgt * 1.8, R * 1.35);
  sh.addColorStop(0, rgba('#000000', 0.38));
  sh.addColorStop(1, rgba('#000000', 0));
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, size, size);
  // cylinder side (visible below the top face)
  const side = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
  side.addColorStop(0, cssRGB(shade(base, -0.05)));
  side.addColorStop(0.35, cssRGB(shade(base, 0.08)));
  side.addColorStop(1, cssRGB(shade(base, -0.45)));
  ctx.fillStyle = side;
  ctx.beginPath();
  ctx.arc(cx, cy + hgt, R, 0, Math.PI);
  ctx.lineTo(cx - R, cy);
  ctx.arc(cx, cy, R, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  // top face with soft gradient
  const top = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  top.addColorStop(0, cssRGB(shade(base, 0.18)));
  top.addColorStop(1, cssRGB(shade(base, -0.08)));
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();
  // rim light and inner shading
  ctx.lineWidth = Math.max(1, size * 0.025);
  ctx.strokeStyle = rgba(shade(base, 0.6), 0.55 + shine * 0.3);
  ctx.beginPath();
  ctx.arc(cx, cy, R - ctx.lineWidth / 2, Math.PI * 0.95, Math.PI * 1.6);
  ctx.stroke();
  ctx.strokeStyle = rgba(shade(base, -0.5), 0.45);
  ctx.beginPath();
  ctx.arc(cx, cy, R - ctx.lineWidth / 2, Math.PI * 0.1, Math.PI * 0.6);
  ctx.stroke();
  if (shine > 0) {
    const sp = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, 0, cx - R * 0.35, cy - R * 0.4, R * 0.7);
    sp.addColorStop(0, rgba('#ffffff', 0.45 * shine));
    sp.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sp;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
  }
  return c;
}

const robloxStuds = defineAsset(
  {
    id: 'roblox-studs',
    name: 'Roblox Studs',
    category: 'Roblox',
    tags: ['roblox', 'studs', 'classic', 'lego', 'plastic', 'baseplate', 'retro', 'brick'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Plastic color', '#4b974b'),
      P.num('studSize', 'Stud size', 16, 240, 64, { unit: 'px' }),
      P.pct('shine', 'Shine', 0.5),
      P.bool('outlines', 'Plate seams', true),
      P.pct('variation', 'Color variation', 0.15),
      P.bool('perspective', 'Perspective floor', false),
      P.pct('horizon', 'Horizon', 0.3),
      P.seed(193),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 193);
      const base = rgbOf(str(p, 'color', '#4b974b'));
      const size = Math.max(8, Math.round(num(p, 'studSize', 64) * u));
      const tile = studTile(size, base, num(p, 'shine', 0.5), bool(p, 'outlines', true));
      const variation = num(p, 'variation', 0.15);
      // 8×8 studs texture with slight per-stud tint variation (still tileable)
      const T = 8;
      const [tex, tctx] = newCanvas(size * T, size * T);
      for (let j = 0; j < T; j++)
        for (let i = 0; i < T; i++) {
          tctx.drawImage(tile, i * size, j * size);
          if (variation > 0) {
            const v = (hash2(i, j, seed) - 0.5) * variation;
            tctx.fillStyle = v > 0 ? rgba('#ffffff', v * 0.35) : rgba('#000000', -v * 0.45);
            tctx.fillRect(i * size, j * size, size, size);
          }
        }
      const [c, ctx] = newCanvas(W, H);
      if (bool(p, 'perspective', false)) {
        const hz = H * num(p, 'horizon', 0.3);
        const sky = ctx.createLinearGradient(0, 0, 0, hz);
        sky.addColorStop(0, '#5ea1e6');
        sky.addColorStop(1, '#cfe6fb');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, hz + 1);
        drawPerspectiveFloor(ctx, tex, W, H, hz, 1.2);
        const haze = ctx.createLinearGradient(0, hz, 0, hz + (H - hz) * 0.45);
        haze.addColorStop(0, '#cfe6fb');
        haze.addColorStop(1, 'rgba(207,230,251,0)');
        ctx.fillStyle = haze;
        ctx.fillRect(0, hz, W, H - hz);
      } else {
        const pat = ctx.createPattern(tex, 'repeat');
        if (pat) {
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, W, H);
        }
      }
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.18;
      fillGrain(ctx, W, H, seed, 1);
      ctx.restore();
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* baseplate-grid                                                      */
/* ------------------------------------------------------------------ */

const baseplateGrid = defineAsset(
  {
    id: 'baseplate-grid',
    name: 'Baseplate Grid',
    category: 'Roblox',
    tags: ['roblox', 'baseplate', 'grid', 'studio', 'floor', 'build', 'gray'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Base color', '#5d5f63'),
      P.color('lineColor', 'Grid color', '#76787d'),
      P.num('cell', 'Cell size', 16, 300, 80, { unit: 'px' }),
      P.num('lineWidth', 'Line width', 1, 12, 3, { unit: 'px' }),
      P.pct('texture', 'Texture', 0.4),
      P.bool('perspective', 'Perspective floor', false),
      P.pct('horizon', 'Horizon', 0.32),
      P.color('sky', 'Sky color', '#9cc9f2'),
      P.seed(197),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 197);
      const r = makeRand(seed);
      const base = rgbOf(str(p, 'color', '#5d5f63'));
      const line = str(p, 'lineColor', '#76787d');
      const cell = Math.max(6, Math.round(num(p, 'cell', 80) * u));
      const lw = Math.max(1, num(p, 'lineWidth', 3) * u);
      const texture = num(p, 'texture', 0.4);
      const T = 8;
      const [tex, tctx] = newCanvas(cell * T, cell * T);
      tctx.fillStyle = cssRGB(base);
      tctx.fillRect(0, 0, tex.width, tex.height);
      // subtle per-cell tone (Roblox baseplate tiles are slightly uneven)
      for (let j = 0; j < T; j++)
        for (let i = 0; i < T; i++) {
          const v = (r() - 0.5) * 0.06;
          tctx.fillStyle = v > 0 ? rgba('#ffffff', v) : rgba('#000000', -v);
          tctx.fillRect(i * cell, j * cell, cell, cell);
        }
      tctx.fillStyle = line;
      for (let i = 0; i < T; i++) {
        tctx.fillRect(i * cell, 0, lw, tex.height);
        tctx.fillRect(0, i * cell, tex.width, lw);
      }
      // inner bevel shadow under each line
      tctx.fillStyle = rgba('#000000', 0.18);
      for (let i = 0; i < T; i++) {
        tctx.fillRect(i * cell + lw, 0, Math.max(1, lw * 0.5), tex.height);
        tctx.fillRect(0, i * cell + lw, tex.width, Math.max(1, lw * 0.5));
      }
      if (texture > 0) {
        tctx.save();
        tctx.globalCompositeOperation = 'overlay';
        tctx.globalAlpha = 0.35 * texture;
        fillGrain(tctx, tex.width, tex.height, seed, Math.max(1, 1.5 * u), 0.7);
        tctx.restore();
      }
      const [c, ctx] = newCanvas(W, H);
      if (bool(p, 'perspective', false)) {
        const hz = H * num(p, 'horizon', 0.32);
        const sky = rgbOf(str(p, 'sky', '#9cc9f2'));
        const g = ctx.createLinearGradient(0, 0, 0, hz);
        g.addColorStop(0, cssRGB(shade(sky, -0.25)));
        g.addColorStop(1, cssRGB(shade(sky, 0.35)));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, hz + 1);
        drawPerspectiveFloor(ctx, tex, W, H, hz, 1.1);
        const haze = ctx.createLinearGradient(0, hz, 0, hz + (H - hz) * 0.5);
        haze.addColorStop(0, cssRGB(shade(sky, 0.35)));
        haze.addColorStop(1, rgba(shade(sky, 0.35), 0));
        ctx.fillStyle = haze;
        ctx.fillRect(0, hz, W, H - hz);
      } else {
        const pat = ctx.createPattern(tex, 'repeat');
        if (pat) {
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, W, H);
        }
      }
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* obby-checker                                                        */
/* ------------------------------------------------------------------ */

const obbyChecker = defineAsset(
  {
    id: 'obby-checker',
    name: 'Obby Checker',
    category: 'Roblox',
    tags: ['roblox', 'obby', 'checker', 'checkerboard', 'floor', 'race', 'finish'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color1', 'Color 1', '#f1f1f1'),
      P.color('color2', 'Color 2', '#d8322e'),
      P.num('size', 'Tile size', 20, 400, 120, { unit: 'px' }),
      P.pct('bevel', 'Bevel', 0.45),
      P.bool('studs', 'Studs', false),
      P.bool('perspective', 'Perspective floor', true),
      P.pct('horizon', 'Horizon', 0.38),
      P.color('sky', 'Sky color', '#6fb4f0'),
      P.seed(199),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 199);
      const c1 = rgbOf(str(p, 'color1', '#f1f1f1'));
      const c2 = rgbOf(str(p, 'color2', '#d8322e'));
      const size = Math.max(8, Math.round(num(p, 'size', 120) * u));
      const bevel = num(p, 'bevel', 0.45);
      const studs = bool(p, 'studs', false);
      const [tex, tctx] = newCanvas(size * 2, size * 2);
      const studA = studs ? studTile(Math.round(size / 2), c1, 0.4, false) : null;
      const studB = studs ? studTile(Math.round(size / 2), c2, 0.4, false) : null;
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const col = (i + j) % 2 ? c2 : c1;
          const x = i * size;
          const y = j * size;
          tctx.fillStyle = cssRGB(col);
          tctx.fillRect(x, y, size, size);
          const st = (i + j) % 2 ? studB : studA;
          if (st) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) tctx.drawImage(st, x + a * st.width, y + b * st.width);
          if (bevel > 0) {
            const bw = Math.max(1, size * 0.06 * bevel + 1);
            tctx.fillStyle = rgba(shade(col, 0.5), 0.6 * bevel);
            tctx.fillRect(x, y, size, bw);
            tctx.fillRect(x, y, bw, size);
            tctx.fillStyle = rgba(shade(col, -0.5), 0.6 * bevel);
            tctx.fillRect(x, y + size - bw, size, bw);
            tctx.fillRect(x + size - bw, y, bw, size);
          }
        }
      tctx.save();
      tctx.globalCompositeOperation = 'overlay';
      tctx.globalAlpha = 0.15;
      fillGrain(tctx, tex.width, tex.height, seed, 1);
      tctx.restore();
      const [c, ctx] = newCanvas(W, H);
      if (bool(p, 'perspective', true)) {
        const hz = H * num(p, 'horizon', 0.38);
        const sky = rgbOf(str(p, 'sky', '#6fb4f0'));
        const g = ctx.createLinearGradient(0, 0, 0, hz);
        g.addColorStop(0, cssRGB(shade(sky, -0.2)));
        g.addColorStop(1, cssRGB(shade(sky, 0.45)));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, hz + 1);
        drawPerspectiveFloor(ctx, tex, W, H, hz, 1.25);
        const haze = ctx.createLinearGradient(0, hz, 0, hz + (H - hz) * 0.4);
        haze.addColorStop(0, cssRGB(shade(sky, 0.45)));
        haze.addColorStop(1, rgba(shade(sky, 0.45), 0));
        ctx.fillStyle = haze;
        ctx.fillRect(0, hz, W, H - hz);
      } else {
        const pat = ctx.createPattern(tex, 'repeat');
        if (pat) {
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, W, H);
        }
      }
      return c;
    },
  },
  { bg: 'none' },
);

export const robloxAssets: AssetDef[] = [robloxStuds, baseplateGrid, obbyChecker];
