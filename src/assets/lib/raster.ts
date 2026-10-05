/**
 * Raster helpers shared by generators: gooey (blur + alpha threshold) shapes, glow sprites,
 * perspective floor projection, bilinear field sampling and a fast jittered-grid Worley noise.
 */
import { clamp01, newCanvas, newReadCanvas, rgbOf } from './util';
import type { Rand } from './util';

/* ------------------------------------------------------------------ */
/* Gooey shapes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Draw shapes (in white, any alpha) with `draw`, soften them with a blur of `blur` px and
 * re-sharpen the alpha with a smoothstep threshold. Overlapping/nearby shapes merge into
 * organic liquid forms (ink splats, drips). The output is at most `maxPx` pixels (up-scaled to
 * W×H otherwise). The blur itself runs at a reduced resolution — detail finer than the blur
 * radius disappears anyway — and the blurred field is up-sampled before thresholding, so the
 * edges stay crisp while the expensive filter pass touches only a fraction of the pixels.
 */
export function gooShape(
  W: number,
  H: number,
  color: string,
  blur: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  o: { lo?: number; hi?: number; maxPx?: number } = {},
): HTMLCanvasElement {
  const s = Math.min(1, Math.sqrt((o.maxPx ?? 2_400_000) / Math.max(1, W * H)));
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));
  const br = blur * s; // blur radius in output px
  const q = br > 3 ? Math.max(0.25, 3 / br) : 1; // blur-pass scale
  const bw = Math.max(1, Math.round(w * q));
  const bh = Math.max(1, Math.round(h * q));
  const [src, sctx] = newCanvas(bw, bh);
  sctx.scale(s * q, s * q);
  sctx.fillStyle = '#ffffff';
  sctx.strokeStyle = '#ffffff';
  draw(sctx);
  let field: HTMLCanvasElement = src;
  if (br > 0) {
    const [bl, bctx] = newCanvas(bw, bh);
    bctx.filter = `blur(${Math.max(0.4, br * q)}px)`;
    bctx.drawImage(src, 0, 0);
    bctx.filter = 'none';
    field = bl;
  }
  const [dst, dctx] = newReadCanvas(w, h);
  if (field.width !== w || field.height !== h) {
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'medium';
    dctx.drawImage(field, 0, 0, w, h);
  } else dctx.drawImage(field, 0, 0);
  const img = dctx.getImageData(0, 0, w, h);
  const d = img.data;
  const c = rgbOf(color);
  const lo = (o.lo ?? 0.42) * 255;
  const hi = (o.hi ?? 0.58) * 255;
  const inv = 1 / Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a <= lo) {
      d[i + 3] = 0;
      continue;
    }
    let t = (a - lo) * inv;
    if (t > 1) t = 1;
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
    d[i + 3] = t * t * (3 - 2 * t) * 255;
  }
  dctx.putImageData(img, 0, 0);
  if (s === 1) return dst;
  const [out, octx] = newCanvas(W, H);
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(dst, 0, 0, W, H);
  return out;
}

/* ------------------------------------------------------------------ */
/* Sprites                                                             */
/* ------------------------------------------------------------------ */

const spriteCache = new Map<string, HTMLCanvasElement>();

/**
 * Soft round sprite (white) used for particles/glows: `hardness` 0 = gaussian-ish glow,
 * 1 = crisp disc. Drawn tinted via `tintSprite`. Cached.
 */
export function softSprite(size = 64, hardness = 0): HTMLCanvasElement {
  const key = `${size}|${hardness.toFixed(2)}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;
  const [c, ctx] = newCanvas(size, size);
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  const h = clamp01(hardness);
  if (h >= 0.99) {
    g.addColorStop(0, '#fff');
    g.addColorStop(0.9, '#fff');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    // exp falloff blended with a plateau for harder sprites
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const soft = Math.exp(-t * t * 4.5) * (1 - t);
      const hard = t < h ? 1 : Math.max(0, 1 - (t - h) / (1 - h + 1e-6));
      const a = soft * (1 - h) + hard * h;
      g.addColorStop(t, `rgba(255,255,255,${a.toFixed(4)})`);
    }
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  spriteCache.set(key, c);
  return c;
}

const tintCache = new Map<string, HTMLCanvasElement>();

/** A sprite tinted with a color (cached by color). */
export function tintSprite(sprite: HTMLCanvasElement, color: string, key: string): HTMLCanvasElement {
  const k = `${key}|${color}`;
  const hit = tintCache.get(k);
  if (hit) return hit;
  const [c, ctx] = newCanvas(sprite.width, sprite.height);
  ctx.drawImage(sprite, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  if (tintCache.size > 200) tintCache.clear();
  tintCache.set(k, c);
  return c;
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

/** Bilinear sample of a fw×fh field at field coords (x, y) (clamped). */
export function sampleField(f: Float32Array, fw: number, fh: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > fw - 1.001) x = fw - 1.001;
  if (y < 0) y = 0;
  else if (y > fh - 1.001) y = fh - 1.001;
  const xi = x | 0;
  const yi = y | 0;
  const tx = x - xi;
  const ty = y - yi;
  const i = yi * fw + xi;
  const a = f[i] + (f[i + 1] - f[i]) * tx;
  const b = f[i + fw] + (f[i + fw + 1] - f[i + fw]) * tx;
  return a + (b - a) * ty;
}

export interface WorleyGrid {
  cell: number;
  gw: number;
  gh: number;
  px: Float32Array;
  py: Float32Array;
  /** Per-cell random 0..1 (for color variation). */
  rnd: Float32Array;
}

/** Jittered grid of feature points covering (w, h) in px with cell size `cell` (x stretched by `sx`). */
export function worleyGrid(w: number, h: number, cell: number, r: Rand, jitter = 0.8, sx = 1): WorleyGrid {
  const cw = cell * sx;
  const gw = Math.ceil(w / cw) + 3;
  const gh = Math.ceil(h / cell) + 3;
  const n = gw * gh;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const rnd = new Float32Array(n);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      // offset rows a little for a less grid-like feel
      const off = (j % 2) * 0.35;
      px[k] = (i - 1 + off + (1 - jitter) / 2 + r() * jitter) * cw;
      py[k] = (j - 1 + (1 - jitter) / 2 + r() * jitter) * cell;
      rnd[k] = r();
    }
  return { cell, gw, gh, px, py, rnd };
}

export interface WorleyHit {
  f1: number;
  f2: number;
  id: number;
  /** Nearest feature point. */
  cx: number;
  cy: number;
}

/** F1/F2 distances (px) and nearest cell id for a point. `sx` must match worleyGrid. */
export function worleyAt(g: WorleyGrid, x: number, y: number, out: WorleyHit, sx = 1) {
  const ci = Math.floor(x / (g.cell * sx)) + 1;
  const cj = Math.floor(y / g.cell) + 1;
  let d1 = 1e18;
  let d2 = 1e18;
  let best = 0;
  for (let j = cj - 1; j <= cj + 1; j++) {
    if (j < 0 || j >= g.gh) continue;
    for (let i = ci - 2; i <= ci + 1; i++) {
      if (i < 0 || i >= g.gw) continue;
      const k = j * g.gw + i;
      const dx = (g.px[k] - x) / sx;
      const dy = g.py[k] - y;
      const d = dx * dx + dy * dy;
      if (d < d1) {
        d2 = d1;
        d1 = d;
        best = k;
      } else if (d < d2) d2 = d;
    }
  }
  out.f1 = Math.sqrt(d1);
  out.f2 = Math.sqrt(d2);
  out.id = best;
  out.cx = g.px[best];
  out.cy = g.py[best];
}

/* ------------------------------------------------------------------ */
/* Perspective                                                         */
/* ------------------------------------------------------------------ */

/**
 * Project a tileable texture onto a floor plane receding to a horizon at `horizonY` (row-by-row
 * scan conversion with a repeating pattern: cheap, no WebGL). At the bottom row one texture px
 * equals one output px; `depth` (≈0.5..3) controls the foreshortening (camera height).
 * Rows near the horizon are left to the caller to fade (they alias).
 */
export function drawPerspectiveFloor(
  ctx: CanvasRenderingContext2D,
  tex: HTMLCanvasElement,
  W: number,
  H: number,
  horizonY: number,
  depth = 1,
) {
  const rows = Math.max(1, H - horizonY);
  const pat = ctx.createPattern(tex, 'repeat');
  if (!pat) return;
  const f = rows * depth;
  const u0 = tex.width / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = pat;
  const y0 = Math.ceil(horizonY);
  for (let y = H - 1; y >= y0; y--) {
    const dy = y + 0.5 - horizonY;
    if (dy <= 0.5) break;
    const z = rows / dy; // lateral scale (texture px per output px)
    const v = -f * (z - 1); // forward texture offset from the near edge
    pat.setTransform(new DOMMatrix().translateSelf(W / 2, y).scaleSelf(1 / z, 1).translateSelf(-u0, -v));
    ctx.fillRect(0, y, W, 1);
  }
  ctx.restore();
}
