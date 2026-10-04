/**
 * Shared outline machinery (cel-shade, ink-outline, poster edges…): luminance edges (Sobel + thin
 * + hysteresis + speck removal) and the alpha silhouette, turned into anti-aliased lines of a
 * given thickness with an exact Euclidean distance transform (round, even-width strokes).
 */
import type { Img } from './util';
import { blurPlane, distanceTransform, edgeSeeds, insideDistance, sobel } from './util';

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
  const { gx, gy, mag } = sobel(lum, w, h);
  const strong = edgeThresholdValue(threshold);
  const weak = strong * 0.5;
  const cand = edgeSeeds(mag, gx, gy, w, h, weak);
  const out = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!cand[i] || visited[i] || mag[i] < strong) continue;
    // flood the connected candidate component starting from a strong pixel
    let sp = 0;
    stack[sp++] = i;
    visited[i] = 1;
    comp.length = 0;
    while (sp > 0) {
      const p = stack[--sp];
      comp.push(p);
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
    if (comp.length >= minLength) for (const p of comp) out[p] = 1;
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
  const dEdge = distanceTransform(seeds, w, h);
  const half = T * 0.5;
  const faint = Math.min(1, T); // sub-pixel lines fade instead of thinning further
  for (let i = 0; i < n; i++) {
    const c = half + 0.5 - dEdge[i];
    if (c > 0) cov[i] = (c >= 1 ? 1 : c) * faint;
  }
  if (o.silhouette !== false && hasTransparency(img)) {
    const dIn = insideDistance(img, false);
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
