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
import { coreExceedsShape, normalizeClipBase } from './clip';
import { blendAtop, isBlendable } from './blendMath';
import { cropExactBackend } from './backendProbe';
import { alignGrid, alignRect, changesSince, effectInfluence, effectUsesFields, fieldBucket, filtersLocal, isPixelExact, mapDirtyRect, type ChangeEntry } from './region';
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
  /** @internal Structure signature (layerSig without bitmap versions), see structSig. */
  ssig?: string;
  /** @internal Bitmap versions this render was made from (content, mask, shown descendants). */
  deps?: DepList;
  /**
   * @internal Holds approximate pixels (a live-painting region update that is not exact on this
   * canvas backend, see markApprox): only live composites may use it; other renders re-render.
   */
  approx?: boolean;
}

/** Bitmap id → version pairs a render depends on. */
export type DepList = [ID, number][];

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
  /** Memo of structSig (signatures without bitmap versions). */
  structMemo?: Map<Layer, string>;
  /**
   * Approximate work allowed (live composites only: region updates that are exact on the
   * software canvas but not on GPU canvases, settled later). Every other render is exact: it
   * never uses approximate layer renders and never does approximate work.
   */
  approxOk?: boolean;
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
  /**
   * The accumulator is a crop of the one a full render uses, which covers this rect (output px):
   * masks are taken from that full rect so crops see the same (blurred) mask pixels.
   */
  cropOf?: PxRect;
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
  /** Layer renders updated in place over the region their bitmaps changed (live painting). */
  regionUpdates: 0,
  /** Document composites re-blended over a dirty rect only. */
  docRegionRenders: 0,
  /** Live (viewport) composites updated in place. */
  liveRegionRenders: 0,
  liveFullRenders: 0,
  /** Region updates / partial composites that may differ from a full render on a GPU canvas. */
  approxUpdates: 0,
  /** ...of which may differ on every canvas (shared distance fields): settled likewise. */
  inexactUpdates: 0,
  /** Settles (approximate work re-rendered exactly). */
  settles: 0,
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
  return { doc, s, W, H, hidden: hidden && hidden.size ? hidden : null, below: below ?? null, stopped: false, sigMemo: new Map(), structMemo: new Map() };
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
 * Geometry every render depends on besides the layer itself: output size, render scale and the
 * document size (fills and gradients span the document, masks are stretched over it, effects and
 * filters get docWidth/docHeight, regions are clipped to it). Canvas Size / Crop / Trim change it
 * without touching fill layers or groups.
 */
export function geometrySig(rc: RC): string {
  return `${rc.W}x${rc.H}@${rc.s}/${rc.doc.width}x${rc.doc.height}`;
}

/**
 * Signature of a layer as rendered EXCEPT the pixels of its bitmaps: layerSig without bitmap
 * versions (plus the render geometry, see geometrySig). Two renders with equal structure
 * signatures differ only where bitmaps were touched in between (see bitmaps.dirtySince), so one
 * can be updated into the other region by region.
 */
export function structSig(rc: RC, l: Layer): string {
  const memo = rc.structMemo ?? (rc.structMemo = new Map());
  const hit = memo.get(l);
  if (hit !== undefined) return hit;
  let s = `${objId(l)}#${geometrySig(rc)}`;
  if (l.type === 'raster') s += `.${l.bitmapId}`;
  if (l.mask) s += `m${l.mask.bitmapId}`;
  if (l.type === 'text') s += textStateSig(l.text);
  if (l.type === 'group') {
    let inner = '';
    eachShownChild(rc, l.childIds, (c) => {
      inner += structSig(rc, c) + ',';
    }, (id) => {
      inner += id === 'B' ? 'B' : 'h,';
    });
    s += `[${inner}]`;
  }
  memo.set(l, s);
  return s;
}

/**
 * Visit the layers of a list exactly as listSig/compositing see them: shown layers in order,
 * stopping at the `below` layer. `marker` gets 'h' for hidden layers and 'B' at the stop.
 */
function eachShownChild(rc: RC, ids: ID[], fn: (l: Layer) => void, marker?: (m: 'h' | 'B') => void) {
  for (const id of ids) {
    if (id === rc.below) {
      marker?.('B');
      return;
    }
    const l = rc.doc.layers[id];
    if (!l) continue;
    if (!isShown(rc, l)) {
      if (l.type === 'group' && rc.below && containsId(rc.doc, l, rc.below)) {
        marker?.('B');
        return;
      }
      marker?.('h');
      continue;
    }
    fn(l);
    if (l.type === 'group' && rc.below && containsId(rc.doc, l, rc.below)) return;
  }
}

function collectDeps(rc: RC, l: Layer, out: Map<ID, number>) {
  if (l.type === 'raster') out.set(l.bitmapId, bitmaps.version(l.bitmapId));
  if (l.mask) out.set(l.mask.bitmapId, bitmaps.version(l.mask.bitmapId));
  if (l.type === 'group') eachShownChild(rc, l.childIds, (c) => collectDeps(rc, c, out));
}

/** Current versions of the bitmaps a layer's render depends on. */
export function depList(rc: RC, l: Layer): DepList {
  const m = new Map<ID, number>();
  collectDeps(rc, l, m);
  return [...m];
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
  // The document size matters too (masks are stretched over it, fills span it).
  return `${s}|${geometrySig(rc)}`;
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
export { fieldBucket };

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
  // One 32-bit load per pixel (alpha = top byte of the little-endian RGBA word).
  const d32 = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
  for (let y = 0; y < i.h; y++) {
    let o = (i.y - r.y + y) * r.w + (i.x - r.x);
    const end = (y + 1) * i.w;
    for (let j = y * i.w; j < end; j++) out[o++] = d32[j] >>> 24;
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

/** Margin (output px) read around an alpha request (covers the usual distance-field headroom). */
const ALPHA_READ_PAD = 24;

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
    // Alpha outside the canvas is 0: a read covering the part of `r` inside the canvas is enough
    // (a distance field asks for a rect a few px larger than the effect's work rect, which is
    // clipped to the canvas — no second readback, i.e. no second GPU sync on GPU canvases).
    const inside = intersectRect(r, { x: 0, y: 0, w: this.C.width, h: this.C.height });
    for (const rd of this.reads) {
      if (sameRect(rd.rect, r)) return rd.data;
      if (containsRect(rd.rect, r)) return subArray(rd.data, rd.rect, r, (n) => new Uint8Array(n));
      if (inside && containsRect(rd.rect, inside)) {
        const out = new Uint8Array(r.w * r.h);
        for (let y = 0; y < inside.h; y++) {
          const so = (inside.y - rd.rect.y + y) * rd.rect.w + (inside.x - rd.rect.x);
          out.set(rd.data.subarray(so, so + inside.w), (inside.y - r.y + y) * r.w + (inside.x - r.x));
        }
        return out;
      }
    }
    // Read a margin around the request too: the distance fields effects ask for next are a few
    // px larger (see fieldBucket), and every readback is a full GPU sync on GPU canvases.
    const rr = expandRect(r, ALPHA_READ_PAD);
    const data = readAlphaPadded(this.C, rr);
    this.reads.push({ rect: rr, data });
    if (this.reads.length > 4) this.reads.shift();
    if (this.tight === undefined) this.tight = tightFromRead(this.region, this.extent, rr, data);
    return subArray(data, rr, r, (n) => new Uint8Array(n));
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
  const sig = `${layerSig(rc, l)}|${geometrySig(rc)}`;
  const hit = slots.get<LayerRender | null>(key, sig);
  // Approximate renders (live painting on a GPU canvas) only serve live composites.
  if (hit !== undefined && (!hit?.approx || rc.approxOk)) {
    renderStats.layerHits++;
    if (hit?.approx) approxUses++;
    return hit;
  }
  let prevs = slots.values<LayerRender | null>(key);
  // Exact renders never derive from approximate ones.
  if (!rc.approxOk) prevs = prevs.filter((p) => !p?.approx);
  // Live painting: the previous render of the same layer, updated in place over the region its
  // bitmaps changed (a brush frame re-renders a few hundred pixels, not the whole layer).
  const upd = regionReuse(rc, l, flags, key, sig, prevs);
  if (upd) {
    if (upd.approx) approxUses++;
    return upd;
  }
  // A moved layer (same content, whole-pixel delta) reuses its previous render, shifted:
  // dragging a layer with strokes/shadows never recomputes its effects.
  const geom = layerGeometry(l, rc.s);
  const tsig = geom ? translationSig(l, flags, geom.m) : null;
  const tfull = tsig ? `${tsig}|${geometrySig(rc)}` : '';
  if (tsig && geom) {
    for (const p of prevs) {
      const mv = p?.move;
      if (!mv || mv.sig !== tfull || (mv.base.approx && !rc.approxOk)) continue;
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
      moved.ssig = structSig(rc, l);
      moved.deps = depList(rc, l);
      renderStats.translateHits++;
      if (mv.base.approx) {
        moved.approx = true;
        approxUses++;
        markApprox(rc, l.id, moved.region);
      }
      slots.set(key, sig, moved, 0, { layerId: l.id, max: 2, res: renderResources(moved) });
      return moved;
    }
  }
  renderStats.layerRenders++;
  let r: LayerRender | null = null;
  const uses0 = approxUses;
  try {
    r = buildLayerRender(rc, l, flags, prevs);
    // Built from approximate pieces (reused content, or a group's approximate children).
    if (r && (r.approx || approxUses !== uses0)) {
      r.approx = true;
      approxUses++;
      markApprox(rc, l.id, r.region);
    }
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
  if (r) {
    r.ssig = structSig(rc, l);
    r.deps = depList(rc, l);
  }
  slots.set(key, sig, r, 0, { layerId: l.id, max: 2, res: renderResources(r) });
  return r;
}

/* ---------------- region updates (live painting) ---------------- */

/*
 * Approximate work and settling. Only LIVE composites (the viewport, rc.approxOk) may do work that
 * is not exact: every other render (renderDocument, exports, thumbnails, rasterize…) is exact by
 * construction — it skips layer renders flagged `approx` and only does region work that is exact
 * on this backend. On the software canvas every region update / partial composite reproduces a
 * full render exactly (see backendProbe). Accelerated (GPU) canvases blur and resample a crop
 * slightly differently than the whole surface (a few levels per channel, more where a threshold
 * follows — e.g. a stroke effect on a feathered edge); several effects sharing distance fields are
 * approximate on every canvas (see sharedFields). Such work is recorded with its area: once no
 * approximate update happened for SETTLE_MS (the stroke ended or paused), the approximate layer
 * renders are dropped and every live composite at that scale re-composites just that area
 * exactly (settle listeners — the viewport — re-render). Nothing else is invalidated.
 */

/** Idle time (ms) after the last approximate update before it is re-rendered exactly. */
export const SETTLE_MS = 350;

/** Approximate work at one render scale. */
interface ApproxWork {
  /** Layers whose cached render holds approximate pixels. */
  layers: Set<ID>;
  /** Output-px area of the live composites that may hold approximate pixels. */
  area: PxRect | null;
  /** The area is unknown (re-render live composites at this scale whole). */
  unknown: boolean;
}

/**
 * Approximate work per render scale (`rc.s.toFixed(5)`). Live composites at a scale draw the
 * layer renders of that scale only, so a settle touches just that scale.
 */
const approx = new Map<string, ApproxWork>();
/** Bumped on every approximate update (lets a group see that a child's update was approximate). */
let approxSeq = 0;
/** Bumped whenever an approximate layer render is handed out (a group drawing it is approximate). */
let approxUses = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleIdle = false;
const settleListeners = new Set<() => void>();

const scaleKey = (s: number) => s.toFixed(5);

/** Whether crops / clipped draws can differ from whole draws on this canvas backend. */
function backendApprox(): boolean {
  return !cropExactBackend();
}

/**
 * Record approximate work at a render scale (in a layer's render, or null = in a composite) over
 * `rect` (output px; null = unknown) and (re)arm the settle timer. `inexact`: approximate on the
 * software canvas too. Only live composites (rc.approxOk) do approximate work.
 */
function markApprox(rc: RC, layerId: ID | null, rect: PxRect | null, inexact = false) {
  approxSeq++;
  renderStats.approxUpdates++;
  if (inexact) renderStats.inexactUpdates++;
  const sk = scaleKey(rc.s);
  let w = approx.get(sk);
  if (!w) approx.set(sk, (w = { layers: new Set(), area: null, unknown: false }));
  if (layerId !== null) w.layers.add(layerId);
  if (rect) w.area = unionRect(w.area, rect);
  else w.unknown = true;
  armSettle();
}

function armSettle() {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleIdle = false;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    // Settle when the browser is idle (not in the middle of input handling / a frame).
    const ric = typeof window !== 'undefined' ? (window as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback : undefined;
    if (!ric) {
      settleApproximations();
      return;
    }
    settleIdle = true;
    ric(
      () => {
        // A newer approximate update re-armed the timer meanwhile: wait for that one.
        if (settleIdle) settleApproximations();
      },
      { timeout: 1000 },
    );
  }, SETTLE_MS);
}

/** Whether approximate work is waiting to be re-rendered exactly. */
export function settlePending(): boolean {
  return approx.size > 0;
}

/**
 * Re-render approximate work exactly now (normally called after SETTLE_MS of idle time): drops
 * the approximate layer renders and has every live composite at their scales re-composite the
 * approximate area (exactly) on its next update, then notifies settle listeners. Other caches
 * never hold approximate pixels. False when nothing was approximate.
 */
export function settleApproximations(): boolean {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  settleIdle = false;
  if (!approx.size) return false;
  for (const [sk, w] of approx) {
    const tag = `|${sk}|`;
    const prefixes = [...w.layers].map((id) => `L|${id}${tag}`);
    if (prefixes.length) slots.deleteWhere((key) => prefixes.some((p) => key.startsWith(p)));
    for (const [k, live] of [...liveStates]) {
      if (live.sk !== sk) continue;
      if (w.unknown || !w.area) liveStates.delete(k);
      else live.pending = unionRect(live.pending, w.area);
    }
  }
  approx.clear();
  renderStats.settles++;
  for (const fn of [...settleListeners]) {
    try {
      fn();
    } catch (err) {
      warnOnce('settle listener failed', err);
    }
  }
  return true;
}

/** Subscribe to settles (re-render when called). Returns the unsubscriber. */
export function onSettle(fn: () => void): () => void {
  settleListeners.add(fn);
  return () => settleListeners.delete(fn);
}

/**
 * Effects whose output on a crop matches the full render on every canvas backend: CPU distance
 * fields / height maps and plain fills. The others blur or resample on the GPU.
 */
const CROP_EXACT_EFFECTS = new Set(['stroke', 'bevel', 'color-overlay']);

/** Where a layer render changed between two sets of bitmap versions (output px). */
interface Change {
  /** Area of the content canvas (content + smart filters + mask) that changed. */
  content: PxRect | null;
  /** Area where any piece of the render (effects included) changed. */
  out: PxRect | null;
}

/** Region (bitmap px) of a bitmap changed since its version in `deps`: null = unchanged, 'full' = unknown. */
function bitmapChange(id: ID, deps: Map<ID, number>): Rect | null | 'full' {
  const v = deps.get(id);
  if (v === undefined) return 'full';
  if (v === bitmaps.version(id)) return null;
  const r = bitmaps.dirtySince(id, v);
  if (!r) return 'full';
  return r.width > 0 && r.height > 0 ? r : null;
}

/** Gaussian sigma (output px) of a mask's feather. */
function maskSigma(mask: LayerMask | null | undefined, s: number): number {
  if (!mask || !mask.enabled) return 0;
  return (Math.max(0, Number(mask.feather) || 0) * s) / 2;
}

/** Output px whose mask visibility changes when the mask bitmap changed in `r` (bitmap px). */
function maskChangeRect(rc: RC, mask: LayerMask, r: Rect): PxRect | 'full' {
  const bmp = bitmaps.tryGet(mask.bitmapId);
  if (!bmp) return 'full';
  // The mask is stretched over the document and edge-clamped beyond it (see maskAlpha).
  const m = new DOMMatrix().scaleSelf((rc.doc.width * rc.s) / bmp.width, (rc.doc.height * rc.s) / bmp.height);
  // A resampled mask's last row/column is an anti-aliased quad edge, drawn differently when the
  // work canvas cuts it (see contentPixelExact): changes reaching the mask's edge re-render.
  if (!isPixelExact(m) && (r.x <= 0 || r.y <= 0 || r.x + r.width >= bmp.width || r.y + r.height >= bmp.height)) return 'full';
  const out = mapDirtyRect(m, r, { w: bmp.width, h: bmp.height });
  const sigma = maskSigma(mask, rc.s);
  return sigma > 0.05 ? expandRect(out, Math.ceil(sigma * 3) + 2) : out;
}

/** Mask bitmap version last seen per (mask bitmap, scale): a mask not being painted right now. */
const maskSeen = new Map<string, number>();

/**
 * Mask alpha over `sub` (absolute output px) exactly as a full render computes it over `full`
 * (⊇ sub; the mask is feather-blurred over the whole rect): cropped from the full-rect mask when
 * it is cached, when exactness is required, or when the mask is not being painted (computed once,
 * then cached). Otherwise (painting on a feathered mask in a live composite) it is computed over
 * the crop, which on GPU canvases blurs slightly differently: `approx`. `temp` canvases go back
 * to the pool after use (release).
 */
function maskOver(rc: RC, mask: LayerMask, full: PxRect, sub: PxRect): { canvas: HTMLCanvasElement | null; approx: boolean; temp: boolean } {
  const { doc, s } = rc;
  if (sameRect(full, sub) || maskSigma(mask, s) <= 0.05) return { canvas: maskAlpha(mask, s, sub, doc.width, doc.height), approx: false, temp: false };
  const seenKey = `${mask.bitmapId}|${scaleKey(s)}`;
  const v = bitmaps.version(mask.bitmapId);
  const steady = maskSeen.get(seenKey) === v;
  if (maskSeen.size > 512) maskSeen.clear();
  maskSeen.set(seenKey, v);
  const whole = maskAlpha(mask, s, full, doc.width, doc.height, { cachedOnly: !!rc.approxOk && !steady });
  if (!whole) return { canvas: maskAlpha(mask, s, sub, doc.width, doc.height), approx: backendApprox(), temp: false };
  const c = acquire(sub.w, sub.h);
  ctx2d(c).drawImage(whole, full.x - sub.x, full.y - sub.y);
  return { canvas: c, approx: false, temp: true };
}

/** Largest effect influence of a layer (output px; 0 without effects), see effectInfluence. */
function effectsInfluenceOf(l: Layer, s: number): number {
  let r = 0;
  for (const e of activeEffects(l)) r = Math.max(r, effectInfluence(e.def, e.params, s));
  return r;
}

/** Shown children of a group as compositing sees them (stops at the `below` layer). */
function shownChildren(rc: RC, ids: ID[]): Layer[] {
  const out: Layer[] = [];
  eachShownChild(rc, ids, (c) => out.push(c));
  return out;
}

/**
 * Where a layer's render changed since it was made from the bitmap versions `deps`, the layer
 * structure being the same (only bitmap pixels changed). 'full' when unknown or when the change
 * is not region-local (smart filters that move pixels, bitmaps touched without a rect…).
 */
function changeOf(rc: RC, l: Layer, deps: Map<ID, number>, flags: RenderFlags): Change | 'full' {
  let content: PxRect | null = null;
  if (l.type === 'raster') {
    const d = bitmapChange(l.bitmapId, deps);
    if (d === 'full') return 'full';
    if (d) {
      const geom = layerGeometry(l, rc.s);
      if (!geom) return 'full';
      content = mapDirtyRect(geom.m, d);
    }
  } else if (l.type === 'group') {
    // Children composite with full flags into the group's content.
    for (const c of shownChildren(rc, l.childIds)) {
      const ch = changeOf(rc, c, deps, FULL_FLAGS);
      if (ch === 'full') return 'full';
      content = unionRect(content, ch.out);
    }
  }
  if (l.mask && flags.mask && l.mask.enabled) {
    const d = bitmapChange(l.mask.bitmapId, deps);
    if (d === 'full') return 'full';
    if (d) {
      const mr = maskChangeRect(rc, l.mask, d);
      if (mr === 'full') return 'full';
      content = unionRect(content, mr);
    }
  }
  if (!content) return { content: null, out: null };
  if (l.type === 'adjustment') return { content, out: content };
  if (flags.filters && hasFilters(l.filters) && !filtersLocal(l.filters)) return 'full';
  const rho = flags.effects ? effectsInfluenceOf(l, rc.s) : 0;
  return { content, out: rho > 0 ? expandRect(content, rho) : content };
}

/**
 * Whether a layer's content draws onto whole output pixels with pixel-aligned edges (a clipped
 * redraw then reproduces a full draw exactly): untransformed bitmaps at integer offsets, fills at
 * scale 1. Text and shapes are drawn through local rasters and treated as transformed.
 */
function contentPixelExact(rc: RC, l: Layer, geom: ReturnType<typeof layerGeometry>): boolean {
  if (l.type === 'raster') return !!geom && isPixelExact(geom.m);
  if (l.type === 'fill') return rc.s === 1;
  return false;
}

/**
 * Whether an output rect (grown by the edge anti-aliasing band) lies inside a raster layer's
 * transformed bitmap quad: no quad edge crosses it, so a clipped redraw matches a full draw.
 */
function insideQuad(l: Layer, geom: ReturnType<typeof layerGeometry>, r: PxRect): boolean {
  if (l.type !== 'raster' || !geom) return false;
  let inv: DOMMatrix;
  try {
    inv = geom.m.inverse();
  } catch {
    return false;
  }
  if (!Number.isFinite(inv.a + inv.b + inv.c + inv.d + inv.e + inv.f)) return false;
  const x0 = r.x - 2,
    y0 = r.y - 2,
    x1 = r.x + r.w + 2,
    y1 = r.y + r.h + 2;
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]) {
    const p = inv.transformPoint({ x, y });
    if (!(p.x >= 0 && p.y >= 0 && p.x <= l.width && p.y <= l.height)) return false;
  }
  return true;
}

/** Copy `src` (placed at ox, oy) into `dst` over the rect `r` only (dst-local px). */
function blitInto(dst: HTMLCanvasElement, src: HTMLCanvasElement, r: PxRect, ox: number, oy: number) {
  const k = ctx2d(dst);
  k.save();
  k.setTransform(1, 0, 0, 1, 0, 0);
  k.globalAlpha = 1;
  k.filter = 'none';
  k.beginPath();
  k.rect(r.x, r.y, r.w, r.h);
  k.clip();
  // clear + source-over (an exact copy of premultiplied pixels) rather than 'copy': see restoreInto.
  k.globalCompositeOperation = 'source-over';
  k.clearRect(r.x, r.y, r.w, r.h);
  k.drawImage(src, ox, oy);
  k.restore();
}

/** Reset the drawing state a fresh canvas would have (partial redraws must match fresh renders). */
function resetDrawState(k: CanvasRenderingContext2D) {
  k.setTransform(1, 0, 0, 1, 0, 0);
  k.globalAlpha = 1;
  k.globalCompositeOperation = 'source-over';
  k.filter = 'none';
  k.imageSmoothingEnabled = true;
  k.imageSmoothingQuality = 'low';
}

/**
 * Re-render a cached layer render IN PLACE over `D` (output px, inside its region) — the area
 * where its content changed: content redrawn (groups re-composite their children there), pixel-
 * local smart filters and the mask re-applied, effects recomputed on a crop large enough for
 * their reach and written back over the area they can change.
 * 'fail' = not possible, nothing was modified; 'corrupt' = not possible after pixels were
 * modified (the render must be dropped).
 */
function updateRenderRegion(rc: RC, l: Layer, flags: RenderFlags, p: LayerRender, D: PxRect): 'ok' | 'approx' | 'fail' | 'corrupt' {
  const region = p.region;
  const C = p.shape;
  if (!C) return 'fail';
  // Zero-copy render (plain raster at 1:1): the live bitmap IS the render.
  if (borrowed.has(C)) return l.type === 'raster' && C === bitmaps.tryGet(l.bitmapId) && p.core === C && !p.behind.length ? 'ok' : 'fail';
  if (C.width !== region.w || C.height !== region.h) return 'fail';
  const hasF = flags.filters && hasFilters(l.filters);
  if (hasF && !filtersLocal(l.filters)) return 'fail';
  const fx = flags.effects ? activeEffects(l) : [];
  const fill = Math.max(0, Math.min(1, Number.isFinite(l.fillOpacity) ? l.fillOpacity : 1));
  const sized = (c: HTMLCanvasElement) => c.width === region.w && c.height === region.h;
  if (!fx.length) {
    // Same layout as buildLayerRender: core = content at full fill, a fill-opacity copy below.
    const ok = fill >= 0.999 ? p.core === C : fill > 0 ? !!p.core && p.core !== C && sized(p.core) : p.core === null;
    if (!ok || p.behind.length) return 'fail';
  } else {
    if (!p.core || !p.extent || !sized(p.core) || !p.behind.every((b) => sized(b.canvas) && !borrowed.has(b.canvas))) return 'fail';
  }
  // Several effects sharing distance fields (see effectUsesFields): a crop can make different
  // sharing choices than a full render, which changes a few soft pixels — approximate everywhere.
  const sharedFields = fx.filter((e) => effectUsesFields(e.def.id)).length > 1;
  const rho = fx.length ? effectsInfluenceOf(l, rc.s) : 0;
  // Partial work starts on the same pixel grid as the full render (dither, blur downsampling).
  const grid = alignGrid(Math.max(flags.mask ? maskSigma(l.mask, rc.s) : 0, rho / 3));
  const Dc = alignRect(D, region, grid);
  if (!Dc) return 'ok';
  const lr: PxRect = { x: Dc.x - region.x, y: Dc.y - region.y, w: Dc.w, h: Dc.h };

  // Decide BEFORE touching any pixel whether the update is exact (see markApprox): renders other
  // than live composites must stay exact, so they re-render instead.
  const gpu = backendApprox();
  const geom = layerGeometry(l, rc.s);
  // Content drawn through a clip (groups re-composite their children over the clip), or (a
  // transformed quad cut by the clip would be anti-aliased differently on a GPU) drawn whole.
  const clipDraw = l.type === 'group' || contentPixelExact(rc, l, geom) || insideQuad(l, geom, Dc);
  // A resampled bitmap or a gradient/pattern fill drawn through a clip: exact on the software
  // canvas, not on every GPU (exact renders draw it whole instead).
  const clipApprox = gpu && clipDraw && ((l.type === 'raster' && !contentPixelExact(rc, l, geom)) || (l.type === 'fill' && (l.fill as Paint).type !== 'solid'));
  const wholeDraw = !clipDraw || (clipApprox && !rc.approxOk);
  let isApprox = sharedFields || (gpu && fx.some((e) => !CROP_EXACT_EFFECTS.has(e.def.id))) || (clipApprox && !wholeDraw);
  if (isApprox && !rc.approxOk) return 'fail';
  const mk = flags.mask && l.mask && l.mask.enabled ? maskOver(rc, l.mask, region, Dc) : null;
  if (mk?.approx) {
    if (!rc.approxOk) {
      if (mk.temp) release(mk.canvas);
      return 'fail';
    }
    isApprox = true;
  }
  const cctx = ctx2d(C);
  const seq0 = approxSeq;
  const uses0 = approxUses;
  // The content (and the core) change in place over Dc: a clip-base cache made from them is stale there.
  markClipStale(rc, l, p, Dc);

  // 2) content
  cctx.save();
  resetDrawState(cctx);
  cctx.beginPath();
  cctx.rect(lr.x, lr.y, lr.w, lr.h);
  cctx.clip();
  cctx.clearRect(lr.x, lr.y, lr.w, lr.h);
  try {
    if (!wholeDraw) drawContent(rc, l, C, region, geom, Dc);
    else {
      // Drawn whole, exactly like a fresh render; only the changed part is kept.
      const T = acquire(region.w, region.h);
      drawContent(rc, l, T, region, geom, null);
      cctx.drawImage(T, 0, 0);
      release(T);
    }
  } catch (err) {
    warnOnce(`layer ${l.id} (${l.type}) failed to update`, err);
    cctx.restore();
    if (mk?.temp) release(mk.canvas);
    return 'corrupt';
  }
  cctx.restore();
  // Groups: approximate when a child's update (or a child render it drew) was.
  if (approxSeq !== seq0 || approxUses !== uses0) isApprox = true;

  // 3) smart filters (pixel-local adjustment filters only), on a crop with the crop's offset
  if (hasF) {
    const T = fresh(Dc.w, Dc.h);
    ctx2d(T).drawImage(C, -lr.x, -lr.y);
    let out: HTMLCanvasElement = T;
    try {
      out = applyFilterStack(T, l.filters, makeFilterContext({ docWidth: rc.doc.width, docHeight: rc.doc.height, offsetX: Dc.x / rc.s, offsetY: Dc.y / rc.s, scale: rc.s }));
    } catch (err) {
      warnOnce(`smart filters of ${l.id} failed`, err);
    }
    if (out !== T) blitInto(C, out, lr, lr.x, lr.y);
  }

  // 4) mask (the full region's mask pixels over the crop when possible, see maskOver)
  if (mk?.canvas) {
    cctx.save();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.beginPath();
    cctx.rect(lr.x, lr.y, lr.w, lr.h);
    cctx.clip();
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(mk.canvas, lr.x, lr.y);
    cctx.restore();
    if (mk.temp) release(mk.canvas);
  }

  // 5) fill opacity / effects
  if (!fx.length) {
    if (p.core && p.core !== C) {
      const k = ctx2d(p.core);
      k.save();
      resetDrawState(k);
      k.beginPath();
      k.rect(lr.x, lr.y, lr.w, lr.h);
      k.clip();
      k.clearRect(lr.x, lr.y, lr.w, lr.h);
      k.globalAlpha = fill;
      k.drawImage(C, 0, 0);
      k.restore();
    }
    if (isApprox) markApprox(rc, l.id, Dc, sharedFields);
    return isApprox ? 'approx' : 'ok';
  }
  // Effects: recompute on a crop that holds all the content the changed outputs depend on.
  const Do = intersectRect(expandRect(Dc, rho), region);
  const Di0 = Do && intersectRect(expandRect(Do, rho), region);
  const Di = Di0 && alignRect(Di0, region, grid);
  if (!Do || !Di) return 'corrupt';
  const Ci = fresh(Di.w, Di.h);
  ctx2d(Ci).drawImage(C, region.x - Di.x, region.y - Di.y);
  let res: EffectsResult;
  try {
    res = runEffects(rc, fx, Ci, Di, p.extent!, p.bounds, fill, l.opacity, { fields: [], fx: [], tight: undefined });
  } catch (err) {
    warnOnce(`effects of ${l.id} failed to update`, err);
    return 'corrupt';
  }
  const shared = p.core === C;
  if (res.behind.length !== p.behind.length || res.behind.some((b, i) => b.op !== p.behind[i].op) || (res.core === Ci) !== shared) return 'corrupt';
  const lo: PxRect = { x: Do.x - region.x, y: Do.y - region.y, w: Do.w, h: Do.h };
  const ox = Di.x - region.x;
  const oy = Di.y - region.y;
  for (let i = 0; i < res.behind.length; i++) blitInto(p.behind[i].canvas, res.behind[i].canvas, lo, ox, oy);
  if (!shared) {
    markClipStale(rc, l, p, Do);
    blitInto(p.core!, res.core, lo, ox, oy);
  }
  if (isApprox) markApprox(rc, l.id, Do, sharedFields);
  return isApprox ? 'approx' : 'ok';
}

/**
 * Region reuse (live painting): the previous render of the same layer structure updated in place
 * over the area its bitmaps changed since it was made. Undefined when not applicable (the layer
 * is then rendered the usual way).
 */
function regionReuse(rc: RC, l: Layer, flags: RenderFlags, key: string, sig: string, prevs: (LayerRender | null)[]): LayerRender | undefined {
  if (!prevs.length || l.type === 'adjustment') return undefined;
  const ss = structSig(rc, l);
  const p = prevs.find((r): r is LayerRender => !!r && r.ssig === ss && !!r.deps);
  if (!p) return undefined;
  const ch = changeOf(rc, l, new Map(p.deps), flags);
  if (ch === 'full') return undefined;
  const D = ch.content ? intersectRect(ch.content, p.region) : null;
  if (D) {
    // A large change re-renders from scratch (as cheap, and keeps the usual reuse paths).
    if (D.w * D.h > 0.5 * p.region.w * p.region.h) return undefined;
    const res = updateRenderRegion(rc, l, flags, p, D);
    if (res === 'fail') return undefined;
    if (res === 'corrupt') {
      // Its pixels were modified before the update turned out impossible: drop every version.
      slots.delete(key);
      prevs.length = 0;
      return undefined;
    }
    renderStats.regionUpdates++;
    // Approximate pixels stay until the render is rebuilt (see settleApproximations).
    if (res === 'approx') p.approx = true;
    // Derived data of the old content is stale now.
    p.tight = undefined;
    p.fields = undefined;
    p.fx = undefined;
  }
  p.csig = contentSig(rc, l, flags);
  p.deps = depList(rc, l);
  p.move = undefined;
  // max 1: the other cached version of this layer may share the canvases just modified.
  slots.set(key, sig, p, 0, { layerId: l.id, max: 1, res: renderResources(p) });
  return p;
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
  /** Reused from an approximate render (the new render is approximate too). */
  approx?: boolean;
}

/** Previous content canvas with the same content signature, adapted to `region` (or null). */
function reuseContent(prevs: (LayerRender | null)[], csig: string, region: PxRect, extent: PxRect, fpad: number): Reuse {
  for (const p of prevs) {
    if (!p || p.csig !== csig) continue;
    const fields = p.fields ?? [];
    const fx = p.fx ?? [];
    const tight = p.tight;
    const approx = p.approx;
    if (!p.shape) return { C: null, fields, fx, tight, approx };
    // Every content pixel the new canvas (and its smart filters' footprint) needs must be in
    // the previous canvas (known opaque bounds lie inside it by construction).
    const need = tight !== undefined ? null : intersectRect(extent, expandRect(region, fpad));
    if (need && !containsRect(p.region, need)) return { C: null, fields, fx, tight, approx };
    if (sameRect(p.region, region) && !borrowed.has(p.shape)) return { C: p.shape, fields, fx, tight, approx };
    const C = fresh(region.w, region.h);
    ctx2d(C).drawImage(p.shape, p.region.x - region.x, p.region.y - region.y);
    return { C, fields, fx, tight, approx };
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

interface EffectsResult {
  core: HTMLCanvasElement;
  behind: BehindPiece[];
  fields: FieldEntry[] | undefined;
  fx: FxEntry[] | undefined;
  tight: PxRect | null | undefined;
}

type ActiveEffect = ReturnType<typeof activeEffects>[number];

/**
 * Stage 5 of a layer render: run the layer effects over the content canvas C (masked + filtered,
 * positioned at `region`). Returns the core (content at fill opacity + above effects) and the
 * behind pieces. `extent` is the content's raster extent, `layoutBox` its layout box (output px).
 */
function runEffects(
  rc: RC,
  fx: ActiveEffect[],
  C: HTMLCanvasElement,
  region: PxRect,
  extent: PxRect,
  layoutBox: PxRect,
  fill: number,
  layerOpacity: number,
  reuse: Pick<Reuse, 'fields' | 'fx' | 'tight'>,
): EffectsResult {
  const { doc, s } = rc;
  // Effects work on everything the content covers (text stroke/warp/descenders, shape stroke,
  // filter growth), not just the layout box; gradients still follow the layout box.
  const ext = intersectRect(extent, region);
  const effectBounds: LocalRect = ext ? { x: ext.x - region.x, y: ext.y - region.y, w: ext.w, h: ext.h } : { x: 0, y: 0, w: 0, h: 0 };
  const paintBox: LocalRect = { x: layoutBox.x - region.x, y: layoutBox.y - region.y, w: layoutBox.w, h: layoutBox.h };
  const fieldsP = new LayerFields(C, region, extent, reuse.fields, reuse.tight);
  const sorted = fx
    .map((e) => ({ ...e, stage: effectStage(e.def, e.params) }))
    .sort((a, b) => a.def.order - b.def.order || a.idx - b.idx);
  const opacity = Math.max(0, Math.min(1, layerOpacity));
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
    core,
    behind,
    fields: fieldsP.entries.length ? fieldsP.entries : undefined,
    fx: fxOut.length ? fxOut : undefined,
    tight: fieldsP.tight,
  };
}

/**
 * Draw a layer's content (no smart filters / mask / effects) into C, which sits at `region`
 * (output px). With `clip` (output px), only that part is drawn: the caller cleared it and set
 * the canvas clip; groups then re-composite their children over the clip only.
 */
function drawContent(rc: RC, l: Layer, C: HTMLCanvasElement, region: PxRect, geom: ReturnType<typeof layerGeometry>, clip: PxRect | null) {
  const cctx = ctx2d(C);
  switch (l.type) {
    case 'raster': {
      const bmp = bitmaps.tryGet(l.bitmapId);
      if (!bmp || !geom) break;
      const m = geom.m;
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
      if (!geom) break;
      const m = geom.m;
      const { k, fx: phx, fy: phy } = localRasterParams(m);
      drawLocal(cctx, renderTextContent(l.text, k, phx, phy), m, region.x, region.y);
      break;
    }
    case 'shape': {
      if (!geom) break;
      const m = geom.m;
      const { k, fx: phx, fy: phy } = localRasterParams(m);
      drawLocal(cctx, renderShapeContent(l.shape, k, phx, phy), m, region.x, region.y);
      break;
    }
    case 'fill': {
      cctx.setTransform(rc.s, 0, 0, rc.s, -region.x, -region.y);
      fillWithPaint(cctx, l.fill as Paint, { x: 0, y: 0, width: rc.doc.width, height: rc.doc.height });
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      break;
    }
    case 'group': {
      const acc: Acc = { canvas: C, ctx: cctx, x: region.x, y: region.y, w: region.w, h: region.h, bounds: null, root: false, clip };
      compositeList(rc, l.childIds, acc);
      break;
    }
  }
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
    drawContent(rc, l, C, region, geom, null);

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
    return { region, core: fill > 0 ? core : null, shape: C, behind: [], bounds: layoutBox, csig, extent, fields: reuse.fields.length ? reuse.fields : undefined, tight: reuse.tight, approx: reuse.approx || undefined };
  }

  const fxr = runEffects(rc, fx, C, region, extent, layoutBox, fill, l.opacity, reuse);
  return { region, core: fxr.core, shape: C, behind: fxr.behind, bounds: layoutBox, csig, extent, fields: fxr.fields, fx: fxr.fx, tight: fxr.tight, approx: reuse.approx || undefined };
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
  // Incremental composite: nothing of this layer inside the recomposited rect.
  if (acc.clip && !intersectRect(R.region, acc.clip)) {
    markDrawn(acc, R.region);
    return;
  }
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

/* ---------------- clip stacks ---------------- */

/**
 * Normalized clip base of a base layer's render (see ./clip.ts): region-local canvases (the size
 * of the render's canvases), cached per base layer and render scale for the render's core / shape
 * canvases — renders that share them (a moved layer, an opacity edit) share it too. Computed on
 * the CPU once per render; renders updated in place (live painting) only recompute the changed
 * area (`stale`, see markClipStale), zero-copy raster renders follow their bitmap's dirty rects.
 */
interface ClipBase {
  shape: HTMLCanvasElement;
  core: HTMLCanvasElement | null;
  w: number;
  h: number;
  /** Base colour made opaque: core / coverage (null: the base draws nothing itself, e.g. 0% fill). */
  norm: HTMLCanvasElement | null;
  /** Coverage, when the core reaches beyond the shape somewhere (null: the shape's alpha). */
  cover: HTMLCanvasElement | null;
  /** Share of the coverage clipped layers may paint, with `cover` (null: all of it). */
  share: HTMLCanvasElement | null;
  /** Region-local area changed in place since it was computed. */
  stale: PxRect | null;
  /** Zero-copy raster render (the live bitmap is the render): the bitmap version computed from. */
  bitmap?: { id: ID; v: number };
}

function clipKey(rc: RC, id: ID): string {
  return `CB|${id}|${scaleKey(rc.s)}`;
}

function clipSig(R: LayerRender): string {
  return `${objId(R.shape)}|${objId(R.core)}|${R.shape?.width}x${R.shape?.height}`;
}

/**
 * A render's core / shape canvases are about to change in place over `abs` (output px): clip bases
 * made from them must recompute that area.
 */
function markClipStale(rc: RC, l: Layer, p: LayerRender, abs: PxRect) {
  if (!p.shape) return;
  for (const cb of slots.values<ClipBase>(clipKey(rc, l.id))) {
    if (cb.shape !== p.shape) continue;
    const r = intersectRect({ x: abs.x - p.region.x, y: abs.y - p.region.y, w: abs.w, h: abs.h }, { x: 0, y: 0, w: cb.w, h: cb.h });
    if (r) cb.stale = unionRect(cb.stale, r);
  }
}

/** Pixels of `src` over `r` (straight alpha), read through a CPU scratch canvas (see applyAdjustment). */
function readImage(src: HTMLCanvasElement, r: PxRect): ImageData {
  const T = acquire(r.w, r.h, { read: true });
  const k = ctx2d(T, { willReadFrequently: true });
  k.drawImage(src, -r.x, -r.y);
  const img = k.getImageData(0, 0, r.w, r.h);
  release(T);
  return img;
}

/**
 * Compute a clip base over the region-local rect `r`. False when the core reaches beyond the shape
 * there while the cache has no coverage canvases yet (and `whole` is false): recompute it whole.
 */
function computeClipBase(cb: ClipBase, r: PxRect, whole: boolean): boolean {
  const core = cb.core;
  if (!core) return true;
  const K = readImage(core, r);
  const S = core === cb.shape ? null : readImage(cb.shape, r);
  if (S && !cb.cover && coreExceedsShape(K.data, S.data)) {
    if (!whole) return false;
    cb.cover = fresh(cb.w, cb.h);
    cb.share = fresh(cb.w, cb.h);
  }
  const put = (c: HTMLCanvasElement, img: ImageData) => ctx2d(c).putImageData(img, r.x, r.y);
  if (cb.cover && cb.share) {
    const k = ctx2d(cb.cover);
    const cov = k.createImageData(r.w, r.h);
    const sh = k.createImageData(r.w, r.h);
    normalizeClipBase(K.data, S && S.data, cov.data, sh.data);
    put(cb.cover, cov);
    put(cb.share, sh);
  } else normalizeClipBase(K.data, S && S.data);
  if (!cb.norm) cb.norm = fresh(cb.w, cb.h);
  put(cb.norm, K);
  return true;
}

/** The (cached, up-to-date) clip base of a base layer render. */
function clipBaseFor(rc: RC, base: Layer, R: LayerRender): ClipBase {
  const shape = R.shape!;
  const key = clipKey(rc, base.id);
  const sig = clipSig(R);
  const whole: PxRect = { x: 0, y: 0, w: shape.width, h: shape.height };
  const hit = slots.get<ClipBase>(key, sig);
  if (hit) {
    if (hit.bitmap) {
      const v = bitmaps.version(hit.bitmap.id);
      if (v !== hit.bitmap.v) {
        const d = bitmaps.dirtySince(hit.bitmap.id, hit.bitmap.v);
        const dr = d ? intersectRect(coverRect(d.x, d.y, d.width, d.height), whole) : whole;
        if (dr) hit.stale = unionRect(hit.stale, dr);
        hit.bitmap.v = v;
      }
    }
    if (!hit.stale) return hit;
    const st = hit.stale;
    hit.stale = null;
    if (computeClipBase(hit, st, false)) return hit;
    // The core now reaches beyond the shape: recompute everything with coverage canvases.
    computeClipBase(hit, whole, true);
    slots.set(key, sig, hit, 0, { layerId: base.id, max: 2, res: [hit.norm, hit.cover, hit.share] });
    return hit;
  }
  const cb: ClipBase = { shape, core: R.core, w: shape.width, h: shape.height, norm: null, cover: null, share: null, stale: null };
  if (base.type === 'raster' && borrowed.has(shape) && bitmaps.tryGet(base.bitmapId) === shape) cb.bitmap = { id: base.bitmapId, v: bitmaps.version(base.bitmapId) };
  computeClipBase(cb, whole, true);
  slots.set(key, sig, cb, 0, { layerId: base.id, max: 2, res: [cb.norm, cb.cover, cb.share] });
  return cb;
}

/**
 * Base layer + clipped layers (Photoshop clipping, see ./clip.ts): the stack's coverage is the
 * base's — clipped layers never add any — and each clipped layer blends "atop" what is below it.
 * The stack is composited over the base made opaque (its normalized colour), clipped layers with
 * plain source-over blending, then the base's coverage is applied with destination-in.
 */
function compositeClipStack(rc: RC, acc: Acc, base: Layer, R: LayerRender, clipped: Layer[]) {
  const a = Math.max(0, Math.min(1, base.opacity));
  if (a <= 0 || !R.shape) return;
  const reg = R.region;
  // Incremental composite: rebuild only the part of the stack inside the accumulator's clip,
  // starting on the region's pixel grid (adjustments in the stack see the same pixel phase).
  let wr: PxRect | null = reg;
  if (acc.clip) {
    const c = intersectRect(reg, acc.clip);
    wr = c && alignRect(c, reg, 64);
    if (!wr) {
      markDrawn(acc, reg);
      return;
    }
  }
  const cb = clipBaseFor(rc, base, R);
  const G = acquire(wr.w, wr.h);
  buildClipStack(rc, cb, reg, G, wr, clipped);
  const g = ctx2d(G);
  const gx = reg.x - wr.x;
  const gy = reg.y - wr.y;
  // The base's coverage.
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(cb.cover ?? R.shape, gx, gy);
  g.globalCompositeOperation = 'source-over';
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
  ctx.drawImage(G, wr.x - acc.x, wr.y - acc.y);
  ctx.restore();
  release(G);
  markDrawn(acc, reg);
}

/**
 * Composite a clip stack into the cleared canvas G, which covers `wr` (output px) of the base
 * render's region `reg`: the normalized base, then each clipped layer (adjustments applied to what
 * is below them in the stack). The base's coverage is NOT applied (G's alpha is the normalized
 * base's, plus whatever clipped layers drew outside it).
 */
function buildClipStack(rc: RC, cb: ClipBase, reg: PxRect, G: HTMLCanvasElement, wr: PxRect, clipped: Layer[]) {
  const g = ctx2d(G);
  // Region-local (0,0) inside G.
  const gx = reg.x - wr.x;
  const gy = reg.y - wr.y;
  if (cb.norm) g.drawImage(cb.norm, gx, gy);
  const gAcc: Acc = { canvas: G, ctx: g, x: wr.x, y: wr.y, w: wr.w, h: wr.h, bounds: wr, root: false, clip: null, cropOf: sameRect(wr, reg) ? undefined : reg };
  for (const c of clipped) {
    if (c.type === 'adjustment') {
      applyAdjustment(rc, gAcc, c);
      continue;
    }
    const CR = renderLayer(rc, c);
    if (!CR) continue;
    const ca = Math.max(0, Math.min(1, c.opacity));
    if (ca <= 0) continue;
    const op = c.type === 'group' && c.blendMode === 'pass-through' ? 'source-over' : compositeOp(c.blendMode);
    const dx = CR.region.x - wr.x;
    const dy = CR.region.y - wr.y;
    if (!CR.behind.length && !cb.share) {
      // Only the core: blended straight onto the stack.
      if (CR.core) {
        g.globalAlpha = ca;
        g.globalCompositeOperation = op;
        g.drawImage(CR.core, dx, dy);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
      continue;
    }
    // Behind pieces + core as one layer (blended with the layer's mode), limited to its share.
    const T = acquire(wr.w, wr.h);
    const t = ctx2d(T);
    for (const b of CR.behind) {
      t.globalCompositeOperation = b.op;
      t.drawImage(b.canvas, dx, dy);
    }
    t.globalCompositeOperation = 'source-over';
    if (CR.core) t.drawImage(CR.core, dx, dy);
    if (cb.share) {
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(cb.share, gx, gy);
    }
    g.globalAlpha = ca;
    g.globalCompositeOperation = op;
    g.drawImage(T, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    release(T);
  }
}

/** What a clipped layer sees of its clip stack (see clipStackBackdrop). Canvases are fresh. */
export interface ClipStackBackdrop {
  /** Output-px rect of the canvases (the base render's region; may reach beyond the document). */
  rect: PxRect;
  /**
   * The stack below the layer before the base's coverage is applied: the base's normalized colour
   * (its core made opaque, without its behind-stage effects) with the clipped layers below
   * composited on it — exactly what a clipped adjustment at that position filters.
   */
  stack: HTMLCanvasElement;
  /** The stack's coverage (alpha): the base's shape, or its core where that reaches beyond it. */
  cover: HTMLCanvasElement;
  /** Share of the coverage clipped layers may paint (alpha), or null when it is all of it. */
  share: HTMLCanvasElement | null;
}

/**
 * The clip stack below the clipped layer `id` as the compositor builds it (PSD export bakes
 * clipped adjustments from it). Stacks are found like compositeList groups them: a non-adjustment
 * layer followed by the clipped layers above it. Hidden clipped layers below `id` are skipped; a
 * hidden base is rendered anyway (the stack is what the layer would see with the base shown).
 * Null when `id` is not part of a clip stack (not clipped, or clipped right above an adjustment,
 * which the compositor applies unclipped); 'empty' when the base draws nothing (neither does the
 * stack).
 */
export function clipStackBackdrop(rc: RC, id: ID): ClipStackBackdrop | 'empty' | null {
  const doc = rc.doc;
  const parent = Object.values(doc.layers).find((g): g is GroupLayer => g.type === 'group' && g.childIds.includes(id));
  const ids = parent ? parent.childIds : doc.rootIds;
  const k = ids.indexOf(id);
  if (k < 0 || !doc.layers[id]?.clipped) return null;
  let base: Layer | null = null;
  let start = -1;
  for (let i = 0; i < k; ) {
    const l = doc.layers[ids[i]];
    if (!l || l.type === 'adjustment') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < ids.length && doc.layers[ids[j]]?.clipped) j++;
    if (k < j) {
      base = l;
      start = i;
      break;
    }
    i = j;
  }
  if (!base) return null;
  const R = renderLayer(rc, base);
  if (!R || !R.shape) return 'empty';
  const clipped: Layer[] = [];
  for (let i = start + 1; i < k; i++) {
    const c = doc.layers[ids[i]];
    if (c && isShown(rc, c)) clipped.push(c);
  }
  const reg = R.region;
  const cb = clipBaseFor(rc, base, R);
  const stack = fresh(reg.w, reg.h);
  buildClipStack(rc, cb, reg, stack, reg, clipped);
  const copy = (src: HTMLCanvasElement) => {
    const c = fresh(reg.w, reg.h);
    ctx2d(c).drawImage(src, 0, 0);
    return c;
  };
  return { rect: { ...reg }, stack, cover: copy(cb.cover ?? R.shape), share: cb.share ? copy(cb.share) : null };
}

/** A layer render split into its parts (see layerParts). Canvases are fresh, output-sized. */
export interface LayerParts {
  /** Behind-stage effect pieces in composite order, each drawn with its own operation. */
  behind: { canvas: HTMLCanvasElement; op: GlobalCompositeOperation }[];
  /** Content at fill opacity + above-stage effects (null: nothing, e.g. 0 % fill). */
  core: HTMLCanvasElement | null;
  /** Whether the layer has active above-stage effects. */
  above: boolean;
  /** Whether the core's alpha exceeds the content's anywhere (an above-stage effect adds coverage). */
  coreBeyondShape: boolean;
}

/**
 * A layer's render as the compositor draws it — behind pieces (already knocked out under the
 * content when the layer is drawn at a lower opacity or fill), then the core — each placed on an
 * output-sized canvas (PSD export: styles as layers of their own).
 */
export function layerParts(rc: RC, l: Layer, flags: RenderFlags): LayerParts | null {
  const R = renderLayer(rc, l, flags);
  if (!R) return null;
  const place = (c: HTMLCanvasElement) => {
    const out = fresh(rc.W, rc.H);
    ctx2d(out).drawImage(c, R.region.x, R.region.y);
    return out;
  };
  const above = flags.effects && activeEffects(l).some((e) => effectStage(e.def, e.params) !== 'behind');
  let beyond = false;
  if (R.core && R.shape && R.core !== R.shape) {
    const r: PxRect = { x: 0, y: 0, w: Math.min(R.core.width, R.shape.width), h: Math.min(R.core.height, R.shape.height) };
    beyond = coreExceedsShape(readImage(R.core, r).data, readImage(R.shape, r).data);
  }
  return { behind: R.behind.map((b) => ({ canvas: place(b.canvas), op: b.op })), core: R.core ? place(R.core) : null, above, coreBeyondShape: beyond };
}

/** Apply an adjustment layer to what has been composited so far in `acc`. */
function applyAdjustment(rc: RC, acc: Acc, adj: AdjustmentLayer) {
  const inst = adj.adjustment;
  const def = inst && filters.get(inst.filterId);
  if (!def || !inst.enabled) return;
  const opacity = Math.max(0, Math.min(1, adj.opacity * (Number.isFinite(adj.fillOpacity) ? adj.fillOpacity : 1) * (inst.opacity ?? 1)));
  if (opacity <= 0 || !acc.bounds) return;
  const full = intersectRect(acc.bounds, accRect(acc));
  let abs = full;
  if (full && acc.clip) {
    // Incremental composite: only the clip (the canvas clip limits the write-back), starting on
    // the full rect's pixel grid so position-dependent filters (ordered dither) and the mask's
    // feather blur line up with a full render.
    const c = intersectRect(full, acc.clip);
    abs = c && alignRect(c, full, alignGrid(maskSigma(adj.mask, rc.s)));
  }
  if (!abs || !full) return;
  // The mask as a full render computes it (over the full accumulator rect), see maskOver.
  const mk = adj.mask && adj.mask.enabled ? maskOver(rc, adj.mask, acc.cropOf ?? full, abs) : null;
  if (mk?.approx) markApprox(rc, null, abs);
  const r: PxRect = { x: abs.x - acc.x, y: abs.y - acc.y, w: abs.w, h: abs.h };
  renderStats.adjustments++;
  const ctx = acc.ctx;
  const blend = adj.blendMode !== 'normal' && isBlendable(adj.blendMode) ? adj.blendMode : null;
  let img: ImageData;
  try {
    if (acc.clip || blend) {
      // Read through a CPU scratch copy. Incremental composite (the live viewport canvas, below
      // caches): Chrome moves a GPU canvas to the CPU once it is read back, and the live canvas
      // must stay accelerated (every brush frame draws layer renders into it). Blend mode: the
      // backdrop's straight colour feeds the blend as is, and a GPU readback un-premultiplies
      // soft pixels with a different rounding than a CPU one — full and incremental composites
      // must read the same colours.
      const R = acquire(r.w, r.h, { read: true });
      const rc2 = ctx2d(R, { willReadFrequently: true });
      rc2.drawImage(acc.canvas, -r.x, -r.y);
      img = rc2.getImageData(0, 0, r.w, r.h);
      release(R);
    } else img = ctx.getImageData(r.x, r.y, r.w, r.h);
  } catch (err) {
    warnOnce('adjustment readback failed', err);
    if (mk?.temp) release(mk.canvas);
    return;
  }
  // Blend mode: the result is B(backdrop, filtered) "atop" the backdrop — its colour blended over
  // the backdrop's straight colour, its alpha the backdrop's (an adjustment never changes
  // coverage, also over semi-transparent pixels). Computed on the CPU (./blendMath.ts): canvas
  // blending rounds ties differently depending on the surfaces, so a crop (incremental composite)
  // and a full render could differ. The backdrop copy is taken first: filters may work in place.
  let backdrop: ImageData | null = null;
  if (blend) {
    backdrop = ctx.createImageData(r.w, r.h);
    backdrop.data.set(img.data);
  }
  let out = runFilter(def, img, inst.params, makeFilterContext({ docWidth: rc.doc.width, docHeight: rc.doc.height, offsetX: abs.x / rc.s, offsetY: abs.y / rc.s, scale: rc.s }));
  if (blend && backdrop) {
    blendAtop(backdrop.data, out.data, blend);
    out = backdrop;
  }
  const F = acquire(r.w, r.h);
  ctx2d(F).putImageData(out, 0, 0);
  lerpInto(ctx, F, opacity, mk?.canvas ?? null, r.x, r.y);
  release(F);
  if (mk?.temp) release(mk.canvas);
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
  // Accumulator-local rect to lerp: everything, or (incremental composite) the clip, aligned to
  // the accumulator's grid so the mask's feather blur matches a full render.
  const all: PxRect = { x: 0, y: 0, w: acc.w, h: acc.h };
  let wr: PxRect | null = all;
  if (acc.clip) {
    const c = intersectRect({ x: acc.clip.x - acc.x, y: acc.clip.y - acc.y, w: acc.clip.w, h: acc.clip.h }, all);
    wr = c && alignRect(c, all, alignGrid(maskSigma(masked ? g.mask : null, rc.s)));
  }
  if (!wr) {
    // Nothing visible to update; still composite for the bookkeeping (bounds, `below` stop).
    compositeList(rc, g.childIds, acc);
    return;
  }
  const before = acquire(wr.w, wr.h);
  ctx2d(before).drawImage(acc.canvas, -wr.x, -wr.y);
  const boundsBefore = acc.bounds;
  compositeList(rc, g.childIds, acc);
  const after = acquire(wr.w, wr.h);
  ctx2d(after).drawImage(acc.canvas, -wr.x, -wr.y);
  const ctx = acc.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(wr.x, wr.y, wr.w, wr.h);
  ctx.drawImage(before, wr.x, wr.y);
  ctx.restore();
  // The mask as a full render computes it (over the whole accumulator), see maskOver.
  const abs: PxRect = { x: acc.x + wr.x, y: acc.y + wr.y, w: wr.w, h: wr.h };
  const mk = masked ? maskOver(rc, g.mask!, acc.cropOf ?? accRect(acc), abs) : null;
  if (mk?.approx) markApprox(rc, null, abs);
  lerpInto(ctx, after, a, mk?.canvas ?? null, wr.x, wr.y);
  release(before, after);
  if (mk?.temp) release(mk.canvas);
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
  // clearRect + source-over is an exact copy of premultiplied pixels. The 'copy' operation is
  // avoided on purpose: on GPU canvases Chrome draws it through its unbounded-composite path,
  // which (with a clip, mid-way through deferred drawing) did not reproduce the source exactly.
  acc.ctx.globalCompositeOperation = 'source-over';
  acc.ctx.globalAlpha = 1;
  acc.ctx.clearRect(0, 0, acc.w, acc.h);
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
  /** Structure signature of the item's layer (see structSig), when shown. */
  ssig?: string;
  /** Bitmap versions the item was composited from, when shown. */
  deps?: DepList;
}

interface DocEntry {
  canvas: HTMLCanvasElement;
  items: DocItem[];
}

/** A flattened composite item as computed for the current document state. */
interface RawItem {
  id: ID;
  sig: string;
  layer: Layer | null;
  /** Index in doc.rootIds of the top-level layer this item belongs to. */
  root: number;
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
function docItems(rc: RC, ids: ID[], st: { stopped: boolean }, out: RawItem[], root = -1) {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const r = root >= 0 ? root : i;
    if (st.stopped) return;
    if (id === rc.below) {
      st.stopped = true;
      out.push({ id: 'below', sig: 'B', layer: null, root: r });
      return;
    }
    const l = rc.doc.layers[id];
    if (!l) continue;
    if (l.type === 'group' && isShown(rc, l) && inlinePassThrough(l)) {
      out.push({ id, sig: `G${objId(l)}`, layer: null, root: r });
      docItems(rc, l.childIds, st, out, r);
      out.push({ id, sig: 'g', layer: null, root: r });
      continue;
    }
    out.push({ id, sig: listSig(rc, [id], st), layer: isShown(rc, l) ? l : null, root: r });
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

function makeItem(rc: RC, r: RawItem): DocItem {
  return {
    id: r.id,
    sig: r.sig,
    region: itemRegion(rc, r.layer),
    ssig: r.layer ? structSig(rc, r.layer) : undefined,
    deps: r.layer ? depList(rc, r.layer) : undefined,
  };
}

/** Everything a document composite request resolves to (cache key, items, signature). */
interface DocState {
  rc: RC;
  doc: Document;
  key: string;
  /** Signature of the empty accumulator (background, size, generation). */
  base: string;
  bg: string;
  raw: RawItem[];
  sig: string;
  docR: PxRect;
}

function docState(doc: Document, o: DocRenderOptions): DocState {
  const rc = makeRC(doc, o.scale, o.hidden, o.below);
  const bg = o.background && doc.background ? doc.background : '';
  const hiddenKey = rc.hidden ? [...rc.hidden].sort().join(',') : '';
  const key = `D|${doc.id}|${rc.s.toFixed(5)}|${bg ? 'b' : ''}|${hiddenKey}|${rc.below ?? ''}`;
  const base = `bg:${bg}|${geometrySig(rc)}|g${cacheGeneration()}|`;
  const raw: RawItem[] = [];
  docItems(rc, doc.rootIds, { stopped: false }, raw);
  const sig = base + raw.map((r) => r.sig).join(';');
  return { rc, doc, key, base, bg, raw, sig, docR: { x: 0, y: 0, w: rc.W, h: rc.H } };
}

/** How to bring a composite up to date: the rect to re-composite (null = nothing visible changed). */
interface DocPlan {
  items: DocItem[];
  dirty: PxRect | null;
  /** Index in doc.rootIds of the only top-level layer that changed (-1 when several / none). */
  root: number;
}

/**
 * Plan an incremental composite from a previous one (same items, a few changed). Items whose
 * layer kept its structure and only had bitmap pixels touched (live painting) contribute just
 * the area their render changed (see changeOf); other changed items their old ∪ new regions.
 * Null when a full composite is needed (structure changed, an adjustment changed, too much
 * changed…).
 */
function planIncremental(st: DocState, old: DocItem[], maxFrac: number): DocPlan | null {
  const { rc, raw } = st;
  if (old.length !== raw.length) return null;
  for (let i = 0; i < raw.length; i++) if (raw[i].id !== old[i].id) return null;
  const changed: number[] = [];
  for (let i = 0; i < raw.length; i++) if (raw[i].sig !== old[i].sig) changed.push(i);
  if (changed.length > 8) return null;
  const items: DocItem[] = old.map((it, i) => ({ ...it, sig: raw[i].sig }));
  let D: PxRect | null = null;
  const roots = new Set<number>();
  for (const i of changed) {
    const r = raw[i];
    const it = old[i];
    roots.add(r.root);
    const l = r.layer;
    if (l && it.deps && it.ssig !== undefined && structSig(rc, l) === it.ssig) {
      const ch = changeOf(rc, l, new Map(it.deps), FULL_FLAGS);
      if (ch !== 'full') {
        // Brings the layer's cached render up to date (in place) before compositing.
        items[i].region = itemRegion(rc, l);
        items[i].deps = depList(rc, l);
        D = unionRect(D, ch.out);
        continue;
      }
    }
    const nr = itemRegion(rc, l);
    const or = it.region;
    items[i].region = nr;
    items[i].ssig = l ? structSig(rc, l) : undefined;
    items[i].deps = l ? depList(rc, l) : undefined;
    if (nr === 'full' || or === 'full') return null;
    D = unionRect(unionRect(D, or), nr);
  }
  const dirty = D ? intersectRect(D, st.docR) : null;
  if (dirty && dirty.w * dirty.h > maxFrac * rc.W * rc.H) return null;
  return { items, dirty, root: roots.size === 1 ? [...roots][0] : -1 };
}

/** Start index of the clipping stack (base + clipped layers) a top-level index belongs to. */
function stackStart(rc: RC, ids: ID[], r: number): number {
  let i = 0;
  while (i < ids.length) {
    const l = rc.doc.layers[ids[i]];
    let j = i + 1;
    if (l && l.type !== 'adjustment') while (j < ids.length && rc.doc.layers[ids[j]]?.clipped) j++;
    if (r < j) return i;
    i = j;
  }
  return r;
}

/* ---------------- below cache (live painting) ---------------- */

/**
 * The accumulator right before a top-level index (everything below the layer being painted),
 * filled lazily in tiles as strokes reach them. While a stroke goes on, each frame restores the
 * stroke region from here and composites only the painted layer and what lies above it.
 * Valid while everything below keeps its signature (the slot signature is the prefix signature).
 */
interface BelowCache {
  index: number;
  canvas: HTMLCanvasElement;
  valid: Uint8Array;
  tilesX: number;
  tilesY: number;
  /** Accumulator bounds after the layers below (see Acc.bounds). */
  bounds: PxRect | null;
}

const BELOW_TILE = 128;

function belowCache(st: DocState, index: number, prefix: string[]): BelowCache | null {
  const p = prefix[index - 1];
  if (index <= 0 || st.rc.below || p === undefined) return null;
  const key = `SB|${st.key}`;
  const sig = `${index}|${p}`;
  const hit = slots.get<BelowCache>(key, sig);
  if (hit) return hit;
  const tilesX = Math.ceil(st.rc.W / BELOW_TILE);
  const tilesY = Math.ceil(st.rc.H / BELOW_TILE);
  const b: BelowCache = { index, canvas: fresh(st.rc.W, st.rc.H), valid: new Uint8Array(tilesX * tilesY), tilesX, tilesY, bounds: null };
  slots.set(key, sig, b, 0, { composite: true, max: 1, layerId: docTag(st.doc.id), res: [b.canvas] });
  return b;
}

/** Composite the layers below into the tiles of `b` that `r` touches and are not filled yet. */
function fillBelow(st: DocState, b: BelowCache, r: PxRect, prefix: string[]) {
  const T = BELOW_TILE;
  const tx0 = Math.max(0, Math.floor(r.x / T));
  const ty0 = Math.max(0, Math.floor(r.y / T));
  const tx1 = Math.min(b.tilesX - 1, Math.floor((r.x + r.w - 1) / T));
  const ty1 = Math.min(b.tilesY - 1, Math.floor((r.y + r.h - 1) / T));
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -1,
    by1 = -1;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (b.valid[ty * b.tilesX + tx]) continue;
      bx0 = Math.min(bx0, tx);
      by0 = Math.min(by0, ty);
      bx1 = Math.max(bx1, tx);
      by1 = Math.max(by1, ty);
    }
  }
  if (bx1 < 0) return;
  const R = intersectRect({ x: bx0 * T, y: by0 * T, w: (bx1 - bx0 + 1) * T, h: (by1 - by0 + 1) * T }, st.docR);
  if (!R) return;
  const { rc } = st;
  const ctx = ctx2d(b.canvas);
  ctx.save();
  resetDrawState(ctx);
  ctx.beginPath();
  ctx.rect(R.x, R.y, R.w, R.h);
  ctx.clip();
  ctx.clearRect(R.x, R.y, R.w, R.h);
  const acc: Acc = { canvas: b.canvas, ctx, x: 0, y: 0, w: rc.W, h: rc.H, bounds: null, root: true, clip: R };
  if (st.bg) {
    ctx.fillStyle = st.bg;
    ctx.fillRect(R.x, R.y, R.w, R.h);
    acc.bounds = st.docR;
  }
  const stopped = rc.stopped;
  // The cache outlives strokes: always exact (layers below that still hold approximate renders
  // re-render, masks come from their full rects).
  const approxOk = rc.approxOk;
  rc.approxOk = false;
  try {
    compositeList(rc, st.doc.rootIds.slice(0, b.index), acc, { prefix, base: st.base, store: false });
  } finally {
    rc.approxOk = approxOk;
    rc.stopped = stopped;
  }
  ctx.restore();
  b.bounds = acc.bounds;
  for (let ty = by0; ty <= by1; ty++) for (let tx = bx0; tx <= bx1; tx++) b.valid[ty * b.tilesX + tx] = 1;
}

/**
 * Re-composite `plan.dirty` of `canvas` (which holds the previous composite) in place. When a
 * single top-level stack changed, the layers below it come from the below cache.
 */
function recomposite(st: DocState, plan: DocPlan, canvas: HTMLCanvasElement) {
  const dirty = plan.dirty;
  if (!dirty) return;
  const { rc, doc } = st;
  const ctx = ctx2d(canvas);
  ctx.save();
  resetDrawState(ctx);
  ctx.beginPath();
  ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
  ctx.clip();
  ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
  const acc: Acc = { canvas, ctx, x: 0, y: 0, w: rc.W, h: rc.H, bounds: null, root: true, clip: dirty };
  const prefix = prefixSigs(rc, doc.rootIds, st.base);
  const start = plan.root >= 0 ? stackStart(rc, doc.rootIds, plan.root) : -1;
  const below = start > 0 ? belowCache(st, start, prefix) : null;
  if (below) {
    fillBelow(st, below, dirty, prefix);
    // The dirty rect is clear: a source-over draw copies the cached pixels exactly.
    ctx.drawImage(below.canvas, 0, 0);
    acc.bounds = below.bounds;
    compositeList(rc, doc.rootIds.slice(start), acc);
  } else {
    if (st.bg) {
      ctx.fillStyle = st.bg;
      ctx.fillRect(dirty.x, dirty.y, dirty.w, dirty.h);
      acc.bounds = st.docR;
    }
    // Resume from a cached adjustment snapshot when everything below it is unchanged (editing
    // above a global adjustment never re-runs its filter).
    compositeList(rc, doc.rootIds, acc, { prefix, base: st.base, store: false });
  }
  ctx.restore();
}

function storeDoc(st: DocState, canvas: HTMLCanvasElement, items: DocItem[]) {
  slots.set(st.key, st.sig, { canvas, items } satisfies DocEntry, 0, { composite: true, max: 1, layerId: docTag(st.doc.id), res: [canvas] });
}

/** Composite the document (cached; the returned canvas must be treated as read-only). */
export function compositeDocument(doc: Document, o: DocRenderOptions): HTMLCanvasElement {
  const st = docState(doc, o);
  const { rc } = st;
  const prev = slots.peek<DocEntry>(st.key);
  if (prev && prev.sig === st.sig) {
    renderStats.docHits++;
    slots.get(st.key, st.sig);
    return prev.value.canvas;
  }
  renderStats.docRenders++;

  // Incremental path: only a few items changed → recomposite the area they changed, on a copy
  // (returned canvases are shared and must not change under their holders).
  if (prev && prev.sig.startsWith(st.base)) {
    const plan = planIncremental(st, prev.value.items, 0.55);
    if (plan) {
      if (!plan.dirty) {
        storeDoc(st, prev.value.canvas, plan.items);
        return prev.value.canvas;
      }
      const out = fresh(rc.W, rc.H);
      ctx2d(out).drawImage(prev.value.canvas, 0, 0);
      recomposite(st, plan, out);
      renderStats.docRegionRenders++;
      storeDoc(st, out, plan.items);
      return out;
    }
  }

  // Full composite (resuming from adjustment snapshots when possible).
  const out = fresh(rc.W, rc.H);
  const ctx = ctx2d(out);
  const acc: Acc = { canvas: out, ctx, x: 0, y: 0, w: rc.W, h: rc.H, bounds: null, root: true, clip: null };
  if (st.bg) {
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, rc.W, rc.H);
    acc.bounds = st.docR;
  }
  compositeList(rc, doc.rootIds, acc, { prefix: prefixSigs(rc, doc.rootIds, st.base), base: st.base, store: true });
  storeDoc(
    st,
    out,
    st.raw.map((r) => makeItem(rc, r)),
  );
  return out;
}

/* ---------------- live composite (viewport) ---------------- */

/** Result of compositeDocumentLive. */
export interface LiveComposite {
  /** The live canvas (owned by the renderer, updated in place by later calls). */
  canvas: HTMLCanvasElement;
  /**
   * Area (output px) that changed since the caller's previous result (`since`), or this call
   * alone when `since` is not given: empty when nothing changed, null = everything.
   */
  dirty: PxRect | null;
  /** Whether any pixel of the canvas may have changed. */
  changed: boolean;
  /** Version of the canvas content: pass it back as `since` on the next call. */
  seq: number;
}

interface LiveState {
  docId: ID;
  /** Render scale key (see scaleKey). */
  sk: string;
  /** Area (output px) holding approximate pixels to re-composite exactly (see settleApproximations). */
  pending: PxRect | null;
  canvas: HTMLCanvasElement;
  sig: string;
  items: DocItem[];
  /** Content version (bumped by every change). */
  seq: number;
  /** Recent changes, oldest first (rect null = everything). */
  log: ChangeEntry[];
}

/** Live composites per document composite key (most recent last). */
const liveStates = new Map<string, LiveState>();
const LIVE_MAX = 4;
/** Changes remembered per live composite (for callers that skipped a few updates). */
const LIVE_LOG = 64;
/** Live composite content versions are unique across states (a dropped state never matches). */
let liveSeq = 0;
const NO_RECT: PxRect = Object.freeze({ x: 0, y: 0, w: 0, h: 0 }) as PxRect;

function touchLive(key: string, cur: LiveState) {
  liveStates.delete(key);
  liveStates.set(key, cur);
  while (liveStates.size > LIVE_MAX) liveStates.delete(liveStates.keys().next().value!);
}

/**
 * Composite the document into a canvas owned by the renderer that is updated IN PLACE: when only
 * part of the document changed (a brush frame), only that area is re-composited and reported as
 * `dirty`, so the caller (the viewport) can redraw just that part. The canvas keeps its identity
 * across calls — do not hold on to it expecting it to stay unchanged. Callers pass the `seq` of
 * their previous result as `since` so changes made through other callers are reported too.
 */
export function compositeDocumentLive(doc: Document, o: DocRenderOptions, since?: number): LiveComposite {
  const st = docState(doc, o);
  let cur = liveStates.get(st.key);
  if (cur && (cur.canvas.width !== st.rc.W || cur.canvas.height !== st.rc.H)) cur = undefined;
  const result = (c: LiveState, own: PxRect | null): LiveComposite => {
    const dirty = since === undefined ? own : changesSince(c.log, c.seq, since);
    return { canvas: c.canvas, dirty, changed: !dirty || (dirty.w > 0 && dirty.h > 0), seq: c.seq };
  };
  const pending = cur?.pending ? intersectRect(cur.pending, st.docR) : null;
  if (cur && cur.sig === st.sig && !pending) {
    if (cur.pending) cur.pending = null;
    return result(cur, NO_RECT);
  }
  // Live composites may do approximate work (settled later), except when settling: then the
  // approximate area is re-composited exactly.
  st.rc.approxOk = !pending;
  if (cur && cur.sig.startsWith(st.base)) {
    const plan = cur.sig === st.sig ? { items: cur.items, dirty: null, root: -1 } : planIncremental(st, cur.items, 0.7);
    if (plan) {
      if (pending) {
        plan.dirty = unionRect(plan.dirty, pending);
        // Whatever is below the changed stack may hold approximate pixels too.
        plan.root = -1;
      }
      cur.pending = null;
      if (plan.dirty) {
        recomposite(st, plan, cur.canvas);
        cur.seq = ++liveSeq;
        cur.log.push({ seq: cur.seq, rect: plan.dirty });
        if (cur.log.length > LIVE_LOG) cur.log.splice(0, cur.log.length - LIVE_LOG);
      }
      cur.sig = st.sig;
      cur.items = plan.items;
      touchLive(st.key, cur);
      renderStats.liveRegionRenders++;
      return result(cur, plan.dirty ?? NO_RECT);
    }
  }
  renderStats.liveFullRenders++;
  const src = compositeDocument(doc, o);
  const entry = slots.peek<DocEntry>(st.key);
  let canvas = cur?.canvas;
  if (!canvas || canvas.width !== src.width || canvas.height !== src.height) canvas = fresh(src.width, src.height);
  const k = ctx2d(canvas);
  k.save();
  resetDrawState(k);
  k.clearRect(0, 0, canvas.width, canvas.height);
  k.drawImage(src, 0, 0);
  k.restore();
  const known = entry && entry.sig === st.sig;
  const seq = ++liveSeq;
  const next: LiveState = { docId: doc.id, sk: scaleKey(st.rc.s), pending: null, canvas, sig: known ? st.sig : '', items: known ? entry.value.items : [], seq, log: [{ seq, rect: null }] };
  touchLive(st.key, next);
  return result(next, null);
}

/** Forget live composites (of one document, or all). */
export function dropLiveComposites(docId?: ID) {
  if (docId === undefined) {
    liveStates.clear();
    return;
  }
  for (const [k, v] of liveStates) if (v.docId === docId) liveStates.delete(k);
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
