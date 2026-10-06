/** Layer helpers used by the move / transform / crop tools. */
import type { Document, ID, Layer, Point, Rect, TransformableLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { uid } from '../core/ids';
import { isEffectivelyVisible, isTransformable } from '../core/document';
import { getLayerBounds, getLayerSize, hitTestLayer } from '../render/compositor';
import { ctxRead } from '../core/canvas';
import { apply, fromTransform, invert, type Affine } from './math/affine';

export function parentMap(doc: Document): Map<ID, ID> {
  const m = new Map<ID, ID>();
  for (const l of Object.values(doc.layers)) if (l.type === 'group') for (const c of l.childIds) m.set(c, l.id);
  return m;
}

export function ancestorsOf(doc: Document, id: ID, parents = parentMap(doc)): ID[] {
  const out: ID[] = [];
  for (let p = parents.get(id); p; p = parents.get(p)) out.push(p);
  return out;
}

/** Position locked by the layer itself or any ancestor group. */
export function isPositionLocked(doc: Document, id: ID, parents = parentMap(doc)): boolean {
  for (let cur: ID | undefined = id; cur; cur = parents.get(cur)) {
    const l = doc.layers[cur];
    if (l && (l.locks.position || l.locks.all)) return true;
  }
  return false;
}

/** Drop ids whose ancestor is also in the list (keeps stacking order of input). */
export function topLevelIds(doc: Document, ids: ID[]): ID[] {
  const set = new Set(ids);
  const parents = parentMap(doc);
  return ids.filter((id) => doc.layers[id] && !ancestorsOf(doc, id, parents).some((a) => set.has(a)));
}

/** Transformable leaf layers under the given ids (groups expanded), split into movable/locked. */
export function transformableLeaves(doc: Document, ids: ID[]): { movable: ID[]; locked: ID[]; other: ID[] } {
  const parents = parentMap(doc);
  const movable: ID[] = [];
  const locked: ID[] = [];
  const other: ID[] = [];
  const seen = new Set<ID>();
  const visit = (id: ID) => {
    if (seen.has(id)) return;
    seen.add(id);
    const l = doc.layers[id];
    if (!l) return;
    if (l.type === 'group') {
      l.childIds.forEach(visit);
      return;
    }
    if (!isTransformable(l)) {
      other.push(id);
      return;
    }
    if (isPositionLocked(doc, id, parents)) locked.push(id);
    else movable.push(id);
  };
  topLevelIds(doc, ids).forEach(visit);
  return { movable, locked, other };
}

/** Local box size + local→doc matrix of a transformable layer. */
export function layerFrame(l: TransformableLayer): { w: number; h: number; m: Affine } {
  let size = { width: 1, height: 1 };
  try {
    size = getLayerSize(l);
  } catch {
    /* renderer mid-edit */
  }
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  return { w, h, m: fromTransform(l.transform, w, h) };
}

/** Doc-space corners (TL, TR, BR, BL) of a transformable layer. */
export function layerCorners(l: TransformableLayer): Point[] {
  const { w, h, m } = layerFrame(l);
  return [apply(m, { x: 0, y: 0 }), apply(m, { x: w, y: 0 }), apply(m, { x: w, y: h }), apply(m, { x: 0, y: h })];
}

export function safeBounds(doc: Document, id: ID): Rect | null {
  try {
    return getLayerBounds(doc, id);
  } catch {
    return null;
  }
}

export function unionBounds(doc: Document, ids: ID[]): Rect | null {
  let r: Rect | null = null;
  for (const id of ids) {
    const b = safeBounds(doc, id);
    if (!b) continue;
    if (!r) r = { ...b };
    else {
      const x = Math.min(r.x, b.x);
      const y = Math.min(r.y, b.y);
      r = { x, y, width: Math.max(r.x + r.width, b.x + b.width) - x, height: Math.max(r.y + r.height, b.y + b.height) - y };
    }
  }
  return r;
}

/** Group directly under the root that contains `id` (or the layer itself if top-level). */
export function topGroupOf(doc: Document, id: ID): ID {
  const parents = parentMap(doc);
  let cur = id;
  for (let p = parents.get(cur); p; p = parents.get(cur)) cur = p;
  return cur;
}

/** Ordered list of all leaf layers, topmost first (global stacking order). */
export function layersTopDown(doc: Document): ID[] {
  const out: ID[] = [];
  const walk = (ids: ID[]) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const l = doc.layers[ids[i]];
      if (!l) continue;
      if (l.type === 'group') walk(l.childIds);
      else out.push(l.id);
    }
  };
  walk(doc.rootIds);
  return out;
}

/**
 * Pick the topmost layer under a doc point. Uses the renderer's hitTestLayer first, then falls
 * back to a geometric test (raster alpha / text & shape boxes) so auto-select works even while
 * the renderer is incomplete. `ignore` skips layers the caller sees through (hitTestLayer).
 */
export function pickLayer(doc: Document, x: number, y: number, ignore?: (l: Layer) => boolean): ID | null {
  let hit: ID | null = null;
  try {
    hit = hitTestLayer(doc, x, y, ignore);
  } catch {
    hit = null;
  }
  if (hit && doc.layers[hit]) return hit;
  const parents = parentMap(doc);
  for (const id of layersTopDown(doc)) {
    const l = doc.layers[id];
    if (!l || !isTransformable(l) || !isEffectivelyVisible(doc, id)) continue;
    if (l.locks.all || ignore?.(l)) continue;
    if (ancestorsOf(doc, id, parents).some((a) => doc.layers[a]?.locks.all)) continue;
    const { w, h, m } = layerFrame(l);
    const p = apply(invert(m), { x, y });
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue;
    if (l.type === 'raster') {
      const bmp = bitmaps.tryGet(l.bitmapId);
      if (!bmp) continue;
      try {
        const a = ctxRead(bmp).getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data[3];
        if (a < 8) continue;
      } catch {
        continue;
      }
    }
    return id;
  }
  return null;
}

/**
 * Deep-clone a layer (and its children) with fresh ids. Raster bitmaps and masks are duplicated
 * so the copies can be edited independently. Returns all new layers and the new root id.
 */
export function cloneLayerTree(doc: Document, id: ID): { layers: Layer[]; rootId: ID } {
  const out: Layer[] = [];
  const clone = (srcId: ID): ID => {
    const src = doc.layers[srcId];
    const copy = structuredClone(src) as Layer;
    copy.id = uid('ly_');
    if (copy.type === 'raster' && bitmaps.has(copy.bitmapId)) copy.bitmapId = bitmaps.duplicate(copy.bitmapId);
    if (copy.mask && bitmaps.has(copy.mask.bitmapId)) copy.mask = { ...copy.mask, bitmapId: bitmaps.duplicate(copy.mask.bitmapId) };
    copy.effects = copy.effects.map((e) => ({ ...e, id: uid('fx_') }));
    copy.filters = copy.filters.map((f) => ({ ...f, id: uid('fx_') }));
    if (copy.type === 'group') copy.childIds = copy.childIds.map((c) => clone(c));
    out.push(copy);
    return copy.id;
  };
  const rootId = clone(id);
  return { layers: out, rootId };
}

/** Human name for a layer type in messages. */
export function kindLabel(l: Layer): string {
  switch (l.type) {
    case 'fill':
      return 'Fill layers';
    case 'adjustment':
      return 'Adjustment layers';
    case 'group':
      return 'Groups';
    case 'text':
      return 'Text layers';
    case 'shape':
      return 'Shape layers';
    default:
      return 'Layers';
  }
}
