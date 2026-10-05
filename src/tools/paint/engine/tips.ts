/**
 * Brush tip stamps. Every stamp is a white canvas whose ALPHA is the tip shape; `tinted()` turns
 * it into a colored stamp once per stroke. All tips are cached (round tips per quantized
 * size/hardness, textured tips per size bucket, tints per tip+color) so strokes never
 * regenerate pixels per dab.
 */
import type { BrushPresetDef } from '../../../registry';
import { createCanvas, ctx2d, ctxRead } from '../../../core/canvas';
import { roundFalloff } from './math';

/** Small LRU cache. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private limit: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }
  /** Remove every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string) {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

const MAX_TIP_RES = 1024;

/** Resolution to render a round tip at for a given brush diameter (limits cache churn). */
export function roundTipResolution(size: number): number {
  const s = Math.max(2, Math.ceil(size));
  if (s <= 64) return s;
  if (s <= 256) return Math.min(MAX_TIP_RES, Math.ceil(s / 4) * 4);
  return Math.min(MAX_TIP_RES, Math.ceil(s / 16) * 16);
}

const roundCache = new Lru<HTMLCanvasElement>(48);

/** Round tip with radial hardness falloff (white, alpha = coverage). */
export function roundTip(size: number, hardness: number): HTMLCanvasElement {
  const n = roundTipResolution(size);
  const h = Math.round(Math.max(0, Math.min(1, hardness)) * 50) / 50;
  const key = `${n}|${h}`;
  const hit = roundCache.get(key);
  if (hit) return hit;
  const c = createCanvas(n, n);
  const ctx = ctxRead(c);
  const img = ctx.createImageData(n, n);
  const d = img.data;
  const r = n / 2;
  for (let y = 0; y < n; y++) {
    const dy = y + 0.5 - r;
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - r;
      const a = roundFalloff(Math.sqrt(dx * dx + dy * dy) / r, h, 1, r);
      const i = (y * n + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  roundCache.set(key, c);
  return c;
}

const pencilCache = new Lru<HTMLCanvasElement>(48);

/** Aliased (hard pixel) tip of an integer diameter. */
export function pencilTip(diameter: number, square = false): HTMLCanvasElement {
  const n = Math.max(1, Math.min(2000, Math.round(diameter)));
  const key = `${n}|${square ? 's' : 'r'}`;
  const hit = pencilCache.get(key);
  if (hit) return hit;
  const c = createCanvas(n, n);
  const ctx = ctxRead(c);
  if (square || n <= 2) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, n, n);
  } else {
    const img = ctx.createImageData(n, n);
    const d = img.data;
    const r = n / 2;
    const r2 = r * r;
    for (let y = 0; y < n; y++) {
      const dy = y + 0.5 - r;
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - r;
        if (dx * dx + dy * dy <= r2 + 0.25) {
          const i = (y * n + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  pencilCache.set(key, c);
  return c;
}

/** Size buckets for textured tips. */
const BUCKETS = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

export function textureBucket(size: number): number {
  for (const b of BUCKETS) if (b >= size) return b;
  return BUCKETS[BUCKETS.length - 1];
}

const textureCache = new Lru<HTMLCanvasElement>(64);

/**
 * Convert a grayscale tip (white = paint) into a white stamp with alpha. Works whether the
 * generator painted white-on-black (opaque) or white-on-transparent.
 */
export function grayToAlpha(src: HTMLCanvasElement, n: number): HTMLCanvasElement {
  const c = createCanvas(n, n);
  const ctx = ctxRead(c);
  ctx.drawImage(src, 0, 0, n, n);
  const img = ctx.getImageData(0, 0, n, n);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
    d[i + 3] = (lum * d[i + 3] + 127) / 255;
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Largest size a textured tip generator is asked for. Procedural noise tips take ~1 s at 1024
 * px; bigger buckets are upscaled from the 512 stamp instead (they upscale cleanly).
 */
export const MAX_GENERATED_TIP = 512;

/** Textured tip of a preset at (at least) `size` px, alpha stamp. */
export function textureTip(preset: BrushPresetDef, size: number): HTMLCanvasElement | null {
  if (!preset.tip) return null;
  const n = textureBucket(size);
  const key = `${preset.id}|${n}`;
  const hit = textureCache.get(key);
  if (hit) return hit;
  let out: HTMLCanvasElement;
  if (n > MAX_GENERATED_TIP) {
    const base = textureTip(preset, MAX_GENERATED_TIP)!;
    out = createCanvas(n, n);
    const ctx = ctx2d(out);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, n, n);
  } else {
    try {
      const raw = preset.tip(n);
      out = grayToAlpha(raw, n);
    } catch (err) {
      console.error(`[paint] tip generator for ${preset.id} failed`, err);
      out = roundTip(n, 1);
    }
  }
  textureCache.set(key, out);
  return out;
}

/** Drop the cached textured tips of one preset (e.g. after a user preset is deleted). */
export function forgetTexture(presetId: string) {
  textureCache.deletePrefix(`${presetId}|`);
}

/* ---------------- idle pre-warming ---------------- */

/** Latest requested bucket per preset id. */
const warmQueue = new Map<string, { preset: BrushPresetDef; size: number }>();
let warmTimer = 0;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

function whenIdle(cb: () => void) {
  const w = window as IdleWindow;
  if (w.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 1500 });
  else window.setTimeout(cb, 0);
}

function warmNext() {
  const next = warmQueue.entries().next();
  if (next.done) return;
  const [id, job] = next.value;
  warmQueue.delete(id);
  textureTip(job.preset, job.size);
  if (warmQueue.size) whenIdle(warmNext);
}

/**
 * Generate a textured tip ahead of time (when the browser is idle) so the first dab of a stroke
 * doesn't wait for it. Debounced, so scrubbing the size slider only warms the bucket it settles
 * on. Cheap no-op for round tips and already-cached buckets.
 */
export function prewarmTexture(preset: BrushPresetDef | undefined, size: number) {
  if (!preset?.tip) return;
  const n = textureBucket(size);
  if (textureCache.get(`${preset.id}|${n}`)) {
    warmQueue.delete(preset.id);
    return;
  }
  warmQueue.set(preset.id, { preset, size: n });
  window.clearTimeout(warmTimer);
  warmTimer = window.setTimeout(() => {
    warmTimer = 0;
    whenIdle(warmNext);
  }, 250);
}

const tintCache = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

/** Colored copy of a white alpha stamp (cached per tip + color). */
export function tinted(tip: HTMLCanvasElement, color: string): HTMLCanvasElement {
  let m = tintCache.get(tip);
  if (!m) {
    m = new Map();
    tintCache.set(tip, m);
  }
  const hit = m.get(color);
  if (hit) return hit;
  const c = createCanvas(tip.width, tip.height);
  const ctx = ctx2d(c);
  ctx.drawImage(tip, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  if (m.size > 6) m.delete(m.keys().next().value as string);
  m.set(color, c);
  return c;
}
