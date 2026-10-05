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

/**
 * Separable 3-pass box blur of a float channel (≈ gaussian with sigma ≈ radius/2), edges clamped.
 * In place. Both passes walk memory row by row (the vertical pass keeps one running sum per
 * column), which is several times faster than a strided column walk on large images.
 */
export function blurFloat(buf: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.round(radius / 2);
  if (r < 1 || w < 2 || h < 2) return buf;
  const tmp = new Float32Array(buf.length);
  const acc = new Float64Array(w);
  const iarr = 1 / (r + r + 1);
  for (let pass = 0; pass < 3; pass++) {
    // Horizontal: buf → tmp
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
    // Vertical: tmp → buf (running sums for all columns at once)
    const lastRow = (h - 1) * w;
    for (let x = 0; x < w; x++) acc[x] = (r + 1) * tmp[x];
    for (let j = 0; j < r; j++) {
      const row = Math.min(j, h - 1) * w;
      for (let x = 0; x < w; x++) acc[x] += tmp[row + x];
    }
    for (let y = 0; y < h; y++) {
      const add = y + r < h ? (y + r) * w : lastRow;
      const sub = y - r >= 0 ? (y - r) * w : 0;
      const out = y * w;
      for (let x = 0; x < w; x++) {
        const v = acc[x] + tmp[add + x];
        buf[out + x] = v * iarr;
        acc[x] = v - tmp[sub + x];
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

/* ------------------------------------------------------------------ */
/* Content frame (padding-aware neighbourhood operations)              */
/* ------------------------------------------------------------------ */

export interface ContentFrame {
  /** Bounds of the pixels with alpha > 0 (inclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /**
   * Sides where the content is CUT (by the layer box or the canvas edge) rather than ending in a
   * silhouette: a straight, fully opaque run covers at least half of that side. Neighbourhood operations
   * (rim light, outlines, edge detection, blurs) extend the content beyond cut sides instead of
   * treating the transparent padding there as background.
   */
  cut: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  /** True when the content itself (inside its bounds) has transparent pixels — an alpha-shaped subject. */
  transparent: boolean;
}

/**
 * Analyse where the content of a buffer is. Smart filters receive the layer padded with a
 * transparent margin, so "has transparent pixels" is NOT a reliable signal of a cut-out subject:
 * an opaque photo covering the canvas arrives framed by transparency. Only transparency inside
 * the content bounds counts, and straight opaque runs along a bound mark a cut side.
 */
export function contentFrame(img: PixelBuffer, minShare = 0.002, cutShare = 0.5): ContentFrame | null {
  const b = alphaBounds(img, 0);
  if (!b) return null;
  const { width: w, data: d } = img;
  const bw = b.x1 - b.x0 + 1,
    bh = b.y1 - b.y0 + 1;
  // Transparency inside the content bounds.
  let count = 0;
  const need = Math.max(1, Math.floor(bw * bh * minShare));
  let transparent = false;
  for (let y = b.y0; y <= b.y1 && !transparent; y++) {
    let p = (y * w + b.x0) * 4 + 3;
    for (let x = b.x0; x <= b.x1; x++, p += 4) {
      if (d[p] < 250 && ++count >= need) {
        transparent = true;
        break;
      }
    }
  }
  const longestRun = (x: number, y: number, dx: number, dy: number, len: number) => {
    let best = 0,
      run = 0;
    for (let k = 0; k < len; k++) {
      // Hard cuts are fully opaque up to the bound; anti-aliased silhouettes (flat feet, a
      // feathered cut-out) have a semi-transparent outermost row and never count as a cut.
      if (d[((y + dy * k) * w + (x + dx * k)) * 4 + 3] >= 250) {
        if (++run > best) best = run;
      } else run = 0;
    }
    return best / len;
  };
  return {
    ...b,
    cut: {
      top: longestRun(b.x0, b.y0, 1, 0, bw) >= cutShare,
      bottom: longestRun(b.x0, b.y1, 1, 0, bw) >= cutShare,
      left: longestRun(b.x0, b.y0, 0, 1, bh) >= cutShare,
      right: longestRun(b.x1, b.y0, 0, 1, bh) >= cutShare,
    },
    transparent,
  };
}

export interface FrameField {
  buf: Float32Array;
  W: number;
  H: number;
  /** Image coordinate of the field's (0, 0): image x = field x + ox. */
  ox: number;
  oy: number;
}

/**
 * Float field covering the content bounds plus a margin `m`. Inside the bounds it holds
 * `value(pixelIndex)`; beyond cut sides the edge values are replicated (content continues);
 * beyond silhouette sides it holds `fill` (transparent background).
 */
export function frameField(img: PixelBuffer, f: ContentFrame, m: number, value: (i: number) => number, fill = 0): FrameField {
  const w = img.width;
  const M = Math.max(0, Math.ceil(m));
  const W = f.x1 - f.x0 + 1 + 2 * M,
    H = f.y1 - f.y0 + 1 + 2 * M;
  const ox = f.x0 - M,
    oy = f.y0 - M;
  const buf = new Float32Array(W * H);
  // Column source map for one row (−1 = fill).
  const colSrc = new Int32Array(W);
  for (let fx = 0; fx < W; fx++) {
    const x = fx + ox;
    colSrc[fx] = x < f.x0 ? (f.cut.left ? f.x0 : -1) : x > f.x1 ? (f.cut.right ? f.x1 : -1) : x;
  }
  for (let fy = 0; fy < H; fy++) {
    const y = fy + oy;
    const sy = y < f.y0 ? (f.cut.top ? f.y0 : -1) : y > f.y1 ? (f.cut.bottom ? f.y1 : -1) : y;
    const row = fy * W;
    if (sy < 0) {
      if (fill !== 0) buf.fill(fill, row, row + W);
      continue;
    }
    const base = sy * w;
    for (let fx = 0; fx < W; fx++) {
      const sx = colSrc[fx];
      buf[row + fx] = sx < 0 ? fill : value(base + sx);
    }
  }
  return { buf, W, H, ox, oy };
}
