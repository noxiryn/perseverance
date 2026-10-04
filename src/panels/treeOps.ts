/**
 * Pure layer-tree helpers used by the Layers panel and the Layer menu.
 * Everything here works on plain Document objects or immer drafts (no store, no canvas), so it
 * can be unit tested in isolation.
 */
import type { Document, GroupLayer, ID, Layer } from '../core/types';
import { childrenOf, detachLayerDraft, flattenIds, isAncestor, parentOf } from '../core/document';

/* ------------------------------------------------------------------ */
/* Selection helpers                                                   */
/* ------------------------------------------------------------------ */

function hasAncestorIn(doc: Document, id: ID, set: Set<ID>): boolean {
  let p = parentOf(doc, id);
  while (p) {
    if (set.has(p)) return true;
    p = parentOf(doc, p);
  }
  return false;
}

/**
 * The given ids without those whose ancestor group is also listed, ordered bottom → top in the
 * global stacking order. Unknown ids are dropped.
 */
export function orderedTopLevel(doc: Document, ids: ID[]): ID[] {
  const set = new Set(ids.filter((id) => doc.layers[id]));
  if (!set.size) return [];
  return flattenIds(doc).filter((id) => set.has(id) && !hasAncestorIn(doc, id, set));
}

/** All descendant ids of a group (depth first). */
export function descendantsOf(doc: Document, id: ID): ID[] {
  const l = doc.layers[id];
  if (!l || l.type !== 'group') return [];
  const out: ID[] = [];
  for (const c of l.childIds) {
    out.push(c);
    out.push(...descendantsOf(doc, c));
  }
  return out;
}

/** Ancestors of a layer, nearest first. */
export function ancestorsOf(doc: Document, id: ID): ID[] {
  const out: ID[] = [];
  let p = parentOf(doc, id);
  while (p) {
    out.push(p);
    p = parentOf(doc, p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Moving                                                              */
/* ------------------------------------------------------------------ */

/** True when `ids` may be moved into `parentId` (not into themselves or their descendants). */
export function canMoveInto(doc: Document, ids: ID[], parentId: ID | null): boolean {
  if (!parentId) return true;
  const target = doc.layers[parentId];
  if (!target || target.type !== 'group') return false;
  return !ids.some((id) => id === parentId || isAncestor(doc, id, parentId));
}

/**
 * Move several layers (ordered bottom → top) into `parentId` at `index` — the insertion index in
 * the target child list as it is BEFORE the move. Works on drafts. Returns false if invalid.
 */
export function moveLayersDraft(d: Document, ids: ID[], parentId: ID | null, index: number): boolean {
  const moving = ids.filter((id) => d.layers[id]);
  if (!moving.length || !canMoveInto(d, moving, parentId)) return false;
  const target = parentId ? (d.layers[parentId] as GroupLayer).childIds : d.rootIds;
  let idx = index;
  for (const id of moving) {
    const i = target.indexOf(id);
    if (i >= 0 && i < index) idx--;
  }
  for (const id of moving) detachLayerDraft(d, id);
  idx = Math.max(0, Math.min(idx, target.length));
  target.splice(idx, 0, ...moving);
  return true;
}

export type DropZone = 'above' | 'below' | 'into';

/**
 * Where a drop on a layers-panel row lands. Rows are shown top → bottom, child lists are stored
 * bottom → top. Dropping "below" an expanded group puts the layers at the top of its children.
 */
export function resolveDrop(doc: Document, rowId: ID, zone: DropZone): { parentId: ID | null; index: number } | null {
  const row = doc.layers[rowId];
  if (!row) return null;
  const parent = parentOf(doc, rowId) ?? null;
  const sibs = childrenOf(doc, parent);
  const i = sibs.indexOf(rowId);
  if (zone === 'into' && row.type === 'group') return { parentId: rowId, index: row.childIds.length };
  if (zone === 'above') return { parentId: parent, index: i + 1 };
  if (row.type === 'group' && !row.collapsed && row.childIds.length) return { parentId: rowId, index: row.childIds.length };
  return { parentId: parent, index: i };
}

export type ArrangeOp = 'front' | 'forward' | 'backward' | 'back';

/** Reorder the given layers within their own sibling lists. Works on drafts. Returns true if changed. */
export function arrangeDraft(d: Document, ids: ID[], op: ArrangeOp): boolean {
  const byParent = new Map<ID | null, ID[]>();
  for (const id of ids) {
    if (!d.layers[id]) continue;
    const p = parentOf(d, id) ?? null;
    const list = byParent.get(p) ?? [];
    list.push(id);
    byParent.set(p, list);
  }
  let changed = false;
  for (const [parent, selIds] of byParent) {
    const list = childrenOf(d, parent);
    const sel = new Set(selIds);
    const before = list.join('|');
    if (op === 'front' || op === 'back') {
      const rest = list.filter((x) => !sel.has(x));
      const moving = list.filter((x) => sel.has(x));
      list.splice(0, list.length, ...(op === 'front' ? [...rest, ...moving] : [...moving, ...rest]));
    } else if (op === 'forward') {
      for (let i = list.length - 2; i >= 0; i--) {
        if (sel.has(list[i]) && !sel.has(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
      }
    } else {
      for (let i = 1; i < list.length; i++) {
        if (sel.has(list[i]) && !sel.has(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
      }
    }
    if (list.join('|') !== before) changed = true;
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* Duplicating                                                         */
/* ------------------------------------------------------------------ */

/** Photoshop-style copy name: "Layer 1" → "Layer 1 copy" → "Layer 1 copy 2"… */
export function copyName(name: string, taken: Set<string>): string {
  const base = name.replace(/ copy( \d+)?$/, '');
  let candidate = `${base} copy`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base} copy ${n++}`;
  return candidate;
}

/**
 * Deep copy of a layer (recursively for groups) with fresh ids. Bitmaps (raster content and
 * masks) are duplicated through `dupBitmap`. The root gets a "copy" name.
 */
export function cloneLayerTree(
  doc: Document,
  id: ID,
  opts: { newId: (prefix: string) => ID; dupBitmap: (bitmapId: ID) => ID; rename?: boolean },
): { rootId: ID; layers: Layer[] } {
  const out: Layer[] = [];
  const taken = new Set(Object.values(doc.layers).map((l) => l.name));
  const clone = (srcId: ID, isRoot: boolean): ID => {
    const src = doc.layers[srcId];
    const l = structuredClone(src) as Layer;
    l.id = opts.newId('ly_');
    if (isRoot && opts.rename !== false) {
      l.name = copyName(src.name, taken);
      taken.add(l.name);
    }
    if (l.type === 'raster') {
      l.bitmapId = opts.dupBitmap(l.bitmapId);
    }
    if (l.mask) l.mask = { ...l.mask, bitmapId: opts.dupBitmap(l.mask.bitmapId) };
    l.effects = l.effects.map((e) => ({ ...e, id: opts.newId('ef_') }));
    l.filters = l.filters.map((f) => ({ ...f, id: opts.newId('fx_') }));
    if (l.type === 'adjustment') l.adjustment = { ...l.adjustment, id: opts.newId('fx_') };
    if (l.type === 'group') l.childIds = (src as GroupLayer).childIds.filter((c) => doc.layers[c]).map((c) => clone(c, false));
    out.push(l);
    return l.id;
  };
  const rootId = clone(id, true);
  return { rootId, layers: out };
}

/* ------------------------------------------------------------------ */
/* Panel rows & filtering                                              */
/* ------------------------------------------------------------------ */

export type LayerKind = 'pixel' | 'adjustment' | 'text' | 'shape' | 'group' | 'smart';

export function layerMatchesKind(l: Layer, kind: LayerKind): boolean {
  switch (kind) {
    case 'pixel':
      return l.type === 'raster';
    case 'adjustment':
      return l.type === 'adjustment' || l.type === 'fill';
    case 'text':
      return l.type === 'text';
    case 'shape':
      return l.type === 'shape';
    case 'group':
      return l.type === 'group';
    case 'smart':
      return l.filters.length > 0;
  }
}

export interface LayerFilter {
  kinds: LayerKind[];
  query: string;
}

export function isFilterActive(f: LayerFilter): boolean {
  return f.kinds.length > 0 || f.query.trim().length > 0;
}

export function layerMatchesFilter(l: Layer, f: LayerFilter): boolean {
  if (f.kinds.length && !f.kinds.some((k) => layerMatchesKind(l, k))) return false;
  const q = f.query.trim().toLowerCase();
  if (q && !l.name.toLowerCase().includes(q)) return false;
  return true;
}

export interface PanelRow {
  id: ID;
  depth: number;
  /** Shown only as context for a matching descendant (filter active). */
  dim: boolean;
}

/**
 * Rows of the layers panel, top → bottom. Without a filter this equals `displayList` (respects
 * collapsed groups). With a filter, every matching layer is listed together with its ancestor
 * groups (dimmed when they do not match themselves); collapsed state is ignored.
 */
export function panelRows(doc: Document, f: LayerFilter): PanelRow[] {
  const active = isFilterActive(f);
  const out: PanelRow[] = [];
  const walk = (parent: ID | null, depth: number): boolean => {
    let any = false;
    const ids = childrenOf(doc, parent);
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const l = doc.layers[id];
      if (!l) continue;
      if (!active) {
        out.push({ id, depth, dim: false });
        if (l.type === 'group' && !l.collapsed) walk(id, depth + 1);
        any = true;
        continue;
      }
      const at = out.length;
      const self = layerMatchesFilter(l, f);
      out.push({ id, depth, dim: !self });
      const child = l.type === 'group' ? walk(id, depth + 1) : false;
      if (!self && !child) out.splice(at, 1);
      else any = true;
    }
    return any;
  };
  walk(null, 0);
  return out;
}

/**
 * Visibility changes for "Alt-click eye = show only this layer": the layer and its ancestors are
 * shown, every sibling along the path is hidden. Returns only the entries that change.
 */
export function soloVisibility(doc: Document, id: ID): Record<ID, boolean> {
  const change: Record<ID, boolean> = {};
  const path = [id, ...ancestorsOf(doc, id)];
  for (const p of path) {
    if (doc.layers[p] && !doc.layers[p].visible) change[p] = true;
    const parent = parentOf(doc, p) ?? null;
    for (const s of childrenOf(doc, parent)) {
      if (s !== p && doc.layers[s]?.visible) change[s] = false;
    }
  }
  return change;
}

/** Layer below `id` in its sibling list (the merge-down target), or null. */
export function layerBelow(doc: Document, id: ID): ID | null {
  const sibs = childrenOf(doc, parentOf(doc, id) ?? null);
  const i = sibs.indexOf(id);
  return i > 0 ? sibs[i - 1] : null;
}
