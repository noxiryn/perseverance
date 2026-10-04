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

/**
 * Box blur of a region in premultiplied float space (radius k, clamp-to-edge inside the region).
 * Returns rw*rh*4 floats.
 */
export function boxBlurRegion(buf: PixelBuf, rx: number, ry: number, rw: number, rh: number, k: number): Float32Array {
  const src = buf.data;
  const W = buf.width;
  const n = rw * rh * 4;
  const pm = new Float32Array(n);
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
  const tmp = new Float32Array(n);
  const size = 2 * k + 1;
  // Horizontal pass.
  for (let y = 0; y < rh; y++) {
    const row = y * rw * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -k; i <= k; i++) sum += pm[row + Math.min(rw - 1, Math.max(0, i)) * 4 + c];
      for (let x = 0; x < rw; x++) {
        tmp[row + x * 4 + c] = sum / size;
        const add = Math.min(rw - 1, x + k + 1);
        const sub = Math.max(0, x - k);
        sum += pm[row + add * 4 + c] - pm[row + sub * 4 + c];
      }
    }
  }
  // Vertical pass.
  const out = pm; // reuse
  for (let x = 0; x < rw; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -k; i <= k; i++) sum += tmp[Math.min(rh - 1, Math.max(0, i)) * rw * 4 + x * 4 + c];
      for (let y = 0; y < rh; y++) {
        out[y * rw * 4 + x * 4 + c] = sum / size;
        const add = Math.min(rh - 1, y + k + 1);
        const sub = Math.max(0, y - k);
        sum += tmp[add * rw * 4 + x * 4 + c] - tmp[sub * rw * 4 + x * 4 + c];
      }
    }
  }
  return out;
}

/** Blur kernel radius for a brush radius. */
export function blurKernel(radius: number): number {
  return Math.max(1, Math.min(8, Math.round(radius * 0.12)));
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
  const blurred = boxBlurRegion(buf, rx, ry, rw, rh, k);
  const d = buf.data;
  const W = buf.width;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const wt = weightAt(a, x, y, W) * amount;
      if (wt <= 0) continue;
      const i = (y * W + x) * 4;
      const bi = ((y - ry) * rw + (x - rx)) * 4;
      const al = d[i + 3];
      if (sharpen) {
        if (al === 0) continue;
        const ba = blurred[bi + 3];
        if (ba <= 0) continue;
        for (let c = 0; c < 3; c++) {
          const bc = blurred[bi + c] / (ba / 255);
          d[i + c] = d[i + c] + (d[i + c] - bc) * wt * 1.6;
        }
        continue;
      }
      // Blur in premultiplied space.
      const af = al / 255;
      const pr = d[i] * af,
        pg = d[i + 1] * af,
        pb = d[i + 2] * af;
      const t = Math.min(1, wt);
      const nr = pr + (blurred[bi] - pr) * t;
      const ng = pg + (blurred[bi + 1] - pg) * t;
      const nb = pb + (blurred[bi + 2] - pb) * t;
      const na = al + (blurred[bi + 3] - al) * t;
      const outA = a.lockAlpha ? al : na;
      if (na > 0.5) {
        const inv = 255 / na;
        d[i] = nr * inv;
        d[i + 1] = ng * inv;
        d[i + 2] = nb * inv;
      }
      d[i + 3] = outA;
    }
  }
  return rect;
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
