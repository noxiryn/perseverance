/**
 * Per-dab pixel operations for the retouch tools (blur, sharpen, smudge, dodge, burn, sponge).
 * Pure functions over RGBA byte buffers — no DOM — so they are unit-testable and run on the
 * small region under the brush only.
 */
import { roundFalloff } from './math';

export interface PixelBuf {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DabArea {
  cx: number;
  cy: number;
  /** radius in px */
  radius: number;
  /** 0..1 */
  hardness: number;
  /** Selection alpha per pixel (same size as the buffer), or null. */
  sel: Uint8Array | null;
  /** Keep each pixel's alpha (lock transparency / masks). */
  lockAlpha: boolean;
}

/** Integer bounds of a dab clipped to the buffer, or null when outside. */
export function dabRect(buf: { width: number; height: number }, cx: number, cy: number, radius: number, pad = 0) {
  const x0 = Math.max(0, Math.floor(cx - radius - pad));
  const y0 = Math.max(0, Math.floor(cy - radius - pad));
  const x1 = Math.min(buf.width, Math.ceil(cx + radius + pad));
  const y1 = Math.min(buf.height, Math.ceil(cy + radius + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Brush weight at a pixel center (falloff × selection). */
function weightAt(a: DabArea, x: number, y: number, w: number): number {
  const dx = x + 0.5 - a.cx;
  const dy = y + 0.5 - a.cy;
  const r = Math.sqrt(dx * dx + dy * dy) / a.radius;
  if (r >= 1) return 0;
  let f = roundFalloff(r, a.hardness, 1, a.radius);
  if (a.sel) f *= a.sel[y * w + x] / 255;
  return f;
}

/* ---------------- falloff lookup (big dabs) ---------------- */

const LUT_N = 2048;
const falloffLut = new Float32Array(LUT_N + 1);
let falloffKey = '';

/**
 * Falloff indexed by normalized SQUARED distance (d²/r² · LUT_N) — no sqrt or function call
 * per pixel. Hard tips depend on the radius (1px anti-aliased edge), soft ones only on hardness.
 */
function falloffTable(hardness: number, radius: number): Float32Array {
  const key = hardness >= 0.999 ? `h${Math.round(radius * 4)}` : `s${hardness}`;
  if (key !== falloffKey) {
    for (let i = 0; i <= LUT_N; i++) falloffLut[i] = roundFalloff(Math.sqrt(i / LUT_N), hardness, 1, radius);
    falloffLut[LUT_N] = 0;
    falloffKey = key;
  }
  return falloffLut;
}

/* ---------------- box blur ---------------- */

/* Grow-only scratch buffers (one blur per dab → no per-dab allocations); see trimPixelScratch. */
let blurA = new Float32Array(0);
let blurB = new Float32Array(0);
let colSums = new Float32Array(0);

function scratchFor(n: number, cols: number) {
  if (blurA.length < n) {
    blurA = new Float32Array(n);
    blurB = new Float32Array(n);
  }
  if (colSums.length < cols * 4) colSums = new Float32Array(cols * 4);
}

/** Release oversized scratch buffers (call when a stroke ends). */
export function trimPixelScratch(maxBytes = 8 << 20) {
  if (blurA.byteLength > maxBytes) {
    blurA = new Float32Array(0);
    blurB = new Float32Array(0);
  }
  if (colSums.byteLength > maxBytes) colSums = new Float32Array(0);
}

/**
 * Separable box blur (radius k, clamp-to-edge) of the premultiplied w×h image in `pm`.
 * Both passes walk memory row by row with the 4 channels interleaved (the vertical pass keeps
 * running column sums), so big regions stay cache friendly. Result is written back into `pm`.
 */
function blurPremultiplied(pm: Float32Array, w: number, h: number, k: number) {
  const tmp = blurB;
  const inv = 1 / (2 * k + 1);
  const stride = w * 4;
  // Horizontal pass: pm → tmp.
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0;
    for (let i = -k; i <= k; i++) {
      const j = row + (i < 0 ? 0 : i >= w ? w - 1 : i) * 4;
      s0 += pm[j];
      s1 += pm[j + 1];
      s2 += pm[j + 2];
      s3 += pm[j + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      tmp[o] = s0 * inv;
      tmp[o + 1] = s1 * inv;
      tmp[o + 2] = s2 * inv;
      tmp[o + 3] = s3 * inv;
      const ax = x + k + 1;
      const sx = x - k;
      const add = row + (ax >= w ? w - 1 : ax) * 4;
      const sub = row + (sx < 0 ? 0 : sx) * 4;
      s0 += pm[add] - pm[sub];
      s1 += pm[add + 1] - pm[sub + 1];
      s2 += pm[add + 2] - pm[sub + 2];
      s3 += pm[add + 3] - pm[sub + 3];
    }
  }
  // Vertical pass: tmp → pm, with running column sums.
  const cs = colSums;
  cs.fill(0, 0, stride);
  for (let i = -k; i <= k; i++) {
    const r = (i < 0 ? 0 : i >= h ? h - 1 : i) * stride;
    for (let j = 0; j < stride; j++) cs[j] += tmp[r + j];
  }
  for (let y = 0; y < h; y++) {
    const o = y * stride;
    const ay = y + k + 1;
    const sy = y - k;
    const addRow = (ay >= h ? h - 1 : ay) * stride;
    const subRow = (sy < 0 ? 0 : sy) * stride;
    for (let j = 0; j < stride; j++) {
      pm[o + j] = cs[j] * inv;
      cs[j] += tmp[addRow + j] - tmp[subRow + j];
    }
  }
}

/**
 * Box blur of a region in premultiplied float space (radius k, clamp-to-edge inside the region).
 * Returns rw*rh*4 floats. The returned array is a shared scratch buffer (it may be longer than
 * rw*rh*4): consume it before the next call.
 */
export function boxBlurRegion(buf: PixelBuf, rx: number, ry: number, rw: number, rh: number, k: number): Float32Array {
  const src = buf.data;
  const W = buf.width;
  scratchFor(rw * rh * 4, rw);
  const pm = blurA;
  for (let y = 0; y < rh; y++) {
    let si = ((ry + y) * W + rx) * 4;
    let di = y * rw * 4;
    for (let x = 0; x < rw; x++, si += 4, di += 4) {
      const a = src[si + 3] / 255;
      pm[di] = src[si] * a;
      pm[di + 1] = src[si + 1] * a;
      pm[di + 2] = src[si + 2] * a;
      pm[di + 3] = src[si + 3];
    }
  }
  blurPremultiplied(pm, rw, rh, k);
  return pm;
}

/**
 * Like boxBlurRegion, on an f×-downsampled copy (f×f block averages, premultiplied). Returns the
 * shared scratch with ceil(rw/f) × ceil(rh/f) RGBA floats.
 */
export function pooledBlurRegion(buf: PixelBuf, rx: number, ry: number, rw: number, rh: number, f: number, k: number): { data: Float32Array; width: number; height: number } {
  const src = buf.data;
  const W = buf.width;
  const dw = Math.ceil(rw / f);
  const dh = Math.ceil(rh / f);
  scratchFor(dw * dh * 4, dw);
  const pm = blurA;
  pm.fill(0, 0, dw * dh * 4);
  // Accumulate premultiplied pixels into their blocks, row by row (sequential reads).
  for (let y = 0; y < rh; y++) {
    let si = ((ry + y) * W + rx) * 4;
    let di = ((y / f) | 0) * dw * 4;
    for (let bx = 0; bx < dw; bx++, di += 4) {
      const n = Math.min(f, rw - bx * f);
      let s0 = 0,
        s1 = 0,
        s2 = 0,
        s3 = 0;
      for (let j = 0; j < n; j++, si += 4) {
        const al = src[si + 3];
        const a = al / 255;
        s0 += src[si] * a;
        s1 += src[si + 1] * a;
        s2 += src[si + 2] * a;
        s3 += al;
      }
      pm[di] += s0;
      pm[di + 1] += s1;
      pm[di + 2] += s2;
      pm[di + 3] += s3;
    }
  }
  for (let by = 0; by < dh; by++) {
    const bh = Math.min(f, rh - by * f);
    for (let bx = 0; bx < dw; bx++) {
      const n = 1 / (bh * Math.min(f, rw - bx * f));
      const di = (by * dw + bx) * 4;
      pm[di] *= n;
      pm[di + 1] *= n;
      pm[di + 2] *= n;
      pm[di + 3] *= n;
    }
  }
  blurPremultiplied(pm, dw, dh, k);
  return { data: pm, width: dw, height: dh };
}

/** Blur kernel radius for a brush radius. */
export function blurKernel(radius: number): number {
  return Math.max(1, Math.min(8, Math.round(radius * 0.12)));
}

/** Downsampling factor for the blur brush (big dabs blur a reduced copy; the kernel is tiny relative to them). */
export function blurDownsample(radius: number): number {
  return radius <= 64 ? 1 : radius <= 160 ? 2 : radius <= 400 ? 4 : 8;
}

/** Blur (amount > 0) or sharpen (amount < 0 → unsharp) under the dab. Returns the touched rect. */
export function blurSharpenDab(buf: PixelBuf, a: DabArea, amount: number, sharpen: boolean) {
  const rect = dabRect(buf, a.cx, a.cy, a.radius);
  if (!rect) return null;
  const k = sharpen ? Math.max(1, Math.min(3, Math.round(a.radius * 0.04))) : blurKernel(a.radius);
  const rx = Math.max(0, rect.x - k);
  const ry = Math.max(0, rect.y - k);
  const rw = Math.min(buf.width, rect.x + rect.width + k) - rx;
  const rh = Math.min(buf.height, rect.y + rect.height + k) - ry;
  const f = sharpen ? 1 : blurDownsample(a.radius);
  let blurred: Float32Array;
  let bw = rw,
    bh = rh;
  if (f > 1) {
    const p = pooledBlurRegion(buf, rx, ry, rw, rh, f, Math.max(1, Math.round(k / f)));
    blurred = p.data;
    bw = p.width;
    bh = p.height;
  } else blurred = boxBlurRegion(buf, rx, ry, rw, rh, k);

  const d = buf.data;
  const W = buf.width;
  const lut = falloffTable(a.hardness, a.radius);
  const r2 = a.radius * a.radius;
  const scale = LUT_N / r2;
  const sel = a.sel;
  const x1 = rect.x + rect.width;
  // Reduced blur (f > 1): bilinear sampling split into a per-column table (u0, fu) and one
  // vertically interpolated row per output row, so each pixel only does a 2-tap lerp.
  let uIdx: Int32Array | null = null;
  let uFrac: Float32Array | null = null;
  let rowBuf: Float32Array | null = null;
  if (f > 1) {
    ({ uIdx, uFrac, rowBuf } = mixTables(rect.width, bw));
    const invF = 1 / f;
    for (let x = rect.x; x < x1; x++) {
      const u = (x + 0.5 - rx) * invF - 0.5;
      const uc = u < 0 ? 0 : u > bw - 1 ? bw - 1 : u;
      const u0 = uc | 0;
      uIdx[x - rect.x] = u0 * 4;
      uFrac[x - rect.x] = uc - u0;
    }
  }
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const dy = y + 0.5 - a.cy;
    const dy2 = dy * dy;
    if (dy2 >= r2) continue;
    // Only the chord of the circle on this row.
    const hw = Math.sqrt(r2 - dy2);
    const xs = Math.max(rect.x, Math.floor(a.cx - hw - 0.5));
    const xe = Math.min(x1, Math.ceil(a.cx + hw + 0.5));
    if (rowBuf) {
      const v = (y + 0.5 - ry) / f - 0.5;
      const vc = v < 0 ? 0 : v > bh - 1 ? bh - 1 : v;
      const v0 = vc | 0;
      const fv = vc - v0;
      const r0 = v0 * bw * 4;
      const r1 = Math.min(bh - 1, v0 + 1) * bw * 4;
      for (let j = 0; j < bw * 4; j++) rowBuf[j] = blurred[r0 + j] + (blurred[r1 + j] - blurred[r0 + j]) * fv;
      // One extra texel so u0 + 1 never reads past the row.
      const last = (bw - 1) * 4;
      rowBuf[bw * 4] = rowBuf[last];
      rowBuf[bw * 4 + 1] = rowBuf[last + 1];
      rowBuf[bw * 4 + 2] = rowBuf[last + 2];
      rowBuf[bw * 4 + 3] = rowBuf[last + 3];
    }
    for (let x = xs; x < xe; x++) {
      const dx = x + 0.5 - a.cx;
      const d2 = dx * dx + dy2;
      if (d2 >= r2) continue;
      let wt = lut[(d2 * scale) | 0];
      if (sel) wt *= sel[y * W + x] / 255;
      wt *= amount;
      if (wt <= 0) continue;
      const i = (y * W + x) * 4;
      const al = d[i + 3];
      let b0: number, b1: number, b2: number, b3: number;
      if (rowBuf) {
        const p = uIdx![x - rect.x];
        const fu = uFrac![x - rect.x];
        b0 = rowBuf[p] + (rowBuf[p + 4] - rowBuf[p]) * fu;
        b1 = rowBuf[p + 1] + (rowBuf[p + 5] - rowBuf[p + 1]) * fu;
        b2 = rowBuf[p + 2] + (rowBuf[p + 6] - rowBuf[p + 2]) * fu;
        b3 = rowBuf[p + 3] + (rowBuf[p + 7] - rowBuf[p + 3]) * fu;
      } else {
        const bi = ((y - ry) * rw + (x - rx)) * 4;
        b0 = blurred[bi];
        b1 = blurred[bi + 1];
        b2 = blurred[bi + 2];
        b3 = blurred[bi + 3];
      }
      if (sharpen) {
        if (al === 0 || b3 <= 0) continue;
        const ib = 255 / b3;
        const s = wt * 1.6;
        d[i] = d[i] + (d[i] - b0 * ib) * s;
        d[i + 1] = d[i + 1] + (d[i + 1] - b1 * ib) * s;
        d[i + 2] = d[i + 2] + (d[i + 2] - b2 * ib) * s;
        continue;
      }
      // Blur in premultiplied space.
      const af = al / 255;
      const pr = d[i] * af,
        pg = d[i + 1] * af,
        pb = d[i + 2] * af;
      const t = wt > 1 ? 1 : wt;
      const nr = pr + (b0 - pr) * t;
      const ng = pg + (b1 - pg) * t;
      const nb = pb + (b2 - pb) * t;
      const na = al + (b3 - al) * t;
      if (na > 0.5) {
        const inv = 255 / na;
        d[i] = nr * inv;
        d[i + 1] = ng * inv;
        d[i + 2] = nb * inv;
      }
      d[i + 3] = a.lockAlpha ? al : na;
    }
  }
  return rect;
}

let mixU = new Int32Array(0);
let mixF = new Float32Array(0);
let mixRow = new Float32Array(0);

/** Grow-only tables for the reduced-blur mixing pass. */
function mixTables(cols: number, bw: number) {
  if (mixU.length < cols) {
    mixU = new Int32Array(cols);
    mixF = new Float32Array(cols);
  }
  if (mixRow.length < (bw + 1) * 4) mixRow = new Float32Array((bw + 1) * 4);
  return { uIdx: mixU, uFrac: mixF, rowBuf: mixRow };
}

/** Smudge state: the color "picked up" by the finger, relative to the dab. */
export interface SmudgeState {
  size: number;
  /** premultiplied RGBA floats, size*size*4 */
  carry: Float32Array;
  primed: boolean;
}

export function createSmudgeState(radius: number): SmudgeState {
  const size = Math.ceil(radius * 2) + 2;
  return { size, carry: new Float32Array(size * size * 4), primed: false };
}

/** Prime the carry buffer from the pixels under the dab (or a finger-painting color). */
export function primeSmudge(st: SmudgeState, buf: PixelBuf, cx: number, cy: number, radius: number, fingerColor?: [number, number, number]) {
  const ox = Math.floor(cx - radius);
  const oy = Math.floor(cy - radius);
  const W = buf.width;
  for (let y = 0; y < st.size; y++) {
    for (let x = 0; x < st.size; x++) {
      const ci = (y * st.size + x) * 4;
      if (fingerColor) {
        st.carry[ci] = fingerColor[0];
        st.carry[ci + 1] = fingerColor[1];
        st.carry[ci + 2] = fingerColor[2];
        st.carry[ci + 3] = 255;
        continue;
      }
      const px = Math.min(buf.width - 1, Math.max(0, ox + x));
      const py = Math.min(buf.height - 1, Math.max(0, oy + y));
      const i = (py * W + px) * 4;
      const af = buf.data[i + 3] / 255;
      st.carry[ci] = buf.data[i] * af;
      st.carry[ci + 1] = buf.data[i + 1] * af;
      st.carry[ci + 2] = buf.data[i + 2] * af;
      st.carry[ci + 3] = buf.data[i + 3];
    }
  }
  st.primed = true;
}

/**
 * Smear the carried color into the pixels under the dab and pick up new color. Like Photoshop,
 * the finger then carries the smudged result, so each dab keeps `strength` of the carried color:
 * high strength drags color far, low strength fades quickly into the local pixels.
 */
export function smudgeDab(buf: PixelBuf, st: SmudgeState, a: DabArea, strength: number) {
  const rect = dabRect(buf, a.cx, a.cy, a.radius);
  if (!rect) return null;
  const ox = Math.floor(a.cx - a.radius);
  const oy = Math.floor(a.cy - a.radius);
  const d = buf.data;
  const W = buf.width;
  const k = Math.max(0.05, Math.min(1, strength));
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const cy = y - oy;
    if (cy < 0 || cy >= st.size) continue;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const cx = x - ox;
      if (cx < 0 || cx >= st.size) continue;
      const w = weightAt(a, x, y, W);
      if (w <= 0) continue;
      const i = (y * W + x) * 4;
      const ci = (cy * st.size + cx) * 4;
      const al = d[i + 3];
      const af = al / 255;
      const pr = d[i] * af,
        pg = d[i + 1] * af,
        pb = d[i + 2] * af;
      const t = w * k;
      const nr = pr + (st.carry[ci] - pr) * t;
      const ng = pg + (st.carry[ci + 1] - pg) * t;
      const nb = pb + (st.carry[ci + 2] - pb) * t;
      const na = al + (st.carry[ci + 3] - al) * t;
      // The finger now holds the smudged result (edges pick up the local color).
      st.carry[ci] = nr;
      st.carry[ci + 1] = ng;
      st.carry[ci + 2] = nb;
      st.carry[ci + 3] = na;
      if (na > 0.5) {
        const inv = 255 / na;
        d[i] = nr * inv;
        d[i + 1] = ng * inv;
        d[i + 2] = nb * inv;
      }
      d[i + 3] = a.lockAlpha ? al : na;
    }
  }
  return rect;
}

/* ------------------------------------------------------------------ */
/* Tone tools (coverage based: effect is capped per stroke)             */
/* ------------------------------------------------------------------ */

export type ToneOp =
  | { kind: 'dodge' | 'burn'; range: 'shadows' | 'midtones' | 'highlights'; exposure: number; protect: boolean }
  | { kind: 'sponge'; mode: 'saturate' | 'desaturate'; flow: number; vibrance: boolean };

/** How strongly a tonal range applies at luminance l (0..1). */
export function rangeWeight(l: number, range: 'shadows' | 'midtones' | 'highlights'): number {
  if (range === 'shadows') return (1 - l) * (1 - l);
  if (range === 'highlights') return l * l;
  const t = 1 - Math.abs(l * 2 - 1);
  return t * (2 - t);
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Apply a tone op to one RGB pixel at strength `amount` (0..1). Writes into out[o..o+2].
 * Exported for tests.
 */
export function toneRGB(r: number, g: number, b: number, amount: number, op: ToneOp, out: Uint8ClampedArray | number[], o: number) {
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (op.kind === 'sponge') {
    const gray = l * 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const sat = max > 0 ? (max - min) / max : 0;
    let f: number;
    if (op.mode === 'saturate') f = 1 + amount * op.flow * 1.6 * (op.vibrance ? 1 - sat * 0.85 : 1);
    else f = 1 - amount * op.flow;
    out[o] = clamp255(gray + (r - gray) * f);
    out[o + 1] = clamp255(gray + (g - gray) * f);
    out[o + 2] = clamp255(gray + (b - gray) * f);
    return;
  }
  const a = Math.min(1, amount * op.exposure * rangeWeight(l, op.range));
  if (op.kind === 'dodge') {
    if (op.protect) {
      const lt = l + (1 - l) * a * 0.85;
      const delta = (lt - l) * 255;
      // Shift all channels equally (keeps hue), then soften overshoot.
      let nr = r + delta,
        ng = g + delta,
        nb = b + delta;
      const over = Math.max(nr, ng, nb) - 255;
      if (over > 0) {
        const k = Math.min(1, over / 255);
        nr += (255 - nr) * k;
        ng += (255 - ng) * k;
        nb += (255 - nb) * k;
      }
      out[o] = clamp255(nr);
      out[o + 1] = clamp255(ng);
      out[o + 2] = clamp255(nb);
    } else {
      out[o] = clamp255(r + (255 - r) * a);
      out[o + 1] = clamp255(g + (255 - g) * a);
      out[o + 2] = clamp255(b + (255 - b) * a);
    }
    return;
  }
  // burn
  if (op.protect) {
    const k = 1 - a * 0.85;
    out[o] = clamp255(r * k);
    out[o + 1] = clamp255(g * k);
    out[o + 2] = clamp255(b * k);
  } else {
    // Per-channel burn deepens saturation like Photoshop without "protect tones".
    out[o] = clamp255(r - (255 - r) * a * 0.35 - r * a * 0.75);
    out[o + 1] = clamp255(g - (255 - g) * a * 0.35 - g * a * 0.75);
    out[o + 2] = clamp255(b - (255 - b) * a * 0.35 - b * a * 0.75);
  }
}

/**
 * Accumulate coverage under the dab and recompute those pixels from the original (start of
 * stroke) pixels, so overlapping dabs build up to — but never beyond — the tool's exposure.
 */
export function toneDab(buf: PixelBuf, orig: Uint8ClampedArray, coverage: Float32Array, a: DabArea, deposit: number, op: ToneOp) {
  const rect = dabRect(buf, a.cx, a.cy, a.radius);
  if (!rect) return null;
  const d = buf.data;
  const W = buf.width;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const w = weightAt(a, x, y, W);
      if (w <= 0) continue;
      const p = y * W + x;
      const cov = coverage[p] + (1 - coverage[p]) * w * deposit;
      coverage[p] = cov;
      const i = p * 4;
      if (orig[i + 3] === 0) continue;
      toneRGB(orig[i], orig[i + 1], orig[i + 2], cov, op, d, i);
    }
  }
  return rect;
}
