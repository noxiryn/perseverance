/**
 * Backgrounds: gradient-backdrop, starfield, brick-wall, stone-wall, grid-floor,
 * city-silhouette, forest-silhouette.
 */
import type { Gradient } from '../../core/types';
import type { AssetDef } from '../../registry';
import { gradientLUT } from '../../core/color';
import { hash2 } from '../../core/noise';
import { fieldDims, fillGrain, noiseField, paintField } from '../lib/field';
import { P, defineAsset } from '../lib/params';
import { sampleField, softSprite, tintSprite, worleyAt, worleyGrid } from '../lib/raster';
import type { WorleyHit } from '../lib/raster';
import type { Pt, Rand, RGB } from '../lib/util';
import { TAU, bool, clamp01, cssRGB, drawUpscaled, makeRand, mixRGB, newCanvas, num, rgbOf, rgba, shade, smoothstep, str, tracePoly, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* gradient-backdrop                                                   */
/* ------------------------------------------------------------------ */

const DEFAULT_GRADIENT: Gradient = {
  kind: 'radial',
  angle: 90,
  scale: 1.1,
  stops: [
    { offset: 0, color: '#4a2a7a' },
    { offset: 0.55, color: '#1c1033' },
    { offset: 1, color: '#07050d' },
  ],
};

/** Paint a Gradient over (0,0,W,H). Diamond gradients are rasterized through a LUT. */
export function paintGradient(ctx: CanvasRenderingContext2D, g: Gradient, W: number, H: number) {
  const stops = (g.reverse ? g.stops.map((s) => ({ offset: 1 - s.offset, color: s.color })) : g.stops).slice().sort((a, b) => a.offset - b.offset);
  const cx = W / 2 + (g.offsetX ?? 0) * W * 0.5;
  const cy = H / 2 + (g.offsetY ?? 0) * H * 0.5;
  const a = (g.angle * Math.PI) / 180;
  const scale = Math.max(0.01, g.scale || 1);
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // half extent of the box along the gradient direction
  const ext = ((Math.abs(dx) * W + Math.abs(dy) * H) / 2) * scale;
  let grad: CanvasGradient | null = null;
  if (g.kind === 'linear') grad = ctx.createLinearGradient(cx - dx * ext, cy - dy * ext, cx + dx * ext, cy + dy * ext);
  else if (g.kind === 'reflected') {
    grad = ctx.createLinearGradient(cx - dx * ext, cy - dy * ext, cx + dx * ext, cy + dy * ext);
    for (const s of stops) {
      grad.addColorStop(0.5 - s.offset * 0.5, s.color);
      grad.addColorStop(0.5 + s.offset * 0.5, s.color);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  } else if (g.kind === 'radial') grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, (Math.hypot(W, H) / 2) * scale);
  else if (g.kind === 'angle') grad = ctx.createConicGradient(a, cx, cy);
  if (grad) {
    for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  // diamond
  const lut = gradientLUT(stops);
  const { fw, fh, s } = fieldDims(W, H, 250_000);
  const R = (Math.max(W, H) / 2) * scale * s;
  const img = paintField(fw, fh, (_i, x, y, px, o) => {
    const ux = x - cx * s;
    const uy = y - cy * s;
    const rx = ux * dx + uy * dy;
    const ry = -ux * dy + uy * dx;
    const t = Math.min(1, (Math.abs(rx) + Math.abs(ry)) / R);
    const k = Math.round(t * 255) * 4;
    px[o] = lut[k];
    px[o + 1] = lut[k + 1];
    px[o + 2] = lut[k + 2];
    px[o + 3] = lut[k + 3];
  });
  drawUpscaled(ctx, img, W, H);
}

const gradientBackdrop = defineAsset(
  {
    id: 'gradient-backdrop',
    name: 'Gradient Backdrop',
    category: 'Backgrounds',
    tags: ['gradient', 'background', 'backdrop', 'studio', 'color', 'smooth'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      { key: 'gradient', label: 'Gradient', type: 'gradient', default: DEFAULT_GRADIENT },
      P.pct('vignette', 'Vignette', 0.35),
      P.pct('noise', 'Dither noise', 0.25),
      P.pct('glow', 'Spotlight', 0.2),
      P.seed(163),
    ],
    generate(p, { width: W, height: H }) {
      const g = (p.gradient as Gradient | undefined) ?? DEFAULT_GRADIENT;
      const [c, ctx] = newCanvas(W, H);
      paintGradient(ctx, g && Array.isArray(g.stops) && g.stops.length ? g : DEFAULT_GRADIENT, W, H);
      const glow = num(p, 'glow', 0.2);
      if (glow > 0) {
        const rg = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.45);
        rg.addColorStop(0, rgba('#ffffff', 0.22 * glow));
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalCompositeOperation = 'soft-light';
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
      }
      const vig = num(p, 'vignette', 0.35);
      if (vig > 0) {
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(W / 2, H / 2);
        const vg = ctx.createRadialGradient(0, 0, 0.35, 0, 0, 1.45);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, rgba('#000000', 0.85 * vig));
        ctx.fillStyle = vg;
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
      }
      const noise = num(p, 'noise', 0.25);
      if (noise > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = 0.12 * noise;
        fillGrain(ctx, W, H, num(p, 'seed', 163), 1);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* starfield                                                           */
/* ------------------------------------------------------------------ */

const starfield = defineAsset(
  {
    id: 'starfield',
    name: 'Starfield',
    category: 'Backgrounds',
    tags: ['stars', 'space', 'night sky', 'galaxy', 'nebula', 'cosmos', 'milky way'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.bool('background', 'Sky background', true),
      P.color('skyTop', 'Sky top', '#03040b'),
      P.color('skyBottom', 'Sky bottom', '#121835'),
      P.pct('density', 'Star density', 0.55),
      P.pct('nebula', 'Nebula', 0.5),
      P.color('nebulaColor', 'Nebula color', '#6b3fd8'),
      P.color('nebulaColor2', 'Nebula accent', '#e0458f'),
      P.bool('milkyWay', 'Milky Way band', true),
      P.seed(167),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 167);
      const r = makeRand(seed);
      const density = num(p, 'density', 0.55);
      const neb = num(p, 'nebula', 0.5);
      const milky = bool(p, 'milkyWay', true);
      const [c, ctx] = newCanvas(W, H);
      if (bool(p, 'background', true)) {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, str(p, 'skyTop', '#03040b'));
        g.addColorStop(1, str(p, 'skyBottom', '#121835'));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      // band direction for the milky way
      const ba = -0.45 + (r() - 0.5) * 0.5;
      const bnx = -Math.sin(ba);
      const bny = Math.cos(ba);
      const bandAt = (x: number, y: number) => {
        if (!milky) return 0;
        const d = ((x - W / 2) * bnx + (y - H / 2) * bny) / (Math.min(W, H) * 0.22);
        return Math.exp(-d * d);
      };
      if (neb > 0) {
        const { fw, fh, s } = fieldDims(W, H, 90_000);
        const f = noiseField(fw, fh, s * u, { seed, freq: 1.4, octaves: 6, warp: 0.45, gain: 0.55 });
        const g2 = noiseField(fw, fh, s * u, { seed: seed + 5, freq: 4, octaves: 5, gain: 0.6 });
        const lanes = noiseField(fw, fh, s * u, { seed: seed + 9, freq: 6, octaves: 3, kind: 'ridged' });
        const c1 = rgbOf(str(p, 'nebulaColor', '#6b3fd8'));
        const c2 = rgbOf(str(p, 'nebulaColor2', '#e0458f'));
        const img = paintField(fw, fh, (i, x, y, px, o) => {
          const band = bandAt(x / s, y / s);
          const cloud = smoothstep(-0.2, 0.75, f[i] + band * 0.55 + g2[i] * 0.25);
          // dark dust lanes carve the brighter clouds
          const dust = 1 - 0.55 * smoothstep(0.55, 0.9, lanes[i]) * cloud;
          const v = cloud * cloud * dust;
          const col = mixRGB(c1, c2, clamp01(g2[i] * 1.4 + 0.45));
          px[o] = col.r;
          px[o + 1] = col.g;
          px[o + 2] = col.b;
          px[o + 3] = Math.min(1, v * neb * (0.45 + band * 0.75)) * 255;
        });
        ctx.save();
        ctx.globalCompositeOperation = bool(p, 'background', true) ? 'screen' : 'source-over';
        drawUpscaled(ctx, img, W, H);
        ctx.restore();
      }
      // stars: many faint dots, fewer bright ones, denser along the band
      const area = (W * H) / (u * u * 1e6);
      const n = Math.round(2600 * density * area);
      const BK = 4;
      const paths = Array.from({ length: BK }, () => new Path2D());
      for (let i = 0; i < n; i++) {
        const x = r() * W;
        const y = r() * H;
        if (milky && r() > 0.35 + bandAt(x, y) * 0.65) continue;
        const b = Math.min(BK - 1, Math.floor(r() ** 3 * BK));
        const rad = u * (0.35 + b * 0.35 + r() * 0.3);
        paths[b].moveTo(x + rad, y);
        paths[b].arc(x, y, rad, 0, TAU);
      }
      for (let b = 0; b < BK; b++) {
        ctx.fillStyle = rgba(b % 2 ? '#dfe8ff' : '#fff6ea', 0.35 + b * 0.2);
        ctx.fill(paths[b]);
      }
      // bright stars with glow and diffraction spikes
      const glow = tintSprite(softSprite(64, 0), '#cfe0ff', 'starfield-g');
      const bright = Math.round(26 * density * area);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < bright; i++) {
        const x = r() * W;
        const y = r() * H;
        const s = u * (4 + r() ** 3 * 22);
        ctx.globalAlpha = 0.5 + r() * 0.4;
        ctx.drawImage(glow, x - s, y - s, s * 2, s * 2);
        if (r() < 0.45) {
          ctx.fillStyle = rgba('#ffffff', 0.7);
          const L = s * (1.2 + r());
          ctx.fillRect(x - L, y - 0.4 * u, L * 2, 0.8 * u);
          ctx.fillRect(x - 0.4 * u, y - L, 0.8 * u, L * 2);
        }
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, u * 1.1, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* brick-wall                                                          */
/* ------------------------------------------------------------------ */

const brickWall = defineAsset(
  {
    id: 'brick-wall',
    name: 'Brick Wall',
    category: 'Backgrounds',
    tags: ['brick', 'wall', 'urban', 'alley', 'texture', 'building', 'street'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('brickColor', 'Brick color', '#8a3b2b'),
      P.color('mortarColor', 'Mortar color', '#b5ab9a'),
      P.num('brickWidth', 'Brick width', 30, 400, 130, { unit: 'px' }),
      P.num('brickHeight', 'Brick height', 12, 200, 48, { unit: 'px' }),
      P.num('mortar', 'Mortar width', 1, 24, 7, { unit: 'px' }),
      P.pct('variation', 'Color variation', 0.5),
      P.pct('wear', 'Wear & grime', 0.5),
      P.angle('light', 'Light angle', 125),
      P.seed(173),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 173);
      const r = makeRand(seed);
      const brick = rgbOf(str(p, 'brickColor', '#8a3b2b'));
      const mortarC = rgbOf(str(p, 'mortarColor', '#b5ab9a'));
      const s = Math.min(1, Math.sqrt(1_000_000 / (W * H)));
      const w = Math.round(W * s);
      const h = Math.round(H * s);
      const k = s * u; // working px per unit
      const bw = Math.max(4, num(p, 'brickWidth', 130) * k);
      const bh = Math.max(3, num(p, 'brickHeight', 48) * k);
      const mw = Math.max(0.6, num(p, 'mortar', 7) * k) / 2;
      const variation = num(p, 'variation', 0.5);
      const wear = num(p, 'wear', 0.5);
      const la = (num(p, 'light', 125) * Math.PI) / 180;
      const lx = Math.cos(la);
      const ly = -Math.sin(la);
      const bevel = Math.max(1, Math.min(bw, bh) * 0.12);
      // noise fields on a coarse grid, sampled bilinearly
      const { fw, fh, s: fs } = fieldDims(w, h, 60_000);
      const ns = fs / k; // field px per unit
      const fChip = noiseField(fw, fh, ns, { seed, freq: 14, octaves: 3 });
      const fTone = noiseField(fw, fh, ns, { seed: seed + 1, freq: 5, octaves: 4 });
      const fGrime = noiseField(fw, fh, ns, { seed: seed + 2, freq: 1.6, octaves: 4, warp: 0.6 });
      const rowJ: number[] = [];
      const rows = Math.ceil(h / bh) + 2;
      for (let i = 0; i < rows; i++) rowJ.push((i % 2) * 0.5 + (r() - 0.5) * 0.08);
      const [lo, lctx] = newCanvas(w, h);
      const img = lctx.createImageData(w, h);
      const d = img.data;
      const fsx = fw / w;
      const fsy = fh / h;
      for (let y = 0; y < h; y++) {
        const row = Math.floor(y / bh);
        const ly0 = y - row * bh;
        const off = rowJ[row + 1] * bw;
        for (let x = 0; x < w; x++) {
          const xx = x + off;
          const col = Math.floor(xx / bw);
          const lx0 = xx - col * bw;
          const fx = x * fsx;
          const fy = y * fsy;
          const chip = sampleField(fChip, fw, fh, fx, fy);
          // distances to the four edges of this brick
          const dl = lx0 - mw;
          const dr = bw - lx0 - mw;
          const dt = ly0 - mw;
          const db = bh - ly0 - mw;
          const dist = Math.min(dl, dr, dt, db) + chip * mw * 1.6 * (0.4 + wear);
          const o = (y * w + x) * 4;
          const tone = sampleField(fTone, fw, fh, fx, fy);
          const grime = sampleField(fGrime, fw, fh, fx, fy);
          let cr: number;
          let cg: number;
          let cb: number;
          if (dist < 0) {
            // mortar, shadowed right under/right of the bricks (ambient occlusion)
            const ao = 1 - 0.35 * smoothstep(-mw * 1.2, 0, dist);
            const m = (0.9 + tone * 0.15) * ao;
            cr = mortarC.r * m;
            cg = mortarC.g * m;
            cb = mortarC.b * m;
          } else {
            const hsh = hash2(col, row, seed);
            const hv = (hsh - 0.5) * variation;
            const hue = (hash2(col + 17, row - 5, seed) - 0.5) * variation;
            let lum = 1 + hv * 0.5 + tone * 0.12;
            // bevel lighting: which edge are we near?
            if (dist < bevel) {
              const e = 1 - dist / bevel;
              let nx = 0;
              let ny = 0;
              const m = Math.min(dl, dr, dt, db);
              if (m === dl) nx = -1;
              else if (m === dr) nx = 1;
              else if (m === dt) ny = -1;
              else ny = 1;
              lum += (nx * lx + ny * ly) * e * 0.35;
            }
            // darker burnt bricks occasionally
            if (hsh > 0.93) lum *= 0.6;
            cr = brick.r * lum * (1 + hue * 0.3);
            cg = brick.g * lum * (1 - hue * 0.1);
            cb = brick.b * lum * (1 - hue * 0.2);
          }
          const gm = 1 - wear * 0.45 * smoothstep(0.05, 0.7, grime);
          d[o] = cr * gm;
          d[o + 1] = cg * gm;
          d[o + 2] = cb * gm;
          d[o + 3] = 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, lo, W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.5;
      fillGrain(ctx, W, H, seed, Math.max(1, 1.5 * u), 0.6);
      ctx.restore();
      // soot gradient at the bottom
      if (wear > 0) {
        const g = ctx.createLinearGradient(0, H * 0.55, 0, H);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, rgba('#000000', 0.35 * wear));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* stone-wall                                                          */
/* ------------------------------------------------------------------ */

const stoneWall = defineAsset(
  {
    id: 'stone-wall',
    name: 'Stone Wall',
    category: 'Backgrounds',
    tags: ['stone', 'wall', 'castle', 'dungeon', 'medieval', 'rock', 'texture'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('stoneColor', 'Stone color', '#7b766c'),
      P.color('mortarColor', 'Mortar color', '#35322d'),
      P.num('stoneSize', 'Stone size', 40, 400, 140, { unit: 'px' }),
      P.num('mortar', 'Mortar width', 1, 30, 7, { unit: 'px' }),
      P.pct('variation', 'Color variation', 0.5),
      P.pct('roughness', 'Roughness', 0.55),
      P.pct('moss', 'Moss', 0),
      P.seed(179),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 179);
      const r = makeRand(seed);
      const stone = rgbOf(str(p, 'stoneColor', '#7b766c'));
      const mortarC = rgbOf(str(p, 'mortarColor', '#35322d'));
      const variation = num(p, 'variation', 0.5);
      const rough = num(p, 'roughness', 0.55);
      const moss = num(p, 'moss', 0);
      const s = Math.min(1, Math.sqrt(780_000 / (W * H)));
      const w = Math.round(W * s);
      const h = Math.round(H * s);
      const k = s * u;
      const cell = Math.max(6, num(p, 'stoneSize', 140) * k);
      const mw = Math.max(0.6, num(p, 'mortar', 7) * k);
      const sx = 1.5; // stones wider than tall
      const grid = worleyGrid(w, h, cell, r, 0.75, sx);
      const { fw, fh, s: fs } = fieldDims(w, h, 70_000);
      const ns = fs / k;
      const fWarp = noiseField(fw, fh, ns, { seed, freq: 6, octaves: 3 });
      const fTex = noiseField(fw, fh, ns, { seed: seed + 1, freq: 22, octaves: 3 });
      const fBig = noiseField(fw, fh, ns, { seed: seed + 2, freq: 2.5, octaves: 4 });
      const hit: WorleyHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };
      const bevel = cell * 0.22;
      const L = { x: -0.55, y: -0.65 };
      const mossC: RGB = { r: 70, g: 92, b: 40 };
      const [lo, lctx] = newCanvas(w, h);
      const img = lctx.createImageData(w, h);
      const d = img.data;
      const fsx = fw / w;
      const fsy = fh / h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const fx = x * fsx;
          const fy = y * fsy;
          const wv = sampleField(fWarp, fw, fh, fx, fy);
          const px = x + wv * cell * 0.08;
          const py = y + wv * cell * 0.06;
          worleyAt(grid, px, py, hit, sx);
          const tex = sampleField(fTex, fw, fh, fx, fy);
          const edge = (hit.f2 - hit.f1) * 0.5 - mw * 0.5 + tex * mw * 0.5 * rough;
          const big = sampleField(fBig, fw, fh, fx, fy);
          const o = (y * w + x) * 4;
          let c: RGB;
          if (edge < 0) {
            const ao = 0.75 + 0.25 * smoothstep(-mw, 0, -edge - mw * 0.2);
            c = shade(mortarC, (tex * 0.15 - 0.05) * ao);
          } else {
            const rv = grid.rnd[hit.id];
            let lum = 1 + (rv - 0.5) * variation * 0.6 + tex * 0.12 * (0.5 + rough) + big * 0.08;
            // pillowy bevel: normal tilts outward from the stone center near the edges
            const e = 1 - smoothstep(0, bevel, edge);
            const dx = (px - hit.cx) / sx;
            const dy = py - hit.cy;
            const dl = Math.hypot(dx, dy) || 1;
            lum += ((dx / dl) * L.x + (dy / dl) * L.y) * e * 0.45;
            lum -= e * e * 0.12;
            c = { r: stone.r * lum, g: stone.g * lum * (1 + (rv - 0.5) * variation * 0.05), b: stone.b * lum * (1 - (rv - 0.5) * variation * 0.1) };
            if (moss > 0) {
              const m = smoothstep(0.5 - moss * 0.5, 0.9 - moss * 0.4, big * 0.5 + 0.5 + (1 - e) * -0.2 + e * 0.15);
              c = mixRGB(c, shade(mossC, tex * 0.3), m * moss);
            }
          }
          d[o] = c.r;
          d[o + 1] = c.g;
          d[o + 2] = c.b;
          d[o + 3] = 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      const [cv, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, lo, W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.35 + rough * 0.35;
      fillGrain(ctx, W, H, seed, Math.max(1, 1.8 * u), 0.8);
      ctx.restore();
      return cv;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* grid-floor                                                          */
/* ------------------------------------------------------------------ */

const gridFloor = defineAsset(
  {
    id: 'grid-floor',
    name: 'Grid Floor',
    category: 'Backgrounds',
    tags: ['grid', 'synthwave', 'retro', 'neon', 'vaporwave', '80s', 'perspective', 'outrun'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Line color', '#ff3df0'),
      P.bool('background', 'Sky & floor', true),
      P.color('skyTop', 'Sky top', '#0a0220'),
      P.color('skyBottom', 'Sky horizon', '#5a1170'),
      P.color('floorColor', 'Floor color', '#0b0320'),
      P.pct('horizon', 'Horizon', 0.55),
      P.num('spacing', 'Grid spacing', 20, 300, 90, { unit: 'px' }),
      P.num('lineWidth', 'Line width', 0.5, 12, 2.5, { step: 0.5, unit: 'px' }),
      P.pct('glow', 'Glow', 0.7),
      P.bool('sun', 'Retro sun', true),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const color = str(p, 'color', '#ff3df0');
      const hz = H * num(p, 'horizon', 0.55);
      const spacing = num(p, 'spacing', 90) * u;
      const lw = num(p, 'lineWidth', 2.5) * u;
      const glow = num(p, 'glow', 0.7);
      const bg = bool(p, 'background', true);
      const [c, ctx] = newCanvas(W, H);
      if (bg) {
        const g = ctx.createLinearGradient(0, 0, 0, hz);
        g.addColorStop(0, str(p, 'skyTop', '#0a0220'));
        g.addColorStop(1, str(p, 'skyBottom', '#5a1170'));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, hz);
        ctx.fillStyle = str(p, 'floorColor', '#0b0320');
        ctx.fillRect(0, hz, W, H - hz);
      }
      if (bool(p, 'sun', true)) {
        const R = Math.min(W, H) * 0.24;
        const sx = W / 2;
        const sy = hz - R * 0.35;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, hz);
        ctx.clip();
        const halo = ctx.createRadialGradient(sx, sy, R * 0.8, sx, sy, R * 2.2);
        halo.addColorStop(0, rgba('#ff5fa0', 0.35));
        halo.addColorStop(1, 'rgba(255,95,160,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, W, hz);
        const sg = ctx.createLinearGradient(0, sy - R, 0, sy + R);
        sg.addColorStop(0, '#ffe66d');
        sg.addColorStop(0.5, '#ff9a3d');
        sg.addColorStop(1, '#ff2d95');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(sx, sy, R, 0, TAU);
        ctx.fill();
        // horizontal slits through the lower half
        ctx.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 7; i++) {
          const t = i / 7;
          const y = sy + R * (0.05 + t * 0.95);
          const hgt = R * (0.02 + t * 0.09);
          ctx.fillRect(sx - R - 2, y, R * 2 + 4, hgt);
        }
        ctx.restore();
      }
      // grid lines on a separate layer (for glow)
      const [gl, gctx] = newCanvas(W, H);
      gctx.strokeStyle = color;
      gctx.lineCap = 'round';
      const vx = W / 2;
      const rows = H - hz;
      // verticals: evenly spaced on the near edge, converging to the vanishing point
      const nearSpan = W * 3;
      const nv = Math.ceil(nearSpan / spacing / 2);
      gctx.lineWidth = lw;
      gctx.beginPath();
      for (let i = -nv; i <= nv; i++) {
        const xb = vx + i * spacing * 1.6;
        gctx.moveTo(vx + (xb - vx) * 0.02, hz + rows * 0.02);
        gctx.lineTo(xb, H);
      }
      gctx.stroke();
      // horizontals: perspective spacing, line k at depth 1 + k·s (square-ish cells near the bottom)
      const ks = (spacing * 0.9) / Math.max(1, rows);
      for (let z = 0; z < 400; z++) {
        const y = hz + rows / (1 + z * ks);
        if (y - hz < 1.2) break;
        gctx.lineWidth = Math.max(0.5, lw * Math.min(1, (y - hz) / (rows * 0.4)));
        gctx.beginPath();
        gctx.moveTo(0, y);
        gctx.lineTo(W, y);
        gctx.stroke();
      }
      gctx.lineWidth = lw * 1.2;
      gctx.beginPath();
      gctx.moveTo(0, hz);
      gctx.lineTo(W, hz);
      gctx.stroke();
      // fade lines into the horizon haze
      gctx.globalCompositeOperation = 'destination-in';
      const fade = gctx.createLinearGradient(0, hz, 0, H);
      fade.addColorStop(0, 'rgba(0,0,0,0.25)');
      fade.addColorStop(0.18, 'rgba(0,0,0,0.85)');
      fade.addColorStop(1, 'rgba(0,0,0,1)');
      gctx.fillStyle = fade;
      gctx.fillRect(0, hz - lw * 2, W, H - hz + lw * 2);
      if (glow > 0) {
        ctx.save();
        ctx.globalCompositeOperation = bg ? 'lighter' : 'source-over';
        ctx.filter = `blur(${Math.max(2, 9 * u)}px)`;
        ctx.globalAlpha = glow;
        ctx.drawImage(gl, 0, 0);
        ctx.filter = `blur(${Math.max(1, 3 * u)}px)`;
        ctx.drawImage(gl, 0, 0);
        ctx.restore();
      }
      ctx.drawImage(gl, 0, 0);
      if (bg) {
        // horizon haze
        const hg = ctx.createLinearGradient(0, hz - H * 0.08, 0, hz + H * 0.1);
        hg.addColorStop(0, 'rgba(255,80,200,0)');
        hg.addColorStop(0.5, rgba(color, 0.28 * (0.5 + glow * 0.5)));
        hg.addColorStop(1, 'rgba(255,80,200,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = hg;
        ctx.fillRect(0, hz - H * 0.08, W, H * 0.18);
        ctx.globalCompositeOperation = 'source-over';
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* city-silhouette                                                     */
/* ------------------------------------------------------------------ */

function skyline(W: number, H: number, base: number, maxH: number, minW: number, maxW: number, r: Rand, detail: boolean): { path: Path2D; windows: { x: number; y: number; w: number; h: number }[] } {
  const path = new Path2D();
  const windows: { x: number; y: number; w: number; h: number }[] = [];
  let x = -r() * maxW;
  while (x < W) {
    const bw = minW + r() * (maxW - minW);
    const bh = maxH * (0.25 + r() ** 1.3 * 0.75);
    const top = base - bh;
    const pts: Pt[] = [{ x, y: H + 2 }];
    const roof = r();
    if (detail && roof < 0.18) {
      // stepped top
      const s1 = bw * (0.15 + r() * 0.15);
      pts.push({ x, y: top + bh * 0.08 }, { x: x + s1, y: top + bh * 0.08 }, { x: x + s1, y: top }, { x: x + bw - s1, y: top }, { x: x + bw - s1, y: top + bh * 0.08 }, { x: x + bw, y: top + bh * 0.08 });
    } else if (detail && roof < 0.3) {
      // spire
      pts.push({ x, y: top }, { x: x + bw * 0.4, y: top }, { x: x + bw * 0.5, y: top - bh * (0.18 + r() * 0.25) }, { x: x + bw * 0.6, y: top }, { x: x + bw, y: top });
    } else if (detail && roof < 0.4) {
      // slanted
      pts.push({ x, y: top + bh * 0.06 }, { x: x + bw, y: top - bh * 0.04 });
    } else {
      pts.push({ x, y: top }, { x: x + bw, y: top });
    }
    pts.push({ x: x + bw, y: H + 2 });
    tracePoly(path, pts);
    // antennas & water towers
    if (detail && r() < 0.3) {
      const ax = x + bw * (0.2 + r() * 0.6);
      const ah = bh * (0.08 + r() * 0.2);
      path.rect(ax - Math.max(1, bw * 0.015), top - ah, Math.max(2, bw * 0.03), ah + 2);
    }
    if (detail && r() < 0.12) {
      const tx = x + bw * (0.2 + r() * 0.4);
      const tw = bw * 0.25;
      path.rect(tx, top - tw * 1.1, tw, tw * 0.75);
      path.moveTo(tx - tw * 0.1, top - tw * 1.1);
      path.lineTo(tx + tw / 2, top - tw * 1.55);
      path.lineTo(tx + tw * 1.1, top - tw * 1.1);
      path.closePath();
    }
    if (detail) {
      const ww = Math.max(1.5, bw * 0.07);
      const wh = ww * 1.5;
      const gx = ww * 1.9;
      const gy = wh * 1.8;
      for (let yy = top + gy; yy < H - gy; yy += gy) {
        for (let xx = x + gx * 0.7; xx < x + bw - gx * 0.6; xx += gx) windows.push({ x: xx, y: yy, w: ww, h: wh });
      }
    }
    x += bw + (r() < 0.2 ? r() * minW * 0.4 : -1);
  }
  return { path, windows };
}

const citySilhouette = defineAsset(
  {
    id: 'city-silhouette',
    name: 'City Silhouette',
    category: 'Backgrounds',
    tags: ['city', 'skyline', 'silhouette', 'buildings', 'urban', 'night', 'skyscrapers'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b10'),
      P.num('layers', 'Depth layers', 1, 4, 3),
      P.pct('height', 'Height', 0.45, { max: 0.9 }),
      P.pct('windows', 'Lit windows', 0.25),
      P.color('windowColor', 'Window color', '#ffd27a'),
      P.color('haze', 'Haze color', '#4a4f6b'),
      P.seed(181),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 181));
      const layers = Math.max(1, Math.round(num(p, 'layers', 3)));
      const height = num(p, 'height', 0.45) * H;
      const color = rgbOf(str(p, 'color', '#0b0b10'));
      const haze = rgbOf(str(p, 'haze', '#4a4f6b'));
      const winAmt = num(p, 'windows', 0.25);
      const [c, ctx] = newCanvas(W, H);
      for (let l = 0; l < layers; l++) {
        const t = layers === 1 ? 1 : l / (layers - 1); // 0 far → 1 near
        const front = l === layers - 1;
        const { path, windows } = skyline(W, H, H + 2, height * (1.15 - t * 0.35), (40 + 30 * t) * u, (110 + 90 * t) * u, r, true);
        ctx.fillStyle = cssRGB(mixRGB(haze, color, 0.25 + 0.75 * t));
        ctx.globalAlpha = 0.55 + 0.45 * t;
        ctx.fill(path);
        ctx.globalAlpha = 1;
        if (front && winAmt > 0) {
          const wc = str(p, 'windowColor', '#ffd27a');
          const lit = new Path2D();
          const dim = new Path2D();
          for (const w of windows) {
            const v = r();
            if (v < winAmt * 0.8) lit.rect(w.x, w.y, w.w, w.h);
            else if (v < winAmt * 1.1) dim.rect(w.x, w.y, w.w, w.h);
          }
          ctx.fillStyle = rgba(wc, 0.9);
          ctx.fill(lit);
          ctx.fillStyle = rgba(wc, 0.35);
          ctx.fill(dim);
        } else if (winAmt > 0 && t > 0.3) {
          const wc = str(p, 'windowColor', '#ffd27a');
          const lit = new Path2D();
          for (const w of windows) if (r() < winAmt * 0.35) lit.rect(w.x, w.y, w.w * 0.8, w.h * 0.8);
          ctx.fillStyle = rgba(wc, 0.4);
          ctx.fill(lit);
        }
      }
      return c;
    },
  },
  { bg: 'mid' },
);

/* ------------------------------------------------------------------ */
/* forest-silhouette                                                   */
/* ------------------------------------------------------------------ */

function pineTree(path: Path2D, x: number, base: number, h: number, r: Rand) {
  const w = h * (0.28 + r() * 0.12);
  const tiers = 5 + Math.floor(r() * 4);
  const trunkW = Math.max(1, w * 0.08);
  path.rect(x - trunkW / 2, base - h * 0.12, trunkW, h * 0.14);
  for (let i = 0; i < tiers; i++) {
    const t0 = i / tiers;
    const yb = base - h * 0.08 - h * 0.88 * t0;
    const yt = base - h * (0.08 + 0.88 * (t0 + 1.6 / tiers));
    const tw = w * (1 - t0 * 0.85) * (0.5 + r() * 0.15);
    const pts: Pt[] = [{ x: x - tw, y: yb + (r() - 0.3) * h * 0.02 }];
    // jagged lower edge
    const teeth = 3 + Math.floor(r() * 3);
    for (let k = 1; k < teeth; k++) {
      const fx = -tw + (2 * tw * k) / teeth;
      pts.push({ x: x + fx, y: yb - h * 0.025 * r() });
      pts.push({ x: x + fx + tw / teeth, y: yb + h * 0.012 * r() });
    }
    pts.push({ x: x + tw, y: yb + (r() - 0.3) * h * 0.02 });
    pts.push({ x: x + (r() - 0.5) * tw * 0.1, y: Math.max(base - h, yt) });
    tracePoly(path, pts);
  }
}

function roundTree(path: Path2D, x: number, base: number, h: number, r: Rand) {
  const trunkW = Math.max(1, h * 0.05);
  path.rect(x - trunkW / 2, base - h * 0.45, trunkW, h * 0.46);
  const crownR = h * (0.22 + r() * 0.08);
  const cy = base - h + crownR;
  for (let i = 0; i < 9; i++) {
    const a = r() * TAU;
    const d = crownR * 0.55 * Math.sqrt(r());
    const rr = crownR * (0.4 + r() * 0.35);
    path.moveTo(x + Math.cos(a) * d + rr, cy + Math.sin(a) * d * 0.8);
    path.arc(x + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, rr, 0, TAU);
  }
}

const forestSilhouette = defineAsset(
  {
    id: 'forest-silhouette',
    name: 'Forest Silhouette',
    category: 'Backgrounds',
    tags: ['forest', 'trees', 'pine', 'silhouette', 'woods', 'horror', 'nature', 'night'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#08090b'),
      P.num('layers', 'Depth layers', 1, 4, 3),
      P.pct('height', 'Height', 0.5, { max: 0.95 }),
      P.pct('density', 'Density', 0.6),
      P.select(
        'style',
        'Trees',
        [
          ['pine', 'Pines'],
          ['mixed', 'Mixed'],
          ['round', 'Deciduous'],
        ],
        'pine',
      ),
      P.color('haze', 'Haze color', '#5b6470'),
      P.seed(191),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 191));
      const layers = Math.max(1, Math.round(num(p, 'layers', 3)));
      const height = num(p, 'height', 0.5) * H;
      const density = num(p, 'density', 0.6);
      const style = str(p, 'style', 'pine');
      const color = rgbOf(str(p, 'color', '#08090b'));
      const haze = rgbOf(str(p, 'haze', '#5b6470'));
      const [c, ctx] = newCanvas(W, H);
      for (let l = 0; l < layers; l++) {
        const t = layers === 1 ? 1 : l / (layers - 1);
        const path = new Path2D();
        const base = H + 2;
        const layerH = height * (0.55 + 0.45 * t);
        // rolling ground
        const ground: Pt[] = [{ x: -10, y: H + 10 }];
        const gh = layerH * 0.12;
        for (let x = -10; x <= W + 20; x += 40 * u) ground.push({ x, y: base - gh * (0.5 + 0.5 * Math.sin(x / (300 * u) + l * 2.1)) });
        ground.push({ x: W + 20, y: H + 10 });
        tracePoly(path, ground);
        const step = (18 + 40 * (1 - density)) * u * (0.6 + t * 0.8);
        for (let x = -step; x < W + step; x += step * (0.5 + r())) {
          const h = layerH * (0.45 + r() * 0.55);
          const kind = style === 'mixed' ? (r() < 0.65 ? 'pine' : 'round') : style;
          const by = base - gh * 0.6;
          if (kind === 'round') roundTree(path, x, by, h * 0.8, r);
          else pineTree(path, x, by, h, r);
        }
        ctx.fillStyle = cssRGB(mixRGB(haze, color, 0.2 + 0.8 * t));
        ctx.fill(path);
      }
      return c;
    },
  },
  { bg: 'mid' },
);

export const backgroundAssets: AssetDef[] = [gradientBackdrop, starfield, brickWall, stoneWall, gridFloor, citySilhouette, forestSilhouette];
