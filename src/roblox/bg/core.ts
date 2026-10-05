/**
 * Background removal core (pure, typed-array based):
 *  - 'auto'  : sample the dominant border colors and flood-fill from every edge with a tolerance.
 *              The flood also follows smooth color gradients (sky, fog, vignettes) away from the
 *              border palette — only where the color drifts slowly with the distance from the
 *              plainly flooded background, so a subject part whose color is just above the
 *              tolerance is never entered through the short (even JPEG-blurred) ramp at its
 *              edge —, removes thin background seams (e.g. the antialiased horizon line between
 *              sky and baseplate) and drops small leftover islands,
 *  - 'color' : key out one picked color (globally or contiguous from the edges),
 *  - 'green' : chroma key on green dominance.
 * Contiguous floods only cross pixels at or below the tolerance; the softness band gives partial
 * transparency in a thin edge band next to the removed background, so it can never leak into the
 * subject and leave its interior semi-transparent.
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
  tolerance: 10,
  softness: 6,
  contiguous: true,
  feather: 0.6,
  shrink: 0,
  decontaminate: 0.6,
};

export const GREEN_PRESET: Partial<BgParams> = { mode: 'green', tolerance: 30, softness: 25, contiguous: false, decontaminate: 0.8, keyColor: '#00b140' };

export type RGB = [number, number, number];

/** Squared "redmean" color distance (unscaled) — compare these, take the root once. */
function colorDistanceSq(r: number, g: number, b: number, pr: number, pg: number, pb: number): number {
  const rm = (r + pr) / 2;
  const dr = r - pr,
    dg = g - pg,
    db = b - pb;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

const DIST_SCALE = 100 / 765;

/** Perceptual-ish ("redmean") color distance scaled to 0..100. */
export function colorDistance(r: number, g: number, b: number, pr: number, pg: number, pb: number): number {
  return Math.sqrt(colorDistanceSq(r, g, b, pr, pg, pb)) * DIST_SCALE;
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
  const k0 = pal.length;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    if (d[q + 3] < 16) {
      D[i] = 0;
      continue;
    }
    const r = d[q],
      g = d[q + 1],
      b = d[q + 2];
    let best = Infinity;
    for (let k = 0; k < k0; k++) {
      const c = pal[k];
      const v = colorDistanceSq(r, g, b, c[0], c[1], c[2]);
      if (v < best) best = v;
    }
    D[i] = Math.sqrt(best) * DIST_SCALE;
  }
  return D;
}

/**
 * 3×3 median of a distance map (edge pixels use their in-image neighbours) for the pixels whose
 * value is within [lo, hi]; the others are copied. Compression noise (JPEG) scatters a subject
 * color that is just above the tolerance to both sides of it; the median keeps it on its side so
 * the flood can't percolate into the subject, while edges stay sharp (unlike a blur). Limiting it
 * to values near the tolerance keeps it cheap and leaves thin, clearly different details (1px
 * outlines, hair) alone. Pure.
 */
export function median3(src: Float32Array, w: number, h: number, lo = -Infinity, hi = Infinity): Float32Array {
  const out = new Float32Array(src);
  const v = new Float64Array(9);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y,
      y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const c = src[y * w + x];
      if (c < lo || c > hi) continue;
      const x0 = x > 0 ? x - 1 : x,
        x1 = x < w - 1 ? x + 1 : x;
      let k = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          // insertion sort while collecting (≤ 9 values)
          const val = src[row + xx];
          let j = k++;
          while (j > 0 && v[j - 1] > val) (v[j] = v[j - 1]), j--;
          v[j] = val;
        }
      }
      out[y * w + x] = k & 1 ? v[k >> 1] : (v[(k >> 1) - 1] + v[k >> 1]) / 2;
    }
  }
  return out;
}

/** Palette used for a mode (auto → border colors, color → key color, green → green key). */
export function paletteFor(img: PixelBuffer, params: BgParams): RGB[] {
  if (params.mode === 'auto') return sampleBorderPalette(img);
  return [hexToRgb(params.mode === 'green' ? '#00b140' : params.keyColor)];
}

/** Auto mode: neighbouring pixels closer than this (0..100) continue the flood along a gradient. */
export const GRADIENT_STEP = 2.2;
/**
 * Auto mode: how fast (0..100 per px of distance from the plainly flooded background) a
 * gradient-followed background may drift above the tolerance. Background gradients drift slowly
 * (a studio sky ≈0.07 per px); a subject part is above the tolerance right next to its edge.
 * The distance is Euclidean, so a path running along the edge can't build up an allowance.
 */
export const GRADIENT_RATE = 0.1;
/** Auto mode: drift above the tolerance allowed regardless of the distance (noise). */
export const GRADIENT_SLACK = 0.2;
/** How far (0..100) beyond tolerance + softness a gradient-followed background may drift. */
export const GRADIENT_DRIFT = 8;
/** Width (px) of the partially transparent band next to the removed background. */
export const SOFT_EDGE_BAND = 2;
/** Auto mode: background seams up to this many px thick between removed areas are removed too. */
export const SEAM_MAX = 3;
/**
 * A gradient-removed area whose outline touches the kept subject for more than this share looks
 * like a subject part (e.g. a shirt close to the background color): reported as `enclosedRemoved`.
 */
export const ENCLOSED_SHARE = 0.5;
/** Auto mode: kept islands smaller than this share of the largest kept region are dropped. */
export const ISLAND_SHARE = 0.015;

const ALPHA_MIN = 16;

/** Gradient-following options of `floodBackground` (distances 0..100). */
export interface GradientFollow {
  /** Largest color step between neighbours. */
  step: number;
  /** Largest distance to the palette a followed pixel may have. */
  cap: number;
  /**
   * Allowed drift above the tolerance per px of (Euclidean) distance from the plain flood
   * (default: unlimited).
   */
  rate?: number;
  /** Drift above the tolerance allowed at any distance (default 0). */
  slack?: number;
}

/**
 * Flood the background from every border pixel. A pixel joins when its background distance is
 * at or below `tol`, or — with `grad`, in a second pass — when it is a small color step away from
 * the pixel it is reached from, has not drifted further than `grad.cap` from the palette and
 * drifted above `tol` no faster than `grad.rate` per px of distance from the plain flood. The
 * second pass only grows by small color steps, even into pixels within tolerance: a subject part
 * whose color happens to match the palette is not swallowed when the gradient reaches its edge.
 * Returns 1 for the plain flood, 2 for gradient-followed pixels.
 */
export function floodBackground(img: PixelBuffer, D: Float32Array, tol: number, grad: GradientFollow | null): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const R = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0,
    tail = 0;
  const seed = (i: number) => {
    if (!R[i] && D[i] <= tol) (R[i] = 1), (queue[tail++] = i);
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  const last = n - w;
  // Pass 1: plain flood (pixels within tolerance).
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < last) seed(i + w);
  }
  if (!grad) return R;
  // Pass 2: follow smooth gradients out of the plain flood.
  const stepSq = (grad.step / DIST_SCALE) ** 2;
  const cap = grad.cap;
  const rate = grad.rate ?? Infinity;
  const slack = grad.slack ?? 0;
  let dist: Float32Array | null = null;
  if (Number.isFinite(rate)) {
    const outside = new Uint8Array(n);
    for (let i = 0; i < n; i++) outside[i] = R[i] ? 0 : 1;
    dist = distanceToOutside(outside, w, h, false);
  }
  // Pass-2 frontier: plain-flood pixels next to an unreached one.
  tail = 0;
  for (let i = 0; i < n; i++) {
    if (!R[i]) continue;
    const x = i % w;
    if ((x > 0 && !R[i - 1]) || (x < w - 1 && !R[i + 1]) || (i >= w && !R[i - w]) || (i < last && !R[i + w])) queue[tail++] = i;
  }
  head = 0;
  // One shared neighbour visit (no per-pixel allocations — this runs over millions of pixels).
  const visit = (i: number, j: number) => {
    if (R[j]) return;
    const dj = D[j];
    if (dj > cap || (dist && dj - tol > slack + rate * dist[j])) return;
    const p = i * 4,
      q = j * 4;
    if (d[p + 3] < ALPHA_MIN || d[q + 3] < ALPHA_MIN) return;
    if (colorDistanceSq(d[p], d[p + 1], d[p + 2], d[q], d[q + 1], d[q + 2]) <= stepSq) {
      R[j] = 2;
      queue[tail++] = j;
    }
  };
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) visit(i, i - 1);
    if (x < w - 1) visit(i, i + 1);
    if (i >= w) visit(i, i - w);
    if (i < last) visit(i, i + w);
  }
  return R;
}

/**
 * Mark thin unreached runs (≤ `maxGap` px, horizontally or vertically) between two reached
 * background pixels whose color is a blend of those two — antialiased seams where two background
 * areas meet (the horizon between sky and baseplate). Thin subject parts (a sword blade against
 * the sky) are not a blend of the background around them and stay. Returns the number marked.
 */
export function removeSeams(img: PixelBuffer, reach: Uint8Array, maxDist: number, maxGap = SEAM_MAX): number {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const marked: number[] = [];
  const maxSq = (maxDist / DIST_SCALE) ** 2;
  for (let i = 0; i < n; i++) {
    if (reach[i]) continue;
    const x = i % w,
      y = (i - x) / w;
    for (let dir = 0; dir < 2; dir++) {
      const stride = dir === 0 ? 1 : w;
      const pos = dir === 0 ? x : y;
      const size = dir === 0 ? w : h;
      let ka = 0,
        kb = 0;
      for (let k = 1; k <= maxGap && pos - k >= 0; k++) {
        if (reach[i - k * stride]) {
          ka = k;
          break;
        }
      }
      if (!ka) continue;
      for (let k = 1; k <= maxGap - ka + 1 && pos + k < size; k++) {
        if (reach[i + k * stride]) {
          kb = k;
          break;
        }
      }
      if (!kb) continue;
      const a = (i - ka * stride) * 4,
        b = (i + kb * stride) * 4,
        p = i * 4;
      // Distance from p to the segment a..b in RGB.
      const abr = d[b] - d[a],
        abg = d[b + 1] - d[a + 1],
        abb = d[b + 2] - d[a + 2];
      const len = abr * abr + abg * abg + abb * abb;
      let t = len > 0 ? ((d[p] - d[a]) * abr + (d[p + 1] - d[a + 1]) * abg + (d[p + 2] - d[a + 2]) * abb) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (colorDistanceSq(d[p], d[p + 1], d[p + 2], d[a] + abr * t, d[a + 1] + abg * t, d[a + 2] + abb * t) <= maxSq) {
        marked.push(i);
        break;
      }
    }
  }
  for (const i of marked) reach[i] = 1;
  return marked.length;
}

/**
 * Zero kept regions (8-connected, value > 0.04) smaller than `share` of the largest one — specks
 * of background clutter the flood could not reach. Separate large parts (a second character, a
 * detached sword) stay. Returns the number of regions dropped.
 */
export function dropIslands(maskF: Float32Array, w: number, h: number, share = ISLAND_SHARE): number {
  const n = w * h;
  const label = new Int32Array(n);
  const queue = new Int32Array(n);
  const areas: number[] = [0];
  for (let s = 0; s < n; s++) {
    if (label[s] || maskF[s] <= 0.04) continue;
    const id = areas.length;
    let head = 0,
      tail = 0,
      area = 0;
    label[s] = id;
    queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++];
      area++;
      const x = i % w,
        y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((!dx && !dy) || xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!label[j] && maskF[j] > 0.04) {
            label[j] = id;
            queue[tail++] = j;
          }
        }
      }
    }
    areas.push(area);
  }
  if (areas.length <= 2) return 0;
  let largest = 0;
  for (const a of areas) if (a > largest) largest = a;
  const min = Math.max(2, largest * share);
  let dropped = 0;
  const drop = new Uint8Array(areas.length);
  for (let k = 1; k < areas.length; k++) if (areas[k] < min) (drop[k] = 1), dropped++;
  if (!dropped) return 0;
  for (let i = 0; i < n; i++) if (drop[label[i]]) maskF[i] = 0;
  return dropped;
}

/**
 * Share (0..1) of the subject that gradient-following removed in areas mostly outlined by the
 * kept subject (likely subject parts close to the background color). `reach` is the flood result
 * (2 = gradient-followed), `maskF` the keep mask (> 0.5 = kept). Pure.
 */
export function enclosedRemovedShare(reach: Uint8Array, maskF: Float32Array, w: number, h: number, minArea = 64): number {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) if (maskF[i] > 0.5) kept++;
  let enclosed = 0;
  for (let s = 0; s < n; s++) {
    if (reach[s] !== 2 || seen[s]) continue;
    let head = 0,
      tail = 0,
      area = 0,
      edgeKept = 0,
      edgeAll = 0;
    seen[s] = 1;
    queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++];
      area++;
      const x = i % w;
      for (let k = 0; k < 4; k++) {
        if ((k === 0 && x === 0) || (k === 1 && x === w - 1) || (k === 2 && i < w) || (k === 3 && i >= n - w)) {
          edgeAll++; // the image border counts as background
          continue;
        }
        const j = k === 0 ? i - 1 : k === 1 ? i + 1 : k === 2 ? i - w : i + w;
        if (reach[j] === 2) {
          if (!seen[j]) (seen[j] = 1), (queue[tail++] = j);
          continue;
        }
        edgeAll++;
        if (!reach[j] && maskF[j] > 0.5) edgeKept++;
      }
    }
    if (area >= minArea && edgeAll && edgeKept / edgeAll > ENCLOSED_SHARE) enclosed += area;
  }
  return kept + enclosed ? enclosed / (kept + enclosed) : 0;
}

export interface KeepMaskOptions {
  /**
   * Resolution of `img` relative to the layer it previews (dialog previews run downscaled):
   * per-pixel gradient limits and pixel widths are scaled so preview and result agree.
   */
  scale?: number;
}

export interface KeepMaskResult {
  /** Final keep-mask (0 = removed, 255 = kept), with shrink and feather. */
  mask: Uint8ClampedArray;
  /** The keep-mask before shrink and feather (quality checks). */
  raw: Uint8ClampedArray;
  /** See enclosedRemovedShare (auto mode only, else 0). */
  enclosedRemoved: number;
}

/**
 * Compute the keep-mask (0 = removed, 255 = kept) for an image, plus the unfeathered mask and
 * quality numbers. The result does NOT include the image's own alpha; multiply with `applyMask`.
 */
export function keepMaskDetailed(img: PixelBuffer, params: BgParams, palette = paletteFor(img, params), opts: KeepMaskOptions = {}): KeepMaskResult {
  const { width: w, height: h } = img;
  const n = w * h;
  const scale = Math.max(0.05, Math.min(1, opts.scale ?? 1));
  const auto = params.mode === 'auto';
  const D0 = backgroundDistance(img, params, palette);
  const tol = Math.max(0, params.tolerance);
  const soft = Math.max(0.001, params.softness);
  const limit = tol + soft;
  // Auto mode works on tight defaults: denoise the distances that decide the flood (see median3).
  const D = auto && palette.length ? median3(D0, w, h, tol - 2, limit + GRADIENT_DRIFT + 2) : D0;
  const contiguous = auto ? true : params.contiguous;
  const maskF = new Float32Array(n);
  let enclosedRemoved = 0;
  if (contiguous) {
    // Smart extras need real border colors (an empty palette means the border is transparent and
    // the image alpha already separates the subject).
    const smart = auto && palette.length > 0;
    // A downscaled preview pixel spans 1/scale layer pixels: colors change faster per pixel.
    // Distances are in image px: a preview px spans 1/scale layer px.
    const core = floodBackground(img, D, tol, smart ? { step: GRADIENT_STEP / scale, cap: limit + GRADIENT_DRIFT, rate: GRADIENT_RATE / scale, slack: GRADIENT_SLACK } : null);
    if (smart) removeSeams(img, core, tol + soft * 0.5, Math.max(1, Math.round(SEAM_MAX * scale)));
    // Soft edge: pixels within the softness band get partial alpha, but only in a thin band next
    // to the removed background (BFS depth-limited) — never deep inside the subject.
    const band = Math.max(1, Math.round(SOFT_EDGE_BAND * scale));
    maskF.fill(1);
    const depth = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0,
      tail = 0;
    const last = n - w;
    for (let i = 0; i < n; i++) {
      if (!core[i]) continue;
      maskF[i] = 0;
      // only the removed pixels next to kept ones can start the band
      const x = i % w;
      if ((x > 0 && !core[i - 1]) || (x < w - 1 && !core[i + 1]) || (i >= w && !core[i - w]) || (i < last && !core[i + w])) queue[tail++] = i;
    }
    const grow = (j: number, di: number) => {
      if (core[j] || depth[j]) return;
      const v = D[j];
      if (v >= limit) return;
      depth[j] = di + 1;
      maskF[j] = (v - tol) / soft;
      queue[tail++] = j;
    };
    while (head < tail) {
      const i = queue[head++];
      const di = depth[i];
      if (di >= band) continue;
      const x = i % w;
      if (x > 0) grow(i - 1, di);
      if (x < w - 1) grow(i + 1, di);
      if (i >= w) grow(i - w, di);
      if (i < last) grow(i + w, di);
    }
    if (smart) {
      dropIslands(maskF, w, h);
      enclosedRemoved = enclosedRemovedShare(core, maskF, w, h, Math.max(16, Math.round(64 * scale * scale)));
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = D[i];
      maskF[i] = v <= tol ? 0 : v >= limit ? 1 : (v - tol) / soft;
    }
  }
  const raw = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) raw[i] = maskF[i] * 255 + 0.5;
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
  return { mask: out, raw, enclosedRemoved };
}

/**
 * Compute the keep-mask (0 = removed, 255 = kept) for an image. The result does NOT include the
 * image's own alpha; multiply with `applyMask`.
 */
export function computeKeepMask(img: PixelBuffer, params: BgParams, palette = paletteFor(img, params), opts: KeepMaskOptions = {}): Uint8ClampedArray {
  return keepMaskDetailed(img, params, palette, opts).mask;
}

export interface CutoutStats {
  /** Share (0..1) of the opaque layer pixels that end up removed. */
  removed: number;
  /** Share (0..1) of the subject's interior (> 3 px from the cut) that is partially transparent. */
  partialInterior: number;
}

/** Interior pixels partially transparent above this share → the dialog warns. */
export const PARTIAL_INTERIOR_WARN = 0.05;
/** Subject share removed in enclosed areas (enclosedRemoved) above this → the dialog warns. */
export const ENCLOSED_REMOVED_WARN = 0.02;

/**
 * Quality numbers for a keep-mask over an image (preview footer + warnings). Pass the mask from
 * before feather and shrink as `raw` (KeepMaskResult.raw): a feathered edge is not a
 * semi-transparent subject.
 */
export function cutoutStats(img: PixelBuffer, mask: Uint8ClampedArray, raw: Uint8ClampedArray = mask): CutoutStats {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const inside = new Uint8Array(n);
  let opaque = 0,
    removed = 0;
  for (let i = 0, q = 3; i < n; i++, q += 4) {
    const visible = d[q] > ALPHA_MIN;
    if (visible) {
      opaque++;
      if (mask[i] < 128) removed++;
    }
    inside[i] = visible && raw[i] > 8 ? 1 : 0;
  }
  const dist = distanceToOutside(inside, w, h, true);
  let interior = 0,
    partial = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i] <= 3) continue;
    interior++;
    if (raw[i] < 240) partial++;
  }
  return { removed: opaque ? removed / opaque : 0, partialInterior: interior ? partial / interior : 0 };
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DecontaminateResult {
  /** True when any pixel color changed. */
  changed: boolean;
  /** Bounds of the changed pixels (null when nothing changed). */
  rect: PixelRect | null;
}

/** Edge band (px from the removed area) where spill is removed: color keys / green screen. */
export const DECONTAM_BAND = 3;
export const GREEN_SPILL_BAND = 6;

/**
 * Remove background color spill from kept pixels near the cut (in place): partially transparent
 * pixels and pixels within a few px of the removed area. Interior colors are never touched, so
 * e.g. green clothing away from the edge keeps its color.
 */
export function decontaminate(img: PixelBuffer, mask: Uint8ClampedArray, params: BgParams, palette: RGB[]): DecontaminateResult {
  const none: DecontaminateResult = { changed: false, rect: null };
  const amount = Math.max(0, Math.min(1, params.decontaminate));
  if (amount <= 0) return none;
  const green = params.mode === 'green';
  if (!green && !palette.length) return none;
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const inside = new Uint8Array(n);
  let anyRemoved = false;
  for (let i = 0; i < n; i++) {
    if (mask[i] >= 250) inside[i] = 1;
    else anyRemoved = true;
  }
  if (!anyRemoved) return none;
  const dist = distanceToOutside(inside, w, h, false);
  const band = green ? GREEN_SPILL_BAND : DECONTAM_BAND;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const m = mask[i];
    if (!m) continue;
    const di = dist[i];
    if (inside[i] && di > band) continue;
    const r = d[q],
      g = d[q + 1],
      b = d[q + 2];
    // Fade the correction out toward the inner edge of the band.
    const fade = inside[i] ? Math.min(1, (band + 1 - di) / 2) : 1;
    const k = amount * fade;
    if (green) {
      const cap = Math.max(r, b);
      if (g <= cap) continue;
      const ng = cap + (g - cap) * (1 - k);
      // Restore lost luminance a little so skin doesn't go magenta.
      const lost = (g - ng) * 0.3;
      d[q] = r + lost * k;
      d[q + 1] = ng;
      d[q + 2] = b + lost * k;
    } else {
      // Nearest background color.
      let best = Infinity,
        bc = palette[0];
      for (const c of palette) {
        const v = colorDistanceSq(r, g, b, c[0], c[1], c[2]);
        if (v < best) {
          best = v;
          bc = c;
        }
      }
      const edgeA = inside[i] ? Math.min(1, 0.55 + di / (band * 2.2)) : m / 255;
      const a = Math.max(0.2, edgeA);
      const fr = (r - (1 - a) * bc[0]) / a;
      const fg = (g - (1 - a) * bc[1]) / a;
      const fb = (b - (1 - a) * bc[2]) / a;
      d[q] = r + (fr - r) * k;
      d[q + 1] = g + (fg - g) * k;
      d[q + 2] = b + (fb - b) * k;
    }
    if (d[q] !== r || d[q + 1] !== g || d[q + 2] !== b) {
      const x = i % w,
        y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? none : { changed: true, rect: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
}

/** Multiply the image alpha by the keep-mask (in place). */
export function applyMask(img: PixelBuffer, mask: Uint8ClampedArray): PixelBuffer {
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) d[q] = (d[q] * mask[i]) / 255;
  return img;
}

export interface RemoveBackgroundResult extends KeepMaskResult {
  palette: RGB[];
  decontaminated: DecontaminateResult;
}

/**
 * Full pipeline: returns the masks, the palette and the decontamination result, and modifies
 * `img` in place when decontaminating (only edge pixels; `decontaminated.rect` bounds the
 * changed area).
 */
export function removeBackground(img: PixelBuffer, params: BgParams, opts: KeepMaskOptions = {}): RemoveBackgroundResult {
  const palette = paletteFor(img, params);
  const res = keepMaskDetailed(img, params, palette, opts);
  const decontaminated = decontaminate(img, res.mask, params, palette);
  return { ...res, palette, decontaminated };
}

/** Bounds of mask pixels below 255 (pixels whose alpha a 'delete' output changes), or null. */
export function maskChangeBounds(mask: Uint8ClampedArray, w: number, h: number): PixelRect | null {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] < 255) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Union of two optional rects. */
export function unionRect(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Subject selection heuristic: alpha if the image has transparency, else auto background removal. */
export function subjectMask(img: PixelBuffer): Uint8ClampedArray {
  const params: BgParams = { ...DEFAULT_BG_PARAMS, tolerance: 12, softness: 8, feather: 0.5, decontaminate: 0 };
  const mask = computeKeepMask(img, params);
  const d = img.data;
  for (let i = 0, q = 3; i < mask.length; i++, q += 4) mask[i] = (mask[i] * d[q]) / 255;
  return mask;
}
