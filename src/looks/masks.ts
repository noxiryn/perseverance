/**
 * Mask painting helpers shared by looks and templates. Masks are doc-sized grayscale bitmaps
 * (white = visible). Everything here draws in document px on a context that may be scaled down
 * (previews), so shapes stay identical at any mask resolution. Saved looks carry the masks of
 * their overlays as small captured images (`ImageMaskSpec`), stretched to the target document.
 */
import type { ID, LayerMask } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas } from '../core/canvas';

/**
 * Trace and fill a polygon whose edges are torn (jagged, seeded) — e.g. a torn newspaper strip.
 * Points are in document px; `amp` is the tear depth, `step` the distance between tear points.
 */
export function tornPolygon(ctx: CanvasRenderingContext2D, pts: [number, number][], amp: number, seed = 1, step = 14) {
  let st = seed >>> 0 || 1;
  const rand = () => {
    st = (st * 1664525 + 1013904223) >>> 0;
    return st / 0xffffffff;
  };
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const [nx, ny] = pts[(i + 1) % pts.length];
    if (i === 0) ctx.moveTo(x, y);
    const len = Math.hypot(nx - x, ny - y);
    const n = Math.max(1, Math.round(len / step));
    // perpendicular unit vector
    const px = -(ny - y) / (len || 1);
    const py = (nx - x) / (len || 1);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const j = k === n ? 0 : (rand() - 0.5) * 2 * amp;
      ctx.lineTo(x + (nx - x) * t + px * j, y + (ny - y) * t + py * j);
    }
  });
  ctx.closePath();
  ctx.fill();
}

/** Mask spec a look overlay can carry (confines the overlay to part of the canvas). */
export type OverlayMaskSpec = EdgeStripsMaskSpec | ImageMaskSpec;

/** Torn-edged strips along the left and/or right document edges. */
export interface EdgeStripsMaskSpec {
  kind: 'edge-strips';
  /** Strip width as a fraction of the document width (top of the strip; the bottom tapers a little). */
  width: number;
  sides?: 'both' | 'left' | 'right';
  /** Tear depth as a fraction of the shorter document side. */
  tear?: number;
  seed?: number;
  feather?: number;
}

/**
 * A mask captured from a document (Save as Look): a low-resolution grayscale image covering the
 * whole document, stretched to the target document's size.
 */
export interface ImageMaskSpec {
  kind: 'image';
  width: number;
  height: number;
  /** Base64 of width × height luminance bytes (row-major, 255 = visible). */
  data: string;
  /** Feather as a fraction of the document's longer side. */
  featherRel?: number;
  density?: number;
  inverted?: boolean;
}

/** Longest side of a captured mask image (px). */
export const MASK_CAPTURE_SIZE = 160;

/** Base64 of a byte array. Pure. */
export function encodeMaskBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Bytes of a base64 mask, or null when it is not `n` bytes long / not base64. Pure. */
export function decodeMaskBytes(data: string, n: number): Uint8Array | null {
  try {
    const bin = atob(data);
    if (bin.length !== n) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Capture a layer mask (a doc-sized bitmap) as an ImageMaskSpec of at most MASK_CAPTURE_SIZE px.
 * Null when its bitmap is missing or no canvas is available.
 */
export function captureMaskSpec(mask: LayerMask, docW: number, docH: number, maxSide = MASK_CAPTURE_SIZE): ImageMaskSpec | null {
  try {
    const src = bitmaps.tryGet(mask.bitmapId);
    if (!src || !src.width || !src.height) return null;
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * s));
    const h = Math.max(1, Math.round(src.height * s));
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const bytes = new Uint8Array(w * h);
    for (let i = 0, q = 0; i < bytes.length; i++, q += 4) bytes[i] = px[q];
    const spec: ImageMaskSpec = { kind: 'image', width: w, height: h, data: encodeMaskBytes(bytes) };
    if (mask.feather > 0) spec.featherRel = mask.feather / Math.max(1, docW, docH);
    if (mask.density !== 1) spec.density = mask.density;
    if (mask.inverted) spec.inverted = true;
    return spec;
  } catch {
    return null;
  }
}

/** Corner points (doc px) of the edge strips of a spec, left strip first. */
export function edgeStripPolygons(spec: EdgeStripsMaskSpec, W: number, H: number): [number, number][][] {
  const out: [number, number][][] = [];
  const sides = spec.sides ?? 'both';
  const w = Math.max(0, Math.min(0.5, spec.width)) * W;
  const pad = Math.max(W, H) * 0.02;
  if (sides !== 'right')
    out.push([
      [-pad, -pad],
      [w, -pad],
      [w * 0.86, H + pad],
      [-pad, H + pad],
    ]);
  if (sides !== 'left')
    out.push([
      [W - w * 0.9, -pad],
      [W + pad, -pad],
      [W + pad, H + pad],
      [W - w, H + pad],
    ]);
  return out;
}

/** Paint a mask spec (white = visible) on a black-cleared context in doc px. */
export function paintOverlayMask(ctx: CanvasRenderingContext2D, spec: OverlayMaskSpec, W: number, H: number) {
  if (spec.kind === 'image') {
    const bytes = decodeMaskBytes(spec.data, spec.width * spec.height);
    if (!bytes) {
      ctx.fillStyle = '#ffffff'; // unreadable mask: show the overlay unmasked
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const small = createCanvas(spec.width, spec.height);
    const sctx = small.getContext('2d');
    if (!sctx) return;
    const img = sctx.createImageData(spec.width, spec.height);
    for (let i = 0, q = 0; i < bytes.length; i++, q += 4) {
      img.data[q] = img.data[q + 1] = img.data[q + 2] = bytes[i];
      img.data[q + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);
    return;
  }
  const amp = Math.max(0, spec.tear ?? 0.009) * Math.min(W, H);
  const step = Math.max(6, Math.min(W, H) * 0.013);
  ctx.fillStyle = '#ffffff';
  edgeStripPolygons(spec, W, H).forEach((poly, i) => tornPolygon(ctx, poly, amp, (spec.seed ?? 5) + i * 7, step));
}

/**
 * Render a mask spec into a new bitmap (resolution `scale` × doc size) and return the LayerMask.
 * Returns null when no canvas is available (tests) — callers then keep the layer unmasked.
 */
export function createOverlayMask(spec: OverlayMaskSpec, W: number, H: number, scale = 1): { mask: LayerMask; bitmapId: ID } | null {
  try {
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.scale(w / W, h / H);
    paintOverlayMask(ctx, spec, W, H);
    const bitmapId = bitmaps.add(c);
    if (spec.kind === 'image')
      return {
        bitmapId,
        mask: { bitmapId, enabled: true, density: spec.density ?? 1, feather: Math.max(0, (spec.featherRel ?? 0) * Math.max(W, H)), inverted: !!spec.inverted },
      };
    return { bitmapId, mask: { bitmapId, enabled: true, density: 1, feather: spec.feather ?? 0, inverted: false } };
  } catch {
    return null;
  }
}
