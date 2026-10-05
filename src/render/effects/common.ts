/**
 * Shared helpers for layer effects (layer styles).
 *
 * The compositor renders each layer into a SURFACE: a canvas covering the layer's padded region
 * in output pixels (document px × render scale). Effects receive that surface as `content`
 * (masked + smart-filtered layer pixels) and draw into a same-sized `target`. Extra region info
 * is passed through `EffectArgsExt` (optional, so effects also work on plain doc-sized canvases).
 */
import type { BlendMode, Gradient, ParamDef, ParamValues } from '../../core/types';
import type { EffectDef, EffectRenderArgs } from '../../registry';
import { ctx2d } from '../../core/canvas';
import { edgeDistance } from '../distance';
import { acquire, release, uniformSides, type Sides } from '../surface';

/** Integer rect relative to the effect canvases. */
export interface LocalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EffectRegion {
  /** Position of the canvases' top-left in output px (doc px × scale). */
  x: number;
  y: number;
  /**
   * Extent of everything the layer content can cover, relative to the canvases and clipped to
   * them: the raster bounds INCLUDING overflow beyond the layout box (text stroke, warp,
   * descenders, shape stroke, smart-filter growth). Pixel work (strokes, bevels, sweeps) must
   * cover this rect, never just the layout box.
   */
  bounds: LocalRect;
  /**
   * The layer's layout box (text box / shape box / bitmap rect) relative to the canvases, NOT
   * clipped. Only for paint geometry (gradient overlay, gradient-filled stroke).
   */
  paintBox: LocalRect;
}

export type DistanceMode = 'outside' | 'inside';

/**
 * Per-layer pixel data shared between effects (and cached across re-renders of the same layer
 * content by the compositor): the content alpha and distance fields to the content edge.
 */
export interface EffectFields {
  /** Alpha (0..255) of the content over a canvas-relative rect (zero outside the canvas). */
  alpha(r: LocalRect): Uint8Array;
  /**
   * Distance (px) from each pixel of a canvas-relative rect to the content edge, exact below
   * `maxDist` (larger values are clamped to ≥ maxDist). See distance.ts `edgeDistance`.
   */
  distance(mode: DistanceMode, maxDist: number, r: LocalRect): Float32Array;
}

export interface EffectArgsExt extends EffectRenderArgs {
  region?: EffectRegion;
  /** Emit an additional piece composited with its own operation (e.g. bevel highlight/shadow). */
  addPiece?: (canvas: HTMLCanvasElement, op: GlobalCompositeOperation) => void;
  /** Shared alpha / distance fields of the content (computed on demand when absent). */
  fields?: EffectFields;
}

export function regionOf(args: EffectRenderArgs): EffectRegion {
  const r = (args as EffectArgsExt).region;
  if (r) return r;
  const all = { x: 0, y: 0, w: args.content.width, h: args.content.height };
  return { x: 0, y: 0, bounds: all, paintBox: all };
}

/** Uncached fields straight from a canvas (effects used outside the compositor). */
export function directFields(content: HTMLCanvasElement): EffectFields {
  return {
    alpha: (r) => readAlpha(content, r),
    distance: (mode, maxDist, r) => edgeDistance(readAlpha(content, r), r.w, r.h, mode, maxDist),
  };
}

export function fieldsOf(args: EffectRenderArgs): EffectFields {
  return (args as EffectArgsExt).fields ?? directFields(args.content);
}

/* ---------------- placement metadata ---------------- */

export interface EffectMeta {
  /** Override of the def's stage depending on params (e.g. stroke position). */
  stage?(p: ParamValues): 'behind' | 'above';
  /** Whether an 'above' effect is clipped to the content alpha (default true). */
  clip?(p: ParamValues): boolean;
  /** How far (output px) the effect can reach beyond the content edges (any direction). */
  reach(p: ParamValues, scale: number): number;
  /**
   * Per-side reach (output px) for directional effects (shadows): the layer's padded region
   * only grows where the effect actually goes. Defaults to `reach` on every side.
   */
  extent?(p: ParamValues, scale: number): Sides;
  /**
   * The output depends on where the layer sits in the document (e.g. a pattern anchored to the
   * document origin). Such effects disable reusing a layer's render when the layer is moved.
   */
  docAnchored?: boolean;
  /**
   * Whether the compositor may keep this effect's output to reuse it while OTHER effects of the
   * layer are edited (default true). Cheap effects (plain fills) opt out to save memory.
   */
  cacheable?: boolean;
}

const metas = new Map<string, EffectMeta>();

export function defineEffect(def: EffectDef, meta: EffectMeta): EffectDef {
  metas.set(def.id, meta);
  return def;
}

export function effectMeta(id: string): EffectMeta | undefined {
  return metas.get(id);
}

/** Stage of an effect instance (param-dependent for stroke). */
export function effectStage(def: EffectDef, p: ParamValues): 'behind' | 'above' {
  return metas.get(def.id)?.stage?.(p) ?? def.stage;
}

/** Whether an effect's output only depends on the content (not on its document position). */
export function effectTranslationSafe(id: string): boolean {
  const m = metas.get(id);
  return !!m && !m.docAnchored;
}

/** Whether an effect's output is worth keeping for reuse (see EffectMeta.cacheable). */
export function effectCacheable(id: string): boolean {
  return metas.get(id)?.cacheable !== false;
}

/** Whether an 'above' effect is clipped to the content alpha. */
export function effectClips(def: EffectDef, p: ParamValues): boolean {
  return metas.get(def.id)?.clip?.(p) ?? true;
}

/** Reach in output px (generic fallback for third-party effects: size + distance params). */
export function effectReach(def: EffectDef, p: ParamValues, scale: number): number {
  const m = metas.get(def.id);
  if (m) return Math.max(0, m.reach(p, scale));
  return (num(p.size, 0) * 1.5 + num(p.distance, 0) + num(p.length, 0)) * scale;
}

/** Per-side reach in output px. */
export function effectExtent(def: EffectDef, p: ParamValues, scale: number): Sides {
  const m = metas.get(def.id);
  if (m?.extent) {
    const e = m.extent(p, scale);
    return { l: Math.max(0, e.l), t: Math.max(0, e.t), r: Math.max(0, e.r), b: Math.max(0, e.b) };
  }
  return uniformSides(effectReach(def, p, scale));
}

/** Sides reached by a blur of `blur` px around content shifted by (dx, dy). */
export function offsetSides(blur: number, dx: number, dy: number): Sides {
  const b = Math.max(0, blur);
  return { l: b + Math.max(0, -dx), t: b + Math.max(0, -dy), r: b + Math.max(0, dx), b: b + Math.max(0, dy) };
}

/* ---------------- params ---------------- */

export function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
export function str(v: unknown, d: string): string {
  return typeof v === 'string' && v ? v : d;
}
export function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d;
}
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function isGradient(v: unknown): v is Gradient {
  return !!v && typeof v === 'object' && Array.isArray((v as Gradient).stops);
}

const BLEND_LABELS: [BlendMode, string][] = [
  ['normal', 'Normal'],
  ['darken', 'Darken'],
  ['multiply', 'Multiply'],
  ['color-burn', 'Color Burn'],
  ['lighten', 'Lighten'],
  ['screen', 'Screen'],
  ['color-dodge', 'Color Dodge'],
  ['linear-dodge', 'Linear Dodge (Add)'],
  ['overlay', 'Overlay'],
  ['soft-light', 'Soft Light'],
  ['hard-light', 'Hard Light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

export const BLEND_OPTIONS = BLEND_LABELS.map(([value, label]) => ({ value, label }));

export const P = {
  color: (key: string, label: string, def: string): ParamDef => ({ key, label, type: 'color', default: def }),
  opacity: (def: number, key = 'opacity', label = 'Opacity'): ParamDef => ({
    key,
    label,
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: def,
    unit: '%',
    displayScale: 100,
  }),
  percent: (key: string, label: string, def: number): ParamDef => ({
    key,
    label,
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: def,
    unit: '%',
    displayScale: 100,
  }),
  px: (key: string, label: string, def: number, max = 250, min = 0): ParamDef => ({ key, label, type: 'number', min, max, step: 1, default: def, unit: 'px' }),
  angle: (def: number, key = 'angle', label = 'Angle'): ParamDef => ({ key, label, type: 'angle', default: def }),
  blend: (def: BlendMode, key = 'blendMode', label = 'Blend Mode'): ParamDef => ({ key, label, type: 'select', options: BLEND_OPTIONS, default: def }),
};

export const DEFAULT_GRADIENT: Gradient = {
  kind: 'linear',
  angle: 90,
  scale: 1,
  stops: [
    { offset: 0, color: '#000000' },
    { offset: 1, color: '#ffffff' },
  ],
};

/* ---------------- geometry ---------------- */

const DEG = Math.PI / 180;

/** Photoshop light-angle convention: an angle of 120° puts the light top-left, so offsets go
 * down-right. Returns the unit offset direction (y down). */
export function offsetDir(angleDeg: number): { x: number; y: number } {
  const a = angleDeg * DEG;
  return { x: -Math.cos(a), y: Math.sin(a) };
}

/** Gaussian sigma used for a Photoshop-like "size" (soft extent) in px. */
export function sizeSigma(sizePx: number): number {
  return Math.max(0, sizePx) / 2.5;
}

/* ---------------- canvas ops ---------------- */

/** Multiply the alpha (premultiplied) of a canvas by `factor` ≥ 1 using additive self-draws. */
export function boostAlpha(c: HTMLCanvasElement, factor: number) {
  if (!(factor > 1.001)) return;
  const ctx = ctx2d(c);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  let f = factor;
  let guard = 0;
  while (f >= 2 && guard++ < 10) {
    ctx.globalAlpha = 1;
    ctx.drawImage(c, 0, 0);
    f /= 2;
  }
  if (f > 1.001) {
    ctx.globalAlpha = Math.min(1, f - 1);
    ctx.drawImage(c, 0, 0);
  }
  ctx.restore();
}

/** Replace a canvas' colors with `color` keeping its alpha. */
export function colorize(c: HTMLCanvasElement, color: string) {
  const ctx = ctx2d(c);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
}

/** Draw `src` into a fresh scratch canvas blurred by `sigma` and offset by (dx, dy). */
export function blurredCopy(src: HTMLCanvasElement, sigma: number, dx = 0, dy = 0): HTMLCanvasElement {
  const out = acquire(src.width, src.height);
  const ctx = ctx2d(out);
  if (sigma > 0.05) ctx.filter = `blur(${sigma.toFixed(3)}px)`;
  ctx.drawImage(src, dx, dy);
  ctx.filter = 'none';
  return out;
}

/**
 * Soft dilation of a matte by `r` px (blur + alpha boost): used for spread/choke. Edges stay
 * smooth; corners are rounded (like Photoshop's spread before blurring).
 */
export function softDilate(src: HTMLCanvasElement, r: number, dx = 0, dy = 0): HTMLCanvasElement {
  if (r < 0.25) {
    const out = acquire(src.width, src.height);
    ctx2d(out).drawImage(src, dx, dy);
    return out;
  }
  // With boost F, the 50% level of a blurred edge moves out by σ·Φ⁻¹(1 − 0.5/F).
  const F = 12; // Φ⁻¹(1 − 1/24) ≈ 1.73
  const sigma = r / 1.73;
  const out = blurredCopy(src, sigma, dx, dy);
  boostAlpha(out, F);
  return out;
}

/** Inverse matte: opaque everywhere except where `src` (drawn at dx,dy) covers. */
export function inverseMatte(src: HTMLCanvasElement, dx = 0, dy = 0): HTMLCanvasElement {
  const out = acquire(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(src, dx, dy);
  ctx.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Draw `src` blurred by `sigma` (offset by dx, dy) straight into an effect target. Effect
 * targets are always handed out empty, so effects can build their result in place.
 */
export function drawBlurred(target: CanvasRenderingContext2D, src: HTMLCanvasElement, sigma: number, dx = 0, dy = 0) {
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
  if (sigma > 0.05) target.filter = `blur(${sigma.toFixed(3)}px)`;
  target.drawImage(src, dx, dy);
  target.restore();
}

/** Recolor everything drawn in the target with `color` at `opacity` (coverage is kept). */
export function tint(target: CanvasRenderingContext2D, color: string, opacity: number) {
  const c = target.canvas;
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = 'source-in';
  target.globalAlpha = clamp01(opacity);
  target.fillStyle = color;
  target.fillRect(0, 0, c.width, c.height);
  target.restore();
}

/** Draw a finished scratch canvas into the effect target with an opacity, then release it. */
export function finish(target: CanvasRenderingContext2D, c: HTMLCanvasElement, opacity: number) {
  if (opacity > 0) {
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = clamp01(opacity);
    target.globalCompositeOperation = 'source-over';
    target.drawImage(c, 0, 0);
    target.restore();
  }
  release(c);
}

/** Read the alpha channel of a sub-rect of a canvas. */
export function readAlpha(c: HTMLCanvasElement, r: LocalRect): Uint8Array {
  const img = ctx2d(c).getImageData(r.x, r.y, r.w, r.h).data;
  const n = r.w * r.h;
  const a = new Uint8Array(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) a[i] = img[j];
  return a;
}

/** Content bounds expanded by d and clipped to the canvas. */
export function workRect(args: EffectRenderArgs, d: number): LocalRect | null {
  const b = regionOf(args).bounds;
  const W = args.content.width;
  const H = args.content.height;
  const k = Math.ceil(Math.max(0, d)) + 2;
  const x = Math.max(0, b.x - k);
  const y = Math.max(0, b.y - k);
  const r = Math.min(W, b.x + b.w + k);
  const bt = Math.min(H, b.y + b.h + k);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

/** Parse a CSS hex color to [r, g, b]. */
export function rgbOf(color: string): [number, number, number] {
  let s = (color || '#000000').trim();
  if (s[0] === '#') {
    s = s.slice(1);
    if (s.length === 3 || s.length === 4) s = s.split('').map((ch) => ch + ch).join('');
    const n = parseInt(s.slice(0, 6), 16);
    if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  return [0, 0, 0];
}

/** Alpha component of a color string (#rrggbbaa / rgba()), 1 when absent. */
export function alphaOfColor(color: string): number {
  const s = (color || '').trim();
  if (s[0] === '#' && (s.length === 9 || s.length === 5)) {
    const hex = s.length === 5 ? s[4] + s[4] : s.slice(7, 9);
    const v = parseInt(hex, 16);
    return Number.isFinite(v) ? v / 255 : 1;
  }
  const m = s.match(/rgba\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).map(Number);
    return p.length > 3 && Number.isFinite(p[3]) ? clamp01(p[3]) : 1;
  }
  return 1;
}
