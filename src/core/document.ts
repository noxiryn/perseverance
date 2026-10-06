/**
 * Document helpers: layer factories with sensible defaults and tree utilities.
 * All functions are pure (they never mutate their inputs) except the `*Draft` helpers,
 * which are meant to be called inside an immer recipe.
 */
import type {
  AdjustmentLayer,
  Document,
  FillContent,
  FillLayer,
  FilterInstance,
  GroupLayer,
  ID,
  Layer,
  LayerBase,
  LayerLocks,
  ParamValues,
  RasterLayer,
  ShapeLayer,
  ShapeProps,
  TextLayer,
  TextProps,
  Transform,
} from './types';
import { uid } from './ids';
import { identityTransform } from './geometry';

export const DEFAULT_LOCKS: LayerLocks = { pixels: false, position: false, transparency: false, all: false };

function base(name: string): Omit<LayerBase, 'type'> {
  return {
    id: uid('ly_'),
    name,
    visible: true,
    locks: { ...DEFAULT_LOCKS },
    opacity: 1,
    fillOpacity: 1,
    blendMode: 'normal',
    clipped: false,
    mask: null,
    effects: [],
    filters: [],
    label: 'none',
  };
}

export function createDocument(opts: { name?: string; width: number; height: number; background?: string | null }): Document {
  return {
    id: uid('doc_'),
    name: opts.name ?? 'Untitled',
    width: Math.round(opts.width),
    height: Math.round(opts.height),
    background: opts.background === undefined ? '#ffffff' : opts.background,
    layers: {},
    rootIds: [],
    selection: null,
    guides: [],
    dpi: 72,
  };
}

export function makeRasterLayer(opts: {
  name?: string;
  bitmapId: ID;
  width: number;
  height: number;
  transform?: Partial<Transform>;
}): RasterLayer {
  return {
    ...base(opts.name ?? 'Layer'),
    type: 'raster',
    bitmapId: opts.bitmapId,
    width: opts.width,
    height: opts.height,
    transform: { ...identityTransform(), ...opts.transform },
    generator: null,
  };
}

export const DEFAULT_TEXT: TextProps = {
  content: 'Your Title',
  fontFamily: 'Anton',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSize: 120,
  fill: { type: 'solid', color: '#111111' },
  align: 'left',
  lineHeight: 1.1,
  letterSpacing: 0,
  scaleX: 1,
  scaleY: 1,
  uppercase: false,
  boxWidth: null,
  stroke: null,
  warp: { style: 'none', bend: 0, horizontal: 0, vertical: 0 },
  fauxBold: false,
  fauxItalic: false,
  antiAlias: true,
};

export function makeTextLayer(opts: { name?: string; text?: Partial<TextProps>; x?: number; y?: number }): TextLayer {
  const text = { ...DEFAULT_TEXT, ...opts.text };
  return {
    ...base(opts.name ?? (text.content.split('\n')[0].slice(0, 32) || 'Text')),
    type: 'text',
    text,
    transform: identityTransform(opts.x ?? 0, opts.y ?? 0),
  };
}

export const DEFAULT_SHAPE: ShapeProps = {
  kind: 'rect',
  width: 200,
  height: 200,
  cornerRadius: 0,
  sides: 5,
  innerRatio: 0.5,
  lineWidth: 8,
  fill: { type: 'solid', color: '#111111' },
  stroke: null,
};

export function makeShapeLayer(opts: { name?: string; shape?: Partial<ShapeProps>; x?: number; y?: number }): ShapeLayer {
  const shape = { ...DEFAULT_SHAPE, ...opts.shape };
  const names: Record<string, string> = {
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    polygon: 'Polygon',
    star: 'Star',
    line: 'Line',
    path: 'Shape',
  };
  return {
    ...base(opts.name ?? names[shape.kind] ?? 'Shape'),
    type: 'shape',
    shape,
    transform: identityTransform(opts.x ?? 0, opts.y ?? 0),
  };
}

export function makeFillLayer(opts: { name?: string; fill: FillContent }): FillLayer {
  const names: Record<string, string> = { solid: 'Color Fill', gradient: 'Gradient Fill', pattern: 'Pattern Fill' };
  return { ...base(opts.name ?? names[opts.fill.type]), type: 'fill', fill: opts.fill };
}

export function makeFilterInstance(filterId: string, params: ParamValues = {}): FilterInstance {
  return { id: uid('fx_'), filterId, enabled: true, params, opacity: 1, blendMode: 'normal' };
}

export function makeAdjustmentLayer(opts: { name?: string; filterId: string; params?: ParamValues }): AdjustmentLayer {
  return {
    ...base(opts.name ?? opts.filterId),
    type: 'adjustment',
    adjustment: makeFilterInstance(opts.filterId, opts.params ?? {}),
  };
}

export function makeGroupLayer(opts: { name?: string; childIds?: ID[] }): GroupLayer {
  const b = base(opts.name ?? 'Group');
  return { ...b, type: 'group', blendMode: 'pass-through', childIds: opts.childIds ?? [], collapsed: false };
}

/* ------------------------------------------------------------------ */
/* Tree utilities                                                      */
/* ------------------------------------------------------------------ */

/** Parent group id of a layer, or null if top-level. Returns undefined if not found. */
export function parentOf(doc: Document, id: ID): ID | null | undefined {
  if (doc.rootIds.includes(id)) return null;
  for (const l of Object.values(doc.layers)) if (l.type === 'group' && l.childIds.includes(id)) return l.id;
  return undefined;
}

/** The sibling list (bottom → top) containing `id`. */
export function siblingsOf(doc: Document, id: ID): ID[] {
  const p = parentOf(doc, id);
  if (p === null || p === undefined) return doc.rootIds;
  return (doc.layers[p] as GroupLayer).childIds;
}

export function childrenOf(doc: Document, parentId: ID | null): ID[] {
  if (parentId === null) return doc.rootIds;
  const g = doc.layers[parentId];
  return g && g.type === 'group' ? g.childIds : [];
}

/** Depth-first list of all layer ids, bottom → top (children before the group that holds them is NOT implied; group listed before its children). */
export function flattenIds(doc: Document, parentId: ID | null = null): ID[] {
  const out: ID[] = [];
  for (const id of childrenOf(doc, parentId)) {
    out.push(id);
    const l = doc.layers[id];
    if (l?.type === 'group') out.push(...flattenIds(doc, id));
  }
  return out;
}

/** Top → bottom display order with depth, as used by the layers panel. */
export function displayList(doc: Document, parentId: ID | null = null, depth = 0): { id: ID; depth: number }[] {
  const out: { id: ID; depth: number }[] = [];
  const ids = childrenOf(doc, parentId);
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const l = doc.layers[id];
    if (!l) continue;
    out.push({ id, depth });
    if (l.type === 'group' && !l.collapsed) out.push(...displayList(doc, id, depth + 1));
  }
  return out;
}

export function isAncestor(doc: Document, ancestorId: ID, id: ID): boolean {
  let p = parentOf(doc, id);
  while (p) {
    if (p === ancestorId) return true;
    p = parentOf(doc, p);
  }
  return false;
}

/** Effective visibility (layer and all ancestors visible). */
export function isEffectivelyVisible(doc: Document, id: ID): boolean {
  let cur: ID | null | undefined = id;
  while (cur) {
    const l: Layer | undefined = doc.layers[cur];
    if (!l || !l.visible) return false;
    cur = parentOf(doc, cur);
  }
  return true;
}

export function isTransformable(l: Layer | undefined): l is RasterLayer | TextLayer | ShapeLayer {
  return !!l && (l.type === 'raster' || l.type === 'text' || l.type === 'shape');
}

/** Generate a unique-ish layer name like "Layer 3". */
export function nextLayerName(doc: Document, prefix = 'Layer'): string {
  let n = 1;
  const names = new Set(Object.values(doc.layers).map((l) => l.name));
  while (names.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/* ---------- draft (immer) mutators ---------- */

/** Insert `layer` into the draft above `aboveId` (same parent), or at top of `parentId`/root. */
export function insertLayerDraft(d: Document, layer: Layer, opts: { aboveId?: ID | null; parentId?: ID | null; index?: number } = {}) {
  d.layers[layer.id] = layer;
  let list: ID[];
  let index: number;
  if (opts.aboveId && d.layers[opts.aboveId]) {
    list = siblingsOf(d, opts.aboveId);
    index = list.indexOf(opts.aboveId) + 1;
  } else {
    list = opts.parentId ? (d.layers[opts.parentId] as GroupLayer).childIds : d.rootIds;
    index = opts.index ?? list.length;
  }
  list.splice(index, 0, layer.id);
}

/** Detach a layer id from its parent list (does not delete it from d.layers). */
export function detachLayerDraft(d: Document, id: ID) {
  const list = siblingsOf(d, id);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

/** Delete a layer (and its descendants) from the draft. */
export function removeLayerDraft(d: Document, id: ID) {
  const l = d.layers[id];
  if (!l) return;
  if (l.type === 'group') for (const c of [...l.childIds]) removeLayerDraft(d, c);
  detachLayerDraft(d, id);
  delete d.layers[id];
}

/** What a viewer sees of a layer's pixels: opacity × fill opacity (0..1). */
export function layerVisibility(l: Layer): number {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
  return clamp01(l.opacity) * clamp01(l.fillOpacity);
}

/**
 * A faint layer (opacity × fill < 50 %): ghost / watermark text behind a title, a barely visible
 * texture. Picking "what did the user double-click" prefers the solid layer above it.
 */
export function isFaintLayer(l: Layer): boolean {
  return layerVisibility(l) < 0.5;
}

/**
 * A layer that doesn't hide what is below it for "what text did the user double-click": blend-mode
 * textures (halftone, grain, fold creases, scratches, ink spray…) and faint layers. Text layers and
 * groups never are. Opaque Normal layers still stop the pick, so text hidden under the character
 * isn't opened.
 */
export function isSeeThroughOverlay(l: Layer): boolean {
  if (l.type === 'text' || l.type === 'group') return false;
  return (l.blendMode ?? 'normal') !== 'normal' || isFaintLayer(l);
}
