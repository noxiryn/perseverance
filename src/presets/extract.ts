/**
 * Palette extraction from pixels (pure): k-means (k-means++ seeding, deterministic) and median
 * cut. Operates on `{ data, width, height }` so it is testable without a canvas.
 */

export interface PixelSource {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type ExtractMethod = 'kmeans' | 'median-cut';

export interface ExtractedColor {
  color: string;
  /** Share of sampled pixels (0..1). */
  weight: number;
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** Collect up to `max` opaque pixels (alpha ≥ 128) as packed RGB triplets. */
export function samplePixels(img: PixelSource, max = 16384): Float32Array {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / max));
  const out = new Float32Array(Math.min(n, Math.ceil(n / step)) * 3);
  let k = 0;
  const d = img.data;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (d[o + 3] < 128) continue;
    out[k++] = d[o];
    out[k++] = d[o + 1];
    out[k++] = d[o + 2];
  }
  return out.subarray(0, k);
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means clustering of RGB samples. */
export function kmeans(px: Float32Array, k: number, iterations = 12, seed = 7): ExtractedColor[] {
  const n = px.length / 3;
  if (!n) return [];
  k = Math.max(1, Math.min(k, n));
  const rand = rng(seed);
  const cent = new Float32Array(k * 3);
  // k-means++ seeding
  const first = Math.floor(rand() * n);
  cent[0] = px[first * 3];
  cent[1] = px[first * 3 + 1];
  cent[2] = px[first * 3 + 2];
  const dist = new Float32Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    const pc = c - 1;
    for (let i = 0; i < n; i++) {
      const dr = px[i * 3] - cent[pc * 3];
      const dg = px[i * 3 + 1] - cent[pc * 3 + 1];
      const db = px[i * 3 + 2] - cent[pc * 3 + 2];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < dist[i]) dist[i] = dd;
      sum += dist[i];
    }
    let target = rand() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= dist[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    cent[c * 3] = px[pick * 3];
    cent[c * 3 + 1] = px[pick * 3 + 1];
    cent[c * 3 + 2] = px[pick * 3 + 2];
  }
  const assign = new Int32Array(n);
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    counts.fill(0);
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const r = px[i * 3],
        g = px[i * 3 + 1],
        b = px[i * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - cent[c * 3],
          dg = g - cent[c * 3 + 1],
          db = b - cent[c * 3 + 2];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
      sums[best * 3] += r;
      sums[best * 3 + 1] += g;
      sums[best * 3 + 2] += b;
      counts[best]++;
    }
    for (let c = 0; c < k; c++) {
      if (!counts[c]) continue;
      cent[c * 3] = sums[c * 3] / counts[c];
      cent[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      cent[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    }
    if (it > 0 && moved === 0) break;
  }
  const out: ExtractedColor[] = [];
  for (let c = 0; c < k; c++) {
    if (!counts[c]) continue;
    out.push({ color: toHex(cent[c * 3], cent[c * 3 + 1], cent[c * 3 + 2]), weight: counts[c] / n });
  }
  return out;
}

/** Median cut: repeatedly split the box with the widest channel range at its median. */
export function medianCut(px: Float32Array, k: number): ExtractedColor[] {
  const n = px.length / 3;
  if (!n) return [];
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  type Box = { start: number; end: number };
  const boxes: Box[] = [{ start: 0, end: n }];
  const range = (b: Box) => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let i = b.start; i < b.end; i++) {
      const o = idx[i] * 3;
      for (let c = 0; c < 3; c++) {
        const v = px[o + c];
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const spans = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const ch = spans.indexOf(Math.max(...spans));
    return { ch, span: spans[ch] };
  };
  while (boxes.length < k) {
    // Split the box with the largest (span × population).
    let bi = -1;
    let bestScore = 0;
    let bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.end - b.start < 2) continue;
      const { ch, span } = range(b);
      const score = span * Math.sqrt(b.end - b.start);
      if (score > bestScore) {
        bestScore = score;
        bi = i;
        bestCh = ch;
      }
    }
    if (bi < 0) break;
    const b = boxes[bi];
    const sub = Array.from(idx.subarray(b.start, b.end)).sort((x, y) => px[x * 3 + bestCh] - px[y * 3 + bestCh]);
    idx.set(sub, b.start);
    const mid = b.start + (sub.length >> 1);
    boxes.splice(bi, 1, { start: b.start, end: mid }, { start: mid, end: b.end });
  }
  return boxes
    .filter((b) => b.end > b.start)
    .map((b) => {
      let r = 0,
        g = 0,
        bl = 0;
      for (let i = b.start; i < b.end; i++) {
        const o = idx[i] * 3;
        r += px[o];
        g += px[o + 1];
        bl += px[o + 2];
      }
      const c = b.end - b.start;
      return { color: toHex(r / c, g / c, bl / c), weight: c / n };
    });
}

function lum(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
}

function dist2(a: string, b: string): number {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const dr = ((x >> 16) & 255) - ((y >> 16) & 255);
  const dg = ((x >> 8) & 255) - ((y >> 8) & 255);
  const db = (x & 255) - (y & 255);
  return dr * dr + dg * dg + db * db;
}

/**
 * Extract a palette of `count` colors (sorted dark → light). Near-duplicates are merged, so the
 * result can be shorter for very flat images.
 */
export function extractPalette(img: PixelSource, count: number, method: ExtractMethod = 'kmeans'): ExtractedColor[] {
  const px = samplePixels(img);
  const raw = method === 'kmeans' ? kmeans(px, count) : medianCut(px, count);
  const merged: ExtractedColor[] = [];
  for (const c of raw.sort((a, b) => b.weight - a.weight)) {
    const near = merged.find((m) => dist2(m.color, c.color) < 64);
    if (near) near.weight += c.weight;
    else merged.push({ ...c });
  }
  return merged.sort((a, b) => lum(a.color) - lum(b.color));
}
