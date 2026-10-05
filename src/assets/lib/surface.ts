/**
 * Reusable surface painters (paper, specks, fibers, scratches) shared by several generators.
 */
import { fieldDims, fillGrain, noiseField, paintField } from './field';
import type { Rand, RGB } from './util';
import { TAU, drawUpscaled, makeRand, rgba, shade } from './util';

export interface PaperOpts {
  /** Large-scale tone variation 0..1 */
  mottle?: number;
  /** Fine grain 0..1 */
  grain?: number;
  /** Fiber strands 0..1 */
  fibers?: number;
  /** Small specks/dirt 0..1 */
  specks?: number;
}

/** Paint an opaque paper surface into ctx (0,0,W,H). `u` = length unit. */
export function paintPaper(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, tone: RGB, seed: number, o: PaperOpts = {}) {
  const mottle = o.mottle ?? 0.6;
  const grain = o.grain ?? 0.5;
  const fibers = o.fibers ?? 0.5;
  const specks = o.specks ?? 0.3;
  // 1. tonal mottling (low-res, upscaled)
  const { fw, fh, s } = fieldDims(W, H, 50_000);
  const up = s * u; // field px per unit
  const f1 = noiseField(fw, fh, up, { seed, freq: 2.2, octaves: 4 });
  const f2 = noiseField(fw, fh, up, { seed: seed + 7, freq: 11, octaves: 3, gain: 0.55 });
  const m = 0.09 * mottle;
  const base = paintField(fw, fh, (i, _x, _y, px, off) => {
    const v = f1[i] * 0.7 + f2[i] * 0.3;
    const k = 1 + v * m;
    px[off] = tone.r * k + v * 2;
    px[off + 1] = tone.g * k;
    px[off + 2] = tone.b * k - v * 3 * mottle;
    px[off + 3] = 255;
  });
  drawUpscaled(ctx, base, W, H);
  // 2. grain (overlay keeps the mean tone)
  if (grain > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(1, 0.32 * grain);
    fillGrain(ctx, W, H, seed, 1);
    ctx.globalAlpha = Math.min(1, 0.45 * grain);
    fillGrain(ctx, W, H, seed + 3, Math.max(1, 2.2 * u), 0.7);
    ctx.restore();
  }
  // 3. fibers
  if (fibers > 0) drawFibers(ctx, W, H, u, tone, makeRand(seed + 11), fibers);
  // 4. specks
  if (specks > 0) drawSpecks(ctx, W, H, u, shade(tone, -0.55), makeRand(seed + 23), specks);
}

/** Thin curved paper fibers, batched into a few paths for speed. */
export function drawFibers(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, tone: RGB, r: Rand, amount: number) {
  const n = Math.round(((W * H) / (u * u * 1e6)) * 1400 * amount);
  const buckets = [
    { color: rgba(shade(tone, -0.35), 0.16), width: Math.max(0.5, 0.45 * u), path: new Path2D() },
    { color: rgba(shade(tone, -0.25), 0.22), width: Math.max(0.6, 0.9 * u), path: new Path2D() },
    { color: rgba('#ffffff', 0.35), width: Math.max(0.5, 0.6 * u), path: new Path2D() },
    { color: rgba('#ffffff', 0.22), width: Math.max(0.8, 1.3 * u), path: new Path2D() },
  ];
  for (let i = 0; i < n; i++) {
    const b = buckets[i % 4];
    const x = r() * W;
    const y = r() * H;
    const a = r() * TAU;
    const L = u * (4 + r() * r() * 34);
    const ex = x + Math.cos(a) * L;
    const ey = y + Math.sin(a) * L;
    const bend = (r() - 0.5) * L * 0.6;
    const cx = (x + ex) / 2 - Math.sin(a) * bend;
    const cy = (y + ey) / 2 + Math.cos(a) * bend;
    b.path.moveTo(x, y);
    b.path.quadraticCurveTo(cx, cy, ex, ey);
  }
  ctx.save();
  ctx.lineCap = 'round';
  for (const b of buckets) {
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.stroke(b.path);
  }
  ctx.restore();
}

/** Tiny irregular dirt specks. */
export function drawSpecks(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, color: RGB, r: Rand, amount: number) {
  const n = Math.round(((W * H) / (u * u * 1e6)) * 260 * amount);
  ctx.save();
  for (let pass = 0; pass < 3; pass++) {
    const p = new Path2D();
    for (let i = 0; i < n / 3; i++) {
      const x = r() * W;
      const y = r() * H;
      const rad = u * (0.3 + r() * r() * (pass === 2 ? 3.2 : 1.4));
      p.moveTo(x + rad, y);
      p.ellipse(x, y, rad, rad * (0.5 + r() * 0.5), r() * Math.PI, 0, TAU);
    }
    ctx.fillStyle = rgba(color, [0.25, 0.4, 0.55][pass]);
    ctx.fill(p);
  }
  ctx.restore();
}

/** Thin light scratches (random short hairlines). */
export function drawScratches(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  u: number,
  color: string,
  r: Rand,
  count: number,
  opts: { minLen?: number; maxLen?: number; alpha?: number; width?: number; angle?: number; angleJitter?: number } = {},
) {
  const minLen = (opts.minLen ?? 10) * u;
  const maxLen = (opts.maxLen ?? 80) * u;
  ctx.save();
  ctx.lineCap = 'round';
  const groups = 4;
  for (let g = 0; g < groups; g++) {
    const p = new Path2D();
    for (let i = 0; i < count / groups; i++) {
      const x = r() * W;
      const y = r() * H;
      const a = opts.angle !== undefined ? opts.angle + (r() - 0.5) * (opts.angleJitter ?? 0.4) : r() * TAU;
      const L = minLen + (maxLen - minLen) * r() * r();
      const bend = (r() - 0.5) * L * 0.25;
      const ex = x + Math.cos(a) * L;
      const ey = y + Math.sin(a) * L;
      p.moveTo(x, y);
      p.quadraticCurveTo((x + ex) / 2 - Math.sin(a) * bend, (y + ey) / 2 + Math.cos(a) * bend, ex, ey);
    }
    ctx.strokeStyle = rgba(color, (opts.alpha ?? 0.5) * (0.45 + g * 0.2));
    ctx.lineWidth = Math.max(0.5, (opts.width ?? 0.8) * u * (0.6 + g * 0.3));
    ctx.stroke(p);
  }
  ctx.restore();
}

/**
 * A jagged crack/crease line between two points (dark core + soft shadow + light lip),
 * like the horizontal paper cracks in the gothic poster reference.
 */
export function drawCrackLine(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], u: number, r: Rand, strength = 1) {
  if (pts.length < 2) return;
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // soft shadow
  ctx.filter = `blur(${Math.max(0.5, 2.2 * u)}px)`;
  ctx.strokeStyle = rgba('#1a1612', 0.22 * strength);
  ctx.lineWidth = 7 * u;
  ctx.stroke(path);
  ctx.filter = 'none';
  // light lip below
  ctx.translate(0, 1.6 * u);
  ctx.strokeStyle = rgba('#ffffff', 0.55 * strength);
  ctx.lineWidth = Math.max(0.6, 1.1 * u);
  ctx.stroke(path);
  ctx.translate(0, -1.6 * u);
  // dark core with varying width (draw in chunks)
  let i = 0;
  while (i < pts.length - 1) {
    const len = 2 + Math.floor(r() * 6);
    const seg = new Path2D();
    seg.moveTo(pts[i].x, pts[i].y);
    for (let k = 1; k <= len && i + k < pts.length; k++) seg.lineTo(pts[i + k].x, pts[i + k].y);
    ctx.strokeStyle = rgba('#0d0b09', (0.55 + r() * 0.4) * strength);
    ctx.lineWidth = Math.max(0.6, u * (0.7 + r() * r() * 2.6));
    ctx.stroke(seg);
    i += len;
  }
  ctx.restore();
}

/** Random-walk polyline roughly from (x0,y0) heading `angle`, total length L. */
export function walkLine(x0: number, y0: number, angle: number, L: number, step: number, wander: number, r: Rand) {
  const pts = [{ x: x0, y: y0 }];
  let a = angle;
  let x = x0;
  let y = y0;
  let travelled = 0;
  while (travelled < L) {
    const s = step * (0.5 + r());
    a += (r() - 0.5) * wander;
    // drift back to the main heading so the line stays straight overall
    a += (angle - a) * 0.25;
    x += Math.cos(a) * s;
    y += Math.sin(a) * s;
    travelled += s;
    pts.push({ x, y });
  }
  return pts;
}
