/**
 * Overlays: film-scratches, dust-specks, film-grain, light-leak, scanlines-overlay,
 * vignette-overlay.
 */
import type { AssetDef } from '../../registry';
import { fieldDims, fillGrain, noiseField, paintField } from '../lib/field';
import { blob } from '../lib/geom';
import { P, defineAsset } from '../lib/params';
import { drawScratches } from '../lib/surface';
import type { Rand, RGB } from '../lib/util';
import { TAU, bool, drawUpscaled, makeRand, newCanvas, num, rgbOf, rgba, smoothstep, str, tracePoly, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* film-scratches                                                      */
/* ------------------------------------------------------------------ */

/** Long, almost straight hairline running mostly vertically (or horizontally). */
function hairline(
  path: Path2D,
  x0: number,
  y0: number,
  len: number,
  vertical: boolean,
  u: number,
  r: Rand,
  broken: number,
) {
  let x = x0;
  let y = y0;
  let drift = (r() - 0.5) * 0.02;
  let travelled = 0;
  path.moveTo(x, y);
  while (travelled < len) {
    const step = (14 + r() * 26) * u;
    drift += (r() - 0.5) * 0.012;
    drift *= 0.9;
    if (vertical) {
      x += drift * step + (r() - 0.5) * 0.35 * u;
      y += step;
    } else {
      y += drift * step + (r() - 0.5) * 0.35 * u;
      x += step;
    }
    travelled += step;
    if (r() < broken * 0.08) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
}

/** Curly dust hair. */
function hair(path: Path2D, x: number, y: number, len: number, r: Rand) {
  let a = r() * TAU;
  let curl = (r() - 0.5) * 0.5;
  const steps = 10 + Math.floor(r() * 10);
  const step = len / steps;
  path.moveTo(x, y);
  for (let i = 0; i < steps; i++) {
    curl += (r() - 0.5) * 0.25;
    a += curl;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    path.lineTo(x, y);
  }
}

const filmScratches = defineAsset(
  {
    id: 'film-scratches',
    name: 'Film Scratches',
    category: 'Overlays',
    tags: ['film', 'scratches', 'dust', 'old', 'cinema', 'grunge', 'black', 'crimson'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    defaultOpacity: 1,
    params: [
      P.pct('density', 'Density', 0.55),
      P.color('color', 'Scratch color', '#f2f2f2'),
      P.bool('background', 'Black film base', true),
      P.color('baseColor', 'Base color', '#060606'),
      P.pct('lines', 'Long lines', 0.6),
      P.pct('dust', 'Dust & specks', 0.6),
      P.pct('grain', 'Grain', 0.5),
      P.seed(27),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 27);
      const r = makeRand(seed);
      const density = num(p, 'density', 0.55);
      const color = str(p, 'color', '#f2f2f2');
      const lines = num(p, 'lines', 0.6);
      const dust = num(p, 'dust', 0.6);
      const grain = num(p, 'grain', 0.5);
      const area = (W * H) / (u * u * 1e6);
      const [c, ctx] = newCanvas(W, H);
      if (bool(p, 'background', true)) {
        const base = rgbOf(str(p, 'baseColor', '#060606'));
        const { fw, fh, s } = fieldDims(W, H, 40_000);
        const f = noiseField(fw, fh, s * u, { seed, freq: 2.4, octaves: 4 });
        const g = noiseField(fw, fh, s * u, { seed: seed + 1, freq: 9, octaves: 3 });
        const img = paintField(fw, fh, (i, x, _y, px, o) => {
          // mottled emulsion + faint vertical density bands of old prints
          const band = Math.sin((x / fw) * 37 + f[i] * 3) * 0.5 + 0.5;
          const v = 1 + f[i] * 0.9 + g[i] * 0.35 + band * 0.25;
          px[o] = base.r * v + v * 3;
          px[o + 1] = base.g * v + v * 3;
          px[o + 2] = base.b * v + v * 3;
          px[o + 3] = 255;
        });
        drawUpscaled(ctx, img, W, H);
        if (grain > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = 0.07 * grain;
          fillGrain(ctx, W, H, seed, 1);
          ctx.globalAlpha = 0.06 * grain;
          fillGrain(ctx, W, H, seed + 1, Math.max(1, 2 * u), 0.8);
          ctx.restore();
        }
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 1. long vertical hairlines (projector scratches) in alpha buckets
      const nV = Math.round((6 + 34 * density) * lines * (W / (u * 1000)) * 0.6);
      for (let bkt = 0; bkt < 4; bkt++) {
        const path = new Path2D();
        for (let i = 0; i < nV / 4; i++) {
          const x = r() * W;
          const y0 = r() < 0.5 ? -10 * u : r() * H * 0.7;
          const len = H * (0.25 + r() * 0.9);
          hairline(path, x, y0, len, true, u, r, 0.5);
        }
        ctx.strokeStyle = rgba(color, [0.12, 0.22, 0.38, 0.6][bkt]);
        ctx.lineWidth = Math.max(0.5, u * [0.7, 0.9, 0.8, 1.3][bkt]);
        ctx.stroke(path);
      }
      // 2. faint long horizontal lines (print/fold marks)
      const nH = Math.round((2 + 8 * density) * lines);
      {
        const path = new Path2D();
        for (let i = 0; i < nH; i++) {
          const y = r() * H;
          const x0 = r() < 0.6 ? -10 * u : r() * W * 0.6;
          hairline(path, x0, y, W * (0.3 + r() * 0.9), false, u, r, 0.3);
        }
        ctx.strokeStyle = rgba(color, 0.16);
        ctx.lineWidth = Math.max(0.5, 0.9 * u);
        ctx.stroke(path);
      }
      // 3. short scratches, some clustered
      drawScratches(ctx, W, H, u, color, r, 180 * density * area, { minLen: 6, maxLen: 70, alpha: 0.55, width: 0.75 });
      const clusters = Math.round(3 + 6 * density);
      for (let k = 0; k < clusters; k++) {
        const cx = r() * W;
        const cy = r() * H;
        const rad = (40 + r() * 120) * u;
        const path = new Path2D();
        const n = 6 + Math.floor(r() * 14);
        const base = r() * TAU;
        for (let i = 0; i < n; i++) {
          const a = base + (r() - 0.5) * 0.7;
          const x = cx + (r() - 0.5) * rad;
          const y = cy + (r() - 0.5) * rad;
          const L = (8 + r() * 50) * u;
          path.moveTo(x, y);
          path.quadraticCurveTo(x + Math.cos(a) * L * 0.5 + (r() - 0.5) * 6 * u, y + Math.sin(a) * L * 0.5, x + Math.cos(a) * L, y + Math.sin(a) * L);
        }
        ctx.strokeStyle = rgba(color, 0.5);
        ctx.lineWidth = Math.max(0.5, 0.8 * u);
        ctx.stroke(path);
      }
      // 4. dust: specks, flecks and curly hairs
      if (dust > 0) {
        const specks = Math.round(700 * dust * area * (0.4 + density));
        for (let bkt = 0; bkt < 3; bkt++) {
          const path = new Path2D();
          for (let i = 0; i < specks / 3; i++) {
            const x = r() * W;
            const y = r() * H;
            const rad = u * (0.5 + r() ** 3 * (bkt === 2 ? 4 : 1.6));
            if (bkt === 2 && r() < 0.5) tracePoly(path, blob(x, y, rad * 1.4, r, 6, 0.7));
            else {
              path.moveTo(x + rad, y);
              path.arc(x, y, rad, 0, TAU);
            }
          }
          ctx.fillStyle = rgba(color, [0.35, 0.6, 0.8][bkt]);
          ctx.fill(path);
        }
        const hairs = new Path2D();
        const nHair = Math.round(26 * dust * area * (0.3 + density));
        for (let i = 0; i < nHair; i++) hair(hairs, r() * W, r() * H, (12 + r() * 50) * u, r);
        ctx.strokeStyle = rgba(color, 0.55);
        ctx.lineWidth = Math.max(0.5, 0.9 * u);
        ctx.stroke(hairs);
        // soft blotches (emulsion damage)
        ctx.save();
        ctx.filter = `blur(${Math.max(1, 6 * u)}px)`;
        const bl = Math.round(4 * dust * (0.5 + density));
        for (let i = 0; i < bl; i++) {
          ctx.fillStyle = rgba(color, 0.06 + r() * 0.08);
          ctx.beginPath();
          ctx.ellipse(r() * W, r() * H, (20 + r() * 60) * u, (10 + r() * 40) * u, r() * TAU, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
        // a few bright sparkles (like the corner flare in film prints)
        const sp = Math.round(2 + 3 * dust);
        for (let i = 0; i < sp; i++) {
          const x = r() * W;
          const y = r() * H;
          const L = (6 + r() * 14) * u;
          ctx.strokeStyle = rgba(color, 0.85);
          ctx.lineWidth = Math.max(0.5, 0.8 * u);
          ctx.beginPath();
          ctx.moveTo(x - L, y);
          ctx.lineTo(x + L, y);
          ctx.moveTo(x, y - L);
          ctx.lineTo(x, y + L);
          ctx.stroke();
          ctx.fillStyle = rgba(color, 0.9);
          ctx.beginPath();
          ctx.arc(x, y, 1.6 * u, 0, TAU);
          ctx.fill();
        }
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* dust-specks                                                         */
/* ------------------------------------------------------------------ */

const dustSpecks = defineAsset(
  {
    id: 'dust-specks',
    name: 'Dust & Specks',
    category: 'Overlays',
    tags: ['dust', 'specks', 'hair', 'scan', 'old photo', 'texture'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#ffffff'),
      P.pct('density', 'Density', 0.5),
      P.num('size', 'Size', 0.3, 4, 1, { step: 0.05, unit: '×' }),
      P.pct('hairs', 'Hairs & fibers', 0.5),
      P.pct('soft', 'Out-of-focus dust', 0.3),
      P.seed(33),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 33));
      const color = str(p, 'color', '#ffffff');
      const density = num(p, 'density', 0.5);
      const size = num(p, 'size', 1);
      const area = (W * H) / (u * u * 1e6);
      const [c, ctx] = newCanvas(W, H);
      const n = Math.round(900 * density * area);
      for (let bkt = 0; bkt < 4; bkt++) {
        const path = new Path2D();
        for (let i = 0; i < n / 4; i++) {
          const x = r() * W;
          const y = r() * H;
          const rad = u * size * (0.4 + r() ** 4 * [1, 1.6, 2.6, 4.5][bkt]);
          if (r() < 0.35) tracePoly(path, blob(x, y, rad * 1.3, r, 5 + Math.floor(r() * 3), 0.8));
          else {
            path.moveTo(x + rad, y);
            path.ellipse(x, y, rad, rad * (0.6 + r() * 0.4), r() * Math.PI, 0, TAU);
          }
        }
        ctx.fillStyle = rgba(color, [0.3, 0.45, 0.65, 0.85][bkt]);
        ctx.fill(path);
      }
      const hairs = num(p, 'hairs', 0.5);
      if (hairs > 0) {
        const path = new Path2D();
        const nh = Math.round(40 * hairs * area * (0.4 + density));
        for (let i = 0; i < nh; i++) hair(path, r() * W, r() * H, (10 + r() * 60) * u * size, r);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = rgba(color, 0.6);
        ctx.lineWidth = Math.max(0.5, 0.8 * u * size);
        ctx.stroke(path);
      }
      const soft = num(p, 'soft', 0.3);
      if (soft > 0) {
        ctx.save();
        ctx.filter = `blur(${Math.max(1, 3 * u * size)}px)`;
        const ns = Math.round(60 * soft * area);
        const path = new Path2D();
        for (let i = 0; i < ns; i++) {
          const x = r() * W;
          const y = r() * H;
          const rad = u * size * (3 + r() * 9);
          path.moveTo(x + rad, y);
          path.arc(x, y, rad, 0, TAU);
        }
        ctx.fillStyle = rgba(color, 0.18);
        ctx.fill(path);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* film-grain                                                          */
/* ------------------------------------------------------------------ */

/** Fill an ImageData-sized buffer with gaussian-ish grain around 128. Pure (exported for tests). */
export function grainBuffer(d: Uint8ClampedArray, seed: number, amount: number, colored: boolean) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const k = amount * 0.55;
  for (let i = 0; i < d.length; i += 4) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const a = s >>> 0;
    // sum of four bytes → approx gaussian (mean 510, sd ≈ 147)
    const g = ((a & 255) + ((a >>> 8) & 255) + ((a >>> 16) & 255) + (a >>> 24) - 510) * k;
    if (colored) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const b = s >>> 0;
      const cr = (((b & 255) - 128) * k) / 2.2;
      const cb = ((((b >>> 8) & 255) - 128) * k) / 2.2;
      d[i] = 128 + g + cr;
      d[i + 1] = 128 + g - (cr + cb) * 0.5;
      d[i + 2] = 128 + g + cb;
    } else {
      d[i] = d[i + 1] = d[i + 2] = 128 + g;
    }
    d[i + 3] = 255;
  }
}

const filmGrain = defineAsset(
  {
    id: 'film-grain',
    name: 'Film Grain',
    category: 'Overlays',
    tags: ['grain', 'noise', 'film', 'texture', 'overlay', 'analog'],
    sizing: 'document',
    defaultBlendMode: 'overlay',
    defaultOpacity: 1,
    params: [
      P.pct('amount', 'Amount', 0.45),
      P.num('size', 'Grain size', 1, 6, 1.4, { step: 0.1, unit: 'px' }),
      P.pct('clumping', 'Clumping', 0.35),
      P.bool('colored', 'Color grain', false),
      P.seed(47),
    ],
    generate(p, { width: W, height: H }) {
      const seed = num(p, 'seed', 47);
      const amount = num(p, 'amount', 0.45);
      const size = Math.max(1, num(p, 'size', 1.4));
      const clump = num(p, 'clumping', 0.35);
      const colored = bool(p, 'colored', false);
      const gw = Math.max(1, Math.round(W / size));
      const gh = Math.max(1, Math.round(H / size));
      const [g, gctx] = newCanvas(gw, gh);
      const img = gctx.createImageData(gw, gh);
      grainBuffer(img.data, seed, amount, colored);
      gctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = size > 1.2;
      ctx.drawImage(g, 0, 0, W, H);
      if (clump > 0) {
        // coarser clumps of grain (silver halide clusters)
        const cw = Math.max(1, Math.round(gw / 3));
        const ch = Math.max(1, Math.round(gh / 3));
        const [cl, clctx] = newCanvas(cw, ch);
        const ci = clctx.createImageData(cw, ch);
        grainBuffer(ci.data, seed + 7, amount * 0.9, false);
        clctx.putImageData(ci, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = clump * 0.8;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(cl, 0, 0, W, H);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'none' },
);

/* ------------------------------------------------------------------ */
/* light-leak                                                          */
/* ------------------------------------------------------------------ */

const lightLeak = defineAsset(
  {
    id: 'light-leak',
    name: 'Light Leak',
    category: 'Overlays',
    tags: ['light leak', 'film', 'warm', 'glow', 'analog', 'burn', 'retro'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color1', 'Hot color', '#ff5a1f'),
      P.color('color2', 'Glow color', '#ffcf6b'),
      P.color('color3', 'Accent', '#ff2a6d'),
      P.pct('intensity', 'Intensity', 0.75),
      P.select(
        'position',
        'Position',
        [
          ['left', 'Left edge'],
          ['right', 'Right edge'],
          ['top', 'Top edge'],
          ['corners', 'Corners'],
          ['random', 'Random'],
        ],
        'right',
      ),
      P.pct('spread', 'Spread', 0.5),
      P.seed(51),
    ],
    generate(p, { width: W, height: H }) {
      const r = makeRand(num(p, 'seed', 51));
      const intensity = num(p, 'intensity', 0.75);
      const spread = num(p, 'spread', 0.5);
      const pos = str(p, 'position', 'right');
      const cols = [str(p, 'color1', '#ff5a1f'), str(p, 'color2', '#ffcf6b'), str(p, 'color3', '#ff2a6d')];
      const s = Math.min(1, Math.sqrt(160_000 / (W * H)));
      const w = Math.max(2, Math.round(W * s));
      const h = Math.max(2, Math.round(H * s));
      const [lo, lctx] = newCanvas(w, h);
      lctx.globalCompositeOperation = 'lighter';
      const M = Math.max(w, h);
      const anchors: { x: number; y: number }[] = [];
      const along = (n: number, fn: (t: number) => { x: number; y: number }) => {
        for (let i = 0; i < n; i++) anchors.push(fn((i + 0.2 + r() * 0.6) / n));
      };
      if (pos === 'left') along(4, (t) => ({ x: -w * 0.05, y: h * t }));
      else if (pos === 'right') along(4, (t) => ({ x: w * 1.05, y: h * t }));
      else if (pos === 'top') along(4, (t) => ({ x: w * t, y: -h * 0.06 }));
      else if (pos === 'corners')
        anchors.push({ x: -w * 0.02, y: -h * 0.02 }, { x: w * 1.02, y: h * 1.02 }, { x: w * 1.02, y: -h * 0.02 }, { x: -w * 0.02, y: h * 1.02 });
      else for (let i = 0; i < 4; i++) anchors.push({ x: r() * w, y: r() * h });
      anchors.forEach((a, i) => {
        const blobs = 3 + Math.floor(r() * 3);
        for (let k = 0; k < blobs; k++) {
          const col = cols[(i + k) % 3];
          const rad = M * (0.12 + r() * 0.3) * (0.6 + spread);
          const x = a.x + (r() - 0.5) * rad * 0.8;
          const y = a.y + (r() - 0.5) * rad * 0.8;
          const g = lctx.createRadialGradient(x, y, 0, x, y, rad);
          const al = (0.25 + r() * 0.35) * intensity;
          g.addColorStop(0, rgba(col, al));
          g.addColorStop(0.4, rgba(col, al * 0.55));
          g.addColorStop(1, rgba(col, 0));
          lctx.fillStyle = g;
          lctx.save();
          lctx.translate(x, y);
          lctx.scale(1, 0.6 + r() * 0.9);
          lctx.translate(-x, -y);
          lctx.fillRect(0, 0, w, h);
          lctx.restore();
        }
      });
      // hot white-yellow core streak at the leak source
      const a0 = anchors[0];
      if (a0) {
        const g = lctx.createRadialGradient(a0.x, a0.y, 0, a0.x, a0.y, M * 0.18 * (0.5 + spread));
        g.addColorStop(0, rgba('#fff3d6', 0.55 * intensity));
        g.addColorStop(1, rgba('#fff3d6', 0));
        lctx.fillStyle = g;
        lctx.fillRect(0, 0, w, h);
      }
      const [c, ctx] = newCanvas(W, H);
      ctx.filter = `blur(${Math.max(2, Math.min(W, H) * 0.012)}px)`;
      drawUpscaled(ctx, lo, W, H);
      ctx.filter = 'none';
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* scanlines-overlay                                                   */
/* ------------------------------------------------------------------ */

const scanlines = defineAsset(
  {
    id: 'scanlines-overlay',
    name: 'Scanlines',
    category: 'Overlays',
    tags: ['scanlines', 'crt', 'retro', 'tv', 'vhs', 'monitor'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    defaultOpacity: 0.7,
    params: [
      P.num('spacing', 'Spacing', 2, 24, 4, { unit: 'px' }),
      P.pct('thickness', 'Line thickness', 0.5),
      P.color('color', 'Color', '#000000'),
      P.pct('softness', 'Softness', 0.4),
      P.bool('rgb', 'RGB phosphor mask', false),
      P.pct('flicker', 'Banding', 0.2),
      P.seed(3),
    ],
    generate(p, { width: W, height: H }) {
      const spacing = Math.max(2, Math.round(num(p, 'spacing', 4)));
      const thick = num(p, 'thickness', 0.5);
      const soft = num(p, 'softness', 0.4);
      const col = rgbOf(str(p, 'color', '#000000'));
      const tw = bool(p, 'rgb', false) ? 3 : 1;
      // one tile: rows of the line profile
      const [tile, tctx] = newCanvas(tw * 2, spacing);
      const img = tctx.createImageData(tw * 2, spacing);
      for (let y = 0; y < spacing; y++) {
        const t = (y + 0.5) / spacing; // 0..1 across the period
        const d = Math.abs(t - 0.5) * 2; // 0 at the line center
        const edge = thick;
        const a = 1 - smoothstep(edge - soft * 0.5, edge + soft * 0.5 + 1e-3, 1 - d);
        for (let x = 0; x < tw * 2; x++) {
          const o = (y * tw * 2 + x) * 4;
          let r = col.r;
          let g = col.g;
          let b = col.b;
          let alpha = 1 - a;
          if (tw === 3) {
            // phosphor triads: tint each column, darken the others slightly
            const k = x % 3;
            r = k === 0 ? 255 : col.r;
            g = k === 1 ? 255 : col.g;
            b = k === 2 ? 255 : col.b;
            alpha = Math.min(1, alpha + 0.25);
          }
          img.data[o] = r;
          img.data[o + 1] = g;
          img.data[o + 2] = b;
          img.data[o + 3] = alpha * 255;
        }
      }
      tctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      const pat = ctx.createPattern(tile, 'repeat');
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, W, H);
      }
      const flick = num(p, 'flicker', 0.2);
      if (flick > 0) {
        // broad horizontal brightness bands (rolling refresh)
        const r = makeRand(num(p, 'seed', 3));
        const bands = 2 + Math.floor(r() * 3);
        for (let i = 0; i < bands; i++) {
          const y = r() * H;
          const bh = H * (0.05 + r() * 0.12);
          const g = ctx.createLinearGradient(0, y - bh, 0, y + bh);
          g.addColorStop(0, rgba(col, 0));
          g.addColorStop(0.5, rgba(col, 0.25 * flick));
          g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g;
          ctx.fillRect(0, y - bh, W, bh * 2);
        }
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* vignette-overlay                                                    */
/* ------------------------------------------------------------------ */

const vignette = defineAsset(
  {
    id: 'vignette-overlay',
    name: 'Vignette',
    category: 'Overlays',
    tags: ['vignette', 'dark edges', 'focus', 'cinematic', 'frame'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#000000'),
      P.pct('amount', 'Amount', 0.75),
      P.pct('softness', 'Softness', 0.6),
      P.pct('size', 'Clear area', 0.45),
      P.num('roundness', 'Roundness', -1, 1, 0, { step: 0.01, hint: '-1 = follows the canvas shape, 1 = circle' }),
      P.point('center', 'Center', { x: 0.5, y: 0.5 }),
      P.pct('noise', 'Dither', 0.3),
      P.seed(1),
    ],
    generate(p, { width: W, height: H }) {
      const color: RGB = rgbOf(str(p, 'color', '#000000'));
      const amount = num(p, 'amount', 0.75);
      const soft = Math.max(0.02, num(p, 'softness', 0.6));
      const size = num(p, 'size', 0.45);
      const round = num(p, 'roundness', 0);
      const ctr = (p.center as { x: number; y: number } | undefined) ?? { x: 0.5, y: 0.5 };
      const cx = ctr.x * W;
      const cy = ctr.y * H;
      // ellipse radii: blend between canvas-shaped (rx=W/2,ry=H/2) and circle
      const t = (round + 1) / 2;
      const circ = Math.hypot(W, H) / 2;
      const rx = (W / 2) * 1.414 * (1 - t) + circ * t;
      const ry = (H / 2) * 1.414 * (1 - t) + circ * t;
      const [c, ctx] = newCanvas(W, H);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      const inner = Math.min(0.95, size * 0.9);
      const outer = Math.min(1.6, inner + soft * 0.9 + 0.05);
      for (let i = 0; i <= 16; i++) {
        const k = i / 16;
        const rr = inner + (outer - inner) * k;
        const e = k * k * (3 - 2 * k);
        g.addColorStop(Math.min(1, rr / 1.6), rgba(color, Math.pow(e, 1.3) * amount));
      }
      g.addColorStop(0, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.scale(1.6, 1.6);
      ctx.fillRect(-2, -2, 4, 4);
      ctx.restore();
      // fill beyond the gradient radius
      const noise = num(p, 'noise', 0.3);
      if (noise > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = 0.06 * noise;
        fillGrain(ctx, W, H, num(p, 'seed', 1), 1);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'paper' },
);

export const overlayAssets: AssetDef[] = [filmScratches, dustSpecks, filmGrain, lightLeak, scanlines, vignette];
