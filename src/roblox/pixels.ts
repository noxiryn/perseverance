/**
 * Pure pixel helpers shared by the Roblox filters, background removal and subject selection.
 * Everything works on plain `{ data, width, height }` buffers (ImageData-compatible) so it can be
 * unit-tested without a canvas.
 */

export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Parse '#rgb' / '#rrggbb' / '#rrggbbaa' into 0..255 channels (no DOM). */
export function hexToRgb(hex: string): [number, number, number] {
  let s = (hex || '#000000').trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHexString(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Rec.709 luma (0..255). */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Alpha channel as floats 0..1. */
export function alphaFloat(img: PixelBuffer): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, p = 3; i < n; i++, p += 4) out[i] = d[p] / 255;
  return out;
}

/** True when a meaningful share of the pixels is (semi-)transparent. */
export function hasTransparency(img: PixelBuffer, minShare = 0.002): boolean {
  const d = img.data;
  const n = img.width * img.height;
  let count = 0;
  const need = Math.max(1, Math.floor(n * minShare));
  for (let p = 3; p < d.length; p += 4) if (d[p] < 250 && ++count >= need) return true;
  return false;
}

/** Tight bounds of pixels with alpha > threshold, or null. */
export function alphaBounds(img: PixelBuffer, threshold = 8): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: w, height: h, data: d } = img;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    let p = y * w * 4 + 3;
    for (let x = 0; x < w; x++, p += 4) {
      if (d[p] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

const INF = 1e9;
const DIAG = Math.SQRT2;

/**
 * Approximate Euclidean distance (chamfer 1/√2, two passes) from every pixel where `inside[i]`
 * is non-zero to the nearest pixel where it is zero. Outside pixels get 0. When `borderIsOutside`
 * the area beyond the image edge counts as outside.
 */
export function distanceToOutside(inside: Uint8Array, w: number, h: number, borderIsOutside = false): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? INF : 0;
  const edge = borderIsOutside ? 1 : INF;
  // forward
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      const l = x > 0 ? d[i - 1] + 1 : edge;
      if (l < v) v = l;
      if (y > 0) {
        const u = d[i - w] + 1;
        if (u < v) v = u;
        const ul = x > 0 ? d[i - w - 1] + DIAG : edge;
        if (ul < v) v = ul;
        const ur = x < w - 1 ? d[i - w + 1] + DIAG : edge;
        if (ur < v) v = ur;
      } else if (edge < v) v = edge;
      d[i] = v;
    }
  }
  // backward
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      const r = x < w - 1 ? d[i + 1] + 1 : edge;
      if (r < v) v = r;
      if (y < h - 1) {
        const b = d[i + w] + 1;
        if (b < v) v = b;
        const br = x < w - 1 ? d[i + w + 1] + DIAG : edge;
        if (br < v) v = br;
        const bl = x > 0 ? d[i + w - 1] + DIAG : edge;
        if (bl < v) v = bl;
      } else if (edge < v) v = edge;
      d[i] = v;
    }
  }
  return d;
}

/** Separable 3-pass box blur of a float channel (≈ gaussian with sigma ≈ radius/2). In place. */
export function blurFloat(buf: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.round(radius / 2);
  if (r < 1 || w < 2 || h < 2) return buf;
  const tmp = new Float32Array(buf.length);
  const iarr = 1 / (r + r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const first = buf[row];
      const last = buf[row + w - 1];
      let val = (r + 1) * first;
      for (let j = 0; j < r; j++) val += buf[row + Math.min(j, w - 1)];
      for (let x = 0; x < w; x++) {
        val += x + r < w ? buf[row + x + r] : last;
        tmp[row + x] = val * iarr;
        val -= x - r >= 0 ? buf[row + x - r] : first;
      }
    }
    for (let x = 0; x < w; x++) {
      const first = tmp[x];
      const last = tmp[(h - 1) * w + x];
      let val = (r + 1) * first;
      for (let j = 0; j < r; j++) val += tmp[Math.min(j, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        val += y + r < h ? tmp[(y + r) * w + x] : last;
        buf[y * w + x] = val * iarr;
        val -= y - r >= 0 ? tmp[(y - r) * w + x] : first;
      }
    }
  }
  return buf;
}

/** Bilinear sample of a float channel; `outside` is returned beyond the edges (or clamps when null). */
export function sampleBilinear(buf: Float32Array, w: number, h: number, x: number, y: number, outside: number | null): number {
  if (outside !== null && (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5)) return outside;
  const fx = Math.max(0, Math.min(w - 1, x));
  const fy = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1),
    y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0,
    ty = fy - y0;
  const a = buf[y0 * w + x0],
    b = buf[y0 * w + x1],
    c = buf[y1 * w + x0],
    d = buf[y1 * w + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Sobel gradient magnitude of a float channel (0..1 input → roughly 0..1 output). */
export function sobel(buf: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0,
      yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0,
        xp = x < w - 1 ? x + 1 : w - 1;
      const tl = buf[ym * w + xm],
        t = buf[ym * w + x],
        tr = buf[ym * w + xp];
      const l = buf[y * w + xm],
        r = buf[y * w + xp];
      const bl = buf[yp * w + xm],
        b = buf[yp * w + x],
        br = buf[yp * w + xp];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      out[y * w + x] = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 4);
    }
  }
  return out;
}

/** Make an ImageData-compatible buffer (used by tests and by code paths without a canvas). */
export function makeBuffer(width: number, height: number, fill?: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { data, width, height };
}
