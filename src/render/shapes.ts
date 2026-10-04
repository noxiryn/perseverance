/** Vector shapes: geometry → Path2D, fill/stroke rasterization of a shape layer's local content. */
import type { Paint, ShapeProps } from '../core/types';
import { createCanvas, ctx2d } from '../core/canvas';
import { shapePresets } from '../registry';
import { cacheGeneration, objId, px, renderCache } from './cache';
import { linePolygon, polygonPoints, roundedPolygonOps, starPoints } from './shapeGeometry';
import { fillWithPaint, paintThroughMask } from './paint';
import type { LocalContent } from './text';
import { acquire, release } from './surface';

const pathCache = new WeakMap<ShapeProps, Path2D>();

function polyPath(pts: { x: number; y: number }[], radius: number): Path2D {
  const p = new Path2D();
  if (radius > 0) {
    for (const op of roundedPolygonOps(pts, radius)) {
      if (op.op === 'M') p.moveTo(op.x, op.y);
      else if (op.op === 'A') p.arcTo(op.x1, op.y1, op.x2, op.y2, op.r);
      else p.closePath();
    }
    return p;
  }
  pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
  p.closePath();
  return p;
}

/** Path of a shape in its local box [0,w]×[0,h]. */
export function shapePath(shape: ShapeProps): Path2D {
  const hit = pathCache.get(shape);
  if (hit) return hit;
  const w = Math.max(0, Number(shape.width) || 0);
  const h = Math.max(0, Number(shape.height) || 0);
  const r = Math.max(0, Number(shape.cornerRadius) || 0);
  let p: Path2D;
  switch (shape.kind) {
    case 'ellipse':
      p = new Path2D();
      p.ellipse(w / 2, h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
      break;
    case 'polygon':
      p = polyPath(polygonPoints(shape.sides, w, h), r);
      break;
    case 'star':
      p = polyPath(starPoints(shape.sides, shape.innerRatio, w, h), r);
      break;
    case 'line':
      p = polyPath(linePolygon(w, h, Number(shape.lineWidth) || 1), 0);
      break;
    case 'path': {
      p = new Path2D();
      if (shape.path) {
        try {
          const vb = shape.viewBox ?? [0, 0, w || 1, h || 1];
          const vw = vb[2] || 1;
          const vh = vb[3] || 1;
          const m = new DOMMatrix().scaleSelf(w / vw, h / vh).translateSelf(-vb[0], -vb[1]);
          p.addPath(new Path2D(shape.path), m);
        } catch {
          /* invalid path data → empty */
        }
      }
      break;
    }
    case 'rect':
    default:
      p = new Path2D();
      if (r > 0) p.roundRect(0, 0, w, h, Math.min(r, w / 2, h / 2));
      else p.rect(0, 0, w, h);
      break;
  }
  pathCache.set(shape, p);
  return p;
}

/** Fill rule of a shape (custom shape presets may use evenodd). */
export function shapeFillRule(shape: ShapeProps): CanvasFillRule {
  if (shape.kind === 'path' && shape.presetId) return shapePresets.get(shape.presetId)?.evenOdd ? 'evenodd' : 'nonzero';
  return 'nonzero';
}

/** Local overflow beyond the shape box caused by its stroke (miter joins included). */
export function shapePadding(shape: ShapeProps): number {
  const base = shape.kind === 'line' ? Math.max(0, Number(shape.lineWidth) || 0) / 2 + 2 : 2;
  const s = shape.stroke;
  if (!s || !(s.width > 0)) return Math.ceil(base);
  const out = s.align === 'outside' ? s.width : s.align === 'center' ? s.width / 2 : 0;
  const miter = (s.join ?? 'miter') === 'miter' ? 4 : 1.2;
  return Math.ceil(out * miter + base);
}

function applyStrokeStyle(ctx: CanvasRenderingContext2D, shape: ShapeProps, lineWidth: number) {
  const s = shape.stroke!;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = s.join ?? 'miter';
  ctx.lineCap = s.cap ?? 'butt';
  ctx.miterLimit = 4;
  if (s.dash && s.dash.length && s.dash.some((d) => d > 0)) {
    // Dash lengths are multiples of the stroke width (Photoshop convention).
    ctx.setLineDash(s.dash.map((d) => Math.max(0, d) * s.width));
  } else ctx.setLineDash([]);
}

/** Render a shape's fill + stroke into a context whose transform maps local shape coordinates. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeProps) {
  const path = shapePath(shape);
  const rule = shapeFillRule(shape);
  const w = Math.max(0, Number(shape.width) || 0);
  const h = Math.max(0, Number(shape.height) || 0);
  const box = { x: 0, y: 0, width: Math.max(1, w), height: Math.max(1, h) };
  if (shape.fill) fillWithPaint(ctx, shape.fill as Paint, box, path, rule);
  const s = shape.stroke;
  if (!s || !(s.width > 0)) return;
  const strokeBox = s.align === 'outside' ? { x: -s.width, y: -s.width, width: box.width + 2 * s.width, height: box.height + 2 * s.width } : box;
  if (s.align === 'center') {
    applyStrokeStyle(ctx, shape, s.width);
    paintThroughMask(ctx, s.paint, strokeBox, (c) => c.stroke(path), 'stroke');
    return;
  }
  if (s.align === 'inside') {
    ctx.save();
    ctx.clip(path, rule);
    applyStrokeStyle(ctx, shape, s.width * 2);
    paintThroughMask(ctx, s.paint, strokeBox, (c) => c.stroke(path), 'stroke');
    ctx.restore();
    return;
  }
  // Outside: stroke at double width on a scratch layer, then knock out the interior.
  const canvas = ctx.canvas as HTMLCanvasElement;
  const tmp = acquire(canvas.width, canvas.height);
  const t = ctx2d(tmp);
  t.setTransform(ctx.getTransform());
  applyStrokeStyle(t, shape, s.width * 2);
  paintThroughMask(t, s.paint, strokeBox, (c) => c.stroke(path), 'stroke');
  t.globalCompositeOperation = 'destination-out';
  t.fillStyle = '#000';
  t.fill(path, rule);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
  release(tmp);
}

const MAX_SHAPE_SIDE = 8192;

/** Rasterize a shape layer's content at k px per local unit (cached by ShapeProps identity). */
export function renderShapeContent(shape: ShapeProps, kRequested: number): LocalContent {
  const P = shapePadding(shape);
  const w = Math.max(1, Number(shape.width) || 1);
  const h = Math.max(1, Number(shape.height) || 1);
  const k = Math.max(0.01, Math.min(kRequested, MAX_SHAPE_SIDE / Math.max(w + 2 * P, h + 2 * P)));
  const key = `shape|${objId(shape)}|${k.toFixed(4)}|${cacheGeneration()}`;
  const hit = renderCache.get<LocalContent>(key);
  if (hit) return hit;
  const canvas = createCanvas(Math.ceil((w + 2 * P) * k), Math.ceil((h + 2 * P) * k));
  const ctx = ctx2d(canvas);
  ctx.setTransform(k, 0, 0, k, P * k, P * k);
  drawShape(ctx, shape);
  const content: LocalContent = { canvas, k, ox: -P, oy: -P };
  renderCache.set(key, content, px(canvas));
  return content;
}
