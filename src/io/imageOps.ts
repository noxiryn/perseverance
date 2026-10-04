/**
 * Image menu operations on the whole document. Each is ONE undoable step: new bitmaps are created
 * for resampled/rotated pixels (the old ones stay referenced by history), the document JSON is
 * updated through commit().
 */
import type { Document, Guide, ID, LayerEffect, Rect, Selection, TransformableLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../core/canvas';
import { uid } from '../core/ids';
import { getLayerBounds, getLayerSize, renderDocument } from '../render/compositor';
import { maskBounds } from '../editor/selection';
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import {
  canvasSizeOffset,
  clampRect,
  opBakedTransform,
  opDocSize,
  opMapPoint,
  opTransform,
  scaleTransform,
  trimBounds,
  type CanvasOp,
} from './math';
import { isDocAligned, requireSession } from './util';
import { MAX_DOC_SIZE } from './newDocument';

const afterGeometryChange = () => {
  viewport.requestRender();
  requestAnimationFrame(() => viewport.fit());
};

/* ------------------------------------------------------------------ */
/* Image Size                                                          */
/* ------------------------------------------------------------------ */

export type ResampleMethod = 'smooth' | 'nearest';

function resample(src: HTMLCanvasElement, w: number, h: number, method: ResampleMethod): HTMLCanvasElement {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  let cur = src;
  if (method === 'smooth') {
    // Stepwise halving keeps big reductions smooth.
    while (cur.width / 2 >= w && cur.height / 2 >= h && cur.width > 2 && cur.height > 2) {
      const half = createCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const hc = ctx2d(half);
      hc.imageSmoothingQuality = 'high';
      hc.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
  }
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = method === 'smooth';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

const STYLE_SIZE_KEYS = ['size', 'distance', 'length'];

function scaleEffects(effects: LayerEffect[], k: number): LayerEffect[] {
  return effects.map((e) => {
    const params = { ...e.params };
    for (const key of STYLE_SIZE_KEYS) {
      const v = params[key];
      if (typeof v === 'number') params[key] = Math.round(v * k * 100) / 100;
    }
    return { ...e, params };
  });
}

/** Resample the document (and every layer, mask, selection, guide) to newW × newH. */
export function resizeImage(newW: number, newH: number, opts: { method?: ResampleMethod; scaleStyles?: boolean } = {}) {
  const s = requireSession('change the image size');
  if (!s) return;
  const doc = s.doc;
  newW = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(newW)));
  newH = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(newH)));
  if (newW === doc.width && newH === doc.height) return;
  const sx = newW / doc.width;
  const sy = newH / doc.height;
  const method = opts.method ?? 'smooth';
  const k = Math.sqrt(sx * sy);

  // Precompute new bitmaps outside the recipe.
  const newRaster = new Map<ID, { id: ID; w: number; h: number }>();
  const newMasks = new Map<ID, ID>();
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') {
      const src = bitmaps.tryGet(l.bitmapId);
      if (src) {
        const w = Math.max(1, Math.round(l.width * sx));
        const h = Math.max(1, Math.round(l.height * sy));
        newRaster.set(l.id, { id: bitmaps.add(resample(src, w, h, method)), w, h });
      }
    }
    if (l.mask && !newMasks.has(l.mask.bitmapId)) {
      const src = bitmaps.tryGet(l.mask.bitmapId);
      if (src) newMasks.set(l.mask.bitmapId, bitmaps.add(resample(src, newW, newH, 'smooth')));
    }
  }
  let selection: Selection | null = null;
  if (doc.selection) {
    const src = bitmaps.tryGet(doc.selection.bitmapId);
    if (src) {
      const c = resample(src, newW, newH, 'smooth');
      const b = maskBounds(c);
      if (b) {
        const shape = doc.selection.shape
          ? { ...doc.selection.shape, rect: { x: doc.selection.shape.rect.x * sx, y: doc.selection.shape.rect.y * sy, width: doc.selection.shape.rect.width * sx, height: doc.selection.shape.rect.height * sy } }
          : null;
        selection = { bitmapId: bitmaps.add(c), bounds: b, shape };
      }
    }
  }

  useEditor.getState().commit('Image Size', (d) => {
    d.width = newW;
    d.height = newH;
    for (const l of Object.values(d.layers)) {
      if (l.type === 'raster') {
        const r = newRaster.get(l.id);
        if (r) {
          const cx = (l.transform.x + l.width / 2) * sx;
          const cy = (l.transform.y + l.height / 2) * sy;
          l.bitmapId = r.id;
          l.width = r.w;
          l.height = r.h;
          l.transform = { ...l.transform, x: cx - r.w / 2, y: cy - r.h / 2 };
        }
      } else if (l.type === 'text' || l.type === 'shape') {
        const size = getLayerSize(l);
        l.transform = scaleTransform(l.transform, size.width, size.height, sx, sy);
      }
      if (l.mask) l.mask = { ...l.mask, bitmapId: newMasks.get(l.mask.bitmapId) ?? l.mask.bitmapId, feather: l.mask.feather * k };
      if (opts.scaleStyles !== false && l.effects.length) l.effects = scaleEffects(l.effects, k);
    }
    d.selection = selection;
    d.guides = d.guides.map((g) => ({ ...g, position: g.position * (g.orientation === 'horizontal' ? sy : sx) }));
  });
  afterGeometryChange();
}

/* ------------------------------------------------------------------ */
/* Canvas Size (also used by crop / trim / reveal all)                 */
/* ------------------------------------------------------------------ */

function maskExtensionColor(src: HTMLCanvasElement): string {
  // Masks extend with their dominant corner value (white for "reveal all", black for "hide all").
  const ctx = ctxRead(src);
  const w = src.width - 1;
  const h = src.height - 1;
  let sum = 0;
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ])
    sum += ctx.getImageData(x, y, 1, 1).data[0];
  return sum / 4 >= 128 ? '#ffffff' : '#000000';
}

/**
 * Resize the canvas to newW × newH, placing the old canvas at (dx, dy). `extension` fills the new
 * area of the bottom Background layer (null = transparent).
 */
export function resizeCanvas(newW: number, newH: number, dx: number, dy: number, extension: string | null, label = 'Canvas Size') {
  const s = activeSession();
  if (!s) return;
  const doc = s.doc;
  newW = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(newW)));
  newH = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(newH)));
  dx = Math.round(dx);
  dy = Math.round(dy);
  if (newW === doc.width && newH === doc.height && !dx && !dy) return;

  // Bottom doc-aligned raster layer = "Background": keep it covering the new canvas.
  const bottom = doc.layers[doc.rootIds[0]];
  const bg = bottom && bottom.type === 'raster' && isDocAligned(bottom, doc) ? bottom : null;
  let bgBitmap: ID | null = null;
  if (bg) {
    const src = bitmaps.tryGet(bg.bitmapId);
    const c = createCanvas(newW, newH);
    const ctx = ctx2d(c);
    if (extension) {
      ctx.fillStyle = extension;
      ctx.fillRect(0, 0, newW, newH);
      ctx.clearRect(dx, dy, doc.width, doc.height);
    }
    if (src) ctx.drawImage(src, dx, dy);
    bgBitmap = bitmaps.add(c);
  }
  const newMasks = new Map<ID, ID>();
  for (const l of Object.values(doc.layers)) {
    if (!l.mask || newMasks.has(l.mask.bitmapId)) continue;
    const src = bitmaps.tryGet(l.mask.bitmapId);
    if (!src) continue;
    const c = createCanvas(newW, newH);
    const ctx = ctx2d(c);
    ctx.fillStyle = maskExtensionColor(src);
    ctx.fillRect(0, 0, newW, newH);
    ctx.clearRect(dx, dy, doc.width, doc.height);
    ctx.drawImage(src, dx, dy);
    newMasks.set(l.mask.bitmapId, bitmaps.add(c));
  }
  let selection: Selection | null = null;
  if (doc.selection && label !== 'Crop') {
    const src = bitmaps.tryGet(doc.selection.bitmapId);
    if (src) {
      const c = createCanvas(newW, newH);
      ctx2d(c).drawImage(src, dx, dy);
      const b = maskBounds(c);
      if (b) {
        const sh = doc.selection.shape;
        selection = { bitmapId: bitmaps.add(c), bounds: b, shape: sh ? { ...sh, rect: { ...sh.rect, x: sh.rect.x + dx, y: sh.rect.y + dy } } : null };
      }
    }
  }

  useEditor.getState().commit(label, (d) => {
    d.width = newW;
    d.height = newH;
    for (const l of Object.values(d.layers)) {
      if (bg && l.id === bg.id && l.type === 'raster' && bgBitmap) {
        l.bitmapId = bgBitmap;
        l.width = newW;
        l.height = newH;
      } else if (l.type === 'raster' || l.type === 'text' || l.type === 'shape') {
        l.transform = { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy };
      }
      if (l.mask) l.mask = { ...l.mask, bitmapId: newMasks.get(l.mask.bitmapId) ?? l.mask.bitmapId };
    }
    d.selection = selection;
    d.guides = d.guides
      .map((g) => ({ ...g, position: g.position + (g.orientation === 'horizontal' ? dy : dx) }))
      .filter((g) => g.position >= 0 && g.position <= (g.orientation === 'horizontal' ? newH : newW));
  });
  afterGeometryChange();
}

export function canvasSize(newW: number, newH: number, anchor: number, extension: string | null) {
  const s = requireSession('change the canvas size');
  if (!s) return;
  const { dx, dy } = canvasSizeOffset(s.doc.width, s.doc.height, Math.round(newW), Math.round(newH), anchor);
  resizeCanvas(newW, newH, dx, dy, extension, 'Canvas Size');
}

/* ------------------------------------------------------------------ */
/* Image Rotation                                                      */
/* ------------------------------------------------------------------ */

/** Apply the pixel mapping of a canvas op to a w×h canvas (returns a new canvas). */
function opCanvas(op: CanvasOp, src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const size = opDocSize(op, w, h);
  const c = createCanvas(size.width, size.height);
  const ctx = ctx2d(c);
  switch (op) {
    case 'rotate90cw':
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case 'rotate90ccw':
      ctx.translate(0, w);
      ctx.rotate(-Math.PI / 2);
      break;
    case 'rotate180':
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
      break;
    case 'flipH':
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      break;
    case 'flipV':
      ctx.translate(0, h);
      ctx.scale(1, -1);
      break;
  }
  ctx.drawImage(src, 0, 0);
  return c;
}

function mapRect(op: CanvasOp, r: Rect, w: number, h: number): Rect {
  const a = opMapPoint(op, r.x, r.y, w, h);
  const b = opMapPoint(op, r.x + r.width, r.y + r.height, w, h);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

const OP_LABELS: Record<CanvasOp, string> = {
  rotate90cw: 'Rotate Canvas 90° CW',
  rotate90ccw: 'Rotate Canvas 90° CCW',
  rotate180: 'Rotate Canvas 180°',
  flipH: 'Flip Canvas Horizontal',
  flipV: 'Flip Canvas Vertical',
};

export function rotateCanvas(op: CanvasOp) {
  const s = requireSession('rotate the canvas');
  if (!s) return;
  const doc = s.doc;
  const W = doc.width;
  const H = doc.height;
  const size = opDocSize(op, W, H);
  const swap = op === 'rotate90cw' || op === 'rotate90ccw';

  const newRaster = new Map<ID, { id: ID; w: number; h: number; transform: TransformableLayer['transform'] }>();
  const newMasks = new Map<ID, ID>();
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') {
      const baked = opBakedTransform(op, l.transform, l.width, l.height, W, H);
      const src = bitmaps.tryGet(l.bitmapId);
      if (baked && src) newRaster.set(l.id, { id: bitmaps.add(opCanvas(op, src)), w: baked.width, h: baked.height, transform: baked.transform });
    }
    if (l.mask && !newMasks.has(l.mask.bitmapId)) {
      const src = bitmaps.tryGet(l.mask.bitmapId);
      if (src) newMasks.set(l.mask.bitmapId, bitmaps.add(opCanvas(op, src)));
    }
  }
  let selection: Selection | null = null;
  if (doc.selection) {
    const src = bitmaps.tryGet(doc.selection.bitmapId);
    if (src) {
      const sh = doc.selection.shape;
      selection = {
        bitmapId: bitmaps.add(opCanvas(op, src)),
        bounds: mapRect(op, doc.selection.bounds, W, H),
        shape: sh ? { ...sh, rect: mapRect(op, sh.rect, W, H) } : null,
      };
    }
  }

  useEditor.getState().commit(OP_LABELS[op], (d) => {
    d.width = size.width;
    d.height = size.height;
    for (const l of Object.values(d.layers)) {
      if (l.type === 'raster') {
        const r = newRaster.get(l.id);
        if (r) {
          l.bitmapId = r.id;
          l.width = r.w;
          l.height = r.h;
          l.transform = r.transform;
        } else l.transform = opTransform(op, l.transform, l.width, l.height, W, H);
      } else if (l.type === 'text' || l.type === 'shape') {
        const sz = getLayerSize(l);
        l.transform = opTransform(op, l.transform, sz.width, sz.height, W, H);
      }
      if (l.mask) l.mask = { ...l.mask, bitmapId: newMasks.get(l.mask.bitmapId) ?? l.mask.bitmapId };
    }
    d.selection = selection;
    d.guides = d.guides.map((g): Guide => {
      if (g.orientation === 'horizontal') {
        const p = opMapPoint(op, 0, g.position, W, H);
        return swap ? { ...g, orientation: 'vertical', position: p.x } : { ...g, position: p.y };
      }
      const p = opMapPoint(op, g.position, 0, W, H);
      return swap ? { ...g, orientation: 'horizontal', position: p.y } : { ...g, position: p.x };
    });
  });
  afterGeometryChange();
}

/* ------------------------------------------------------------------ */
/* Crop / Trim / Reveal All                                            */
/* ------------------------------------------------------------------ */

export function cropToSelection() {
  const s = requireSession('crop');
  if (!s) return;
  const sel = s.doc.selection;
  if (!sel) {
    toast('Make a selection first — Crop trims the canvas to the selection bounds.', 'info', 3200);
    return;
  }
  const r = clampRect(sel.bounds, s.doc.width, s.doc.height);
  if (!r) {
    toast('The selection is outside the canvas.', 'info');
    return;
  }
  resizeCanvas(r.width, r.height, -r.x, -r.y, null, 'Crop');
}

export type TrimBasis = 'transparent' | 'topLeft' | 'bottomRight';

export function trimDocument(basis: TrimBasis, sides = { top: true, bottom: true, left: true, right: true }) {
  const s = requireSession('trim');
  if (!s) return;
  const doc = s.doc;
  const comp = renderDocument(doc, { background: true });
  const data = ctxRead(comp).getImageData(0, 0, comp.width, comp.height);
  let bounds: Rect | null;
  if (basis === 'transparent') bounds = trimBounds(data, 'transparent', undefined, sides);
  else {
    const i = basis === 'topLeft' ? 0 : (data.width * data.height - 1) * 4;
    const c: [number, number, number, number] = [data.data[i], data.data[i + 1], data.data[i + 2], data.data[i + 3]];
    bounds = trimBounds(data, 'color', c, sides, 2);
  }
  if (!bounds) {
    toast('Trimming would remove everything — nothing was changed.', 'warning', 3200);
    return;
  }
  if (bounds.x === 0 && bounds.y === 0 && bounds.width === doc.width && bounds.height === doc.height) {
    toast(basis === 'transparent' ? 'There are no transparent edges to trim.' : 'There are no matching edges to trim.', 'info');
    return;
  }
  resizeCanvas(bounds.width, bounds.height, -bounds.x, -bounds.y, null, 'Trim');
}

export function revealAll() {
  const s = requireSession('reveal all');
  if (!s) return;
  const doc = s.doc;
  let minX = 0,
    minY = 0,
    maxX = doc.width,
    maxY = doc.height;
  for (const l of Object.values(doc.layers)) {
    if (l.type !== 'raster' && l.type !== 'text' && l.type !== 'shape') continue;
    const b = getLayerBounds(doc, l.id);
    if (!b) continue;
    minX = Math.min(minX, Math.floor(b.x));
    minY = Math.min(minY, Math.floor(b.y));
    maxX = Math.max(maxX, Math.ceil(b.x + b.width));
    maxY = Math.max(maxY, Math.ceil(b.y + b.height));
  }
  if (minX === 0 && minY === 0 && maxX === doc.width && maxY === doc.height) {
    toast('All layer content is already inside the canvas.', 'info');
    return;
  }
  if (maxX - minX > MAX_DOC_SIZE || maxY - minY > MAX_DOC_SIZE) {
    toast(`Reveal All would exceed the maximum canvas size (${MAX_DOC_SIZE} px).`, 'warning');
    return;
  }
  resizeCanvas(maxX - minX, maxY - minY, -minX, -minY, null, 'Reveal All');
}

/* ------------------------------------------------------------------ */
/* Duplicate                                                           */
/* ------------------------------------------------------------------ */

/** Deep copy of a document with duplicated bitmaps (independent pixels) and a new id. */
export function duplicateDocument(doc: Document, name = `${doc.name} copy`): Document {
  const copy = structuredClone(doc) as Document;
  copy.id = uid('doc_');
  copy.name = name;
  const remap = new Map<ID, ID>();
  const dup = (id: ID): ID => {
    let n = remap.get(id);
    if (!n) {
      n = bitmaps.has(id) ? bitmaps.duplicate(id) : bitmaps.create(1, 1);
      remap.set(id, n);
    }
    return n;
  };
  for (const l of Object.values(copy.layers)) {
    if (l.type === 'raster') l.bitmapId = dup(l.bitmapId);
    if (l.mask) l.mask.bitmapId = dup(l.mask.bitmapId);
  }
  if (copy.selection) copy.selection.bitmapId = dup(copy.selection.bitmapId);
  return copy;
}

export function duplicateImage() {
  const s = requireSession('duplicate');
  if (!s) return;
  const copy = duplicateDocument(s.doc);
  useEditor.getState().openDocument(copy, { label: 'Duplicate', activeLayerId: s.activeLayerId });
  toast(`Created “${copy.name}”`, 'success');
}
