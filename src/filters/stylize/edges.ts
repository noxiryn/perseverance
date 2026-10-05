/**
 * Shared outline machinery (cel-shade, ink-outline, poster edges…): luminance edges (Sobel + thin
 * + hysteresis + speck removal) and the alpha silhouette, turned into anti-aliased lines of a
 * given thickness with an exact Euclidean distance transform (round, even-width strokes).
 */
import type { Img } from './util';
import { blurPlane, boundedDistance, edgeSeeds, insideDistance, sobel } from './util';

export interface OutlineOptions {
  /** Line width in image px. */
  thickness: number;
  /** 0..1 user threshold (higher = fewer, stronger edges only). */
  threshold: number;
  /** Also outline the alpha silhouette (inner stroke so alpha is preserved). */
  silhouette?: boolean;
  /** Pre-blur sigma in image px (noise suppression). */
  smooth?: number;
  /** Drop edge fragments shorter than this many px. */
  minLength?: number;
  /** Optional precomputed luminance plane (0..1). */
  luma?: Float32Array;
}

/** Map the 0..1 threshold slider to a Sobel magnitude (after the pre-blur). */
export function edgeThresholdValue(t: number): number {
  return 0.008 + 0.3 * t * t;
}

/**
 * Edge seeds with hysteresis (weak edges connected to strong ones are kept) and removal of tiny
 * isolated fragments. Returns 0/1 mask.
 */
export function detectEdges(lum: Float32Array, w: number, h: number, threshold: number, minLength = 3): Uint8Array {
  const strong = edgeThresholdValue(threshold);
  const weak = strong * 0.5;
  let cand: Uint8Array;
  if (w >= 3 && h >= 3) cand = edgeCandidates(lum, w, h, weak, strong);
  else {
    const { gx, gy, mag } = sobel(lum, w, h);
    cand = edgeSeeds(mag, gx, gy, w, h, weak);
    for (let i = 0; i < cand.length; i++) if (cand[i] && mag[i] >= strong) cand[i] = 2;
  }
  return keepConnected(cand, w, h, minLength);
}

/**
 * sobel() + edgeSeeds() streamed row by row (three-row rings instead of three full-size planes),
 * same arithmetic: 0 = no candidate, 1 = thin edge ≥ weak, 2 = thin edge ≥ strong (w, h ≥ 3).
 */
function edgeCandidates(lum: Float32Array, w: number, h: number, weak: number, strong: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const GX = [new Float32Array(w), new Float32Array(w), new Float32Array(w)],
    GY = [new Float32Array(w), new Float32Array(w), new Float32Array(w)],
    MG = [new Float32Array(w), new Float32Array(w), new Float32Array(w)];
  const sob = (y: number) => {
    const k = y % 3;
    sobelRowInto(lum, GX[k], GY[k], MG[k], (y > 0 ? y - 1 : 0) * w, y * w, (y < h - 1 ? y + 1 : y) * w, w);
  };
  sob(0);
  sob(1);
  for (let y = 1; y < h - 1; y++) {
    sob(y + 1);
    const c = y % 3;
    seedRow(MG[(y + 2) % 3], MG[c], MG[(y + 1) % 3], GX[c], GY[c], out, y * w, w, weak, strong);
  }
  return out;
}

/** sobel() of one row (w ≥ 3) into row buffers: clamped end columns, branch-free interior. */
function sobelRowInto(buf: Float32Array, gx: Float32Array, gy: Float32Array, mag: Float32Array, ym: number, y0: number, yp: number, w: number) {
  sobelAt(buf, gx, gy, mag, ym, y0, yp, 0, 0, 1);
  for (let x = 1, e = w - 1; x < e; x++) {
    const a = buf[ym + x - 1],
      b = buf[ym + x],
      c = buf[ym + x + 1],
      d = buf[y0 + x - 1],
      f = buf[y0 + x + 1],
      g = buf[yp + x - 1],
      hh = buf[yp + x],
      k = buf[yp + x + 1];
    const sx = (c + 2 * f + k - a - 2 * d - g) * 0.25;
    const sy = (g + 2 * hh + k - a - 2 * b - c) * 0.25;
    gx[x] = sx;
    gy[x] = sy;
    mag[x] = Math.sqrt(sx * sx + sy * sy);
  }
  sobelAt(buf, gx, gy, mag, ym, y0, yp, w - 1, w - 2, w - 1);
}

/** sobel() at column x with neighbour columns xm / xp. */
function sobelAt(buf: Float32Array, gx: Float32Array, gy: Float32Array, mag: Float32Array, ym: number, y0: number, yp: number, x: number, xm: number, xp: number) {
  const a = buf[ym + xm],
    b = buf[ym + x],
    c = buf[ym + xp],
    d = buf[y0 + xm],
    f = buf[y0 + xp],
    g = buf[yp + xm],
    hh = buf[yp + x],
    k = buf[yp + xp];
  const sx = (c + 2 * f + k - a - 2 * d - g) * 0.25;
  const sy = (g + 2 * hh + k - a - 2 * b - c) * 0.25;
  gx[x] = sx;
  gy[x] = sy;
  mag[x] = Math.sqrt(sx * sx + sy * sy);
}

/** edgeSeeds() of one interior row from the magnitude rows above / at / below it. */
function seedRow(up: Float32Array, mid: Float32Array, dn: Float32Array, gx: Float32Array, gy: Float32Array, out: Uint8Array, o: number, w: number, weak: number, strong: number) {
  for (let x = 1; x < w - 1; x++) {
    const m = mid[x];
    if (m < weak) continue;
    const ax = Math.abs(gx[x]),
      ay = Math.abs(gy[x]);
    let n1: number, n2: number;
    if (ax > ay * 2.414) {
      n1 = mid[x - 1];
      n2 = mid[x + 1];
    } else if (ay > ax * 2.414) {
      n1 = up[x];
      n2 = dn[x];
    } else if (gx[x] * gy[x] > 0) {
      n1 = up[x - 1];
      n2 = dn[x + 1];
    } else {
      n1 = up[x + 1];
      n2 = dn[x - 1];
    }
    if (m >= n1 && m >= n2) out[o + x] = m >= strong ? 2 : 1;
  }
}

/**
 * Hysteresis + speck removal: the 8-connected components of candidates (`cand` ≠ 0) that contain
 * a strong pixel (2) and have at least minLength pixels (flood fill from each strong seed, in
 * scan order — same components as before, with typed-array bookkeeping).
 */
function keepConnected(cand: Uint8Array, w: number, h: number, minLength: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (cand[i] !== 2 || visited[i]) continue;
    // flood the connected candidate component starting from a strong pixel
    let sp = 0,
      nc = 0;
    stack[sp++] = i;
    visited[i] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      comp[nc++] = p;
      const px = p % w,
        py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (cand[q] && !visited[q]) {
            visited[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    if (nc >= minLength) for (let c = 0; c < nc; c++) out[comp[c]] = 1;
  }
  return out;
}

/** Luminance with transparent areas pulled to mid-gray (so alpha edges don't dominate). */
export function edgeLuma(img: Img): Float32Array {
  const { data } = img;
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = data[j + 3] / 255;
    const l = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
    out[i] = l * a + 0.5 * (1 - a);
  }
  return out;
}

export function hasTransparency(img: Img): boolean {
  const d = img.data;
  for (let j = 3; j < d.length; j += 4) if (d[j] < 128) return true;
  return false;
}

/** Anti-aliased outline coverage (0..1 per pixel). */
export function outlineCoverage(img: Img, o: OutlineOptions): Float32Array {
  const { width: w, height: h } = img;
  const n = w * h;
  const cov = new Float32Array(n);
  const T = Math.max(0, o.thickness);
  if (T <= 0.01) return cov;
  const lum = o.luma ? Float32Array.from(o.luma) : edgeLuma(img);
  blurPlane(lum, w, h, o.smooth ?? 1);
  const seeds = detectEdges(lum, w, h, o.threshold, o.minLength ?? 3);
  const half = T * 0.5;
  const dEdge = boundedDistance(seeds, w, h, half + 1);
  const faint = Math.min(1, T); // sub-pixel lines fade instead of thinning further
  for (let i = 0; i < n; i++) {
    const c = half + 0.5 - dEdge[i];
    if (c > 0) cov[i] = (c >= 1 ? 1 : c) * faint;
  }
  if (o.silhouette !== false && hasTransparency(img)) {
    const dIn = insideDistance(img, false, T + 1);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      if (d[i * 4 + 3] === 0) continue;
      const c = T + 0.5 - dIn[i];
      if (c > 0) {
        const v = (c >= 1 ? 1 : c) * faint;
        if (v > cov[i]) cov[i] = v;
      }
    }
  }
  return cov;
}
