/**
 * Paper & Grunge assets: paper-texture, grunge-paper, crumpled-paper, fold-creases,
 * newspaper-clippings, concrete, cracks, torn-paper-strip.
 */
import type { AssetDef } from '../../registry';
import { createNoise2D } from '../../core/noise';
import { fieldDims, fillGrain, noiseField, paintField } from '../lib/field';
import { FONT } from '../lib/fonts';
import { tornLine } from '../lib/geom';
import { simplex } from '../lib/noise';
import { worleyAt, worleyGrid } from '../lib/raster';
import type { WorleyGrid, WorleyHit } from '../lib/raster';
import { P, defineAsset } from '../lib/params';
import { drawCrackLine, drawFibers, drawScratches, paintPaper, walkLine } from '../lib/surface';
import type { Pt, Rand, RGB } from '../lib/util';
import { TAU, bool, cssRGB, drawUpscaled, makeRand, newCanvas, num, rgbOf, rgba, shade, smoothstep, str, tracePoly, unitOf } from '../lib/util';
import { capitalize, fakeHeadline, fakeSentence } from '../lib/words';

/* ------------------------------------------------------------------ */
/* paper-texture                                                       */
/* ------------------------------------------------------------------ */

const paperTexture = defineAsset(
  {
    id: 'paper-texture',
    name: 'Paper Texture',
    category: 'Paper & Grunge',
    tags: ['paper', 'texture', 'off-white', 'fibers', 'grain', 'poster'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    defaultOpacity: 1,
    params: [
      P.color('tone', 'Tone', '#ece8df'),
      P.pct('grain', 'Grain', 0.5),
      P.pct('fibers', 'Fibers', 0.5),
      P.pct('mottle', 'Mottling', 0.45),
      P.pct('specks', 'Specks', 0.25),
      P.seed(7),
    ],
    generate(p, { width: W, height: H }) {
      const [c, ctx] = newCanvas(W, H);
      paintPaper(ctx, W, H, unitOf(W, H), rgbOf(str(p, 'tone', '#ece8df')), num(p, 'seed', 7), {
        grain: num(p, 'grain', 0.5),
        fibers: num(p, 'fibers', 0.5),
        mottle: num(p, 'mottle', 0.45),
        specks: num(p, 'specks', 0.25),
      });
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* grunge-paper                                                        */
/* ------------------------------------------------------------------ */

function horizontalCracks(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, r: Rand, count: number, strength = 1) {
  for (let k = 0; k < count; k++) {
    const y0 = H * (0.08 + 0.84 * ((k + r()) / Math.max(1, count)));
    const pts = walkLine(-20 * u, y0, (r() - 0.5) * 0.12, W + 40 * u, 7 * u, 0.9, r);
    // only part of the width sometimes
    const start = r() < 0.4 ? Math.floor(r() * pts.length * 0.4) : 0;
    const end = r() < 0.4 ? Math.floor(pts.length * (0.6 + r() * 0.4)) : pts.length;
    drawCrackLine(ctx, pts.slice(start, end), u, r, strength * (0.7 + r() * 0.3));
    // little branch splinters
    const branches = r.int(1, 4);
    for (let b = 0; b < branches; b++) {
      const at = pts[start + Math.floor(r() * Math.max(1, end - start - 1))];
      if (!at) continue;
      const br = walkLine(at.x, at.y, (r() - 0.5) * 1.2 + (r() < 0.5 ? 0 : Math.PI), 20 * u + r() * 60 * u, 5 * u, 1.2, r);
      drawCrackLine(ctx, br, u * 0.7, r, strength * 0.6);
    }
  }
}

const grungePaper = defineAsset(
  {
    id: 'grunge-paper',
    name: 'Grunge Paper',
    category: 'Paper & Grunge',
    tags: ['paper', 'grunge', 'stains', 'aged', 'cracks', 'burnt', 'vintage'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    defaultOpacity: 1,
    params: [
      P.color('tone', 'Tone', '#e4ddcf'),
      P.pct('stains', 'Stains', 0.55),
      P.pct('edges', 'Edge burn', 0.6),
      P.num('cracks', 'Cracks', 0, 10, 3),
      P.pct('scratches', 'Scratches', 0.5),
      P.pct('grain', 'Grain', 0.7),
      P.seed(13),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 13);
      const tone = rgbOf(str(p, 'tone', '#e4ddcf'));
      const stains = num(p, 'stains', 0.55);
      const edges = num(p, 'edges', 0.6);
      const [c, ctx] = newCanvas(W, H);
      paintPaper(ctx, W, H, u, tone, seed, { mottle: 1, grain: num(p, 'grain', 0.7), fibers: 0.6, specks: 0.8 });
      // stains + burnt edges, computed on a reduced grid (soft features: upscaling hides it)
      const { fw, fh, s } = fieldDims(W, H, 80_000);
      const up = s * u;
      const f = noiseField(fw, fh, up, { seed: seed + 1, freq: 1.7, octaves: 5, warp: 0.7 });
      const f2 = noiseField(fw, fh, up, { seed: seed + 2, freq: 2.4, octaves: 4 });
      const tint = noiseField(fw, fh, up, { seed: seed + 3, freq: 0.9, octaves: 3 });
      const M = Math.min(fw, fh);
      const t = 0.5 - stains * 0.22;
      const stain = { r: 120, g: 88, b: 52 };
      const burn = { r: 46, g: 30, b: 18 };
      const layer = paintField(fw, fh, (i, x, y, px, o) => {
        const v = f[i];
        // tea stains: faint fill + a darker, slightly sharper tide line at the rim
        const inside = smoothstep(t, t + 0.06, v);
        const d = (v - t - 0.012) / 0.018;
        const ring = Math.exp(-d * d) * smoothstep(t - 0.02, t + 0.01, v);
        // broad warm discoloration
        const age = smoothstep(-0.2, 0.7, tint[i]) * 0.12;
        const aS = stains * (inside * 0.1 + ring * 0.22 + age);
        // irregular burnt edges
        const e = Math.min(x, fw - 1 - x, y, fh - 1 - y) / M;
        const bw = 0.025 + 0.11 * smoothstep(-0.5, 0.6, f2[i]);
        const k = 1 - smoothstep(0, bw, e);
        const aB = edges * k * k * 0.9;
        const a = 1 - (1 - aS) * (1 - aB);
        const wb = aB / (aS + aB + 1e-6);
        px[o] = stain.r + (burn.r - stain.r) * wb;
        px[o + 1] = stain.g + (burn.g - stain.g) * wb;
        px[o + 2] = stain.b + (burn.b - stain.b) * wb;
        px[o + 3] = a * 255;
      });
      drawUpscaled(ctx, layer, W, H);
      const r = makeRand(seed + 5);
      horizontalCracks(ctx, W, H, u, r, Math.round(num(p, 'cracks', 3)));
      const sc = num(p, 'scratches', 0.5);
      if (sc > 0) {
        const area = (W * H) / (u * u * 1e6);
        drawScratches(ctx, W, H, u, '#ffffff', r, 160 * sc * area, { alpha: 0.4, maxLen: 70 });
        drawScratches(ctx, W, H, u, '#2a2219', r, 70 * sc * area, { alpha: 0.35, maxLen: 50 });
      }
      // dirt clusters
      const clusters = Math.round(6 * stains + 2);
      for (let k = 0; k < clusters; k++) {
        const cx = r() * W;
        const cy = r() * H;
        const rad = u * (20 + r() * 80);
        const pth = new Path2D();
        for (let i = 0; i < 40; i++) {
          const a = r() * TAU;
          const d = rad * Math.sqrt(r());
          const sz = u * (0.4 + r() * r() * 2.4);
          pth.moveTo(cx + Math.cos(a) * d + sz, cy + Math.sin(a) * d);
          pth.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, sz, 0, TAU);
        }
        ctx.fillStyle = rgba('#241a10', 0.45);
        ctx.fill(pth);
      }
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* crumpled-paper                                                      */
/* ------------------------------------------------------------------ */

/**
 * Crumpled paper as a continuous height field: the sum, over several scales, of Voronoi
 * "F2 − F1" pyramids with a random up/down sign per cell. F2 − F1 is zero on cell borders and
 * grows linearly inside, so every cell becomes a faceted pyramid (mountain or valley fold) whose
 * borders are straight sharp creases — big folds broken into smaller and smaller facets, like
 * real crumpled stock. Fine wrinkles come from ridged |noise|. Shading uses the field's normals
 * plus a little occlusion in the valleys; computed at reduced resolution and up-scaled, then
 * full-resolution grain and fibers are added on top.
 */
export interface CreaseScale {
  grid: WorleyGrid;
  amp: number;
}

/** Height of the crumple field at (x, y) (px). Pure given the grids. */
export function crumpleHeight(scales: CreaseScale[], x: number, y: number, hit: WorleyHit): number {
  let h = 0;
  for (const sc of scales) {
    worleyAt(sc.grid, x, y, hit);
    const rv = sc.grid.rnd[hit.id];
    // sign and strength per cell: some cells fold up, some down, some barely
    const sgn = rv < 0.5 ? -(0.35 + rv * 1.3) : 0.35 + (rv - 0.5) * 1.3;
    h += sc.amp * sgn * (hit.f2 - hit.f1);
  }
  return h;
}

const crumpledPaper = defineAsset(
  {
    id: 'crumpled-paper',
    name: 'Crumpled Paper',
    category: 'Paper & Grunge',
    tags: ['paper', 'crumpled', 'wrinkles', 'creases', 'texture', 'folds'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    defaultOpacity: 1,
    params: [
      P.color('tone', 'Tone', '#ebe7de'),
      P.pct('crumple', 'Crumple', 0.65),
      P.num('scale', 'Fold size', 40, 400, 170, { unit: 'px' }),
      P.pct('wrinkles', 'Fine wrinkles', 0.35),
      P.angle('light', 'Light angle', 125),
      P.pct('grain', 'Grain', 0.45),
      P.seed(21),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 21);
      const tone = rgbOf(str(p, 'tone', '#ebe7de'));
      const crumple = num(p, 'crumple', 0.65);
      const wrinkles = num(p, 'wrinkles', 0.35);
      const la = (num(p, 'light', 125) * Math.PI) / 180;
      const ws = Math.min(1, Math.sqrt(400_000 / (W * H)));
      const w = Math.max(2, Math.round(W * ws));
      const h = Math.max(2, Math.round(H * ws));
      const k = ws * u; // working px per unit
      const r = makeRand(seed);
      const base = Math.max(8, num(p, 'scale', 170) * k);
      const levels = [
        { cell: base * 1.9, amp: 0.55 },
        { cell: base * 0.85, amp: 0.42 },
        { cell: base * 0.38, amp: 0.3 },
      ];
      // fine crinkles: one more, smaller crease level (same visual language as the big folds)
      if (wrinkles > 0) levels.push({ cell: Math.max(3, base * 0.17), amp: 0.5 * wrinkles });
      const scales: CreaseScale[] = levels.map((sc, i) => ({ grid: worleyGrid(w, h, sc.cell, r.fork(i + 1), 0.95), amp: sc.amp * crumple }));
      // height field (+1px border for the gradients)
      const hw = w + 2;
      const hh = h + 2;
      const hf = new Float32Array(hw * hh);
      const hit: WorleyHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < hw; x++) {
          const px = x - 1;
          const py = y - 1;
          hf[y * hw + x] = crumpleHeight(scales, px, py, hit);
        }
      }
      const Lx = Math.cos(la) * 0.62;
      const Ly = -Math.sin(la) * 0.62;
      const Lz = 0.78;
      const ll = Math.hypot(Lx, Ly, Lz);
      const lx = Lx / ll;
      const ly = Ly / ll;
      const lz = Lz / ll;
      const [lo, lctx] = newCanvas(w, h);
      const img = lctx.createImageData(w, h);
      const d = img.data;
      const slope = 1.25;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y + 1) * hw + (x + 1);
          const dx = (hf[i + 1] - hf[i - 1]) * 0.5 * slope;
          const dy = (hf[i + hw] - hf[i - hw]) * 0.5 * slope;
          const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
          const lum = (-dx * lx - dy * ly + lz) * inv;
          // valleys (positive laplacian) collect a little shadow, ridges catch a glint
          const lap = hf[i + 1] + hf[i - 1] + hf[i + hw] + hf[i - hw] - 4 * hf[i];
          let v = 1 + (lum - lz) * 0.68 - Math.max(0, lap) * 0.07 + Math.max(0, -lap) * 0.025;
          v = v < 0.58 ? 0.58 : v > 1.1 ? 1.1 : v;
          const o = (y * w + x) * 4;
          d[o] = Math.min(255, tone.r * v);
          d[o + 1] = Math.min(255, tone.g * v);
          d[o + 2] = Math.min(255, tone.b * v);
          d[o + 3] = 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, lo, W, H);
      const grain = num(p, 'grain', 0.45);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.16 * grain;
      fillGrain(ctx, W, H, seed, 1);
      ctx.globalAlpha = 0.2 * grain;
      fillGrain(ctx, W, H, seed + 1, Math.max(1, 2 * u), 0.7);
      ctx.restore();
      drawFibers(ctx, W, H, u, tone, makeRand(seed + 9), 0.35);
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* fold-creases                                                        */
/* ------------------------------------------------------------------ */

function drawFold(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, u: number, strength: number, r: Rand, seed: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L;
  const ny = dx / L;
  const lit = r() < 0.5 ? 1 : -1;
  const spread = (30 + r() * 70) * u;
  // broad soft shading on both sides of the fold
  for (const side of [1, -1]) {
    const g = ctx.createLinearGradient(a.x, a.y, a.x + nx * spread * side, a.y + ny * spread * side);
    const col = side === lit ? '#ffffff' : '#000000';
    const amt = (side === lit ? 0.32 : 0.38) * strength;
    g.addColorStop(0, rgba(col, amt));
    g.addColorStop(0.35, rgba(col, amt * 0.4));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x + nx * spread * side, b.y + ny * spread * side);
    ctx.lineTo(a.x + nx * spread * side, a.y + ny * spread * side);
    ctx.closePath();
    ctx.fill();
  }
  // crisp worn crease: segments with varying alpha
  const n = createNoise2D(seed);
  const steps = Math.max(8, Math.round(L / (6 * u)));
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const w = 0.55 + 0.45 * n(t0 * 9, 0.5);
    const x0 = a.x + dx * t0;
    const y0 = a.y + dy * t0;
    const x1 = a.x + dx * t1;
    const y1 = a.y + dy * t1;
    ctx.strokeStyle = rgba('#000000', 0.75 * strength * w);
    ctx.lineWidth = Math.max(0.8, 1.8 * u);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const ox = nx * lit * 1.7 * u;
    const oy = ny * lit * 1.7 * u;
    ctx.strokeStyle = rgba('#ffffff', 0.85 * strength * (1.1 - w * 0.5));
    ctx.lineWidth = Math.max(0.7, 1.5 * u);
    ctx.beginPath();
    ctx.moveTo(x0 + ox, y0 + oy);
    ctx.lineTo(x1 + ox, y1 + oy);
    ctx.stroke();
  }
  // worn specks along the fold
  const sp = new Path2D();
  const nSp = Math.round(L / (14 * u));
  for (let i = 0; i < nSp; i++) {
    const t = r();
    const off = (r() - 0.5) * 3 * u;
    const x = a.x + dx * t + nx * off;
    const y = a.y + dy * t + ny * off;
    const rad = u * (0.4 + r() * 1.2);
    sp.moveTo(x + rad, y);
    sp.arc(x, y, rad, 0, TAU);
  }
  ctx.fillStyle = rgba('#ffffff', 0.55 * strength);
  ctx.fill(sp);
  ctx.restore();
}

/** Extend segment a→b far beyond the canvas. */
function extend(a: Pt, b: Pt, k: number): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return [
    { x: a.x - dx * k, y: a.y - dy * k },
    { x: b.x + dx * k, y: b.y + dy * k },
  ];
}

const foldCreases = defineAsset(
  {
    id: 'fold-creases',
    name: 'Fold Creases',
    category: 'Paper & Grunge',
    tags: ['folds', 'creases', 'paper', 'grid', 'overlay', 'worn'],
    sizing: 'document',
    defaultBlendMode: 'overlay',
    defaultOpacity: 1,
    params: [
      P.num('folds', 'Folds', 1, 12, 3),
      P.pct('strength', 'Strength', 0.7),
      P.select('style', 'Layout', ['grid', 'random', 'diagonal'], 'grid'),
      P.pct('wear', 'Wrinkles', 0.5),
      P.seed(4),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 4);
      const strength = num(p, 'strength', 0.7);
      const folds = Math.max(1, Math.round(num(p, 'folds', 3)));
      const style = str(p, 'style', 'grid');
      const wear = num(p, 'wear', 0.5);
      const r = makeRand(seed);
      const [c, ctx] = newCanvas(W, H);
      // neutral 50% gray (invisible in overlay) with faint, soft wrinkle relief
      const { fw, fh, s } = fieldDims(W, H, 60_000);
      const f = noiseField(fw, fh, s * u, { seed, freq: 2.2, octaves: 5, gain: 0.55 });
      const bg = paintField(fw, fh, (i, _x, _y, px, o) => {
        const v = 128 + f[i] * 14 * wear;
        px[o] = px[o + 1] = px[o + 2] = v;
        px[o + 3] = 255;
      });
      drawUpscaled(ctx, bg, W, H);
      const lines: [Pt, Pt][] = [];
      if (style === 'grid') {
        const nv = Math.ceil(folds / 2);
        const nh = Math.max(0, folds - nv);
        for (let i = 0; i < nv; i++) {
          const x = W * ((i + 1) / (nv + 1)) + (r() - 0.5) * W * 0.06;
          lines.push(extend({ x: x + (r() - 0.5) * 8 * u, y: 0 }, { x: x + (r() - 0.5) * 16 * u, y: H }, 0.2));
        }
        for (let j = 0; j < nh; j++) {
          const y = H * ((j + 1) / (nh + 1)) + (r() - 0.5) * H * 0.06;
          lines.push(extend({ x: 0, y: y + (r() - 0.5) * 8 * u }, { x: W, y: y + (r() - 0.5) * 16 * u }, 0.2));
        }
      } else {
        for (let i = 0; i < folds; i++) {
          const cx = W * (0.15 + r() * 0.7);
          const cy = H * (0.15 + r() * 0.7);
          const a = style === 'diagonal' ? (r() < 0.5 ? 1 : -1) * (0.55 + r() * 0.35) : r() * Math.PI;
          const d = Math.hypot(W, H);
          lines.push([
            { x: cx - Math.cos(a) * d, y: cy - Math.sin(a) * d },
            { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d },
          ]);
        }
      }
      lines.forEach(([a, b], i) => drawFold(ctx, a, b, u, strength, r, seed + i * 13));
      // short secondary wrinkles
      const extra = Math.round(4 + wear * 10);
      for (let i = 0; i < extra; i++) {
        const cx = r() * W;
        const cy = r() * H;
        const a = r() * Math.PI;
        const len = (60 + r() * 220) * u;
        drawFold(
          ctx,
          { x: cx - Math.cos(a) * len, y: cy - Math.sin(a) * len },
          { x: cx + Math.cos(a) * len, y: cy + Math.sin(a) * len },
          u * 0.6,
          strength * 0.35 * wear,
          r,
          seed + 400 + i,
        );
      }
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* newspaper-clippings                                                 */
/* ------------------------------------------------------------------ */

function measureFit(ctx: CanvasRenderingContext2D, text: string, font: (size: number) => string, target: number): number {
  ctx.font = font(100);
  const w = ctx.measureText(text).width || 1;
  return (target / w) * 100;
}

let dotTile: HTMLCanvasElement | null = null;

/** A newsprint-style halftoned photo: gradient backdrop + blurry subject + dot screen. */
function drawFakePhoto(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: Rand, u: number, ink: RGB) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const v1 = 70 + r() * 70;
  const v2 = 140 + r() * 80;
  const g = ctx.createLinearGradient(x, y, x + w * (r() - 0.3), y + h);
  g.addColorStop(0, `rgb(${v2},${v2},${v2})`);
  g.addColorStop(1, `rgb(${v1},${v1},${v1})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.filter = `blur(${Math.max(0.5, w * 0.025)}px)`;
  if (r() < 0.6) {
    // portrait: head + shoulders
    const cx = x + w * (0.35 + r() * 0.3);
    const tone = 25 + r() * 40;
    ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
    ctx.beginPath();
    ctx.ellipse(cx, y + h * 0.42, w * 0.15, h * 0.2, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, y + h * 1.02, w * 0.42, h * 0.42, 0, Math.PI, TAU);
    ctx.fill();
  } else {
    // landscape / street: horizon + a few dark masses
    const hy = y + h * (0.45 + r() * 0.25);
    ctx.fillStyle = 'rgb(48,48,48)';
    ctx.fillRect(x, hy, w, h);
    for (let i = 0; i < 4; i++) {
      const bw = w * (0.08 + r() * 0.2);
      const bh = h * (0.15 + r() * 0.4);
      const bx = x + r() * w;
      const t = 30 + r() * 60;
      ctx.fillStyle = `rgb(${t},${t},${t})`;
      ctx.fillRect(bx, hy - bh, bw, bh);
    }
  }
  ctx.filter = 'none';
  // coarse dot screen
  if (!dotTile) {
    dotTile = document.createElement('canvas');
    dotTile.width = dotTile.height = 8;
    const d = dotTile.getContext('2d');
    if (d) {
      d.fillStyle = 'rgba(0,0,0,0.55)';
      d.beginPath();
      d.arc(4, 4, 2.2, 0, TAU);
      d.fill();
    }
  }
  const pat = ctx.createPattern(dotTile, 'repeat');
  if (pat) {
    pat.setTransform(new DOMMatrix().translate(x, y).rotate(45).scale(Math.max(0.35, u * 0.42)));
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = pat;
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
  ctx.strokeStyle = rgba(ink, 0.8);
  ctx.lineWidth = Math.max(0.5, 0.6 * u);
  ctx.strokeRect(x, y, w, h);
}

/** Draws justified fake body text in a column; returns the y where it stopped. */
function drawColumn(
  ctx: CanvasRenderingContext2D,
  r: Rand,
  x0: number,
  y0: number,
  colW: number,
  yMax: number,
  fs: number,
  ink: RGB,
  u: number,
) {
  const lineH = fs * 1.2;
  const bodyFont = `${fs}px ${FONT.body}`;
  ctx.font = bodyFont;
  const spaceW = ctx.measureText(' ').width;
  const widths = new Map<string, number>();
  let y = y0 + fs;
  let firstLine = true;
  let paraLeft = r.int(3, 11);
  let words: string[] = fakeSentence(r, 60);
  ctx.textBaseline = 'alphabetic';
  while (y < yMax) {
    const roll = r();
    if (roll < 0.045 && y > y0 + lineH * 4 && y < yMax - lineH * 4) {
      // subhead
      ctx.font = `700 ${fs * 1.18}px ${FONT.body}`;
      ctx.fillStyle = rgba(ink, 0.92);
      const t = capitalize(fakeHeadline(r, r.int(2, 3)));
      const tw = ctx.measureText(t).width;
      ctx.fillText(t, x0 + Math.max(0, (colW - tw) / 2), y + fs * 0.4);
      y += lineH * 1.9;
      firstLine = true;
      continue;
    }
    if (roll < 0.06 && colW > 50 * u && y < yMax - colW) {
      // photo block: a halftoned gray picture (portrait silhouette or landscape)
      const ph = colW * (0.55 + r() * 0.35);
      drawFakePhoto(ctx, x0, y - fs * 0.6, colW, ph, r, u, ink);
      y += ph + fs * 0.3;
      ctx.font = `italic ${fs * 0.85}px ${FONT.body}`;
      ctx.fillStyle = rgba(ink, 0.85);
      ctx.fillText(fakeSentence(r, 5).join(' '), x0, y, colW);
      y += lineH * 1.5;
      firstLine = true;
      continue;
    }
    // body line
    ctx.font = bodyFont;
    const indent = firstLine ? fs * 1.4 : 0;
    const avail = colW - indent;
    const space = spaceW;
    const line: string[] = [];
    let w = 0;
    for (;;) {
      if (!words.length) words = fakeSentence(r, 60);
      const word = words[0];
      let ww = widths.get(word);
      if (ww === undefined) {
        ww = ctx.measureText(word).width;
        widths.set(word, ww);
      }
      if (line.length && w + space + ww > avail) break;
      line.push(word);
      w += (line.length > 1 ? space : 0) + ww;
      words.shift();
      if (w > avail) break;
    }
    paraLeft--;
    const lastOfPara = paraLeft <= 0;
    ctx.fillStyle = rgba(ink, 0.78 + r() * 0.17);
    const gaps = line.length - 1;
    const extra = !lastOfPara && gaps > 0 ? (avail - w) / gaps : 0;
    const drawCount = lastOfPara ? Math.max(1, Math.ceil(line.length * (0.3 + r() * 0.6))) : line.length;
    // one fillText per line: justification through word spacing
    ctx.wordSpacing = `${extra.toFixed(2)}px`;
    ctx.fillText(line.slice(0, drawCount).join(' '), x0 + indent, y);
    ctx.wordSpacing = '0px';
    firstLine = false;
    if (lastOfPara) {
      paraLeft = r.int(3, 12);
      firstLine = true;
    }
    y += lineH;
  }
  return y;
}

function renderClipping(
  r: Rand,
  cw: number,
  ch: number,
  u: number,
  cols: number,
  tone: RGB,
  headlines: boolean,
  textSize: number,
  seed: number,
  paperTex: HTMLCanvasElement,
  zoom = 1,
) {
  const pad = Math.ceil(10 * u);
  const [c, ctx] = newCanvas(cw + pad * 2, ch + pad * 2);
  ctx.translate(pad, pad);
  // outline: torn on some sides, cut on others
  const torn = [r() < 0.75, r() < 0.65, r() < 0.75, r() < 0.65];
  if (torn.filter(Boolean).length < 2) torn[r.int(0, 3)] = true;
  const j = () => (r() - 0.5) * 5 * u;
  const corners: Pt[] = [
    { x: j(), y: j() },
    { x: cw + j(), y: j() },
    { x: cw + j(), y: ch + j() },
    { x: j(), y: ch + j() },
  ];
  const poly: Pt[] = [];
  for (let s = 0; s < 4; s++) {
    const a = corners[s];
    const b = corners[(s + 1) % 4];
    const seg = torn[s] ? tornLine(a, b, r, 0.045 + r() * 0.05, Math.max(1.5, 2.2 * u)) : [a, b];
    for (let i = 0; i < seg.length - 1; i++) poly.push(seg[i]);
  }
  const path = new Path2D();
  tracePoly(path, poly);
  // white fibrous fringe of torn paper (under the sheet)
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = rgba(shade(tone, 0.55), 0.95);
  ctx.lineWidth = Math.max(1, 3.4 * u);
  ctx.stroke(path);
  ctx.restore();
  ctx.save();
  ctx.clip(path);
  ctx.save();
  ctx.translate(-pad, -pad);
  // shared paper texture (rendered once per asset) at a random offset, slightly re-toned
  const ox = r() * Math.max(0, paperTex.width - (cw + pad * 2));
  const oy = r() * Math.max(0, paperTex.height - (ch + pad * 2));
  ctx.drawImage(paperTex, -ox, -oy);
  ctx.fillStyle = rgba(tone, 0.35);
  ctx.fillRect(0, 0, cw + pad * 2, ch + pad * 2);
  ctx.restore();
  const ink: RGB = { r: 24, g: 22, b: 20 };
  const m = (8 + r() * 6) * u;
  let y = m;
  const inner = cw - m * 2;
  if (headlines && r() < 0.8) {
    const style = r.pick(['sans', 'serif', 'cond'] as const);
    const words = r.int(1, 3);
    const raw = fakeHeadline(r, words);
    const text = style === 'serif' ? raw.split(' ').map(capitalize).join(' ') : raw.toUpperCase();
    const fontFn =
      style === 'sans'
        ? (sz: number) => `400 ${sz}px ${FONT.headSans}`
        : style === 'cond'
          ? (sz: number) => `600 ${sz}px ${FONT.headCond}`
          : (sz: number) => `900 ${sz}px ${FONT.headSerif}`;
    let size = measureFit(ctx, text, fontFn, inner * (0.95 + r() * 0.5));
    size = Math.max(18 * u * textSize, Math.min(size, ch * 0.24));
    ctx.font = fontFn(size);
    ctx.fillStyle = rgba(ink, 0.94);
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, m, y + size * 0.82);
    y += size * 0.98;
    if (r() < 0.6) {
      const sub = fakeSentence(r, r.int(4, 8)).join(' ');
      const ss = Math.max(9 * u, size * 0.28);
      ctx.font = `italic ${ss}px ${FONT.body}`;
      ctx.fillStyle = rgba(ink, 0.85);
      ctx.fillText(sub, m, y + ss);
      y += ss * 1.5;
    }
    ctx.fillStyle = rgba(ink, 0.9);
    ctx.fillRect(m, y, inner, Math.max(0.8, 1.6 * u));
    ctx.fillRect(m, y + 3 * u, inner, Math.max(0.5, 0.6 * u));
    y += 9 * u;
  }
  const gutter = 7 * u * Math.sqrt(zoom);
  const colW = (inner - (cols - 1) * gutter) / cols;
  // `zoom` > 1 = a close-up clipping with big type (like the cut-outs in the noir reference)
  const fs = Math.max(5, Math.min(colW / 13, 15 * u * zoom) * textSize);
  for (let k = 0; k < cols; k++) {
    const x0 = m + k * (colW + gutter);
    drawColumn(ctx, r, x0, y, colW, ch + fs * 2, fs, ink, u);
    if (k < cols - 1) {
      ctx.fillStyle = rgba(ink, 0.5);
      ctx.fillRect(x0 + colW + gutter / 2 - 0.3 * u, y, Math.max(0.5, 0.6 * u), ch);
    }
  }
  // print texture + aging
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.35;
  fillGrain(ctx, cw, ch, seed + 2, Math.max(1, 1.5 * u), 0.6);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const age = ctx.createRadialGradient(cw * r(), ch * r(), 0, cw / 2, ch / 2, Math.max(cw, ch) * 0.8);
  age.addColorStop(0, rgba('#ffffff', 0));
  age.addColorStop(1, rgba('#3a3226', 0.16));
  ctx.fillStyle = age;
  ctx.fillRect(0, 0, cw, ch);
  ctx.restore();
  return { canvas: c, pad };
}

const newspaperClippings = defineAsset(
  {
    id: 'newspaper-clippings',
    name: 'Newspaper Clippings',
    category: 'Paper & Grunge',
    tags: ['newspaper', 'clippings', 'collage', 'noir', 'text', 'torn', 'print'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    defaultOpacity: 1,
    params: [
      P.num('columns', 'Columns', 1, 6, 3),
      P.color('tone', 'Paper tone', '#dcd9d0'),
      P.pct('density', 'Density', 0.55),
      P.num('rotation', 'Rotation', 0, 45, 8, { unit: '°' }),
      P.select(
        'placement',
        'Placement',
        [
          ['edges', 'Along edges'],
          ['left', 'Left edge'],
          ['right', 'Right edge'],
          ['scattered', 'Scattered'],
        ],
        'edges',
      ),
      P.num('textSize', 'Text size', 0.5, 3, 1.3, { step: 0.05, unit: '×' }),
      P.bool('headlines', 'Headlines', true),
      P.pct('shadow', 'Shadow', 0.5),
      P.seed(3),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 3);
      const r = makeRand(seed);
      const cols = Math.max(1, Math.round(num(p, 'columns', 3)));
      const tone = rgbOf(str(p, 'tone', '#dcd9d0'));
      const density = num(p, 'density', 0.55);
      const rot = (num(p, 'rotation', 8) * Math.PI) / 180;
      const placement = str(p, 'placement', 'edges');
      const textSize = num(p, 'textSize', 1.3);
      const headlines = bool(p, 'headlines', true);
      const shadow = num(p, 'shadow', 0.5);
      const M = Math.min(W, H);
      const count = Math.max(1, Math.round(1 + density * 8));
      type Slot = { side: 'l' | 'r' | 't' | 'b' | 'c'; t: number };
      let slots: Slot[];
      if (placement === 'left' || placement === 'right') {
        const side = placement === 'left' ? 'l' : 'r';
        slots = Array.from({ length: count }, (_, i) => ({ side, t: (i + 0.5) / count }));
      } else if (placement === 'scattered') {
        slots = Array.from({ length: count }, () => ({ side: 'c', t: r() }));
      } else {
        const order: Slot[] = [
          { side: 'l', t: 0.3 },
          { side: 'r', t: 0.8 },
          { side: 'l', t: 0.85 },
          { side: 'r', t: 0.2 },
          { side: 'b', t: 0.25 },
          { side: 't', t: 0.75 },
          { side: 'b', t: 0.8 },
          { side: 't', t: 0.15 },
          { side: 'l', t: 0.55 },
          { side: 'r', t: 0.5 },
        ];
        slots = order.slice(0, count);
      }
      const [c, ctx] = newCanvas(W, H);
      const texSide = Math.ceil(M * 0.86 + 24 * u);
      const [paperTex, ptx] = newCanvas(texSide, texSide);
      paintPaper(ptx, texSide, texSide, u, tone, seed, { mottle: 0.7, grain: 0.6, fibers: 0.25, specks: 0.25 });
      slots.forEach((slot, idx) => {
        const vertical = (slot.side === 'l' || slot.side === 'r') && r() < 0.45;
        let cw = M * (0.26 + r() * 0.2);
        let ch = M * (0.42 + r() * 0.4);
        if (slot.side === 't' || slot.side === 'b') [cw, ch] = [ch * 0.9, cw * 0.95];
        // most clippings are regular print; every few is a close-up with large type
        const zoom = idx % 3 === 0 ? 1.7 + r() * 0.9 : 0.85 + r() * 0.4;
        const colsHere = Math.max(1, Math.min(cols, Math.round(((cw / M) * cols * 2.6) / zoom)));
        const { canvas: clip, pad } = renderClipping(
          r,
          Math.round(cw),
          Math.round(ch),
          u,
          colsHere,
          shade(tone, (r() - 0.5) * 0.1),
          headlines,
          textSize,
          seed * 7 + idx,
          paperTex,
          zoom,
        );
        let angle = (r() - 0.5) * 2 * rot;
        if (vertical) angle += (r() < 0.5 ? 1 : -1) * Math.PI / 2;
        // visual (rotated) extents
        const ew = vertical ? ch : cw;
        const eh = vertical ? cw : ch;
        let x = 0;
        let y = 0;
        switch (slot.side) {
          case 'l':
            x = ew * (0.12 + r() * 0.3);
            y = H * slot.t;
            break;
          case 'r':
            x = W - ew * (0.12 + r() * 0.3);
            y = H * slot.t;
            break;
          case 't':
            x = W * slot.t;
            y = eh * (0.1 + r() * 0.25);
            break;
          case 'b':
            x = W * slot.t;
            y = H - eh * (0.1 + r() * 0.25);
            break;
          default:
            x = W * (0.1 + r() * 0.8);
            y = H * (0.1 + r() * 0.8);
        }
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        if (shadow > 0) {
          // cheap soft shadow: blur a quarter-resolution silhouette, then scale it up
          const q = 0.25;
          const [sh, sctx] = newCanvas(Math.ceil(clip.width * q) + 8, Math.ceil(clip.height * q) + 8);
          sctx.filter = `blur(${Math.max(0.5, 14 * u * shadow * q * 0.6)}px)`;
          sctx.drawImage(clip, 4, 4, clip.width * q, clip.height * q);
          sctx.filter = 'none';
          sctx.globalCompositeOperation = 'source-in';
          sctx.fillStyle = rgba('#000000', 0.6 * shadow);
          sctx.fillRect(0, 0, sh.width, sh.height);
          ctx.drawImage(sh, -cw / 2 - pad + 3 * u - 4 / q, -ch / 2 - pad + 4 * u - 4 / q, sh.width / q, sh.height / q);
        }
        ctx.drawImage(clip, -cw / 2 - pad, -ch / 2 - pad);
        ctx.restore();
      });
      return c;
    },
  },
  { bg: 'dark', fonts: true },
);

/* ------------------------------------------------------------------ */
/* concrete                                                            */
/* ------------------------------------------------------------------ */

const concrete = defineAsset(
  {
    id: 'concrete',
    name: 'Concrete',
    category: 'Paper & Grunge',
    tags: ['concrete', 'wall', 'cement', 'texture', 'grunge', 'urban'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('tone', 'Tone', '#8e8c87'),
      P.pct('roughness', 'Roughness', 0.6),
      P.pct('pits', 'Pits', 0.5),
      P.pct('stains', 'Stains', 0.45),
      P.seed(9),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 9);
      const tone = rgbOf(str(p, 'tone', '#8e8c87'));
      const rough = num(p, 'roughness', 0.6);
      const stains = num(p, 'stains', 0.45);
      const { fw, fh, s } = fieldDims(W, H, 150_000);
      const f1 = noiseField(fw, fh, s * u, { seed, freq: 2.5, octaves: 5, warp: 0.5 });
      const f2 = noiseField(fw, fh, s * u, { seed: seed + 1, freq: 18, octaves: 3 });
      const f3 = noiseField(fw, fh, s * u, { seed: seed + 2, freq: 1.2, octaves: 3, stretchY: 3 });
      const base = paintField(fw, fh, (i, _x, _y, px, o) => {
        const streak = Math.max(0, f3[i]) * stains * 0.35;
        const k = 1 + f1[i] * 0.22 * rough + f2[i] * 0.08 * rough - streak;
        px[o] = tone.r * k;
        px[o + 1] = tone.g * k;
        px[o + 2] = tone.b * k * (1 - streak * 0.1);
        px[o + 3] = 255;
      });
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, base, W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.55 * rough + 0.2;
      fillGrain(ctx, W, H, seed, 1);
      ctx.globalAlpha = 0.5 * rough;
      fillGrain(ctx, W, H, seed + 1, Math.max(1, 3 * u), 1);
      ctx.restore();
      // pits: dark holes with a light lower lip
      const r = makeRand(seed + 3);
      const n = Math.round(((W * H) / (u * u * 1e6)) * 1600 * num(p, 'pits', 0.5));
      const dark = new Path2D();
      const light = new Path2D();
      for (let i = 0; i < n; i++) {
        const x = r() * W;
        const y = r() * H;
        const rad = u * (0.5 + r() * r() * 4);
        light.moveTo(x + rad, y + rad * 0.5);
        light.ellipse(x, y + rad * 0.5, rad, rad * 0.8, 0, 0, TAU);
        dark.moveTo(x + rad, y);
        dark.ellipse(x, y, rad, rad * 0.8, 0, 0, TAU);
      }
      ctx.fillStyle = rgba(shade(tone, 0.4), 0.35);
      ctx.fill(light);
      ctx.fillStyle = rgba(shade(tone, -0.6), 0.6);
      ctx.fill(dark);
      drawScratches(ctx, W, H, u, '#000000', r, 40 * rough, { alpha: 0.25, maxLen: 120 });
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* cracks                                                              */
/* ------------------------------------------------------------------ */

function crackBranch(
  out: { pts: Pt[]; w: number }[],
  x: number,
  y: number,
  a: number,
  len: number,
  w: number,
  u: number,
  r: Rand,
  branching: number,
  depth: number,
) {
  const pts: Pt[] = [{ x, y }];
  let travelled = 0;
  let ang = a;
  while (travelled < len) {
    const step = u * (5 + r() * 9);
    ang += (r() - 0.5) * 0.9;
    ang += (a - ang) * 0.2;
    x += Math.cos(ang) * step;
    y += Math.sin(ang) * step;
    travelled += step;
    pts.push({ x, y });
    if (depth < 4 && r() < 0.05 * branching) {
      crackBranch(out, x, y, ang + r.sign() * (0.4 + r() * 0.8), (len - travelled) * (0.3 + r() * 0.5), w * 0.6, u, r, branching, depth + 1);
    }
  }
  out.push({ pts, w });
}

const cracks = defineAsset(
  {
    id: 'cracks',
    name: 'Cracks',
    category: 'Paper & Grunge',
    tags: ['cracks', 'broken', 'shatter', 'damage', 'ground', 'wall'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    params: [
      P.color('color', 'Color', '#121110'),
      P.num('count', 'Cracks', 1, 12, 4),
      P.pct('branching', 'Branching', 0.55),
      P.num('thickness', 'Thickness', 0.5, 8, 2, { step: 0.1, unit: 'px' }),
      P.bool('highlight', 'Light edge', true),
      P.seed(15),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 15));
      const color = str(p, 'color', '#121110');
      const count = Math.round(num(p, 'count', 4));
      const branching = num(p, 'branching', 0.55);
      const th = num(p, 'thickness', 2) * u;
      const all: { pts: Pt[]; w: number }[] = [];
      for (let i = 0; i < count; i++) {
        const x = r() * W;
        const y = r() * H;
        const rays = r.int(2, 4);
        const a0 = r() * TAU;
        for (let k = 0; k < rays; k++) {
          crackBranch(all, x, y, a0 + (k / rays) * TAU + (r() - 0.5) * 0.8, Math.min(W, H) * (0.2 + r() * 0.45), th, u, r, branching, 0);
        }
      }
      const [c, ctx] = newCanvas(W, H);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const hl = bool(p, 'highlight', true);
      for (const { pts, w } of all) {
        // taper: thick at start, thin at end
        for (let i = 1; i < pts.length; i++) {
          const t = i / pts.length;
          const lw = Math.max(0.5, w * (1 - t * 0.85) * (0.7 + r() * 0.6));
          if (hl) {
            ctx.strokeStyle = rgba('#ffffff', 0.35);
            ctx.lineWidth = Math.max(0.5, lw * 0.6);
            ctx.beginPath();
            ctx.moveTo(pts[i - 1].x + lw * 0.6, pts[i - 1].y + lw * 0.8);
            ctx.lineTo(pts[i].x + lw * 0.6, pts[i].y + lw * 0.8);
            ctx.stroke();
          }
          ctx.strokeStyle = rgba(color, 0.9);
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
          ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        }
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* torn-paper-strip                                                    */
/* ------------------------------------------------------------------ */

const tornPaperStrip = defineAsset(
  {
    id: 'torn-paper-strip',
    name: 'Torn Paper Strip',
    category: 'Paper & Grunge',
    tags: ['torn', 'paper', 'strip', 'label', 'banner', 'tape'],
    sizing: { width: 1600, height: 380 },
    defaultBlendMode: 'normal',
    params: [
      P.color('tone', 'Tone', '#efebe2'),
      P.pct('roughness', 'Tear roughness', 0.5),
      P.pct('shadow', 'Shadow', 0.5),
      P.pct('grain', 'Grain', 0.5),
      P.seed(2),
    ],
    generate(p, { width: W, height: H }) {
      const u = Math.max(0.2, Math.min(W, H) / 380);
      const seed = num(p, 'seed', 2);
      const r = makeRand(seed);
      const tone = rgbOf(str(p, 'tone', '#efebe2'));
      const rough = num(p, 'roughness', 0.5);
      const shadow = num(p, 'shadow', 0.5);
      const m = 24 * u;
      const corners: Pt[] = [
        { x: m + r() * 10 * u, y: m + r() * 18 * u },
        { x: W - m - r() * 10 * u, y: m + r() * 18 * u },
        { x: W - m - r() * 10 * u, y: H - m - r() * 18 * u },
        { x: m + r() * 10 * u, y: H - m - r() * 18 * u },
      ];
      const poly: Pt[] = [];
      for (let s = 0; s < 4; s++) {
        const seg = tornLine(corners[s], corners[(s + 1) % 4], r, (s % 2 === 0 ? 0.03 : 0.12) + rough * 0.08, Math.max(1.5, 2.5 * u));
        for (let i = 0; i < seg.length - 1; i++) poly.push(seg[i]);
      }
      const path = new Path2D();
      tracePoly(path, poly);
      const [c, ctx] = newCanvas(W, H);
      if (shadow > 0) {
        ctx.save();
        ctx.shadowColor = rgba('#000000', 0.5 * shadow);
        ctx.shadowBlur = 16 * u * shadow;
        ctx.shadowOffsetY = 6 * u * shadow;
        ctx.fillStyle = rgba(tone, 1);
        ctx.fill(path);
        ctx.restore();
      }
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = rgba(shade(tone, 0.6), 1);
      ctx.lineWidth = 4 * u;
      ctx.stroke(path);
      ctx.clip(path);
      paintPaper(ctx, W, H, u * 0.9, tone, seed, { grain: num(p, 'grain', 0.5), fibers: 0.5, mottle: 0.7, specks: 0.2 });
      ctx.restore();
      // fibers poking out of the torn edge
      ctx.save();
      ctx.strokeStyle = rgba(shade(tone, 0.5), 0.8);
      ctx.lineWidth = Math.max(0.5, 0.8 * u);
      ctx.beginPath();
      for (let i = 0; i < poly.length; i += 3) {
        if (r() > 0.35) continue;
        const pt = poly[i];
        const a = r() * TAU;
        const L = (2 + r() * 6) * u;
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x + Math.cos(a) * L, pt.y + Math.sin(a) * L);
      }
      ctx.stroke();
      ctx.restore();
      return c;
    },
  },
  { bg: 'dark' },
);

export const paperAssets: AssetDef[] = [
  paperTexture,
  grungePaper,
  crumpledPaper,
  foldCreases,
  newspaperClippings,
  concrete,
  cracks,
  tornPaperStrip,
];

export { horizontalCracks };
