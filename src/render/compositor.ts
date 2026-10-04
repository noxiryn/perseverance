/**
 * Compositor — renders a Document to canvases.
 *
 * THIS FILE IS THE CONTRACT. The function signatures below are used across the app; the bodies
 * are a minimal baseline (raster + solid fill, normal blending) to be completed by the renderer
 * module (text, shapes, gradients, patterns, masks, clipping, effects, filters, adjustments,
 * groups, caching). Keep the exported signatures stable.
 */
import type { Document, ID, Layer, Paint, Rect, Size, TextProps, TransformableLayer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d } from '../core/canvas';
import { transformMatrix, transformedBounds } from '../core/geometry';
import { compositeOp } from '../filters/engine';

export interface RenderOptions {
  /** Output scale relative to document pixels (default 1). */
  scale?: number;
  /** Paint doc.background under the layers (default true). */
  background?: boolean;
  /** Layers to skip (e.g. the layer being edited by the text tool). */
  hidden?: Set<ID>;
  /** Render only layers strictly below this layer id (in global stacking order). */
  below?: ID;
}

/** Composite the whole document. Returns a canvas of size (doc.width*scale, doc.height*scale). */
export function renderDocument(doc: Document, opts: RenderOptions = {}): HTMLCanvasElement {
  const scale = opts.scale ?? 1;
  const out = createCanvas(doc.width * scale, doc.height * scale);
  const ctx = ctx2d(out);
  if (opts.background !== false && doc.background) {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  const drawList = (ids: ID[]) => {
    for (const id of ids) {
      if (opts.below === id) return true;
      const l = doc.layers[id];
      if (!l || !l.visible || opts.hidden?.has(id)) continue;
      if (l.type === 'group') {
        if (drawList(l.childIds)) return true;
        continue;
      }
      const lc = renderLayerToDoc(doc, l, { scale });
      if (!lc) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = compositeOp(l.blendMode);
      ctx.drawImage(lc, 0, 0);
      ctx.restore();
    }
    return false;
  };
  drawList(doc.rootIds);
  return out;
}

/**
 * Render one layer (content + smart filters + effects + mask, NOT opacity/blend) into a
 * doc-sized (× scale) canvas. Groups render their children composited. Null if nothing to draw.
 */
export function renderLayerToDoc(
  doc: Document,
  layer: Layer,
  opts: { scale?: number; effects?: boolean; mask?: boolean } = {},
): HTMLCanvasElement | null {
  const scale = opts.scale ?? 1;
  const out = createCanvas(doc.width * scale, doc.height * scale);
  const ctx = ctx2d(out);
  ctx.scale(scale, scale);
  if (layer.type === 'raster') {
    const bmp = bitmaps.tryGet(layer.bitmapId);
    if (!bmp) return null;
    const m = transformMatrix(layer.transform, layer.width, layer.height);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(bmp, 0, 0);
  } else if (layer.type === 'fill' && layer.fill.type === 'solid') {
    ctx.fillStyle = layer.fill.color;
    ctx.fillRect(0, 0, doc.width, doc.height);
  } else {
    return null;
  }
  return out;
}

/**
 * Render a transformable layer's local content (bitmap / rasterized text / rasterized shape)
 * with smart filters applied, in its local box. Size equals getLayerSize(layer).
 */
export function renderLayerContent(doc: Document, layer: TransformableLayer): HTMLCanvasElement {
  const size = getLayerSize(layer);
  const out = createCanvas(size.width, size.height);
  if (layer.type === 'raster') {
    const bmp = bitmaps.tryGet(layer.bitmapId);
    if (bmp) ctx2d(out).drawImage(bmp, 0, 0);
  }
  return out;
}

/** Local content box size of a transformable layer (text is measured). */
export function getLayerSize(layer: TransformableLayer): Size {
  if (layer.type === 'raster') return { width: layer.width, height: layer.height };
  if (layer.type === 'shape') return { width: layer.shape.width, height: layer.shape.height };
  return measureText(layer.text);
}

export interface TextLayout {
  width: number;
  height: number;
  lines: { text: string; x: number; y: number; width: number }[];
  /** Baseline offset of the first line from the top of the box. */
  ascent: number;
}

/** Measure/lay out text (wrapping when boxWidth is set). */
export function measureText(text: TextProps): TextLayout {
  const c = createCanvas(1, 1);
  const ctx = ctx2d(c);
  ctx.font = `${text.fontStyle} ${text.fontWeight} ${text.fontSize}px "${text.fontFamily}"`;
  const content = text.uppercase ? text.content.toUpperCase() : text.content;
  const lines = content.split('\n');
  const lh = text.fontSize * text.lineHeight;
  let width = 0;
  const out = lines.map((t, i) => {
    const w = ctx.measureText(t).width + Math.max(0, t.length - 1) * text.letterSpacing;
    width = Math.max(width, w);
    return { text: t, x: 0, y: i * lh, width: w };
  });
  return { width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(lines.length * lh)), lines: out, ascent: text.fontSize * 0.8 };
}

/** Doc-space bounds of a layer's content (transformed box; groups = union; fills = canvas). */
export function getLayerBounds(doc: Document, layerId: ID): Rect | null {
  const l = doc.layers[layerId];
  if (!l) return null;
  if (l.type === 'raster' || l.type === 'text' || l.type === 'shape') {
    const s = getLayerSize(l);
    return transformedBounds(l.transform, s.width, s.height);
  }
  if (l.type === 'group') {
    let r: Rect | null = null;
    for (const c of l.childIds) {
      const b = getLayerBounds(doc, c);
      if (!b) continue;
      r = r
        ? {
            x: Math.min(r.x, b.x),
            y: Math.min(r.y, b.y),
            width: Math.max(r.x + r.width, b.x + b.width) - Math.min(r.x, b.x),
            height: Math.max(r.y + r.height, b.y + b.height) - Math.min(r.y, b.y),
          }
        : b;
    }
    return r;
  }
  return { x: 0, y: 0, width: doc.width, height: doc.height };
}

/** Topmost visible, unlocked-for-selection layer with a non-transparent pixel at doc (x,y). */
export function hitTestLayer(doc: Document, x: number, y: number): ID | null {
  return null;
}

/** Rasterize any layer into a doc-sized canvas (content + filters + effects + mask). */
export function rasterizeLayer(doc: Document, layerId: ID): HTMLCanvasElement | null {
  const l = doc.layers[layerId];
  return l ? renderLayerToDoc(doc, l) : null;
}

/** Small thumbnail of a layer (or the whole doc when layerId is null) fitting size×size. */
export function renderThumbnail(doc: Document, layerId: ID | null, size: number): HTMLCanvasElement {
  const s = Math.min(size / doc.width, size / doc.height);
  if (!layerId) return renderDocument(doc, { scale: s });
  const l = doc.layers[layerId];
  return (l && renderLayerToDoc(doc, l, { scale: s })) || createCanvas(doc.width * s, doc.height * s);
}

/** Fill a rect with a Paint (solid/gradient/pattern) in the given context's current transform. */
export function fillWithPaint(ctx: CanvasRenderingContext2D, paint: Paint, box: Rect, path?: Path2D) {
  if (paint.type === 'solid') ctx.fillStyle = paint.color;
  if (path) ctx.fill(path);
  else ctx.fillRect(box.x, box.y, box.width, box.height);
}

/** Drop cached renders (all, or for one layer). */
export function invalidateRenderCache(layerId?: ID) {
  void layerId;
}
