/**
 * Type ▸ Rasterize Type Layer and Type ▸ Convert to Shape.
 *
 * Rasterizing renders the text content (with its overflow: outline, descenders, warp) into a
 * bitmap placed at integer document coordinates; effects, smart filters, mask, opacity and blend
 * stay live on the new raster layer. Converting to shape traces the rendered glyphs (supersampled)
 * into a smooth vector path in the text's own local frame, so the transform is kept.
 */
import type { Document, ID, LayerBase, Paint, RasterLayer, ShapeLayer, ShapeProps, TextLayer } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { ctxRead } from '../../core/canvas';
import { uid } from '../../core/ids';
import { makeRasterLayer, makeShapeLayer, siblingsOf } from '../../core/document';
import { invalidateRenderCache, measureText, renderLayerToDoc, textLocalBounds } from '../../render/compositor';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { apply, keepAnchor, layerMatrix } from './affine';
import { commitEditing, isEditing } from './session';
import { simplifyClosed, smoothClosedPath, traceGrid } from '../shape/trace';

/** Base layer properties carried over to the converted layer. */
function carryBase(from: TextLayer, to: Omit<LayerBase, 'type'> & { type: string }) {
  to.name = from.name;
  to.visible = from.visible;
  to.locks = { ...from.locks };
  to.opacity = from.opacity;
  to.fillOpacity = from.fillOpacity;
  to.blendMode = from.blendMode;
  to.clipped = from.clipped;
  to.mask = from.mask ? { ...from.mask } : null;
  to.effects = structuredClone(from.effects);
  to.filters = structuredClone(from.filters);
  to.label = from.label;
  if (from.meta) to.meta = structuredClone(from.meta);
}

/** Render a scratch copy of a text layer into a canvas covering `rect` (doc units) at `scale`. */
function renderScratch(doc: Document, layer: TextLayer, rect: { x: number; y: number; width: number; height: number }, scale: number, patch?: Partial<TextLayer>): HTMLCanvasElement | null {
  const tmp: TextLayer = {
    ...layer,
    ...patch,
    id: uid('tmp_'),
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    blendMode: 'normal',
    clipped: false,
    mask: null,
    effects: [],
    filters: [],
    transform: { ...(patch?.transform ?? layer.transform) },
  };
  tmp.transform.x -= rect.x;
  tmp.transform.y -= rect.y;
  const scratch: Document = {
    ...doc,
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
    background: null,
    selection: null,
    layers: { [tmp.id]: tmp },
    rootIds: [tmp.id],
  };
  try {
    return renderLayerToDoc(scratch, tmp, { scale, effects: false, mask: false });
  } finally {
    invalidateRenderCache(tmp.id);
  }
}

/** Document-space integer rect covering everything the text content can draw. */
export function textDocRect(layer: TextLayer): { x: number; y: number; width: number; height: number } {
  const lb = textLocalBounds(layer.text);
  const L = measureText(layer.text);
  const M = layerMatrix(layer.transform, L.width, L.height);
  const pts = [
    apply(M, { x: lb.x, y: lb.y }),
    apply(M, { x: lb.x + lb.width, y: lb.y }),
    apply(M, { x: lb.x + lb.width, y: lb.y + lb.height }),
    apply(M, { x: lb.x, y: lb.y + lb.height }),
  ];
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x))) - 1;
  const y0 = Math.floor(Math.min(...pts.map((p) => p.y))) - 1;
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x))) + 1;
  const y1 = Math.ceil(Math.max(...pts.map((p) => p.y))) + 1;
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

const MAX_SIDE = 12000;

/** Raster layer equivalent of a text layer (pure w.r.t. the document; allocates a bitmap). */
export function rasterizeTextLayer(doc: Document, layer: TextLayer): RasterLayer | null {
  const r = textDocRect(layer);
  if (r.width > MAX_SIDE || r.height > MAX_SIDE) return null;
  const canvas = renderScratch(doc, layer, r, 1);
  if (!canvas) return null;
  const raster = makeRasterLayer({ name: layer.name, bitmapId: bitmaps.add(canvas), width: canvas.width, height: canvas.height, transform: { x: r.x, y: r.y } });
  carryBase(layer, raster);
  raster.id = uid('ly_');
  return raster;
}

function replaceInTree(d: Document, oldId: ID, layer: RasterLayer | ShapeLayer) {
  const list = siblingsOf(d, oldId);
  const i = list.indexOf(oldId);
  if (i < 0) return;
  d.layers[layer.id] = layer;
  list.splice(i, 1, layer.id);
  delete d.layers[oldId];
}

function selectedTextLayers(): TextLayer[] {
  const s = activeSession();
  if (!s) return [];
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  return ids.map((id) => s.doc.layers[id]).filter((l): l is TextLayer => !!l && l.type === 'text');
}

/** Type ▸ Rasterize Type Layer. */
export function rasterizeSelectedText() {
  if (isEditing()) commitEditing();
  const s = activeSession();
  if (!s) return void toast('Open a document first', 'info');
  const layers = selectedTextLayers().filter((l) => !l.locks.all);
  if (!layers.length) return void toast('Select a text layer to rasterize', 'info');
  const out: { from: ID; to: RasterLayer }[] = [];
  for (const l of layers) {
    const r = rasterizeTextLayer(s.doc, l);
    if (r) out.push({ from: l.id, to: r });
  }
  if (!out.length) return void toast('The text is too large to rasterize', 'error');
  const ids = out.map((o) => o.to.id);
  useEditor.getState().commit(
    out.length > 1 ? 'Rasterize Type Layers' : 'Rasterize Type',
    (d) => {
      for (const o of out) replaceInTree(d, o.from, o.to);
    },
    { activeLayerId: ids[ids.length - 1], selectedLayerIds: ids },
  );
  viewport.requestRender();
  toast(out.length > 1 ? `${out.length} text layers rasterized` : 'Text rasterized — effects stay editable', 'success');
}

/* ---------------- convert to shape ---------------- */

/** Vector shape tracing the glyphs of a text layer, in the text's local frame (transform kept). */
export function textToShape(doc: Document, layer: TextLayer): ShapeLayer | null {
  const t = layer.text;
  const L = measureText(t);
  const lb = textLocalBounds(t);
  // Supersample so curves trace smoothly (~180px per em, capped).
  const k = Math.max(1, Math.min(6, 180 / Math.max(1, t.fontSize * Math.max(Math.abs(t.scaleY || 1), 0.2))));
  const W = Math.ceil(lb.width * k);
  const H = Math.ceil(lb.height * k);
  if (W * H > 36e6 || W > 16000 || H > 16000) return null;
  // Render the glyph fill only (no outline), black, untransformed: local (lb.x, lb.y) → pixel (0, 0).
  const scratchLayer: Partial<TextLayer> = {
    text: { ...t, fill: { type: 'solid', color: '#000000' }, stroke: null },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, skewX: 0 },
  };
  const canvas = renderScratch(doc, layer, { x: lb.x, y: lb.y, width: lb.width, height: lb.height }, k, scratchLayer);
  if (!canvas) return null;
  const cw = canvas.width;
  const ch = canvas.height;
  const data = ctxRead(canvas).getImageData(0, 0, cw, ch).data;
  const loops = traceGrid(cw, ch, (x, y) => data[(y * cw + x) * 4 + 3] >= 128);
  if (!loops.length) return null;
  const f = (n: number) => String(Math.round(n * 100) / 100);
  let d = '';
  for (const loop of loops) {
    const simple = simplifyClosed(loop, 0.65);
    if (simple.length < 3) continue;
    const local = simple.map(([x, y]) => [x / k, y / k] as [number, number]);
    d += smoothClosedPath(local, 58, f);
  }
  if (!d) return null;
  const fill: Paint = structuredClone(t.fill);
  const shape: ShapeProps = {
    kind: 'path',
    width: lb.width,
    height: lb.height,
    cornerRadius: 0,
    sides: 5,
    innerRatio: 0.5,
    lineWidth: 1,
    path: d,
    viewBox: [0, 0, lb.width, lb.height],
    fill,
    stroke: t.stroke && t.stroke.width > 0 ? { paint: { type: 'solid', color: t.stroke.color }, width: t.stroke.width, align: 'outside', join: 'round', cap: 'round' } : null,
  };
  const pos = keepAnchor(layer.transform, L.width, L.height, { x: lb.x, y: lb.y }, lb.width, lb.height, { x: 0, y: 0 });
  const out = makeShapeLayer({ name: layer.name, shape });
  carryBase(layer, out);
  out.id = uid('ly_');
  out.transform = { ...layer.transform, x: pos.x, y: pos.y };
  return out;
}

/** Type ▸ Convert to Shape. */
export function convertSelectedTextToShape() {
  if (isEditing()) commitEditing();
  const s = activeSession();
  if (!s) return void toast('Open a document first', 'info');
  const layers = selectedTextLayers().filter((l) => !l.locks.all);
  if (!layers.length) return void toast('Select a text layer to convert to a shape', 'info');
  const out: { from: ID; to: ShapeLayer }[] = [];
  for (const l of layers) {
    const shp = textToShape(s.doc, l);
    if (shp) out.push({ from: l.id, to: shp });
  }
  if (!out.length) return void toast('Nothing to convert — the text is empty or too large', 'warning');
  const ids = out.map((o) => o.to.id);
  useEditor.getState().commit(
    'Convert to Shape',
    (d) => {
      for (const o of out) replaceInTree(d, o.from, o.to);
    },
    { activeLayerId: ids[ids.length - 1], selectedLayerIds: ids },
  );
  viewport.requestRender();
  toast('Text converted to a shape layer', 'success');
}
