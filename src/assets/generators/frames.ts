/**
 * Borders & Frames: torn-border, film-frame, rounded-frame, brush-border, polaroid.
 */
import type { AssetDef } from '../../registry';
import { createNoise2D } from '../../core/noise';
import { fieldDims, noiseField, paintField } from '../lib/field';
import { FONT } from '../lib/fonts';
import { blob, tornLine } from '../lib/geom';
import { P, defineAsset } from '../lib/params';
import { drawScratches, drawSpecks, paintPaper } from '../lib/surface';
import type { Pt, Rand, RGB } from '../lib/util';
import { TAU, bool, drawUpscaled, makeRand, newCanvas, num, rgbOf, rgba, shade, smoothstep, str, tracePoly, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* torn-border                                                         */
/* ------------------------------------------------------------------ */

interface EdgeSample {
  x: number;
  y: number;
  nx: number;
  ny: number;
  s: number;
}

/** Samples along a rounded rectangle (clockwise) with inward normals. */
export function roundedRectSamples(x0: number, y0: number, x1: number, y1: number, cr: number, step: number): { pts: EdgeSample[]; perimeter: number } {
  const pts: EdgeSample[] = [];
  let s = 0;
  const line = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(L / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx, ny, s: s + L * t });
    }
    s += L;
  };
  const arc = (cx: number, cy: number, a0: number) => {
    const L = (cr * Math.PI) / 2;
    const n = Math.max(2, Math.round(L / step));
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2);
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pts.push({ x: cx + c * cr, y: cy + sn * cr, nx: -c, ny: -sn, s: s + L * (i / n) });
    }
    s += L;
  };
  line(x0 + cr, y0, x1 - cr, y0, 0, 1);
  arc(x1 - cr, y0 + cr, -Math.PI / 2);
  line(x1, y0 + cr, x1, y1 - cr, -1, 0);
  arc(x1 - cr, y1 - cr, 0);
  line(x1 - cr, y1, x0 + cr, y1, 0, -1);
  arc(x0 + cr, y1 - cr, Math.PI / 2);
  line(x0, y1 - cr, x0, y0 + cr, 1, 0);
  arc(x0 + cr, y0 + cr, Math.PI);
  return { pts, perimeter: s };
}

function framePath(W: number, H: number, inner: Pt[]): Path2D {
  const p = new Path2D();
  p.rect(-50, -50, W + 100, H + 100);
  tracePoly(p, inner);
  return p;
}

const tornBorder = defineAsset(
  {
    id: 'torn-border',
    name: 'Torn Border',
    category: 'Borders & Frames',
    tags: ['torn', 'burnt', 'border', 'frame', 'gothic', 'grunge', 'edges', 'vignette'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    defaultOpacity: 1,
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('thickness', 'Thickness', 10, 260, 64, { unit: 'px' }),
      P.pct('roughness', 'Roughness', 0.65),
      P.pct('burn', 'Burnt edge', 0.55),
      P.pct('flecks', 'Flecks', 0.6),
      P.pct('texture', 'Scuffs', 0.55),
      P.pct('fringe', 'Torn fringe', 0.45),
      P.seed(11),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 11);
      const r = makeRand(seed);
      const color = rgbOf(str(p, 'color', '#0b0b0b'));
      const T = num(p, 'thickness', 64) * u;
      const rough = num(p, 'roughness', 0.65);
      const burn = num(p, 'burn', 0.55);
      const fleckAmt = num(p, 'flecks', 0.6);
      const texture = num(p, 'texture', 0.55);
      const fringe = num(p, 'fringe', 0.45);
      const nBig = createNoise2D(seed + 1);
      const nMid = createNoise2D(seed + 2);
      const nSmall = createNoise2D(seed + 3);
      const nBand = createNoise2D(seed + 4);
      const nRidge = createNoise2D(seed + 5);
      const inset = T * 0.8;
      const cr = Math.min(T * 1.2, Math.min(W, H) * 0.12);
      const { pts, perimeter: Pm } = roundedRectSamples(inset, inset, W - inset, H - inset, cr, Math.max(1, 1.6 * u));
      // a few deeper bites into the paper and a few retreats
      const chunks = Array.from({ length: Math.round(4 + 7 * rough) }, () => ({
        s: r() * Pm,
        w: (14 + r() * 70) * u,
        h: T * (r() < 0.7 ? 0.35 + r() * 0.9 : -(0.2 + r() * 0.3)),
        sharp: r() < 0.5,
      }));
      const periodic = (n: (x: number, y: number) => number, s: number, featureLen: number, salt: number) => {
        const th = (s / Pm) * TAU;
        const R = Pm / TAU / featureLen;
        return n(Math.cos(th) * R + salt, Math.sin(th) * R - salt);
      };
      const inner: Pt[] = [];
      const scorch: Pt[] = [];
      const offs: number[] = [];
      for (const q of pts) {
        let off =
          T *
          (0.12 +
            rough *
              (0.38 * periodic(nBig, q.s, 260 * u, 0) +
                0.3 * periodic(nMid, q.s, 60 * u, 3) +
                0.16 * periodic(nSmall, q.s, 14 * u, 7) +
                // ridged component → sharp torn creases instead of soft waves
                0.22 * (0.5 - Math.abs(periodic(nRidge, q.s, 34 * u, 5)))));
        for (const c of chunks) {
          let d = Math.abs(q.s - c.s);
          d = Math.min(d, Pm - d);
          const k = d / c.w;
          off += c.h * (c.sharp ? Math.max(0, 1 - k) ** 1.6 : Math.exp(-k * k * 2.5));
        }
        off += (r() - 0.5) * 3.2 * u * (0.3 + rough);
        off = Math.max(-inset * 0.75, off);
        offs.push(off);
        inner.push({ x: q.x + q.nx * off, y: q.y + q.ny * off });
        const band = (4 + 14 * Math.abs(periodic(nBand, q.s, 36 * u, 11))) * u * (0.4 + burn);
        scorch.push({ x: q.x + q.nx * (off + band), y: q.y + q.ny * (off + band) });
      }
      const [c, ctx] = newCanvas(W, H);
      // 1. burnt edge on the paper side: narrow soft darkening + an irregular scorch band
      if (burn > 0) {
        ctx.save();
        ctx.filter = `blur(${Math.max(1, T * 0.16)}px)`;
        ctx.strokeStyle = rgba(color, 0.3 * burn);
        ctx.lineWidth = T * 0.42;
        ctx.beginPath();
        tracePoly(ctx, inner);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = rgba(color, 0.22 * burn);
        ctx.fill(framePath(W, H, scorch), 'evenodd');
      }
      // 2. the frame itself
      ctx.fillStyle = rgba(color, 1);
      ctx.fill(framePath(W, H, inner), 'evenodd');
      // 3. worn print inside the black: soft mottling, worn speckle patches, scratches
      if (texture > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const { fw, fh, s } = fieldDims(W, H, 140_000);
        const f = noiseField(fw, fh, s / u, { seed: seed + 9, freq: 5, octaves: 4 });
        const g = noiseField(fw, fh, s / u, { seed: seed + 10, freq: 40, octaves: 2 });
        const wornF = noiseField(fw, fh, s / u, { seed: seed + 12, freq: 9, octaves: 3 });
        const light = shade(color, 0.36);
        const scuff = paintField(fw, fh, (i, _x, _y, px, o) => {
          const worn = smoothstep(0.15, 0.55, wornF[i]) * smoothstep(0.1, 0.6, g[i] * 0.5 + 0.5);
          const a = smoothstep(-0.1, 0.8, f[i]) * 0.16 + worn * 0.5;
          px[o] = light.r;
          px[o + 1] = light.g;
          px[o + 2] = light.b;
          px[o + 3] = Math.min(1, a * texture) * 255;
        });
        drawUpscaled(ctx, scuff, W, H);
        const area = (W * H) / (u * u * 1e6);
        drawScratches(ctx, W, H, u, '#cfcfcf', r, 300 * texture * area, { angle: 0, angleJitter: 0.25, alpha: 0.38, maxLen: 110, width: 0.7 });
        drawScratches(ctx, W, H, u, '#cfcfcf', r, 120 * texture * area, { angle: Math.PI / 2, angleJitter: 0.3, alpha: 0.3, maxLen: 70, width: 0.6 });
        drawSpecks(ctx, W, H, u, { r: 220, g: 220, b: 220 }, r, 1.1 * texture);
        ctx.restore();
      }
      // 4. torn fringe: a thin light fibrous lip where the black layer tore away
      if (fringe > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.lineJoin = 'round';
        let i = 0;
        while (i < inner.length - 1) {
          const len = 8 + Math.floor(r() * 60);
          if (r() < 0.55 * fringe + 0.15) {
            const seg = new Path2D();
            const w = (1.5 + r() * 3.5) * u;
            for (let k = 0; k <= len && i + k < inner.length; k++) {
              const q = pts[i + k];
              const e = inner[i + k];
              const x = e.x - q.nx * w * 0.6;
              const y = e.y - q.ny * w * 0.6;
              if (k) seg.lineTo(x, y);
              else seg.moveTo(x, y);
            }
            ctx.strokeStyle = rgba(shade(color, 0.75), (0.25 + r() * 0.45) * fringe);
            ctx.lineWidth = w;
            ctx.stroke(seg);
          }
          i += len;
        }
        ctx.restore();
      }
      // 5. flecks scattered just inside the tear, denser near the edge
      const nFlecks = Math.round((Pm / u / 1000) * 460 * fleckAmt);
      const fl = new Path2D();
      for (let i = 0; i < nFlecks; i++) {
        const k = Math.floor(r() * pts.length);
        const q = pts[k];
        const d = -Math.log(1 - r() * 0.995) * T * 0.22 + 1.2 * u;
        const tj = (r() - 0.5) * 6 * u;
        const x = inner[k].x + q.nx * d - q.ny * tj;
        const y = inner[k].y + q.ny * d + q.nx * tj;
        const size = u * (0.35 + r() ** 3 * 4.5) * (1 - 0.6 * smoothstep(0, T, d));
        tracePoly(fl, blob(x, y, size, r, r.int(4, 7), 0.75));
      }
      ctx.fillStyle = rgba(color, 0.95);
      ctx.fill(fl);
      // 6. paper fibers crossing the torn edge
      ctx.save();
      ctx.lineCap = 'round';
      const fib = new Path2D();
      const nFib = Math.round((Pm / u / 1000) * 240 * (0.4 + rough));
      for (let i = 0; i < nFib; i++) {
        const k = Math.floor(r() * pts.length);
        const q = pts[k];
        const e = inner[k];
        const len = (2 + r() * 8) * u;
        const tang = (r() - 0.5) * 1.6;
        const ex = e.x + (q.nx * Math.cos(tang) - q.ny * Math.sin(tang)) * len;
        const ey = e.y + (q.ny * Math.cos(tang) + q.nx * Math.sin(tang)) * len;
        fib.moveTo(e.x - q.nx * 2 * u, e.y - q.ny * 2 * u);
        fib.quadraticCurveTo(e.x + (r() - 0.5) * len, e.y + (r() - 0.5) * len, ex, ey);
      }
      ctx.strokeStyle = rgba(color, 0.7);
      ctx.lineWidth = Math.max(0.5, 0.6 * u);
      ctx.stroke(fib);
      ctx.restore();
      void offs;
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* film-frame                                                          */
/* ------------------------------------------------------------------ */

const filmFrame = defineAsset(
  {
    id: 'film-frame',
    name: 'Film Frame',
    category: 'Borders & Frames',
    tags: ['film', '35mm', 'negative', 'sprockets', 'cinema', 'frame', 'retro'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Film color', '#0c0b0a'),
      P.select('orientation', 'Orientation', ['horizontal', 'vertical'], 'horizontal'),
      P.num('band', 'Band size', 30, 200, 92, { unit: 'px' }),
      P.bool('holes', 'Sprocket holes', true),
      P.bool('text', 'Edge print', true),
      P.color('textColor', 'Print color', '#e0862e'),
      P.text('label', 'Edge label', 'PRSV 400  SAFETY FILM'),
      P.pct('wear', 'Wear', 0.4),
      P.seed(5),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 5));
      const vertical = str(p, 'orientation', 'horizontal') === 'vertical';
      const color = str(p, 'color', '#0c0b0a');
      const band = num(p, 'band', 92) * u;
      const [c, ctx] = newCanvas(W, H);
      // work in a rotated frame for vertical orientation
      const LW = vertical ? H : W;
      const LH = vertical ? W : H;
      ctx.save();
      if (vertical) {
        ctx.translate(W, 0);
        ctx.rotate(Math.PI / 2);
      }
      const frame = new Path2D();
      frame.rect(0, 0, LW, LH);
      const innerR = 14 * u;
      frame.roundRect(band * 0.15, band, LW - band * 0.3, LH - band * 2, innerR);
      ctx.fillStyle = color;
      ctx.fill(frame, 'evenodd');
      // frame separators (thin bars where frames meet), drawn at the left/right edges
      ctx.fillRect(0, 0, band * 0.15, LH);
      ctx.fillRect(LW - band * 0.15, 0, band * 0.15, LH);
      ctx.globalCompositeOperation = 'source-atop';
      const wear = num(p, 'wear', 0.4);
      drawScratches(ctx, LW, LH, u, '#ffffff', r, 120 * wear, { angle: 0, angleJitter: 0.1, alpha: 0.18, maxLen: 200 });
      ctx.globalCompositeOperation = 'source-over';
      if (bool(p, 'holes', true)) {
        const hw = band * 0.34;
        const hh = band * 0.44;
        const pitch = band * 0.95;
        ctx.globalCompositeOperation = 'destination-out';
        for (const yy of [band * 0.28, LH - band * 0.28 - hh]) {
          for (let x = pitch * 0.35; x < LW; x += pitch) {
            ctx.beginPath();
            ctx.roundRect(x, yy, hw, hh, hw * 0.22);
            ctx.fill();
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      if (bool(p, 'text', true)) {
        const tc = str(p, 'textColor', '#e0862e');
        const label = str(p, 'label', 'PRSV 400  SAFETY FILM');
        const fs = band * 0.16;
        ctx.font = `700 ${fs}px ${FONT.cond}`;
        ctx.fillStyle = rgba(tc, 0.9);
        ctx.textBaseline = 'middle';
        const yText = band * 0.86;
        let frameNo = r.int(1, 30);
        for (let x = band * 0.6; x < LW - band; x += band * 4.2) {
          ctx.fillText(`${label}`, x, yText);
          ctx.fillText(`▸ ${frameNo}`, x + band * 2.6, yText);
          ctx.fillText(`${frameNo}A`, x + band * 1.2, LH - band * 0.86);
          frameNo++;
        }
      }
      ctx.restore();
      return c;
    },
  },
  { bg: 'paper', fonts: true },
);

/* ------------------------------------------------------------------ */
/* rounded-frame                                                       */
/* ------------------------------------------------------------------ */

const roundedFrame = defineAsset(
  {
    id: 'rounded-frame',
    name: 'Rounded Frame',
    category: 'Borders & Frames',
    tags: ['frame', 'border', 'rounded', 'icon', 'clean', 'outline'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#111111'),
      P.num('thickness', 'Thickness', 2, 200, 34, { unit: 'px' }),
      P.num('radius', 'Corner radius', 0, 400, 70, { unit: 'px' }),
      P.num('inset', 'Inset', 0, 200, 0, { unit: 'px' }),
      P.color('accent', 'Accent line', '#8b7cf6'),
      P.num('accentWidth', 'Accent width', 0, 40, 6, { unit: 'px' }),
      P.num('accentGap', 'Accent gap', 0, 80, 10, { unit: 'px' }),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const t = num(p, 'thickness', 34) * u;
      const rad = num(p, 'radius', 70) * u;
      const inset = num(p, 'inset', 0) * u;
      const [c, ctx] = newCanvas(W, H);
      const path = new Path2D();
      path.roundRect(inset, inset, W - inset * 2, H - inset * 2, rad + t * 0.5);
      path.roundRect(inset + t, inset + t, W - (inset + t) * 2, H - (inset + t) * 2, rad);
      ctx.fillStyle = str(p, 'color', '#111111');
      ctx.fill(path, 'evenodd');
      const aw = num(p, 'accentWidth', 6) * u;
      if (aw > 0) {
        const g = num(p, 'accentGap', 10) * u + t + inset;
        ctx.strokeStyle = str(p, 'accent', '#8b7cf6');
        ctx.lineWidth = aw;
        ctx.beginPath();
        ctx.roundRect(g + aw / 2, g + aw / 2, W - (g + aw / 2) * 2, H - (g + aw / 2) * 2, Math.max(0, rad - (g - t - inset) - aw / 2));
        ctx.stroke();
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* brush-border                                                        */
/* ------------------------------------------------------------------ */

function bristleStroke(ctx: CanvasRenderingContext2D, x0: number, x1: number, depth: number, u: number, r: Rand, color: RGB, dry: number) {
  // A horizontal dry-brush stroke along the top edge occupying y ∈ [0, depth] (local coords).
  const bristles = Math.max(6, Math.round(depth / (2.2 * u)));
  for (let b = 0; b < bristles; b++) {
    const y = (b / bristles) * depth + (r() - 0.5) * 2 * u;
    const outer = 1 - b / bristles; // bristles near the paper side are drier
    const skipStart = r() * (x1 - x0) * 0.25 * dry * (1 - outer);
    const skipEnd = r() * (x1 - x0) * 0.35 * dry * (1 - outer);
    const sx = x0 + skipStart;
    const ex = x1 - skipEnd;
    if (ex <= sx) continue;
    ctx.strokeStyle = rgba(color, 0.65 + r() * 0.35);
    ctx.lineWidth = u * (1.2 + r() * 2.6);
    ctx.beginPath();
    ctx.moveTo(sx, y);
    // broken bristles: gaps along the stroke
    let x = sx;
    while (x < ex) {
      const seg = (20 + r() * 140) * u;
      const nx = Math.min(ex, x + seg);
      ctx.lineTo(nx, y + (r() - 0.5) * 1.5 * u);
      x = nx;
      if (r() < 0.25 * dry * (1 - outer * 0.7)) {
        x += (4 + r() * 20) * u;
        ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  }
}

const brushBorder = defineAsset(
  {
    id: 'brush-border',
    name: 'Brush Border',
    category: 'Borders & Frames',
    tags: ['brush', 'paint', 'border', 'frame', 'dry brush', 'grunge'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('thickness', 'Thickness', 10, 260, 70, { unit: 'px' }),
      P.pct('roughness', 'Dryness', 0.6),
      P.seed(6),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 6));
      const color = rgbOf(str(p, 'color', '#0b0b0b'));
      const T = num(p, 'thickness', 70) * u;
      const dry = num(p, 'roughness', 0.6);
      const [c, ctx] = newCanvas(W, H);
      ctx.lineCap = 'round';
      const sides: [number, number, number][] = [
        [0, 0, 0],
        [W, 0, Math.PI / 2],
        [W, H, Math.PI],
        [0, H, -Math.PI / 2],
      ];
      sides.forEach(([tx, ty, rot], i) => {
        const len = i % 2 === 0 ? W : H;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(rot);
        // solid core
        ctx.fillStyle = rgba(color, 1);
        ctx.fillRect(-T, -T, len + T * 2, T * 1.45);
        const strokes = Math.round(len / (T * 1.4)) + 3;
        for (let k = 0; k < strokes; k++) {
          const x0 = -T + (k / strokes) * (len + T) + (r() - 0.5) * T;
          const x1 = x0 + T * (1.8 + r() * 3);
          bristleStroke(ctx, x0, x1, T * (0.7 + r() * 0.7), u, r, color, dry);
        }
        ctx.restore();
      });
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* polaroid                                                            */
/* ------------------------------------------------------------------ */

const polaroid = defineAsset(
  {
    id: 'polaroid',
    name: 'Polaroid',
    category: 'Borders & Frames',
    tags: ['polaroid', 'photo', 'instant', 'frame', 'memory', 'scrapbook'],
    sizing: { width: 760, height: 900 },
    defaultBlendMode: 'normal',
    params: [
      P.color('tone', 'Frame color', '#f3f1ea'),
      P.text('caption', 'Caption', ''),
      P.color('captionColor', 'Caption color', '#2b2b2b'),
      P.select(
        'photo',
        'Photo area',
        [
          ['clear', 'Transparent'],
          ['dark', 'Dark'],
          ['faded', 'Faded'],
        ],
        'clear',
      ),
      P.pct('shadow', 'Shadow', 0.5),
      P.pct('aging', 'Aging', 0.3),
      P.seed(8),
    ],
    generate(p, { width: W, height: H }) {
      const u = Math.min(W, H) / 760;
      const seed = num(p, 'seed', 8);
      const r = makeRand(seed);
      const tone = rgbOf(str(p, 'tone', '#f3f1ea'));
      const shadow = num(p, 'shadow', 0.5);
      const m = 26 * u;
      const fx = m;
      const fy = m;
      const fwid = W - m * 2;
      const fhgt = H - m * 2;
      const side = fwid * 0.065;
      const win = { x: fx + side, y: fy + side, w: fwid - side * 2, h: Math.min(fwid - side * 2, fhgt - side * 3.6) };
      const [c, ctx] = newCanvas(W, H);
      if (shadow > 0) {
        ctx.save();
        ctx.shadowColor = rgba('#000000', 0.55 * shadow);
        ctx.shadowBlur = 22 * u * shadow;
        ctx.shadowOffsetY = 8 * u * shadow;
        ctx.fillStyle = rgba(tone, 1);
        ctx.fillRect(fx, fy, fwid, fhgt);
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, fy, fwid, fhgt);
      ctx.clip();
      ctx.translate(fx, fy);
      paintPaper(ctx, fwid, fhgt, u * 0.8, tone, seed, { grain: 0.4, fibers: 0.25, mottle: 0.5 + num(p, 'aging', 0.3), specks: num(p, 'aging', 0.3) });
      const aging = num(p, 'aging', 0.3);
      if (aging > 0) {
        const g = ctx.createRadialGradient(fwid / 2, fhgt / 2, fwid * 0.3, fwid / 2, fhgt / 2, fhgt * 0.75);
        g.addColorStop(0, rgba('#ffffff', 0));
        g.addColorStop(1, rgba('#8a6a3a', 0.35 * aging));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, fwid, fhgt);
      }
      ctx.restore();
      // photo window
      const photo = str(p, 'photo', 'clear');
      if (photo === 'clear') {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(win.x, win.y, win.w, win.h);
        ctx.restore();
      } else {
        const g = ctx.createLinearGradient(win.x, win.y, win.x + win.w, win.y + win.h);
        if (photo === 'dark') {
          g.addColorStop(0, '#26262a');
          g.addColorStop(1, '#0d0d10');
        } else {
          g.addColorStop(0, '#c9bfae');
          g.addColorStop(1, '#8f8576');
        }
        ctx.fillStyle = g;
        ctx.fillRect(win.x, win.y, win.w, win.h);
      }
      // inner edge shading of the window
      ctx.save();
      ctx.strokeStyle = rgba('#000000', 0.25);
      ctx.lineWidth = Math.max(1, 1.5 * u);
      ctx.strokeRect(win.x + 0.5, win.y + 0.5, win.w - 1, win.h - 1);
      ctx.restore();
      const caption = str(p, 'caption', '');
      if (caption) {
        const cy = win.y + win.h + (fy + fhgt - (win.y + win.h)) / 2;
        let size = 64 * u;
        ctx.font = `400 ${size}px ${FONT.hand}`;
        const tw = ctx.measureText(caption).width;
        if (tw > win.w * 0.95) size *= (win.w * 0.95) / tw;
        ctx.font = `400 ${size}px ${FONT.hand}`;
        ctx.fillStyle = str(p, 'captionColor', '#2b2b2b');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(W / 2, cy);
        ctx.rotate((r() - 0.5) * 0.05);
        ctx.fillText(caption, 0, 0);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'dark', fonts: true },
);

export const frameAssets: AssetDef[] = [tornBorder, filmFrame, roundedFrame, brushBorder, polaroid];
export { tornLine };
