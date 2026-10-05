/**
 * Compositing engine.
 *
 * Every layer renders into a LayerRender: canvases positioned in OUTPUT pixel space (document
 * px × render scale), cropped to the layer's padded region:
 *   - `shape`: the layer content with smart filters and mask applied, full alpha (used for
 *     clipping masks, above-effect clipping and hit testing),
 *   - `core`: content at fill opacity + above-stage effects (clipped to the content alpha),
 *   - `behind`: behind-stage effects, each composited with its own blend mode.
 * The accumulator then draws behind pieces and the core with the layer opacity/blend mode.
 *
 * Regions: the padded region grows per side by the layer effects' reach (a shadow only grows it
 * in its own direction) and is clipped to the part of the document those effects can affect.
 * Effects receive the full raster extent of the content (`bounds`, including text stroke/warp/
 * descender and smart-filter overflow) and the layout box separately (`paintBox`).
 *
 * Caching: LayerRenders live in per-layer slots keyed by a signature (object identity of the
 * layer + bitmap/mask versions + descendants for groups + scale/doc size), so during a live
 * preview only the changed layer re-renders. Within a re-render:
 *   - a moved layer reuses its previous render shifted by whole pixels (translation reuse),
 *   - an effect-only edit reuses the previous masked/filtered content (content reuse) and the
 *     distance fields computed from it (strokes/bevels only re-map coverage).
 * The document composite and the accumulator right after each top-level adjustment layer are
 * cached too (editing above an adjustment does not re-run its filter). Every cached canvas and
 * field is counted once against the slot budget, however many entries share it.
 */
import type { AdjustmentLayer, Document, FilterInstance, GroupLayer, ID, Layer, LayerMask, Paint, Rect, TextProps } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { ctx2d } from '../core/canvas';
import { transformMatrix } from '../core/geometry';
import { effects, filters, type EffectDef } from '../registry';
import { applyFilterStack, compositeOp, makeFilterContext, resolveParams, runFilter } from '../filters/engine';
import { cacheGeneration, objId, slots, type Resource } from './cache';
import { edgeDistance } from './distance';
import { applyMask, lerpInto, maskAlpha } from './mask';
import { fillWithPaint } from './paint';
import { renderShapeContent, shapeLocalBounds } from './shapes';
import { layoutTextProps, renderTextContent, textCacheEpoch, textFontReady, textLocalBounds, type LocalContent } from './text';
import {
  MAX_SIDE,
  NO_SIDES,
  acquire,
  addSides,
  containsRect,
  coverRect,
  expandRect,
  expandSides,
  flipSides,
  fresh,
  intersectRect,
  maxSide,
  maxSides,
  release,
  sameRect,
  unionRect,
  type PxRect,
  type Sides,
} from './surface';
import {
  effectCacheable,
  effectClips,
  effectExtent,
  effectStage,
  effectTranslationSafe,
  type DistanceMode,
  type EffectArgsExt,
  type EffectFields,
  type LocalRect,
} from './effects';

/* ================================================================== */
/* Types                                                               */
/* ================================================================== */

export interface RenderFlags {
  effects: boolean;
  mask: boolean;
  filters: boolean;
}

export const FULL_FLAGS: RenderFlags = { effects: true, mask: true, filters: true };

export interface BehindPiece {
  canvas: HTMLCanvasElement;
  op: GlobalCompositeOperation;
}

/** A distance field of a layer's content (absolute output px). */
export interface FieldEntry {
  mode: DistanceMode;
  /** Distances are exact below this value. */
  maxDist: number;
  /** Area covered by `data`. */
  rect: PxRect;
  /** Content area the field was computed from (alpha outside it was taken as 0). */
  src: PxRect;
  data: Float32Array;
}

/** Translation reuse info: the unshifted render a moved layer's render is derived from. */
interface MoveInfo {
  sig: string;
  base: LayerRender;
  /** Raw output-px translation of the layer when `base` was built. */
  e: number;
  f: number;
  /** Unclipped padded region of the base (content raster bounds grown by effects/filters). */
  full: PxRect;
  /** Document clip growth: regions are clipped to expandSides(doc, clip). */
  clip: Sides;
}

export interface LayerRender {
  /** Canvas placement in output px. */
  region: PxRect;
  /** Content at fill opacity + above effects. */
  core: HTMLCanvasElement | null;
  /** Masked + filtered content at full alpha. */
  shape: HTMLCanvasElement | null;
  behind: BehindPiece[];
  /** Layer layout box in output px, unclipped. */
  bounds: PxRect;
  /** @internal Signature of `shape` (content + transform + filters + mask), see contentSig. */
  csig?: string;
  /** @internal Raster extent of the content (output px, unclipped). */
  extent?: PxRect;
  /** @internal Distance fields of `shape`, reusable by renders with the same csig. */
  fields?: FieldEntry[];
  /**
   * @internal Opaque bounds of the content (output px; null = empty), when known and not cut by
   * the region: the true content extent, tighter than `extent` (text padding, empty bitmap areas).
   */
  tight?: PxRect | null;
  /** @internal Outputs of cacheable effects, reusable by renders with the same csig. */
  fx?: FxEntry[];
  /** @internal Translation reuse. */
  move?: MoveInfo;
}

/** A cached effect output: its pieces in composite order (behind pieces, or above pieces). */
interface FxEntry {
  key: string;
  region: PxRect;
  pieces: BehindPiece[];
}

/** Per-call render context. */
export interface RC {
  doc: Document;
  /** Render scale (output px per doc px). */
  s: number;
  /** Output size. */
  W: number;
  H: number;
  hidden: Set<ID> | null;
  below: ID | null;
  stopped: boolean;
  sigMemo: Map<Layer, string>;
}

interface Acc {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Canvas origin in output px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Union of drawn areas (output px). */
  bounds: PxRect | null;
  root: boolean;
  /** Incremental render: only this rect (output px) is recomposited (ctx is clipped to it). */
  clip: PxRect | null;
}

/** Canvases referenced by renders but owned elsewhere (bitmap store): not counted in budgets. */
const borrowed = new WeakSet<HTMLCanvasElement>();

/** Simple counters for profiling (window.__app tests read them). */
export const renderStats = {
  layerRenders: 0,
  layerHits: 0,
  translateHits: 0,
  contentReuse: 0,
  fxReuse: 0,
  fieldHits: 0,
  fieldComputes: 0,
  docRenders: 0,
  docHits: 0,
  adjustments: 0,
  snapshotHits: 0,
};

/* ================================================================== */
/* Context & signatures                                                */
/* ================================================================== */

export function outputSize(doc: Document, scale: number): { W: number; H: number; s: number } {
  let s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const maxSide = Math.max(doc.width, doc.height) * s;
  if (maxSide > MAX_SIDE) s *= MAX_SIDE / maxSide;
  return { W: Math.max(1, Math.round(doc.width * s)), H: Math.max(1, Math.round(doc.height * s)), s };
}

export function makeRC(doc: Document, scale = 1, hidden?: Set<ID> | null, below?: ID | null): RC {
  const { W, H, s } = outputSize(doc, scale);
  return { doc, s, W, H, hidden: hidden && hidden.size ? hidden : null, below: below ?? null, stopped: false, sigMemo: new Map() };
}

export function isShown(rc: RC, l: Layer): boolean {
  return l.visible && !rc.hidden?.has(l.id);
}

export function containsId(doc: Document, g: GroupLayer, id: ID): boolean {
  for (const c of g.childIds) {
    if (c === id) return true;
    const l = doc.layers[c];
    if (l?.type === 'group' && containsId(doc, l, id)) return true;
  }
  return false;
}

/** Text-state fragment of signatures: font generation, text epoch, face readiness. */
function textStateSig(t: TextProps): string {
  return `g${cacheGeneration()}e${textCacheEpoch()}${textFontReady(t) ? 'r' : 'p'}`;
}

/** Signature of a layer's render (content, effects, mask; descendants for groups). */
export function layerSig(rc: RC, l: Layer): string {
  const memo = rc.sigMemo.get(l);
  if (memo !== undefined) return memo;
  let s = String(objId(l));
  if (l.type === 'raster') s += `.${bitmaps.version(l.bitmapId)}`;
  if (l.mask) s += `m${bitmaps.version(l.mask.bitmapId)}`;
  // Text re-renders when fonts finish loading (generation bump), when a font slice loads (text
  // epoch) or when its own face becomes ready (covers documents that are not open).
  if (l.type === 'text') s += textStateSig(l.text);
  if (l.type === 'group') s += `[${listSig(rc, l.childIds, { stopped: false })}]`;
  rc.sigMemo.set(l, s);
  return s;
}

/** Signature of a layer list as rendered (hidden layers / the `below` stop included). */
export function listSig(rc: RC, ids: ID[], st: { stopped: boolean }): string {
  let out = '';
  for (const id of ids) {
    if (st.stopped) break;
    if (id === rc.below) {
      st.stopped = true;
      out += 'B';
      break;
    }
    const l = rc.doc.layers[id];
    if (!l) continue;
    if (!isShown(rc, l)) {
      if (l.type === 'group' && rc.below && containsId(rc.doc, l, rc.below)) {
        st.stopped = true;
        out += 'B';
        break;
      }
      out += 'h,';
      continue;
    }
    out += layerSig(rc, l) + ',';
    if (l.type === 'group' && rc.below && containsId(rc.doc, l, rc.below)) {
      st.stopped = true;
      break;
    }
  }
  return out;
}

/**
 * Signature of a layer's masked + filtered content canvas (`shape`): everything it depends on
 * EXCEPT effects, opacity, fill opacity and blend mode. Renders with equal content signatures
 * share content pixels and distance fields (an effect-only edit never re-draws the content,
 * re-runs smart filters or re-applies the mask).
 */
function contentSig(rc: RC, l: Layer, flags: RenderFlags): string {
  let s: string;
  switch (l.type) {
    case 'raster':
      s = `r${l.bitmapId}.${bitmaps.version(l.bitmapId)}.${l.width}x${l.height}|t${objId(l.transform)}`;
      break;
    case 'text':
      s = `t${objId(l.text)}${textStateSig(l.text)}|t${objId(l.transform)}`;
      break;
    case 'shape':
      s = `s${objId(l.shape)}|t${objId(l.transform)}`;
      break;
    case 'fill':
      s = `f${objId(l.fill)}`;
      break;
    case 'group':
      s = `g[${listSig(rc, l.childIds, { stopped: false })}]`;
      break;
    default:
      s = `x${objId(l)}`;
  }
  if (flags.filters && hasFilters(l.filters)) s += `|f${objId(l.filters)}`;
  if (flags.mask && l.mask?.enabled) s += `|m${objId(l.mask)}.${bitmaps.version(l.mask.bitmapId)}`;
  return `${s}|${rc.W}x${rc.H}|${rc.s}`;
}

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

function activeEffects(l: Layer): { def: EffectDef; params: ReturnType<typeof resolveParams>; idx: number }[] {
  const out: { def: EffectDef; params: ReturnType<typeof resolveParams>; idx: number }[] = [];
  l.effects?.forEach((e, idx) => {
    if (!e.enabled) return;
    const def = effects.get(e.effectId);
    if (!def) return;
    out.push({ def, params: resolveParams(def, e.params), idx });
  });
  return out;
}

function hasFilters(list: FilterInstance[] | undefined): boolean {
  return !!list?.some((f) => f.enabled && filters.has(f.filterId));
}

const PAD_KEY = /radius|size|distance|length|blur|spread|thickness|width|offset|strength|amount/i;

/** Heuristic growth (output px) of non-adjustment smart filters (blur radius, distortion…). */
export function filterPad(list: FilterInstance[] | undefined, s: number): number {
  if (!list) return 0;
  let pad = 0;
  for (const f of list) {
    if (!f.enabled) continue;
    const def = filters.get(f.filterId);
    if (!def || def.adjustment) continue;
    const p = resolveParams(def, f.params);
    let m = 0;
    for (const k in p) {
      const v = p[k];
      if (typeof v === 'number' && PAD_KEY.test(k)) m = Math.max(m, Math.abs(v));
    }
    if (def.category === 'Distort') m = Math.max(m, 40);
    pad += Math.min(300, m * 1.5);
  }
  return pad > 0 ? Math.ceil(pad * s) + 2 : 0;
}

/** Per-side reach (output px) of a layer's enabled effects. */
export function effectsSidesOf(l: Layer, s: number): Sides {
  let r: Sides = NO_SIDES;
  for (const e of activeEffects(l)) r = maxSides(r, effectExtent(e.def, e.params, s));
  return { l: Math.ceil(r.l), t: Math.ceil(r.t), r: Math.ceil(r.r), b: Math.ceil(r.b) };
}

/** Max effect reach over all sides (output px). */
export function effectsReachOf(l: Layer, s: number): number {
  return maxSide(effectsSidesOf(l, s));
}

function isPassThroughSimple(g: GroupLayer): boolean {
  return g.blendMode === 'pass-through' && activeEffects(g).length === 0 && !hasFilters(g.filters);
}

const warned = new Set<string>();
function warnOnce(key: string, err: unknown) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[render] ${key}`, err);
}

/** Local content raster choice: pixel-aligned when the mapping is an axis-aligned uniform scale. */
function localRasterParams(m: DOMMatrix): { k: number; fx: number; fy: number } {
  const axis = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && m.a > 0 && m.d > 0 && Math.abs(m.a - m.d) <= 1e-6 * m.a;
  if (axis) {
    const q = (v: number) => {
      const f = v - Math.floor(v);
      const r = Math.round(f * 64) / 64;
      return r >= 1 ? 0 : r;
    };
    return { k: m.a, fx: q(m.e), fy: q(m.f) };
  }
  return { k: Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d), 1e-3), fx: 0, fy: 0 };
}

/** Draw a local raster through `m` (output px) into ctx whose origin sits at (ox, oy). */
function drawLocal(ctx: CanvasRenderingContext2D, lc: LocalContent, m: DOMMatrix, ox: number, oy: number) {
  const t = new DOMMatrix([m.a, m.b, m.c, m.d, m.e - ox, m.f - oy]).translateSelf(lc.ox, lc.oy).scaleSelf(1 / lc.k, 1 / lc.k);
  const ex = Math.round(t.e);
  const ey = Math.round(t.f);
  if (Math.abs(t.a - 1) < 1e-6 && Math.abs(t.d - 1) < 1e-6 && Math.abs(t.b) < 1e-9 && Math.abs(t.c) < 1e-9 && Math.abs(t.e - ex) < 0.02 && Math.abs(t.f - ey) < 0.02) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lc.canvas, ex, ey);
    return;
  }
  ctx.setTransform(t);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lc.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function boundsOfMatrixRect(m: DOMMatrix, r: Rect): { x: number; y: number; w: number; h: number } {
  const pts = [
    m.transformPoint({ x: r.x, y: r.y }),
    m.transformPoint({ x: r.x + r.width, y: r.y }),
    m.transformPoint({ x: r.x + r.width, y: r.y + r.height }),
    m.transformPoint({ x: r.x, y: r.y + r.height }),
  ];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Last TextProps rendered per text layer (invalidateRenderCache(id) drops its layout too). */
const layerTexts = new Map<ID, TextProps>();

/** The text style a layer was last rendered/measured with (null when unknown). */
export function lastLayerText(id: ID): TextProps | null {
  return layerTexts.get(id) ?? null;
}

/** Forget per-layer bookkeeping (the layer was deleted / its document closed). */
export function forgetLayer(id: ID) {
  layerTexts.delete(id);
}

/** Output-px matrix of a transformable layer (local box → output px) and its local raster bounds. */
export function layerGeometry(l: Layer, s: number): { m: DOMMatrix; local: Rect; box: Rect } | null {
  if (l.type === 'raster') {
    const m = new DOMMatrix().scaleSelf(s, s).multiplySelf(transformMatrix(l.transform, l.width, l.height));
    const box = { x: 0, y: 0, width: l.width, height: l.height };
    return { m, local: box, box };
  }
  if (l.type === 'text') {
    if (layerTexts.get(l.id) !== l.text) {
      if (layerTexts.size > 4096) layerTexts.clear();
      layerTexts.set(l.id, l.text);
    }
    const layout = layoutTextProps(l.text);
    const m = new DOMMatrix().scaleSelf(s, s).multiplySelf(transformMatrix(l.transform, layout.width, layout.height));
    return { m, local: textLocalBounds(l.text), box: { x: 0, y: 0, width: layout.width, height: layout.height } };
  }
  if (l.type === 'shape') {
    const w = Math.max(1, Number(l.shape.width) || 1);
    const h = Math.max(1, Number(l.shape.height) || 1);
    const m = new DOMMatrix().scaleSelf(s, s).multiplySelf(transformMatrix(l.transform, w, h));
    return { m, local: shapeLocalBounds(l.shape), box: { x: 0, y: 0, width: w, height: h } };
  }
  return null;
}

/* ================================================================== */
/* Distance fields shared by effects                                   */
/* ================================================================== */

/**
 * Fields are computed ~25% deeper (at least 2 px; and that much wider) than asked: dragging a
 * stroke/bevel size up reuses them for a while instead of recomputing the distance transform
 * every frame, while small strokes stay cheap (the transform's cost grows with the depth).
 */
export function fieldBucket(maxDist: number): number {
  return Math.ceil(maxDist + Math.max(2, maxDist * 0.25));
}

function subArray<T extends Float32Array | Uint8Array>(src: T, sr: PxRect, r: PxRect, make: (n: number) => T): T {
  const out = make(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    const so = (r.y - sr.y + y) * sr.w + (r.x - sr.x);
    out.set(src.subarray(so, so + r.w), y * r.w);
  }
  return out;
}

/** Alpha of a canvas over a rect that may extend past its edges (zero there). */
function readAlphaPadded(c: HTMLCanvasElement, r: LocalRect): Uint8Array {
  const out = new Uint8Array(r.w * r.h);
  const i = intersectRect(r, { x: 0, y: 0, w: c.width, h: c.height });
  if (!i) return out;
  const d = ctx2d(c).getImageData(i.x, i.y, i.w, i.h).data;
  for (let y = 0; y < i.h; y++) {
    let o = (i.y - r.y + y) * r.w + (i.x - r.x);
    for (let x = 0, j = y * i.w * 4 + 3; x < i.w; x++, j += 4) out[o++] = d[j];
  }
  return out;
}

/** Bounding box (local to the map) of non-zero alpha, or null. */
function alphaBBox(a: Uint8Array, w: number, h: number): PxRect | null {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    for (let x = 0; x < w; x++) {
      if (a[row + x]) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = w - 1; x > first; x--) {
      if (a[row + x]) {
        last = x;
        break;
      }
    }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Opaque content bounds from an alpha read of `r` (local) — only when the region holds ALL the
 * content (not clipped: a clipped region may miss content beyond its edges, even disconnected
 * content) and `r` covers it. Undefined when unknown, null when the content is empty.
 */
function tightFromRead(region: PxRect, extent: PxRect, r: LocalRect, data: Uint8Array): PxRect | null | undefined {
  if (!containsRect(region, extent)) return undefined;
  const local = { x: extent.x - region.x, y: extent.y - region.y, w: extent.w, h: extent.h };
  if (!containsRect(r, local)) return undefined;
  const bb = alphaBBox(data, r.w, r.h);
  return bb ? { x: bb.x + r.x + region.x, y: bb.y + r.y + region.y, w: bb.w, h: bb.h } : null;
}

/** EffectFields of one layer render: alpha reads and distance fields, cached and shared. */
class LayerFields implements EffectFields {
  /** Fields used or computed by this render (carried by the LayerRender for later reuse). */
  readonly entries: FieldEntry[] = [];
  private reads: { rect: LocalRect; data: Uint8Array }[] = [];

  constructor(
    private readonly C: HTMLCanvasElement,
    private readonly region: PxRect,
    private readonly extent: PxRect,
    private readonly inherited: FieldEntry[],
    /** Opaque content bounds (undefined = unknown). */
    public tight: PxRect | null | undefined,
  ) {}

  alpha(r: LocalRect): Uint8Array {
    for (const rd of this.reads) {
      if (sameRect(rd.rect, r)) return rd.data;
      if (containsRect(rd.rect, r)) return subArray(rd.data, rd.rect, r, (n) => new Uint8Array(n));
    }
    const data = readAlphaPadded(this.C, r);
    this.reads.push({ rect: { ...r }, data });
    if (this.reads.length > 4) this.reads.shift();
    if (this.tight === undefined) this.tight = tightFromRead(this.region, this.extent, r, data);
    return data;
  }

  distance(mode: DistanceMode, maxDist: number, r: LocalRect): Float32Array {
    const reg = this.region;
    const abs: PxRect = { x: r.x + reg.x, y: r.y + reg.y, w: r.w, h: r.h };
    // The field at a pixel depends on the content within maxDist of it: that part of the
    // content must have been present when the field was computed.
    const content = this.tight === undefined ? this.extent : this.tight;
    const needSrc = content ? intersectRect(expandRect(abs, maxDist + 2), content) : null;
    const ok = (e: FieldEntry) => e.mode === mode && e.maxDist >= maxDist && containsRect(e.rect, abs) && (!needSrc || containsRect(e.src, needSrc));
    let e = this.entries.find(ok);
    if (!e) {
      e = this.inherited.find(ok);
      if (e) this.entries.push(e);
    }
    if (e) renderStats.fieldHits++;
    else {
      renderStats.fieldComputes++;
      // A shallower field of the same content exists: a size is being dragged up — compute
      // with more headroom so the drag recomputes only every ~60% of growth.
      const growing = this.inherited.some((f) => f.mode === mode && f.maxDist < maxDist);
      const B = growing ? Math.max(fieldBucket(maxDist), Math.ceil(maxDist * 1.6 + 2)) : fieldBucket(maxDist);
      const rect = expandRect(abs, B - maxDist);
      const a = this.alpha({ x: rect.x - reg.x, y: rect.y - reg.y, w: rect.w, h: rect.h });
      e = { mode, maxDist: B, rect, src: { ...reg }, data: edgeDistance(a, rect.w, rect.h, mode, B) };
      this.entries.push(e);
    }
    return sameRect(e.rect, abs) ? e.data : subArray(e.data, e.rect, abs, (n) => new Float32Array(n));
  }
}

/* ================================================================== */
/* Layer render                                                        */
/* ================================================================== */

function flagsKey(f: RenderFlags): string {
  return `${f.effects ? 'e' : ''}${f.mask ? 'm' : ''}${f.filters ? 'f' : ''}`;
}

/* ---------------- translation reuse ---------------- */

/** Whether a translation delta (output px) is a whole number of pixels. */
const wholePx = (d: number) => Math.abs(d - Math.round(d)) < 1e-6;

/**
 * Signature of everything a transformable layer's render depends on EXCEPT its integer
 * position (content identity, effects, rotation/scale/skew, fill/knockout, sub-pixel phase).
 * Null when the render depends on the document position (masks, smart filters, doc-anchored
 * effects) — then a moved layer is rendered from scratch.
 */
function translationSig(l: Layer, flags: RenderFlags, m: DOMMatrix): string | null {
  if (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape') return null;
  if (flags.mask && l.mask?.enabled) return null;
  if (flags.filters && hasFilters(l.filters)) return null;
  if (flags.effects && l.effects?.some((e) => e.enabled && !effectTranslationSafe(e.effectId))) return null;
  const t = l.transform;
  const content =
    l.type === 'raster'
      ? `r${l.bitmapId}.${bitmaps.version(l.bitmapId)}.${l.width}x${l.height}`
      : l.type === 'text'
        ? `t${objId(l.text)}${textStateSig(l.text)}`
        : `s${objId(l.shape)}`;
  const fill = Number.isFinite(l.fillOpacity) ? l.fillOpacity : 1;
  const knock = fill * Math.max(0, Math.min(1, l.opacity)) < 0.999 ? 1 : 0;
  // The sub-pixel phase is NOT part of the signature: the lookup requires an exact whole-pixel
  // delta from the base render (see renderLayer), so a shifted render equals a fresh one.
  return `${content}|e${flags.effects ? objId(l.effects) : 0}|${m.a},${m.b},${m.c},${m.d}|${t.rotation}|${t.scaleX}|${t.scaleY}|${t.skewX ?? 0}|${fill}|${knock}`;
}

const shiftRect = (r: PxRect, dx: number, dy: number): PxRect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });

/** A render moved by whole output pixels (canvases and fields shared, positions shifted). */
function shiftRender(r: LayerRender, dx: number, dy: number, csig: string | undefined): LayerRender {
  return {
    region: shiftRect(r.region, dx, dy),
    core: r.core,
    shape: r.shape,
    behind: r.behind,
    bounds: shiftRect(r.bounds, dx, dy),
    csig,
    extent: r.extent && shiftRect(r.extent, dx, dy),
    fields: r.fields?.map((f) => ({ ...f, rect: shiftRect(f.rect, dx, dy), src: shiftRect(f.src, dx, dy) })),
    tight: r.tight && shiftRect(r.tight, dx, dy),
    fx: r.fx?.map((f) => ({ ...f, region: shiftRect(f.region, dx, dy) })),
  };
}

/** Resources of a render counted against the cache budget (borrowed bitmaps excluded). */
function renderResources(r: LayerRender | null): Resource[] {
  if (!r) return [];
  const out: Resource[] = [];
  for (const c of [r.core, r.shape, ...r.behind.map((b) => b.canvas)]) if (c && !borrowed.has(c)) out.push(c);
  if (r.fields) for (const f of r.fields) out.push(f.data);
  if (r.fx) for (const f of r.fx) for (const pc of f.pieces) out.push(pc.canvas);
  return out;
}

/** Render (or fetch from cache) a non-adjustment layer. Null when it draws nothing. */
export function renderLayer(rc: RC, l: Layer, flags: RenderFlags = FULL_FLAGS): LayerRender | null {
  if (l.type === 'adjustment') return null;
  const fk = flagsKey(flags);
  const key = `L|${l.id}|${rc.s.toFixed(5)}|${fk}`;
  const sig = `${layerSig(rc, l)}|${rc.W}x${rc.H}`;
  const hit = slots.get<LayerRender | null>(key, sig);
  if (hit !== undefined) {
    renderStats.layerHits++;
    return hit;
  }
  const prevs = slots.values<LayerRender | null>(key);
  // A moved layer (same content, whole-pixel delta) reuses its previous render, shifted:
  // dragging a layer with strokes/shadows never recomputes its effects.
  const geom = layerGeometry(l, rc.s);
  const tsig = geom ? translationSig(l, flags, geom.m) : null;
  const tfull = tsig ? `${tsig}|${rc.W}x${rc.H}` : '';
  if (tsig && geom) {
    for (const p of prevs) {
      const mv = p?.move;
      if (!mv || mv.sig !== tfull) continue;
      // Shift relative to the unshifted base by an exact whole-pixel delta (same sub-pixel
      // phase): the shifted render is identical to a fresh render at the new position.
      const ddx = geom.m.e - mv.e;
      const ddy = geom.m.f - mv.f;
      if (!wholePx(ddx) || !wholePx(ddy)) continue;
      const dx = Math.round(ddx);
      const dy = Math.round(ddy);
      // Valid when everything a fresh render would hold at the new position (its clipped
      // region) is inside the shifted base: pixels the base lacked (clipped away near the
      // document edge) must not move into view.
      const need = intersectRect(shiftRect(mv.full, dx, dy), expandSides({ x: 0, y: 0, w: rc.W, h: rc.H }, mv.clip));
      if (!need || !containsRect(shiftRect(mv.base.region, dx, dy), need)) continue;
      const moved = shiftRender(mv.base, dx, dy, contentSig(rc, l, flags));
      moved.move = mv;
      renderStats.translateHits++;
      slots.set(key, sig, moved, 0, { layerId: l.id, max: 2, res: renderResources(moved) });
      return moved;
    }
  }
  renderStats.layerRenders++;
  let r: LayerRender | null = null;
  try {
    r = buildLayerRender(rc, l, flags, prevs);
  } catch (err) {
    warnOnce(`layer ${l.id} (${l.type}) failed to render`, err);
    r = null;
  }
  if (r && tsig && geom && !(r.core && borrowed.has(r.core))) {
    // Renders whose region is exactly the document-clipped padded region can be shifted
    // (not those cut further by the canvas size limit).
    const grow = addSides(flags.effects ? effectsSidesOf(l, rc.s) : NO_SIDES, flags.filters ? filterPad(l.filters, rc.s) : 0);
    const b = boundsOfMatrixRect(geom.m, geom.local);
    const full = expandSides(coverRect(b.x, b.y, b.w, b.h), grow);
    const clip = flipSides(grow);
    const expected = intersectRect(full, expandSides({ x: 0, y: 0, w: rc.W, h: rc.H }, clip));
    if (expected && sameRect(expected, r.region)) r.move = { sig: tfull, base: r, e: geom.m.e, f: geom.m.f, full, clip };
  }
  slots.set(key, sig, r, 0, { layerId: l.id, max: 2, res: renderResources(r) });
  return r;
}

/** Union of the regions children of a group can draw into (output px). */
function groupExtent(rc: RC, g: GroupLayer): PxRect | null {
  const saved = rc.stopped;
  let r: PxRect | null = null;
  for (const id of g.childIds) {
    if (id === rc.below) break;
    const c = rc.doc.layers[id];
    if (!c || !isShown(rc, c) || c.type === 'adjustment') continue;
    if (c.type === 'group' && isPassThroughSimple(c)) r = unionRect(r, groupExtent(rc, c));
    else {
      const lr = renderLayer(rc, c);
      if (lr) r = unionRect(r, lr.region);
    }
    if (c.type === 'group' && rc.below && containsId(rc.doc, c, rc.below)) break;
  }
  rc.stopped = saved;
  return r;
}

interface Reuse {
  C: HTMLCanvasElement | null;
  fields: FieldEntry[];
  fx: FxEntry[];
  /** Opaque content bounds known from the previous render (undefined = unknown). */
  tight: PxRect | null | undefined;
}

/** Previous content canvas with the same content signature, adapted to `region` (or null). */
function reuseContent(prevs: (LayerRender | null)[], csig: string, region: PxRect, extent: PxRect, fpad: number): Reuse {
  for (const p of prevs) {
    if (!p || p.csig !== csig) continue;
    const fields = p.fields ?? [];
    const fx = p.fx ?? [];
    const tight = p.tight;
    if (!p.shape) return { C: null, fields, fx, tight };
    // Every content pixel the new canvas (and its smart filters' footprint) needs must be in
    // the previous canvas (known opaque bounds lie inside it by construction).
    const need = tight !== undefined ? null : intersectRect(extent, expandRect(region, fpad));
    if (need && !containsRect(p.region, need)) return { C: null, fields, fx, tight };
    if (sameRect(p.region, region) && !borrowed.has(p.shape)) return { C: p.shape, fields, fx, tight };
    const C = fresh(region.w, region.h);
    ctx2d(C).drawImage(p.shape, p.region.x - region.x, p.region.y - region.y);
    return { C, fields, fx, tight };
  }
  return { C: null, fields: [], fx: [], tight: undefined };
}

/** Cache key of an effect instance's output (content identity is checked separately). */
function fxKey(def: EffectDef, params: Record<string, unknown>, knock: boolean, clips: boolean): string {
  let p: string;
  try {
    p = JSON.stringify(params);
  } catch {
    p = String(Math.random());
  }
  return `${def.id}|${knock ? 'k' : ''}${clips ? 'c' : ''}|${p}`;
}

/** A canvas positioned at `from` redrawn into a fresh canvas positioned at `to` (output px). */
function moveCanvas(c: HTMLCanvasElement, from: PxRect, to: PxRect): HTMLCanvasElement {
  if (sameRect(from, to)) return c;
  const out = fresh(to.w, to.h);
  ctx2d(out).drawImage(c, from.x - to.x, from.y - to.y);
  return out;
}

function buildLayerRender(rc: RC, l: Layer, flags: RenderFlags, prevs: (LayerRender | null)[]): LayerRender | null {
  const { doc, s, W, H } = rc;
  const docR: PxRect = { x: 0, y: 0, w: W, h: H };
  // 1) content box (output px, float) ------------------------------------------------------
  let box: { x: number; y: number; w: number; h: number } | null = null;
  let contentBox: { x: number; y: number; w: number; h: number } | null = null;
  const geom = layerGeometry(l, s);
  if (geom) {
    box = boundsOfMatrixRect(geom.m, geom.local);
    contentBox = boundsOfMatrixRect(geom.m, geom.box);
  } else if (l.type === 'fill') {
    box = contentBox = { x: 0, y: 0, w: W, h: H };
  } else if (l.type === 'group') {
    const e = groupExtent(rc, l);
    if (e) box = contentBox = { x: e.x, y: e.y, w: e.w, h: e.h };
  }
  if (!box || !(box.w > 0) || !(box.h > 0)) return null;
  if (l.type === 'raster' && !bitmaps.tryGet(l.bitmapId)) return null;

  const fx = flags.effects ? activeEffects(l) : [];
  const sides = flags.effects ? effectsSidesOf(l, s) : NO_SIDES;
  const fpad = flags.filters ? filterPad(l.filters, s) : 0;
  const csig = contentSig(rc, l, flags);

  // Plain raster at 1:1 and an integer offset: the bitmap itself is the render (zero copy).
  if (l.type === 'raster' && !fx.length && !(flags.filters && hasFilters(l.filters)) && !(flags.mask && l.mask?.enabled) && !(l.fillOpacity < 0.999)) {
    const m = geom!.m;
    const ex = Math.round(m.e);
    const ey = Math.round(m.f);
    if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.e - ex) < 1e-3 && Math.abs(m.f - ey) < 1e-3) {
      const bmp = bitmaps.tryGet(l.bitmapId)!;
      const region = { x: ex, y: ey, w: bmp.width, h: bmp.height };
      if (!intersectRect(region, docR)) return null;
      borrowed.add(bmp);
      return { region, core: bmp, shape: bmp, behind: [], bounds: region, csig, extent: region };
    }
  }
  // Region: the content's raster bounds grown per side by the effects' reach (+ smart-filter
  // growth), limited to what can affect the document (content farther out than an effect can
  // pull it in, or effect output beyond the document, is never visible).
  const grow = addSides(sides, fpad);
  const cover = coverRect(box.x, box.y, box.w, box.h);
  const extent = expandRect(cover, fpad);
  const region = intersectRect(expandSides(cover, grow), expandSides(docR, flipSides(grow)));
  if (!region) return null;
  if (region.w > MAX_SIDE || region.h > MAX_SIDE) {
    const clipped = intersectRect(region, expandRect(docR, Math.min(maxSide(grow), 64)));
    if (!clipped) return null;
    region.x = clipped.x;
    region.y = clipped.y;
    region.w = Math.min(MAX_SIDE, clipped.w);
    region.h = Math.min(MAX_SIDE, clipped.h);
  }

  // 2–4) content, smart filters, mask (or the previous render's content when only effects,
  // opacity or blending changed) ------------------------------------------------------------
  const reuse = reuseContent(prevs, csig, region, extent, fpad);
  let C: HTMLCanvasElement;
  if (reuse.C) {
    C = reuse.C;
    renderStats.contentReuse++;
  } else {
    C = fresh(region.w, region.h);
    const cctx = ctx2d(C);
    switch (l.type) {
      case 'raster': {
        const bmp = bitmaps.tryGet(l.bitmapId)!;
        const m = geom!.m;
        const ex = Math.round(m.e - region.x);
        const ey = Math.round(m.f - region.y);
        if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && Math.abs(m.e - region.x - ex) < 1e-3 && Math.abs(m.f - region.y - ey) < 1e-3) {
          cctx.drawImage(bmp, ex, ey);
        } else {
          cctx.setTransform(m.a, m.b, m.c, m.d, m.e - region.x, m.f - region.y);
          cctx.imageSmoothingEnabled = true;
          cctx.imageSmoothingQuality = 'high';
          cctx.drawImage(bmp, 0, 0);
          cctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        break;
      }
      case 'text': {
        const m = geom!.m;
        const { k, fx: phx, fy: phy } = localRasterParams(m);
        drawLocal(cctx, renderTextContent(l.text, k, phx, phy), m, region.x, region.y);
        break;
      }
      case 'shape': {
        const m = geom!.m;
        const { k, fx: phx, fy: phy } = localRasterParams(m);
        drawLocal(cctx, renderShapeContent(l.shape, k, phx, phy), m, region.x, region.y);
        break;
      }
      case 'fill': {
        cctx.setTransform(s, 0, 0, s, -region.x, -region.y);
        fillWithPaint(cctx, l.fill as Paint, { x: 0, y: 0, width: doc.width, height: doc.height });
        cctx.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
      case 'group': {
        const acc: Acc = { canvas: C, ctx: cctx, x: region.x, y: region.y, w: region.w, h: region.h, bounds: null, root: false, clip: null };
        compositeList(rc, l.childIds, acc);
        break;
      }
    }

    // 3) smart filters
    if (flags.filters && hasFilters(l.filters)) {
      try {
        const out = applyFilterStack(C, l.filters, makeFilterContext({ docWidth: doc.width, docHeight: doc.height, offsetX: region.x / s, offsetY: region.y / s, scale: s }));
        if (out !== C) C = out;
      } catch (err) {
        warnOnce(`smart filters of ${l.id} failed`, err);
      }
    }

    // 4) mask
    if (flags.mask && l.mask && l.mask.enabled) applyMask(C, region, l.mask, s, doc.width, doc.height);
  }

  const layoutBox = coverRect(contentBox!.x, contentBox!.y, contentBox!.w, contentBox!.h);
  const fill = Math.max(0, Math.min(1, Number.isFinite(l.fillOpacity) ? l.fillOpacity : 1));

  // 5) effects -------------------------------------------------------------------------------
  if (!fx.length) {
    let core: HTMLCanvasElement = C;
    if (fill < 0.999) {
      core = fresh(region.w, region.h);
      const k = ctx2d(core);
      k.globalAlpha = fill;
      k.drawImage(C, 0, 0);
    }
    return { region, core: fill > 0 ? core : null, shape: C, behind: [], bounds: layoutBox, csig, extent, fields: reuse.fields.length ? reuse.fields : undefined, tight: reuse.tight };
  }

  // Effects work on everything the content covers (text stroke/warp/descenders, shape stroke,
  // filter growth), not just the layout box; gradients still follow the layout box.
  const ext = intersectRect(extent, region);
  const effectBounds: LocalRect = ext ? { x: ext.x - region.x, y: ext.y - region.y, w: ext.w, h: ext.h } : { x: 0, y: 0, w: 0, h: 0 };
  const paintBox: LocalRect = { x: layoutBox.x - region.x, y: layoutBox.y - region.y, w: layoutBox.w, h: layoutBox.h };
  const fieldsP = new LayerFields(C, region, extent, reuse.fields, reuse.tight);
  const sorted = fx
    .map((e) => ({ ...e, stage: effectStage(e.def, e.params) }))
    .sort((a, b) => a.def.order - b.def.order || a.idx - b.idx);
  const opacity = Math.max(0, Math.min(1, l.opacity));
  const knock = fill * opacity < 0.999;
  const behind: BehindPiece[] = [];
  // Only behind-stage effects at full fill: the core IS the content (no copy).
  const shareCore = fill >= 0.999 && sorted.every((e) => e.stage === 'behind');
  const core = shareCore ? C : fresh(region.w, region.h);
  const kctx = ctx2d(core);
  if (!shareCore && fill > 0) {
    kctx.globalAlpha = fill;
    kctx.drawImage(C, 0, 0);
    kctx.globalAlpha = 1;
  }
  const knockOut = (c: HTMLCanvasElement) => {
    const k = ctx2d(c);
    k.globalCompositeOperation = 'destination-out';
    k.drawImage(C, 0, 0);
    k.globalCompositeOperation = 'source-over';
  };
  const clipTo = (c: HTMLCanvasElement) => {
    const k = ctx2d(c);
    k.globalCompositeOperation = 'destination-in';
    k.drawImage(C, 0, 0);
    k.globalCompositeOperation = 'source-over';
  };
  const fxOut: FxEntry[] = [];
  const contentRect = (fieldsP.tight === undefined ? extent : fieldsP.tight) ?? null;
  for (const e of sorted) {
    const op = compositeOp((typeof e.params.blendMode === 'string' ? e.params.blendMode : 'normal') as Parameters<typeof compositeOp>[0]);
    const isBehind = e.stage === 'behind';
    const clips = !isBehind && effectClips(e.def, e.params);
    const cacheable = effectCacheable(e.def.id);
    const key = cacheable ? fxKey(e.def, e.params, knock && isBehind, clips) : '';
    // Reuse this effect's previous output (same content, same params) when it is complete in
    // the new region: only the edited effect of a layer re-renders.
    if (cacheable) {
      const need = contentRect ? intersectRect(expandSides(contentRect, effectExtent(e.def, e.params, s)), region) : null;
      const hit = reuse.fx.find((f) => f.key === key && (sameRect(f.region, region) || !need || containsRect(f.region, need)));
      if (hit) {
        const pieces = hit.pieces.map((pc) => ({ canvas: moveCanvas(pc.canvas, hit.region, region), op: pc.op }));
        fxOut.push({ key, region, pieces });
        renderStats.fxReuse++;
        for (const pc of pieces) {
          if (isBehind) behind.push(pc);
          else {
            kctx.globalCompositeOperation = pc.op;
            kctx.drawImage(pc.canvas, 0, 0);
            kctx.globalCompositeOperation = 'source-over';
          }
        }
        continue;
      }
    }
    const recorded: BehindPiece[] = [];
    // Cacheable above-stage outputs are kept (fresh canvases); others use pooled scratch.
    const target = isBehind || cacheable ? fresh(region.w, region.h) : acquire(region.w, region.h);
    const args: EffectArgsExt = {
      content: C,
      params: e.params,
      target: ctx2d(target),
      scale: s,
      docWidth: doc.width,
      docHeight: doc.height,
      region: { x: region.x, y: region.y, bounds: effectBounds, paintBox },
      fields: fieldsP,
      addPiece: (piece, pop) => {
        // Pieces belong to the effect (often pooled): keep copies.
        const copy = fresh(region.w, region.h);
        ctx2d(copy).drawImage(piece, 0, 0);
        if (isBehind) {
          if (knock) knockOut(copy);
          behind.push({ canvas: copy, op: pop });
        } else {
          if (clips) clipTo(copy);
          kctx.globalCompositeOperation = pop;
          kctx.drawImage(copy, 0, 0);
          kctx.globalCompositeOperation = 'source-over';
        }
        recorded.push({ canvas: copy, op: pop });
      },
    };
    try {
      e.def.render(args);
    } catch (err) {
      warnOnce(`effect ${e.def.id} failed`, err);
    }
    if (isBehind) {
      if (knock) knockOut(target);
      behind.push({ canvas: target, op });
    } else {
      if (clips) clipTo(target);
      kctx.globalCompositeOperation = op;
      kctx.drawImage(target, 0, 0);
      kctx.globalCompositeOperation = 'source-over';
      if (!cacheable) release(target);
    }
    if (cacheable) {
      recorded.push({ canvas: target, op });
      fxOut.push({ key, region, pieces: recorded });
    }
  }
  return {
    region,
    core,
    shape: C,
    behind,
    bounds: layoutBox,
    csig,
    extent,
    fields: fieldsP.entries.length ? fieldsP.entries : undefined,
    fx: fxOut.length ? fxOut : undefined,
    tight: fieldsP.tight,
  };
}

/* ================================================================== */
/* Compositing                                                         */
/* ================================================================== */

function accRect(acc: Acc): PxRect {
  return { x: acc.x, y: acc.y, w: acc.w, h: acc.h };
}

function markDrawn(acc: Acc, r: PxRect) {
  const i = intersectRect(r, accRect(acc));
  if (i) acc.bounds = unionRect(acc.bounds, i);
}

/** Draw a layer render into the accumulator with the layer's opacity and blend mode. */
function compositeRender(acc: Acc, l: Layer, R: LayerRender) {
  const a = Math.max(0, Math.min(1, l.opacity));
  if (a <= 0) return;
  const ctx = acc.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dx = R.region.x - acc.x;
  const dy = R.region.y - acc.y;
  for (const b of R.behind) {
    ctx.globalAlpha = a;
    ctx.globalCompositeOperation = b.op;
    ctx.drawImage(b.canvas, dx, dy);
  }
  if (R.core) {
    ctx.globalAlpha = a;
    ctx.globalCompositeOperation = compositeOp(l.blendMode);
    ctx.drawImage(R.core, dx, dy);
  }
  ctx.restore();
  markDrawn(acc, R.region);
}

/** Base layer + clipped layers: clipped content is limited to the base's alpha. */
function compositeClipStack(rc: RC, acc: Acc, base: Layer, R: LayerRender, clipped: Layer[]) {
  const a = Math.max(0, Math.min(1, base.opacity));
  if (a <= 0 || !R.shape) return;
  const reg = R.region;
  const G = acquire(reg.w, reg.h);
  const g = ctx2d(G);
  if (R.core) g.drawImage(R.core, 0, 0);
  const gAcc: Acc = { canvas: G, ctx: g, x: reg.x, y: reg.y, w: reg.w, h: reg.h, bounds: reg, root: false, clip: null };
  for (const c of clipped) {
    if (c.type === 'adjustment') {
      applyAdjustment(rc, gAcc, c);
      continue;
    }
    const CR = renderLayer(rc, c);
    if (!CR) continue;
    const ca = Math.max(0, Math.min(1, c.opacity));
    if (ca <= 0) continue;
    const T = acquire(reg.w, reg.h);
    const t = ctx2d(T);
    const dx = CR.region.x - reg.x;
    const dy = CR.region.y - reg.y;
    for (const b of CR.behind) {
      t.globalCompositeOperation = b.op;
      t.drawImage(b.canvas, dx, dy);
    }
    t.globalCompositeOperation = 'source-over';
    if (CR.core) t.drawImage(CR.core, dx, dy);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(R.shape, 0, 0);
    g.globalAlpha = ca;
    g.globalCompositeOperation = c.type === 'group' && c.blendMode === 'pass-through' ? 'source-over' : compositeOp(c.blendMode);
    g.drawImage(T, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    release(T);
  }
  const ctx = acc.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dx = reg.x - acc.x;
  const dy = reg.y - acc.y;
  for (const b of R.behind) {
    ctx.globalAlpha = a;
    ctx.globalCompositeOperation = b.op;
    ctx.drawImage(b.canvas, dx, dy);
  }
  ctx.globalAlpha = a;
  ctx.globalCompositeOperation = compositeOp(base.blendMode);
  ctx.drawImage(G, dx, dy);
  ctx.restore();
  release(G);
  markDrawn(acc, reg);
}

/** Mask alpha for an accumulator sub-rect (local coords), or null. */
function maskFor(rc: RC, mask: LayerMask | null, acc: Acc, r: PxRect): HTMLCanvasElement | null {
  if (!mask || !mask.enabled) return null;
  return maskAlpha(mask, rc.s, { x: acc.x + r.x, y: acc.y + r.y, w: r.w, h: r.h }, rc.doc.width, rc.doc.height);
}

/** Apply an adjustment layer to what has been composited so far in `acc`. */
function applyAdjustment(rc: RC, acc: Acc, adj: AdjustmentLayer) {
  const inst = adj.adjustment;
  const def = inst && filters.get(inst.filterId);
  if (!def || !inst.enabled) return;
  const opacity = Math.max(0, Math.min(1, adj.opacity * (Number.isFinite(adj.fillOpacity) ? adj.fillOpacity : 1) * (inst.opacity ?? 1)));
  if (opacity <= 0 || !acc.bounds) return;
  let abs = intersectRect(acc.bounds, accRect(acc));
  if (abs && acc.clip) abs = intersectRect(abs, acc.clip);
  if (!abs) return;
  const r: PxRect = { x: abs.x - acc.x, y: abs.y - acc.y, w: abs.w, h: abs.h };
  renderStats.adjustments++;
  const ctx = acc.ctx;
  let img: ImageData;
  try {
    img = ctx.getImageData(r.x, r.y, r.w, r.h);
  } catch (err) {
    warnOnce('adjustment readback failed', err);
    return;
  }
  const out = runFilter(def, img, inst.params, makeFilterContext({ docWidth: rc.doc.width, docHeight: rc.doc.height, offsetX: abs.x / rc.s, offsetY: abs.y / rc.s, scale: rc.s }));
  let F = acquire(r.w, r.h);
  ctx2d(F).putImageData(out, 0, 0);
  if (adj.blendMode && adj.blendMode !== 'normal') {
    const B = acquire(r.w, r.h);
    const b = ctx2d(B);
    b.drawImage(acc.canvas, -r.x, -r.y);
    b.globalCompositeOperation = compositeOp(adj.blendMode);
    b.drawImage(F, 0, 0);
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(acc.canvas, -r.x, -r.y);
    b.globalCompositeOperation = 'source-over';
    release(F);
    F = B;
  }
  lerpInto(ctx, F, opacity, maskFor(rc, adj.mask, acc, r), r.x, r.y);
  release(F);
}

/** Pass-through group: children composite directly into the parent accumulator. */
function compositePassThrough(rc: RC, acc: Acc, g: GroupLayer) {
  const a = Math.max(0, Math.min(1, g.opacity * (Number.isFinite(g.fillOpacity) ? g.fillOpacity : 1)));
  const masked = !!g.mask && g.mask.enabled;
  if (a >= 0.999 && !masked) {
    compositeList(rc, g.childIds, acc);
    return;
  }
  if (a <= 0) {
    if (rc.below && containsId(rc.doc, g, rc.below)) rc.stopped = true;
    return;
  }
  const before = acquire(acc.w, acc.h);
  ctx2d(before).drawImage(acc.canvas, 0, 0);
  const boundsBefore = acc.bounds;
  compositeList(rc, g.childIds, acc);
  const after = acquire(acc.w, acc.h);
  ctx2d(after).drawImage(acc.canvas, 0, 0);
  const ctx = acc.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, acc.w, acc.h);
  ctx.drawImage(before, 0, 0);
  ctx.restore();
  lerpInto(ctx, after, a, maskFor(rc, g.mask, acc, { x: 0, y: 0, w: acc.w, h: acc.h }), 0, 0);
  release(before, after);
  acc.bounds = unionRect(boundsBefore, acc.bounds);
}

/* ---------------- root plan: snapshots around top-level adjustments ---------------- */

/** Slot tag of a document's composites and snapshots (dropped when the document closes). */
export function docTag(docId: ID): string {
  return `doc:${docId}`;
}

interface Snapshot {
  canvas: HTMLCanvasElement;
  bounds: PxRect | null;
}

interface RootPlan {
  /** Prefix signature per top-level index (prefix[k] covers ids[0..k]). */
  prefix: string[];
  /** Signature of the empty accumulator (background, size…). */
  base: string;
  /**
   * Whether snapshots may be stored. Incremental (dirty-rect) composites only RESTORE: their
   * accumulator is valid inside the dirty rect only.
   */
  store: boolean;
}

/**
 * Last seen (prefix, adjustment signature) per adjustment: a 'pre' snapshot is only worth its
 * full-canvas copy when the adjustment itself is being edited (its signature changes while
 * everything below stays the same) — e.g. dragging a Hue/Saturation slider.
 */
const adjustmentSeen = new Map<string, { prefix: string; sig: string }>();

function snapKey(rc: RC, adj: Layer, kind: 'pre' | 'post') {
  return `S${kind}|${rc.doc.id}|${adj.id}|${rc.s.toFixed(5)}|${rc.below ?? ''}`;
}

function prefixAt(plan: RootPlan, k: number): string | undefined {
  return k < 0 ? plan.base : plan.prefix[k];
}

/** Cumulative signatures of a top-level list (index → prefix signature). */
function prefixSigs(rc: RC, ids: ID[], base: string): string[] {
  const out: string[] = [];
  let acc = base;
  const st = { stopped: false };
  for (const id of ids) {
    if (st.stopped) break;
    acc += listSig(rc, [id], st) + ';';
    out.push(acc);
  }
  return out;
}

function restoreInto(acc: Acc, snap: Snapshot) {
  acc.ctx.save();
  acc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  acc.ctx.globalCompositeOperation = 'copy';
  acc.ctx.drawImage(snap.canvas, 0, 0);
  acc.ctx.restore();
  acc.bounds = snap.bounds;
}

function storeSnapshot(rc: RC, acc: Acc, adj: Layer, kind: 'pre' | 'post', sig: string) {
  const key = snapKey(rc, adj, kind);
  if (slots.get<Snapshot>(key, sig)) return;
  const copy = fresh(acc.w, acc.h);
  ctx2d(copy).drawImage(acc.canvas, 0, 0);
  slots.set(key, sig, { canvas: copy, bounds: acc.bounds } satisfies Snapshot, 0, { composite: true, max: 1, layerId: docTag(rc.doc.id), res: [copy] });
}

/** Resume from the highest cached adjustment snapshot. Returns the index to continue from. */
function restoreSnapshots(rc: RC, ids: ID[], acc: Acc, plan: RootPlan): number {
  for (let k = Math.min(ids.length, plan.prefix.length) - 1; k >= 0; k--) {
    const l = rc.doc.layers[ids[k]];
    if (!l || l.type !== 'adjustment' || !isShown(rc, l)) continue;
    const post = slots.get<Snapshot>(snapKey(rc, l, 'post'), plan.prefix[k]);
    if (post) {
      renderStats.snapshotHits++;
      restoreInto(acc, post);
      return k + 1;
    }
    const pre = slots.get<Snapshot>(snapKey(rc, l, 'pre'), prefixAt(plan, k - 1)!);
    if (pre) {
      renderStats.snapshotHits++;
      restoreInto(acc, pre);
      return k;
    }
  }
  return 0;
}

function anyShownAfter(rc: RC, ids: ID[], i: number): boolean {
  for (let k = i + 1; k < ids.length; k++) {
    if (ids[k] === rc.below) return false;
    const l = rc.doc.layers[ids[k]];
    if (l && isShown(rc, l)) return true;
  }
  return false;
}

/** Composite a layer list (bottom → top) into an accumulator. */
function compositeList(rc: RC, ids: ID[], acc: Acc, plan?: RootPlan) {
  const doc = rc.doc;
  let i = plan ? restoreSnapshots(rc, ids, acc, plan) : 0;
  while (i < ids.length) {
    if (rc.stopped) return;
    const id = ids[i];
    const l = doc.layers[id];
    if (!l) {
      i++;
      continue;
    }
    if (id === rc.below) {
      rc.stopped = true;
      return;
    }
    if (!isShown(rc, l)) {
      if (l.type === 'group' && rc.below && containsId(doc, l, rc.below)) {
        rc.stopped = true;
        return;
      }
      i++;
      // Layers clipped to a hidden base are hidden with it.
      if (l.type !== 'adjustment') {
        while (i < ids.length && doc.layers[ids[i]]?.clipped) {
          if (ids[i] === rc.below) {
            rc.stopped = true;
            return;
          }
          i++;
        }
      }
      continue;
    }
    if (l.type === 'adjustment') {
      const preSig = plan?.store ? prefixAt(plan, i - 1) : undefined;
      if (plan && preSig !== undefined) {
        const key = snapKey(rc, l, 'pre');
        const sig = layerSig(rc, l);
        const seen = adjustmentSeen.get(key);
        if (seen && seen.prefix === preSig && seen.sig !== sig) storeSnapshot(rc, acc, l, 'pre', preSig);
        if (adjustmentSeen.size > 256) adjustmentSeen.clear();
        adjustmentSeen.set(key, { prefix: preSig, sig });
      }
      applyAdjustment(rc, acc, l);
      // 'post' snapshots only pay off when something above can change independently.
      if (plan?.store && plan.prefix[i] !== undefined && anyShownAfter(rc, ids, i)) storeSnapshot(rc, acc, l, 'post', plan.prefix[i]);
      i++;
      continue;
    }
    // Gather layers clipped to this base.
    let j = i + 1;
    let stopAfter = false;
    const clipped: Layer[] = [];
    while (j < ids.length) {
      const c = doc.layers[ids[j]];
      if (!c || !c.clipped) break;
      if (ids[j] === rc.below) {
        stopAfter = true;
        break;
      }
      if (isShown(rc, c)) clipped.push(c);
      j++;
    }
    if (l.type === 'group' && isPassThroughSimple(l) && !clipped.length) compositePassThrough(rc, acc, l);
    else {
      const R = renderLayer(rc, l);
      if (R) {
        if (clipped.length) compositeClipStack(rc, acc, l, R, clipped);
        else compositeRender(acc, l, R);
      }
    }
    if (l.type === 'group' && rc.below && containsId(doc, l, rc.below)) rc.stopped = true;
    i = j;
    if (stopAfter) rc.stopped = true;
  }
}

/* ================================================================== */
/* Document                                                            */
/* ================================================================== */

export interface DocRenderOptions {
  scale: number;
  background: boolean;
  hidden: Set<ID> | null;
  below: ID | null;
}

/** Region a composited item can change ('full' = anywhere, e.g. adjustment layers). */
type ItemRegion = PxRect | null | 'full';

interface DocItem {
  id: ID;
  sig: string;
  region: ItemRegion;
}

interface DocEntry {
  canvas: HTMLCanvasElement;
  items: DocItem[];
}

function inlinePassThrough(g: GroupLayer): boolean {
  return isPassThroughSimple(g) && g.opacity * (Number.isFinite(g.fillOpacity) ? g.fillOpacity : 1) >= 0.999 && !(g.mask && g.mask.enabled);
}

function hasAdjustmentInline(rc: RC, g: GroupLayer): boolean {
  for (const id of g.childIds) {
    const c = rc.doc.layers[id];
    if (!c || !isShown(rc, c)) continue;
    if (c.type === 'adjustment') return true;
    if (c.type === 'group' && isPassThroughSimple(c) && hasAdjustmentInline(rc, c)) return true;
  }
  return false;
}

/**
 * Flattened composite items: pass-through groups (opacity 100%, no mask) composite exactly like
 * their children inlined, so they are expanded and changes are tracked per leaf.
 */
function docItems(rc: RC, ids: ID[], st: { stopped: boolean }, out: { id: ID; sig: string; layer: Layer | null }[]) {
  for (const id of ids) {
    if (st.stopped) return;
    if (id === rc.below) {
      st.stopped = true;
      out.push({ id: 'below', sig: 'B', layer: null });
      return;
    }
    const l = rc.doc.layers[id];
    if (!l) continue;
    if (l.type === 'group' && isShown(rc, l) && inlinePassThrough(l)) {
      out.push({ id, sig: `G${objId(l)}`, layer: null });
      docItems(rc, l.childIds, st, out);
      out.push({ id, sig: 'g', layer: null });
      continue;
    }
    out.push({ id, sig: listSig(rc, [id], st), layer: isShown(rc, l) ? l : null });
  }
}

function itemRegion(rc: RC, l: Layer | null): ItemRegion {
  if (!l) return null;
  if (l.type === 'adjustment') return 'full';
  if (l.type === 'group' && isPassThroughSimple(l)) {
    if (hasAdjustmentInline(rc, l)) return 'full';
    return groupExtent(rc, l);
  }
  return renderLayer(rc, l)?.region ?? null;
}

/** Composite the document (cached; the returned canvas must be treated as read-only). */
export function compositeDocument(doc: Document, o: DocRenderOptions): HTMLCanvasElement {
  const rc = makeRC(doc, o.scale, o.hidden, o.below);
  const bg = o.background && doc.background ? doc.background : '';
  const hiddenKey = rc.hidden ? [...rc.hidden].sort().join(',') : '';
  const key = `D|${doc.id}|${rc.s.toFixed(5)}|${bg ? 'b' : ''}|${hiddenKey}|${rc.below ?? ''}`;
  const base = `bg:${bg}|${rc.W}x${rc.H}|g${cacheGeneration()}|`;
  const raw: { id: ID; sig: string; layer: Layer | null }[] = [];
  docItems(rc, doc.rootIds, { stopped: false }, raw);
  const sig = base + raw.map((r) => r.sig).join(';');
  const prev = slots.peek<DocEntry>(key);
  if (prev && prev.sig === sig) {
    renderStats.docHits++;
    slots.get(key, sig);
    return prev.value.canvas;
  }
  renderStats.docRenders++;
  const docR: PxRect = { x: 0, y: 0, w: rc.W, h: rc.H };

  // Incremental path: only a few items changed → recomposite their old ∪ new regions.
  if (prev && prev.sig.startsWith(base) && prev.value.items.length === raw.length && raw.every((r, i) => r.id === prev.value.items[i].id)) {
    const old = prev.value.items;
    const changed: number[] = [];
    for (let i = 0; i < raw.length; i++) if (raw[i].sig !== old[i].sig) changed.push(i);
    if (changed.length > 0 && changed.length <= 8) {
      let D: PxRect | null = null;
      let full = false;
      const items: DocItem[] = old.map((it, i) => ({ id: it.id, sig: raw[i].sig, region: it.region }));
      for (const i of changed) {
        const nr = itemRegion(rc, raw[i].layer);
        items[i].region = nr;
        const or = old[i].region;
        if (nr === 'full' || or === 'full') {
          full = true;
          break;
        }
        D = unionRect(unionRect(D, or), nr);
      }
      if (!full) {
        const dirty = D ? intersectRect(D, docR) : null;
        if (!dirty) {
          slots.set(key, sig, { canvas: prev.value.canvas, items } satisfies DocEntry, 0, { composite: true, max: 1, layerId: docTag(doc.id), res: [prev.value.canvas] });
          return prev.value.canvas;
        }
        if (dirty.w * dirty.h <= 0.55 * rc.W * rc.H) {
          const out = fresh(rc.W, rc.H);
          const ctx = ctx2d(out);
          ctx.drawImage(prev.value.canvas, 0, 0);
          ctx.save();
          ctx.beginPath();
          ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
          ctx.clip();
          ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
          const acc: Acc = { canvas: out, ctx, x: 0, y: 0, w: rc.W, h: rc.H, bounds: null, root: true, clip: dirty };
          if (bg) {
            ctx.fillStyle = bg;
            ctx.fillRect(dirty.x, dirty.y, dirty.w, dirty.h);
            acc.bounds = docR;
          }
          // Resume from a cached adjustment snapshot when everything below it is unchanged
          // (editing above a global adjustment never re-runs its filter).
          compositeList(rc, doc.rootIds, acc, { prefix: prefixSigs(rc, doc.rootIds, base), base, store: false });
          ctx.restore();
          slots.set(key, sig, { canvas: out, items } satisfies DocEntry, 0, { composite: true, max: 1, layerId: docTag(doc.id), res: [out] });
          return out;
        }
      }
    }
  }

  // Full composite (resuming from adjustment snapshots when possible).
  const out = fresh(rc.W, rc.H);
  const ctx = ctx2d(out);
  const acc: Acc = { canvas: out, ctx, x: 0, y: 0, w: rc.W, h: rc.H, bounds: null, root: true, clip: null };
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, rc.W, rc.H);
    acc.bounds = docR;
  }
  compositeList(rc, doc.rootIds, acc, { prefix: prefixSigs(rc, doc.rootIds, base), base, store: true });
  const items: DocItem[] = raw.map((r) => ({ id: r.id, sig: r.sig, region: itemRegion(rc, r.layer) }));
  slots.set(key, sig, { canvas: out, items } satisfies DocEntry, 0, { composite: true, max: 1, layerId: docTag(doc.id), res: [out] });
  return out;
}

/** Draw a layer render's pieces (no layer opacity/blend) into a fresh doc-sized canvas. */
export function flattenRender(rc: RC, R: LayerRender, withBehind = true): HTMLCanvasElement {
  const out = fresh(rc.W, rc.H);
  const ctx = ctx2d(out);
  if (withBehind) {
    for (const b of R.behind) {
      ctx.globalCompositeOperation = b.op;
      ctx.drawImage(b.canvas, R.region.x, R.region.y);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  if (R.core) ctx.drawImage(R.core, R.region.x, R.region.y);
  return out;
}
