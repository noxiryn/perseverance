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
import { createCanvas, ctx2d, ctxRead, opaqueBounds } from '../../core/canvas';
import { uid } from '../../core/ids';
import { makeRasterLayer, makeShapeLayer, siblingsOf } from '../../core/document';
import { invalidateRenderCache, measureText, renderLayerToDoc, textLocalBounds } from '../../render/compositor';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { apply, keepAnchor, layerMatrix } from './affine';
import { commitEditing, isEditing } from './session';
import { simplifyClosed, smoothClosedPath, traceGrid } from '../shape/trace';
import { remapGradient } from './gradientRemap';

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

type RasterizeResult = { ok: true; layer: RasterLayer } | { ok: false; reason: 'large' | 'failed' };

/** Crop a canvas to its non-transparent pixels (null when fully transparent). */
function cropToContent(canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const b = opaqueBounds(canvas);
  if (!b) return null;
  if (b.x === 0 && b.y === 0 && b.width === canvas.width && b.height === canvas.height) return { canvas, x: 0, y: 0 };
  const out = createCanvas(b.width, b.height);
  ctx2d(out).drawImage(canvas, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
  return { canvas: out, x: b.x, y: b.y };
}

function rasterize(doc: Document, layer: TextLayer): RasterizeResult {
  const r = textDocRect(layer);
  if (r.width > MAX_SIDE || r.height > MAX_SIDE) return { ok: false, reason: 'large' };
  const canvas = renderScratch(doc, layer, r, 1);
  if (!canvas) return { ok: false, reason: 'failed' };
  // The render covers the text's overflow padding: keep only the pixels it actually drew, so the
  // layer's box (transform handles, align, snapping, W/H) hugs the glyphs.
  const crop = cropToContent(canvas);
  // Empty / whitespace-only text becomes an empty document-sized layer (like New Layer).
  const bmp = crop ? crop.canvas : createCanvas(Math.max(1, doc.width), Math.max(1, doc.height));
  const x = crop ? r.x + crop.x : 0;
  const y = crop ? r.y + crop.y : 0;
  const raster = makeRasterLayer({ name: layer.name, bitmapId: bitmaps.add(bmp), width: bmp.width, height: bmp.height, transform: { x, y } });
  carryBase(layer, raster);
  raster.id = uid('ly_');
  return { ok: true, layer: raster };
}

/**
 * Raster layer equivalent of a text layer (pure w.r.t. the document; allocates a bitmap), cropped
 * to the drawn pixels. Null when the text is too large to rasterize.
 */
export function rasterizeTextLayer(doc: Document, layer: TextLayer): RasterLayer | null {
  const res = rasterize(doc, layer);
  return res.ok ? res.layer : null;
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
  let tooLarge = 0;
  for (const l of layers) {
    const r = rasterize(s.doc, l);
    if (r.ok) out.push({ from: l.id, to: r.layer });
    else if (r.reason === 'large') tooLarge++;
  }
  if (!out.length) return void toast(tooLarge ? 'The text is too large to rasterize — reduce its size or scale first' : 'Could not rasterize the text layer', 'error');
  if (tooLarge) toast(`${tooLarge} text layer${tooLarge > 1 ? 's were' : ' was'} too large to rasterize and left unchanged`, 'warning');
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
  // Simplified loops in scratch units (local - lb origin), and their tight bounds.
  const polys: [number, number][][] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    const simple = simplifyClosed(loop, 0.65);
    if (simple.length < 3) continue;
    const local = simple.map(([x, y]) => [x / k, y / k] as [number, number]);
    for (const [x, y] of local) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    polys.push(local);
  }
  if (!polys.length || !(maxX > minX) || !(maxY > minY)) return null;
  // The quadratic smoothing stays inside each polygon's hull, so these bounds hold the outline.
  const w = maxX - minX;
  const h = maxY - minY;
  const f = (n: number) => String(Math.round(n * 100) / 100);
  let d = '';
  for (const poly of polys) d += smoothClosedPath(poly.map(([x, y]) => [x - minX, y - minY] as [number, number]), 58, f);
  if (!d) return null;
  // Tight box origin in the text's layout coordinates.
  const ox = lb.x + minX;
  const oy = lb.y + minY;
  // Text paints its gradient over the layout box; the shape over its own box → remap so the colours stay put.
  const fill: Paint =
    t.fill.type === 'gradient'
      ? { type: 'gradient', gradient: remapGradient(t.fill.gradient, { x: 0, y: 0, width: L.width, height: L.height }, { x: ox, y: oy, width: w, height: h }) }
      : structuredClone(t.fill);
  const shape: ShapeProps = {
    kind: 'path',
    width: w,
    height: h,
    cornerRadius: 0,
    sides: 5,
    innerRatio: 0.5,
    lineWidth: 1,
    path: d,
    viewBox: [0, 0, w, h],
    fill,
    stroke: t.stroke && t.stroke.width > 0 ? { paint: { type: 'solid', color: t.stroke.color }, width: t.stroke.width, align: 'outside', join: 'round', cap: 'round' } : null,
  };
  const pos = keepAnchor(layer.transform, L.width, L.height, { x: ox, y: oy }, w, h, { x: 0, y: 0 });
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
