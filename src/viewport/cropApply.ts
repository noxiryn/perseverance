/**
 * Apply a crop to the active document: changes doc.width/height, offsets transformable layers and
 * guides, re-cuts doc-space masks and the selection into new bitmaps, and (optionally) deletes
 * pixels of raster layers that fall outside the new canvas. One undoable history step.
 */
import type { Document, ID, Rect, Selection, Transform } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d } from '../core/canvas';
import { isTransformable } from '../core/document';
import { viewport } from '../editor/viewport';
import { selectionFromCanvas } from '../editor/selection';
import { activeSession, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { apply, decompose, fromTransform, invert, mul, translate } from './math/affine';
import { roundCropRect } from './math/crop';
import { maskBackground } from './maskFollow';

interface RasterCut {
  bitmapId: ID;
  width: number;
  height: number;
  transform: Transform;
}

/** Crop a raster layer's bitmap to the part that lies inside the new canvas (w×h). */
function cutRaster(bitmapId: ID, lw: number, lh: number, t: Transform, w: number, h: number): RasterCut | null {
  const src = bitmaps.tryGet(bitmapId);
  if (!src) return null;
  const M = fromTransform(t, lw, lh);
  const inv = invert(M);
  const pts = [
    apply(inv, { x: 0, y: 0 }),
    apply(inv, { x: w, y: 0 }),
    apply(inv, { x: w, y: h }),
    apply(inv, { x: 0, y: h }),
  ];
  const u0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))));
  const v0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
  const u1 = Math.min(lw, Math.ceil(Math.max(...pts.map((p) => p.x))));
  const v1 = Math.min(lh, Math.ceil(Math.max(...pts.map((p) => p.y))));
  if (u0 === 0 && v0 === 0 && u1 === lw && v1 === lh) return null; // fully inside: keep as is
  if (u1 <= u0 || v1 <= v0) {
    // Entirely outside the new canvas: keep an empty 1×1 layer.
    return { bitmapId: bitmaps.create(1, 1), width: 1, height: 1, transform: { ...t, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 } };
  }
  const nw = u1 - u0;
  const nh = v1 - v0;
  const c = createCanvas(nw, nh);
  ctx2d(c).drawImage(src, -u0, -v0);
  const M2 = mul(M, translate(u0, v0));
  return { bitmapId: bitmaps.add(c), width: nw, height: nh, transform: decompose(M2, nw, nh, t) };
}

/** Re-cut a doc-space mask for the new canvas. */
function cutMask(bitmapId: ID, ox: number, oy: number, w: number, h: number): ID | null {
  const src = bitmaps.tryGet(bitmapId);
  if (!src) return null;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.fillStyle = maskBackground(src);
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, -ox, -oy);
  return bitmaps.add(c);
}

function cutSelection(sel: Selection, ox: number, oy: number, w: number, h: number): Selection | null {
  const src = bitmaps.tryGet(sel.bitmapId);
  if (!src) return null;
  const c = createCanvas(w, h);
  ctx2d(c).drawImage(src, -ox, -oy);
  let shape: Selection['shape'] = null;
  if (sel.shape) {
    const r = { ...sel.shape.rect, x: sel.shape.rect.x - ox, y: sel.shape.rect.y - oy };
    const inside = r.x >= 0 && r.y >= 0 && r.x + r.width <= w && r.y + r.height <= h;
    if (inside) shape = { type: sel.shape.type, rect: r };
    else if (sel.shape.type === 'rect') {
      const x0 = Math.max(0, r.x);
      const y0 = Math.max(0, r.y);
      const x1 = Math.min(w, r.x + r.width);
      const y1 = Math.min(h, r.y + r.height);
      if (x1 > x0 && y1 > y0) shape = { type: 'rect', rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    }
  }
  return selectionFromCanvas(c, shape);
}

/** Crop the active document to `rect` (doc px). Returns false when nothing changed. */
export function applyCrop(rect: Rect, opts: { deletePixels: boolean; label?: string } = { deletePixels: false }): boolean {
  const s = activeSession();
  if (!s) return false;
  const doc: Document = s.doc;
  const r = roundCropRect(rect);
  const { x: ox, y: oy, width: w, height: h } = r;
  if (ox === 0 && oy === 0 && w === doc.width && h === doc.height) return false;
  if (w > 30000 || h > 30000) {
    toast('The crop is too large (max 30000 px).', 'warning');
    return false;
  }

  const masks = new Map<ID, ID>();
  const cuts = new Map<ID, RasterCut>();
  for (const l of Object.values(doc.layers)) {
    if (l.mask) {
      const m = cutMask(l.mask.bitmapId, ox, oy, w, h);
      if (m) masks.set(l.id, m);
    }
    if (opts.deletePixels && l.type === 'raster') {
      const t = { ...l.transform, x: l.transform.x - ox, y: l.transform.y - oy };
      const cut = cutRaster(l.bitmapId, l.width, l.height, t, w, h);
      if (cut) cuts.set(l.id, cut);
    }
  }
  const selection = doc.selection ? cutSelection(doc.selection, ox, oy, w, h) : null;

  // Keep the cropped content where it is on screen.
  const z = viewport.zoom();
  const v = s.view;

  useEditor.getState().commit(opts.label ?? 'Crop', (d) => {
    d.width = w;
    d.height = h;
    for (const l of Object.values(d.layers)) {
      const cut = cuts.get(l.id);
      if (cut && l.type === 'raster') {
        l.bitmapId = cut.bitmapId;
        l.width = cut.width;
        l.height = cut.height;
        l.transform = cut.transform;
      } else if (isTransformable(l)) {
        l.transform.x -= ox;
        l.transform.y -= oy;
      }
      const m = masks.get(l.id);
      if (m && l.mask) l.mask.bitmapId = m;
    }
    d.guides = d.guides.map((g) => ({ ...g, position: g.position - (g.orientation === 'vertical' ? ox : oy) }));
    d.selection = selection;
  });
  if (v.zoom) {
    useEditor.getState().setView({
      panX: v.panX + (ox + w / 2 - doc.width / 2) * z,
      panY: v.panY + (oy + h / 2 - doc.height / 2) * z,
    });
  }
  return true;
}
