/** Built-in overlay layers drawn by the viewport: grid, pixel grid, selection ants. Screen space. */
import type { Document } from '../core/types';
import { viewport } from '../editor/viewport';
import { selectionOutline, drawAnts } from './outline';
import { docToScreenMatrix } from './state';

interface Size {
  width: number;
  height: number;
}

/** Visible document span in doc px (integer-expanded) + its screen extents. */
function visibleSpan(doc: Document, size: Size) {
  const o = viewport.origin();
  const z = viewport.zoom();
  const x0 = Math.max(0, Math.floor(-o.x / z));
  const y0 = Math.max(0, Math.floor(-o.y / z));
  const x1 = Math.min(doc.width, Math.ceil((size.width - o.x) / z));
  const y1 = Math.min(doc.height, Math.ceil((size.height - o.y) / z));
  return { o, z, x0, y0, x1, y1 };
}

/** Document grid every `gridSize` px with 4 subdivisions when there is room. */
export function drawGrid(ctx: CanvasRenderingContext2D, doc: Document, gridSize: number, size: Size) {
  const { o, z, x0, y0, x1, y1 } = visibleSpan(doc, size);
  if (x1 <= x0 || y1 <= y0) return;
  const step = Math.max(1, gridSize);
  const sub = step / 4;
  const top = Math.max(0, o.y);
  const bottom = Math.min(size.height, o.y + doc.height * z);
  const left = Math.max(0, o.x);
  const right = Math.min(size.width, o.x + doc.width * z);
  const lines = (s: number, color: string) => {
    if (s * z < 6) return;
    ctx.beginPath();
    for (let v = Math.ceil(x0 / s) * s; v <= x1; v += s) {
      const x = Math.round(o.x + v * z) + 0.5;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let v = Math.ceil(y0 / s) * s; v <= y1; v += s) {
      const y = Math.round(o.y + v * z) + 0.5;
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  ctx.save();
  ctx.lineWidth = 1;
  if (sub * z >= 10) lines(sub, 'rgba(128,128,128,0.22)');
  lines(step, 'rgba(128,128,128,0.6)');
  ctx.restore();
}

/** One line per document pixel (only drawn at high zoom). */
export function drawPixelGrid(ctx: CanvasRenderingContext2D, doc: Document, size: Size) {
  const { o, z, x0, y0, x1, y1 } = visibleSpan(doc, size);
  if (x1 <= x0 || y1 <= y0 || z < 8) return;
  const top = Math.max(0, o.y);
  const bottom = Math.min(size.height, o.y + doc.height * z);
  const left = Math.max(0, o.x);
  const right = Math.min(size.width, o.x + doc.width * z);
  ctx.save();
  ctx.lineWidth = 1;
  // Fade in between 8× and 12×.
  const a = Math.min(1, (z - 8) / 4) * 0.18 + 0.12;
  ctx.strokeStyle = `rgba(128,128,128,${a.toFixed(3)})`;
  ctx.beginPath();
  for (let v = x0; v <= x1; v++) {
    const x = Math.round(o.x + v * z) + 0.5;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let v = y0; v <= y1; v++) {
    const y = Math.round(o.y + v * z) + 0.5;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Marching ants for the document selection. */
export function drawSelection(ctx: CanvasRenderingContext2D, doc: Document) {
  const path = selectionOutline(doc.selection);
  if (!path) return;
  drawAnts(ctx, path, docToScreenMatrix());
}
