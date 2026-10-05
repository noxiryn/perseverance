/**
 * Text: measurement/layout (shared with the type tool), caret helpers, and rasterization of a
 * text layer's local content (fill paint, outline stroke, faux bold/italic, warp).
 */
import type { Rect, TextProps } from '../core/types';
import { createCanvas, ctx2d } from '../core/canvas';
import { ensureFont, isFontReady } from '../fonts/loader';
import { cacheGeneration, objId, px, slots } from './cache';
import { layoutText, lineIndexForCaret, type Measure } from './textLayout';
import { isWarpActive, warpPoint } from './warpMath';
import { buildGrid, warpImage } from './meshWarp';
import { fillWithPaint } from './paint';
import { acquire, release } from './surface';
import { strokeCoverage } from './effects/math';

export interface TextLayoutLine {
  text: string;
  /** Left of the line in the layout box (local px). */
  x: number;
  /** Top of the line box (local px). */
  y: number;
  width: number;
  /** Baseline (local px). */
  baseline: number;
  /** Range in the displayed (case-transformed) content: [start, end). */
  start: number;
  end: number;
  hard: boolean;
}

export interface TextLayout {
  width: number;
  height: number;
  lines: TextLayoutLine[];
  /** Baseline offset of the first line from the top of the box. */
  ascent: number;
  /** Font ascent/descent (local px, × scaleY). */
  fontAscent: number;
  fontDescent: number;
  /** Distance between baselines (local px). */
  lineHeight: number;
  /** The string that was laid out (uppercase applied). */
  content: string;
}

/** Local-space content of a vector layer rasterized at k px per local unit. */
export interface LocalContent {
  canvas: HTMLCanvasElement;
  /** canvas pixel (i, j) ↔ local point (ox + i / k, oy + j / k) */
  k: number;
  ox: number;
  oy: number;
}

/** Faux italic shear (tan ≈ 12°). */
export const ITALIC_SKEW = 0.21;
const MAX_TEXT_SIDE = 8192;

let mctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!mctx) mctx = ctx2d(createCanvas(4, 4), { willReadFrequently: true });
  return mctx;
}

function cleanFamily(f: string): string {
  return (f || 'sans-serif').replace(/["']/g, '').trim() || 'sans-serif';
}

/** CSS font shorthand for a text layer (at an explicit size). */
export function fontString(t: Pick<TextProps, 'fontStyle' | 'fontWeight' | 'fontFamily' | 'fontSize'>, size = t.fontSize): string {
  const style = t.fontStyle === 'italic' ? 'italic' : 'normal';
  const weight = Math.round(Number(t.fontWeight) || 400);
  return `${style} ${weight} ${Math.max(0.5, size)}px "${cleanFamily(t.fontFamily)}", sans-serif`;
}

/** Request the face used by a text layer (re-renders after it loads). */
export function requestTextFont(t: TextProps) {
  const fam = cleanFamily(t.fontFamily);
  const w = Math.round(Number(t.fontWeight) || 400);
  const st = t.fontStyle === 'italic' ? 'italic' : 'normal';
  if (!isFontReady(fam, w, st)) void ensureFont(fam, w, st);
}

/** Whether the face of a text layer is loaded (part of text cache signatures). */
export function textFontReady(t: TextProps): boolean {
  return isFontReady(cleanFamily(t.fontFamily), Math.round(Number(t.fontWeight) || 400), t.fontStyle === 'italic' ? 'italic' : 'normal');
}

export function displayContent(t: TextProps): string {
  const c = t.content ?? '';
  return t.uppercase ? c.toUpperCase() : c;
}

function codePointCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) n++;
  }
  return n;
}

/** Measure function for a text style (layout px: × scaleX, letter spacing between glyphs). */
export function textMeasure(t: TextProps): Measure {
  const ctx = measureCtx();
  const font = fontString(t);
  const ls = Number(t.letterSpacing) || 0;
  const sx = Math.abs(Number(t.scaleX) || 1);
  return (s: string) => {
    if (!s) return 0;
    ctx.font = font;
    ctx.letterSpacing = `${ls}px`;
    // measureText includes the spacing after the last glyph; the visual width does not.
    const w = ctx.measureText(s).width - (codePointCount(s) > 0 ? ls : 0);
    return Math.max(0, w) * sx;
  };
}

function fontMetrics(t: TextProps): { ascent: number; descent: number } {
  const ctx = measureCtx();
  ctx.font = fontString(t);
  ctx.letterSpacing = '0px';
  const m = ctx.measureText('Hg');
  const size = Math.max(0.5, Number(t.fontSize) || 12);
  let a = m.fontBoundingBoxAscent;
  let d = m.fontBoundingBoxDescent;
  if (!Number.isFinite(a) || a <= 0) a = size * 0.8;
  if (!Number.isFinite(d) || d < 0) d = size * 0.2;
  return { ascent: a, descent: d };
}

let layoutCache = new WeakMap<TextProps, { gen: number; ready: boolean; layout: TextLayout }>();

/**
 * Text cache epoch, bumped by `resetTextCaches()` (e.g. when a new unicode-range slice of a font
 * finished loading: the face's "ready" flag does not change, but glyphs do). It is part of every
 * text raster key and of text layers' render signatures, so composites rebuild too.
 */
let textEpoch = 0;
export function textCacheEpoch(): number {
  return textEpoch;
}

/** Lay out text (wrapping when boxWidth is set). Identical to what the renderer draws. */
export function layoutTextProps(t: TextProps): TextLayout {
  const gen = cacheGeneration();
  const ready = textFontReady(t);
  const hit = layoutCache.get(t);
  if (hit && hit.gen === gen && hit.ready === ready) return hit.layout;
  const sy = Math.abs(Number(t.scaleY) || 1);
  const size = Math.max(0.5, Number(t.fontSize) || 12);
  const met = fontMetrics(t);
  const content = displayContent(t);
  const lineHeight = size * (Number.isFinite(t.lineHeight) && t.lineHeight > 0 ? t.lineHeight : 1.2) * sy;
  const res = layoutText(
    {
      content,
      boxWidth: t.boxWidth && t.boxWidth > 0 ? t.boxWidth : null,
      align: t.align === 'center' || t.align === 'right' ? t.align : 'left',
      lineHeight,
      ascent: met.ascent * sy,
      descent: met.descent * sy,
    },
    textMeasure(t),
  );
  const layout: TextLayout = {
    width: res.width,
    height: res.height,
    lines: res.lines,
    ascent: res.ascent,
    fontAscent: met.ascent * sy,
    fontDescent: met.descent * sy,
    lineHeight,
    content,
  };
  layoutCache.set(t, { gen, ready, layout });
  return layout;
}

/** Drop every cached text layout and raster (they rebuild lazily with the new epoch). */
export function resetTextCaches() {
  layoutCache = new WeakMap();
  flatPixels.clear();
  textEpoch++;
}

/**
 * Drop the cached layout and rasters of one text style (the next measure/render recomputes
 * them). `invalidateRenderCache(layerId)` calls this for the layer's current text.
 */
export function invalidateTextLayout(t: TextProps) {
  layoutCache.delete(t);
  slots.delete(`text|${objId(t)}`);
  flatPixels.clear();
}

/* ---------------- caret helpers (for the type tool) ---------------- */

export interface CaretInfo {
  /** Caret x in the layout box (local px). */
  x: number;
  /** Top of the caret line box. */
  y: number;
  height: number;
  /** Baseline of the caret line. */
  baseline: number;
  line: number;
}

function caretX(t: TextProps, layout: TextLayout, lineIdx: number, index: number, measure: Measure): number {
  const line = layout.lines[lineIdx];
  const i = Math.max(line.start, Math.min(index, line.end));
  const prefix = layout.content.slice(line.start, i);
  if (!prefix) return line.x;
  const ls = (Number(t.letterSpacing) || 0) * Math.abs(Number(t.scaleX) || 1);
  // Put the caret in the middle of the tracking gap after the prefix.
  return line.x + measure(prefix) + ls / 2;
}

/** Caret geometry for a string index (0..content.length) in local layout coordinates. */
export function caretAt(t: TextProps, index: number, layout: TextLayout = layoutTextProps(t)): CaretInfo {
  const li = lineIndexForCaret(layout.lines, Math.max(0, Math.min(index, layout.content.length)));
  const line = layout.lines[li];
  return {
    x: caretX(t, layout, li, index, textMeasure(t)),
    y: line.y,
    height: layout.lineHeight,
    baseline: line.baseline,
    line: li,
  };
}

/** Caret geometry for every index 0..content.length. */
export function caretPositions(t: TextProps, layout: TextLayout = layoutTextProps(t)): CaretInfo[] {
  const measure = textMeasure(t);
  const out: CaretInfo[] = [];
  for (let i = 0; i <= layout.content.length; i++) {
    const li = lineIndexForCaret(layout.lines, i);
    const line = layout.lines[li];
    out.push({ x: caretX(t, layout, li, i, measure), y: line.y, height: layout.lineHeight, baseline: line.baseline, line: li });
  }
  return out;
}

/** Nearest caret index for a point in local layout coordinates. */
export function indexAtPoint(t: TextProps, x: number, y: number, layout: TextLayout = layoutTextProps(t)): number {
  if (!layout.lines.length) return 0;
  const li = Math.max(0, Math.min(layout.lines.length - 1, Math.floor(y / layout.lineHeight)));
  const line = layout.lines[li];
  const measure = textMeasure(t);
  let best = line.start;
  let bestD = Infinity;
  // Soft-wrapped lines exclude the trailing whitespace position (it belongs to the next line start).
  const last = line.hard || li === layout.lines.length - 1 ? line.end : Math.max(line.start, line.end - 1);
  for (let i = line.start; i <= last; i++) {
    const cx = caretX(t, layout, li, i, measure);
    const d = Math.abs(cx - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Highlight rectangles (local coords) for a selection range [start, end). */
export function selectionRects(t: TextProps, start: number, end: number, layout: TextLayout = layoutTextProps(t)): Rect[] {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (a === b) return [];
  const measure = textMeasure(t);
  const rects: Rect[] = [];
  layout.lines.forEach((line, li) => {
    const s = Math.max(a, line.start);
    const e = Math.min(b, line.end);
    if (e < s || (e === s && !(b > line.end && a <= line.end && line.hard && e === line.end))) return;
    const x0 = s === line.start ? line.x : caretX(t, layout, li, s, measure);
    let x1 = caretX(t, layout, li, e, measure);
    if (b > line.end && line.hard && li < layout.lines.length - 1) x1 += Math.max(2, (Number(t.fontSize) || 12) * 0.25);
    rects.push({ x: x0, y: line.y, width: Math.max(1, x1 - x0), height: layout.lineHeight });
  });
  return rects;
}

/* ---------------- rasterization ---------------- */

/** Local-space overflow padding around the layout box (stroke, descenders, italic, faux bold). */
export function textPadding(t: TextProps, layout: TextLayout): number {
  const size = Math.max(0.5, Number(t.fontSize) || 12) * Math.max(Math.abs(t.scaleX || 1), Math.abs(t.scaleY || 1));
  const stroke = t.stroke && t.stroke.width > 0 ? t.stroke.width : 0;
  const bold = t.fauxBold ? size * 0.04 : 0;
  const italic = t.fauxItalic ? (layout.fontAscent + layout.fontDescent) * ITALIC_SKEW : 0;
  // Line boxes smaller than the font (lineHeight < 1) push glyphs outside the box.
  const tight = Math.max(0, layout.fontAscent + layout.fontDescent - layout.lineHeight);
  return Math.ceil(size * 0.3 + stroke + bold + italic + tight + 2);
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  t: TextProps,
  layout: TextLayout,
  pass: (ctx: CanvasRenderingContext2D, text: string) => void,
) {
  const sx = Number(t.scaleX) || 1;
  const sy = Number(t.scaleY) || 1;
  for (const line of layout.lines) {
    if (!line.text) continue;
    ctx.save();
    ctx.translate(line.x, line.baseline);
    if (t.fauxItalic) ctx.transform(1, 0, -ITALIC_SKEW, 1, 0, 0);
    if (sx < 0 || sy < 0) {
      // Negative glyph scale: mirror inside the line's own box.
      ctx.translate(sx < 0 ? line.width : 0, 0);
    }
    ctx.scale(sx, sy);
    pass(ctx, line.text);
    ctx.restore();
  }
}

function setupTextCtx(ctx: CanvasRenderingContext2D, t: TextProps) {
  ctx.font = fontString(t);
  ctx.letterSpacing = `${Number(t.letterSpacing) || 0}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
}

/**
 * Local origin of a raster so that canvas pixel 0 lands on an integer device pixel when the
 * device mapping is `k·u + e` with frac(e) = f (pixel-exact drawing of untransformed layers).
 */
export function alignedOrigin(minLocal: number, k: number, f: number): number {
  return (Math.floor(f + k * minLocal + 1e-9) - f) / k;
}

/** Coverage map → canvas painted with a paint (solid color or the text fill paint) through it. */
function drawCoverage(
  ctx: CanvasRenderingContext2D,
  cov: Uint8Array,
  wPx: number,
  hPx: number,
  paint: (pc: CanvasRenderingContext2D) => void,
) {
  const img = new ImageData(wPx, hPx);
  const px32 = new Uint32Array(img.data.buffer);
  for (let i = 0; i < cov.length; i++) {
    const v = cov[i];
    if (v) px32[i] = ((v << 24) | 0xffffff) >>> 0;
  }
  const m = acquire(wPx, hPx);
  const mc = ctx2d(m);
  mc.putImageData(img, 0, 0);
  mc.globalCompositeOperation = 'source-in';
  paint(mc);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(m, 0, 0);
  ctx.restore();
  release(m);
}

/**
 * Outline / faux bold for horizontally or vertically scaled glyphs. A canvas stroke would be
 * scaled with the glyphs (thicker on one axis), so both are built from the scaled glyph coverage
 * instead: faux bold = isotropic dilation of the glyphs, outline = dilation of the (bold) glyphs
 * by the stroke width (exact distance field, round joins), drawn behind the fill.
 */
function renderFlatAniso(t: TextProps, layout: TextLayout, canvas: HTMLCanvasElement, k: number, ox: number, oy: number) {
  const wPx = canvas.width;
  const hPx = canvas.height;
  const ctx = ctx2d(canvas);
  const G = acquire(wPx, hPx, { read: true });
  const g = ctx2d(G, { willReadFrequently: true });
  g.setTransform(k, 0, 0, k, -ox * k, -oy * k);
  setupTextCtx(g, t);
  g.fillStyle = '#ffffff';
  drawLines(g, t, layout, (c, s) => c.fillText(s, 0, 0));
  const data = g.getImageData(0, 0, wPx, hPx).data;
  release(G);
  let a: Uint8Array = new Uint8Array(wPx * hPx);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = data[j];
  const size = Math.max(0.5, Number(t.fontSize) || 12);
  const gscale = Math.sqrt(Math.abs((Number(t.scaleX) || 1) * (Number(t.scaleY) || 1)));
  if (t.fauxBold) a = strokeCoverage(a, wPx, hPx, size * 0.04 * gscale * 0.5 * k, 'outside');
  if (t.stroke && t.stroke.width > 0) {
    const color = t.stroke.color || '#000000';
    const outline = strokeCoverage(a, wPx, hPx, t.stroke.width * k, 'outside');
    drawCoverage(ctx, outline, wPx, hPx, (pc) => {
      pc.fillStyle = color;
      pc.fillRect(0, 0, wPx, hPx);
    });
  }
  const fill = t.fill ?? { type: 'solid', color: '#000000' };
  const box: Rect = { x: 0, y: 0, width: layout.width, height: layout.height };
  drawCoverage(ctx, a, wPx, hPx, (pc) => {
    if (fill.type === 'solid') {
      pc.fillStyle = fill.color;
      pc.fillRect(0, 0, wPx, hPx);
      return;
    }
    pc.setTransform(k, 0, 0, k, -ox * k, -oy * k);
    const area = new Path2D();
    area.rect(ox, oy, wPx / k, hPx / k);
    fillWithPaint(pc, fill, box, area);
    pc.setTransform(1, 0, 0, 1, 0, 0);
  });
}

/** Render the flat (unwarped) text into a canvas: local content with padding P. */
function renderFlat(t: TextProps, layout: TextLayout, k: number, P: number, fx = 0, fy = 0): LocalContent {
  const ox = alignedOrigin(-P, k, fx);
  const oy = alignedOrigin(-P, k, fy);
  const wPx = Math.ceil((layout.width + P - ox) * k);
  const hPx = Math.ceil((layout.height + P - oy) * k);
  const canvas = createCanvas(wPx, hPx);
  const asx = Math.abs(Number(t.scaleX) || 1);
  const asy = Math.abs(Number(t.scaleY) || 1);
  if (Math.abs(asx - asy) > 1e-3 * Math.max(asx, asy) && ((t.stroke && t.stroke.width > 0) || t.fauxBold)) {
    renderFlatAniso(t, layout, canvas, k, ox, oy);
    if (t.antiAlias === false) hardenAlpha(canvas);
    return { canvas, k, ox, oy };
  }
  const ctx = ctx2d(canvas);
  ctx.setTransform(k, 0, 0, k, -ox * k, -oy * k);
  setupTextCtx(ctx, t);
  const box: Rect = { x: 0, y: 0, width: layout.width, height: layout.height };
  const size = Math.max(0.5, Number(t.fontSize) || 12);
  const fauxW = t.fauxBold ? size * 0.04 : 0;
  // 1) Outline stroke behind the fill.
  if (t.stroke && t.stroke.width > 0) {
    ctx.strokeStyle = t.stroke.color || '#000000';
    // Drawn in glyph space (scaled by the uniform glyph scale): the outline reaches `width`
    // output px beyond the faux-bold glyph edge (faux bold itself scales with the glyphs).
    const sxy = Math.max(Math.abs(t.scaleX || 1), Math.abs(t.scaleY || 1)) || 1;
    ctx.lineWidth = (t.stroke.width * 2) / sxy + fauxW;
    drawLines(ctx, t, layout, (c, s) => c.strokeText(s, 0, 0));
  }
  // 2) Fill (+ faux bold) with the fill paint.
  const fill = t.fill ?? { type: 'solid', color: '#000000' };
  if (fill.type === 'solid') {
    ctx.fillStyle = fill.color;
    ctx.strokeStyle = fill.color;
    ctx.lineWidth = fauxW;
    drawLines(ctx, t, layout, (c, s) => {
      if (fauxW > 0) c.strokeText(s, 0, 0);
      c.fillText(s, 0, 0);
    });
  } else {
    const tmp = acquire(wPx, hPx);
    const tc = ctx2d(tmp);
    tc.setTransform(k, 0, 0, k, -ox * k, -oy * k);
    setupTextCtx(tc, t);
    tc.fillStyle = '#ffffff';
    tc.strokeStyle = '#ffffff';
    tc.lineWidth = fauxW;
    drawLines(tc, t, layout, (c, s) => {
      if (fauxW > 0) c.strokeText(s, 0, 0);
      c.fillText(s, 0, 0);
    });
    // Paint laid out over the layout box, extended over the padding (glyph overflow).
    const paintC = acquire(wPx, hPx);
    const pc = ctx2d(paintC);
    pc.setTransform(k, 0, 0, k, -ox * k, -oy * k);
    const area = new Path2D();
    area.rect(ox, oy, wPx / k, hPx / k);
    fillWithPaint(pc, fill, box, area);
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.globalCompositeOperation = 'source-in';
    tc.drawImage(paintC, 0, 0);
    tc.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tmp, 0, 0);
    release(tmp, paintC);
  }
  if (t.antiAlias === false) hardenAlpha(canvas);
  return { canvas, k, ox, oy };
}

function hardenAlpha(c: HTMLCanvasElement) {
  const ctx = ctx2d(c);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 110 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
}

/** Source px per warp-mesh cell (affine per triangle; 8px keeps the error far below a pixel). */
const WARP_CELL = 8;

/** Pixels of an unwarped text raster (input of the mesh warp). */
interface FlatPixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  k: number;
  ox: number;
  oy: number;
}

/**
 * Flat rasters of warped texts keyed by everything BUT the warp: dragging a Bend/Distortion
 * slider re-runs only the mesh warp (no text drawing, no GPU readback).
 */
const flatPixels = new Map<string, FlatPixels>();
const FLAT_CACHE_MAX = 3;

function flatPixelsFor(t: TextProps, layout: TextLayout, k: number, P: number): FlatPixels {
  const { warp: _warp, ...rest } = t;
  const key = `${k.toFixed(5)}|${cacheGeneration()}|${textEpoch}|${textFontReady(t) ? 1 : 0}|${JSON.stringify(rest)}`;
  const hit = flatPixels.get(key);
  if (hit) {
    flatPixels.delete(key);
    flatPixels.set(key, hit);
    return hit;
  }
  const flat = renderFlat(t, layout, k, P);
  const { canvas } = flat;
  const data = ctx2d(canvas, { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const fp: FlatPixels = { data, w: canvas.width, h: canvas.height, k, ox: flat.ox, oy: flat.oy };
  flatPixels.set(key, fp);
  while (flatPixels.size > FLAT_CACHE_MAX) flatPixels.delete(flatPixels.keys().next().value as string);
  return fp;
}

/**
 * Warp a flat local content through the text warp mapping with a seamless software triangle
 * mesh (see meshWarp.ts): exact per-triangle inverse mapping + premultiplied bilinear sampling.
 */
function warpContent(flat: FlatPixels, t: TextProps, layout: TextLayout): LocalContent {
  const { k, ox, oy } = flat;
  const src = { width: flat.w, height: flat.h };
  const a = layout.width / 2;
  const c = layout.height / 2;
  const w = t.warp;
  const cols = Math.max(4, Math.min(320, Math.round(src.width / WARP_CELL)));
  const rows = Math.max(2, Math.min(160, Math.round(src.height / WARP_CELL)));
  // Mesh in LOCAL coordinates first (to find the warped extent), then convert to output px.
  const grid = buildGrid(src.width, src.height, cols, rows, (sx, sy) => {
    const [X, Y] = warpPoint(w, ox + sx / k - a, oy + sy / k - c, a, c);
    return [X + a, Y + c];
  });
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < grid.dx.length; i++) {
    const X = grid.dx[i];
    const Y = grid.dy[i];
    if (X < minX) minX = X;
    if (Y < minY) minY = Y;
    if (X > maxX) maxX = X;
    if (Y > maxY) maxY = Y;
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) {
    const c0 = createCanvas(src.width, src.height);
    const img0 = new ImageData(src.width, src.height);
    img0.data.set(flat.data);
    ctx2d(c0).putImageData(img0, 0, 0);
    return { canvas: c0, k, ox, oy };
  }
  const nox = Math.floor(minX - 2);
  const noy = Math.floor(minY - 2);
  const outW = Math.max(1, Math.min(MAX_TEXT_SIDE, Math.ceil((maxX + 2 - nox) * k)));
  const outH = Math.max(1, Math.min(MAX_TEXT_SIDE, Math.ceil((maxY + 2 - noy) * k)));
  for (let i = 0; i < grid.dx.length; i++) {
    grid.dx[i] = (grid.dx[i] - nox) * k;
    grid.dy[i] = (grid.dy[i] - noy) * k;
  }
  const out = createCanvas(outW, outH);
  const img = new ImageData(outW, outH);
  warpImage(flat.data, src.width, src.height, img.data, outW, outH, grid);
  ctx2d(out).putImageData(img, 0, 0);
  return { canvas: out, k, ox: nox, oy: noy };
}

/** Local bounds (layout coordinates) covered by a text layer's raster: layout box + overflow. */
export function textLocalBounds(t: TextProps): Rect {
  const layout = layoutTextProps(t);
  const P = textPadding(t, layout);
  if (!isWarpActive(t.warp)) return { x: -P, y: -P, width: layout.width + 2 * P, height: layout.height + 2 * P };
  const a = layout.width / 2;
  const c = layout.height / 2;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const N = 24;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      if (j > 0 && j < N && i > 0 && i < N && (i + j) % 3) continue;
      const lx = -P + ((layout.width + 2 * P) * i) / N;
      const ly = -P + ((layout.height + 2 * P) * j) / N;
      const [X, Y] = warpPoint(t.warp, lx - a, ly - c, a, c);
      minX = Math.min(minX, X + a);
      minY = Math.min(minY, Y + c);
      maxX = Math.max(maxX, X + a);
      maxY = Math.max(maxY, Y + c);
    }
  }
  return { x: minX - 2, y: minY - 2, width: maxX - minX + 4, height: maxY - minY + 4 };
}

/**
 * Rasterize a text layer's content at k px per local unit (cached per TextProps identity).
 * The canvas includes overflow (stroke, descenders, warp) around the layout box.
 * `fx/fy` = fractional device offset of the local origin (pixel-exact placement of
 * axis-aligned text); ignored for warped text.
 */
export function renderTextContent(t: TextProps, kRequested: number, fx = 0, fy = 0): LocalContent {
  requestTextFont(t);
  const layout = layoutTextProps(t);
  const P = textPadding(t, layout);
  const warp = isWarpActive(t.warp);
  const growth = warp ? 1.8 : 1;
  const maxDim = Math.max(layout.width + 2 * P, layout.height + 2 * P) * growth;
  const k = Math.max(0.01, Math.min(kRequested, MAX_TEXT_SIDE / Math.max(1, maxDim)));
  if (warp || k !== kRequested) fx = fy = 0;
  const key = `text|${objId(t)}`;
  const sig = `${k.toFixed(5)}|${fx.toFixed(4)}|${fy.toFixed(4)}|${cacheGeneration()}|${textEpoch}|${textFontReady(t) ? 'r' : 'p'}`;
  const hit = slots.get<LocalContent>(key, sig);
  if (hit) return hit;
  const content = warp ? warpContent(flatPixelsFor(t, layout, k, P), t, layout) : renderFlat(t, layout, k, P, fx, fy);
  // A few raster scales per text (document, thumbnails, navigator) coexist without thrashing.
  slots.set(key, sig, content, px(content.canvas), { max: 4 });
  return content;
}
