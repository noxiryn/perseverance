/**
 * Background removal core (pure, typed-array based):
 *  - 'auto'  : sample the dominant border colors and flood-fill from every edge with a tolerance,
 *  - 'color' : key out one picked color (globally or contiguous from the edges),
 *  - 'green' : chroma key on green dominance.
 * Then shrink (erode) the edge, feather it, and optionally decontaminate color spill.
 */
import { blurFloat, distanceToOutside, hexToRgb, smoothstep, type PixelBuffer } from '../pixels';

export type BgMode = 'auto' | 'color' | 'green';

export interface BgParams {
  mode: BgMode;
  /** Key color for 'color' mode. */
  keyColor: string;
  /** 0..100 — distance below which pixels are fully removed. */
  tolerance: number;
  /** 0..100 — transition band above the tolerance (partial transparency). */
  softness: number;
  /** Only remove background connected to the image border (always on for 'auto'). */
  contiguous: boolean;
  /** Edge blur in px. */
  feather: number;
  /** Erode the kept area by px. */
  shrink: number;
  /** 0..1 — remove background color spill from edge pixels. */
  decontaminate: number;
}

export const DEFAULT_BG_PARAMS: BgParams = {
  mode: 'auto',
  keyColor: '#00b140',
  tolerance: 18,
  softness: 12,
  contiguous: true,
  feather: 0.6,
  shrink: 0,
  decontaminate: 0.6,
};

export const GREEN_PRESET: Partial<BgParams> = { mode: 'green', tolerance: 30, softness: 25, contiguous: false, decontaminate: 0.8, keyColor: '#00b140' };

export type RGB = [number, number, number];

/** Perceptual-ish ("redmean") color distance scaled to 0..100. */
export function colorDistance(r: number, g: number, b: number, pr: number, pg: number, pb: number): number {
  const rm = (r + pr) / 2;
  const dr = r - pr,
    dg = g - pg,
    db = b - pb;
  return (Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 765) * 100;
}

/**
 * Dominant colors along the image border (ignores transparent pixels). Returns up to `maxColors`
 * colors that each cover a meaningful share of the border.
 */
export function sampleBorderPalette(img: PixelBuffer, maxColors = 4): RGB[] {
  const { width: w, height: h, data: d } = img;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const perim = 2 * (w + h);
  const step = Math.max(1, Math.floor(perim / 6000));
  const visit = (x: number, y: number) => {
    const q = (y * w + x) * 4;
    if (d[q + 3] < 16) return;
    const key = ((d[q] >> 3) << 10) | ((d[q + 1] >> 3) << 5) | (d[q + 2] >> 3);
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { n: 0, r: 0, g: 0, b: 0 }));
    e.n++;
    e.r += d[q];
    e.g += d[q + 1];
    e.b += d[q + 2];
    total++;
  };
  // Sample a 2px-deep frame to be robust against a 1px border line.
  for (let depth = 0; depth < Math.min(2, Math.floor(Math.min(w, h) / 2)); depth++) {
    for (let x = 0; x < w; x += step) {
      visit(x, depth);
      visit(x, h - 1 - depth);
    }
    for (let y = 0; y < h; y += step) {
      visit(depth, y);
      visit(w - 1 - depth, y);
    }
  }
  if (!total) return [];
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  // Merge similar buckets into clusters.
  const clusters: { n: number; r: number; g: number; b: number }[] = [];
  for (const e of sorted) {
    const mr = e.r / e.n,
      mg = e.g / e.n,
      mb = e.b / e.n;
    const c = clusters.find((k) => colorDistance(mr, mg, mb, k.r / k.n, k.g / k.n, k.b / k.n) < 9);
    if (c) {
      c.n += e.n;
      c.r += e.r;
      c.g += e.g;
      c.b += e.b;
    } else clusters.push({ ...e });
  }
  clusters.sort((a, b) => b.n - a.n);
  const out: RGB[] = [];
  let covered = 0;
  for (const c of clusters) {
    if (out.length >= maxColors) break;
    if (out.length && c.n / total < 0.04) break;
    out.push([c.r / c.n, c.g / c.n, c.b / c.n]);
    covered += c.n;
    if (covered / total > 0.97) break;
  }
  return out;
}

/** Per-pixel "background-ness" distance (0 = definitely background). */
export function backgroundDistance(img: PixelBuffer, params: BgParams, palette: RGB[]): Float32Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const D = new Float32Array(n);
  if (params.mode === 'green') {
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      if (d[q + 3] < 16) {
        D[i] = 0;
        continue;
      }
      const r = d[q],
        g = d[q + 1],
        b = d[q + 2];
      const excess = g - Math.max(r, b);
      const greenness = Math.max(0, Math.min(100, (excess / 255) * 260));
      D[i] = 100 - greenness;
    }
    return D;
  }
  if (!palette.length) {
    // Border is fully transparent: the existing alpha already separates the subject.
    for (let i = 0, q = 3; i < n; i++, q += 4) D[i] = d[q] < 16 ? 0 : 100;
    return D;
  }
  const pal = palette;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    if (d[q + 3] < 16) {
      D[i] = 0;
      continue;
    }
    const r = d[q],
      g = d[q + 1],
      b = d[q + 2];
    let best = 1e9;
    for (let k = 0; k < pal.length; k++) {
      const c = pal[k];
      const v = colorDistance(r, g, b, c[0], c[1], c[2]);
      if (v < best) best = v;
    }
    D[i] = best;
  }
  return D;
}

/** Palette used for a mode (auto → border colors, color → key color, green → green key). */
export function paletteFor(img: PixelBuffer, params: BgParams): RGB[] {
  if (params.mode === 'auto') return sampleBorderPalette(img);
  return [hexToRgb(params.mode === 'green' ? '#00b140' : params.keyColor)];
}

/**
 * Compute the keep-mask (0 = removed, 255 = kept) for an image. The result does NOT include the
 * image's own alpha; multiply with `applyMask`.
 */
export function computeKeepMask(img: PixelBuffer, params: BgParams, palette = paletteFor(img, params)): Uint8ClampedArray {
  const { width: w, height: h } = img;
  const n = w * h;
  const D = backgroundDistance(img, params, palette);
  const tol = Math.max(0, params.tolerance);
  const soft = Math.max(0.001, params.softness);
  const limit = tol + soft;
  const contiguous = params.mode === 'auto' ? true : params.contiguous;
  let reach: Uint8Array | null = null;
  if (contiguous) {
    reach = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0,
      tail = 0;
    const push = (i: number) => {
      if (!reach![i] && D[i] < limit) {
        reach![i] = 1;
        queue[tail++] = i;
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < n - w) push(i + w);
    }
  }
  const maskF = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (reach && !reach[i]) {
      maskF[i] = 1;
      continue;
    }
    const v = D[i];
    maskF[i] = v <= tol ? 0 : v >= limit ? 1 : (v - tol) / soft;
  }
  // Shrink edge
  if (params.shrink > 0.01) {
    const inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) inside[i] = maskF[i] >= 0.5 ? 1 : 0;
    const dist = distanceToOutside(inside, w, h, false);
    const s = params.shrink;
    for (let i = 0; i < n; i++) if (inside[i]) maskF[i] *= smoothstep(s - 0.5, s + 0.5, dist[i]);
  }
  // Feather
  if (params.feather > 0.25) blurFloat(maskF, w, h, params.feather * 2);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) out[i] = maskF[i] * 255 + 0.5;
  return out;
}

/** Remove background color spill from kept pixels (in place). */
export function decontaminate(img: PixelBuffer, mask: Uint8ClampedArray, params: BgParams, palette: RGB[]): PixelBuffer {
  const amount = Math.max(0, Math.min(1, params.decontaminate));
  if (amount <= 0) return img;
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  if (params.mode === 'green') {
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      if (!mask[i]) continue;
      const r = d[q],
        g = d[q + 1],
        b = d[q + 2];
      const cap = Math.max(r, b);
      if (g > cap) {
        const ng = cap + (g - cap) * (1 - amount);
        // Restore lost luminance a little so skin doesn't go magenta.
        const lost = (g - ng) * 0.3;
        d[q] = r + lost * amount;
        d[q + 1] = ng;
        d[q + 2] = b + lost * amount;
      }
    }
    return img;
  }
  if (!palette.length) return img;
  // Pixels near the edge: partially transparent, or within a few px of the removed area.
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = mask[i] >= 250 ? 1 : 0;
  const dist = distanceToOutside(inside, w, h, false);
  const band = 3;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const m = mask[i];
    if (!m) continue;
    if (inside[i] && dist[i] > band) continue;
    const r = d[q],
      g = d[q + 1],
      b = d[q + 2];
    // nearest background color
    let best = 1e9,
      bc = palette[0];
    for (const c of palette) {
      const v = colorDistance(r, g, b, c[0], c[1], c[2]);
      if (v < best) {
        best = v;
        bc = c;
      }
    }
    const edgeA = inside[i] ? Math.min(1, 0.55 + dist[i] / (band * 2.2)) : m / 255;
    const a = Math.max(0.2, edgeA);
    const fr = (r - (1 - a) * bc[0]) / a;
    const fg = (g - (1 - a) * bc[1]) / a;
    const fb = (b - (1 - a) * bc[2]) / a;
    d[q] = r + (fr - r) * amount;
    d[q + 1] = g + (fg - g) * amount;
    d[q + 2] = b + (fb - b) * amount;
  }
  return img;
}

/** Multiply the image alpha by the keep-mask (in place). */
export function applyMask(img: PixelBuffer, mask: Uint8ClampedArray): PixelBuffer {
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) d[q] = (d[q] * mask[i]) / 255;
  return img;
}

/** Full pipeline on a copy: returns { mask, palette } and modifies `img` when decontaminating. */
export function removeBackground(img: PixelBuffer, params: BgParams): { mask: Uint8ClampedArray; palette: RGB[] } {
  const palette = paletteFor(img, params);
  const mask = computeKeepMask(img, params, palette);
  decontaminate(img, mask, params, palette);
  return { mask, palette };
}

/** Subject selection heuristic: alpha if the image has transparency, else auto background removal. */
export function subjectMask(img: PixelBuffer): Uint8ClampedArray {
  const params: BgParams = { ...DEFAULT_BG_PARAMS, tolerance: 16, softness: 10, feather: 0.5, decontaminate: 0 };
  const mask = computeKeepMask(img, params);
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) mask[i] = (mask[i] * d[q]) / 255;
  return mask;
}
