/**
 * CompositeSession — the live painting pipeline for GPU-drawn tools (brush, pencil, eraser,
 * clone, gradient, bucket).
 *
 *   stroke buffer S (dabs at flow)  ──►  T = before ⊕ (S · selection) at opacity / blend
 *
 * Only dirty rects are recomposited each frame (one rAF), the before-image is a GPU copy of
 * the layer taken at stroke start, and the BitmapPatch is read back once on commit.
 */
import type { Rect } from '../../../core/types';
import { bitmaps } from '../../../core/bitmaps';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { pixelRect, rectUnion } from '../../../core/geometry';
import { viewport } from '../../../editor/viewport';
import { useEditor } from '../../../state/editor';
import { targetStillValid, type PaintTarget } from './target';

export interface CompositeMode {
  /** 0..1 stroke opacity cap. */
  opacity: number;
  /** Composite op used to apply the stroke buffer to the layer. */
  op: GlobalCompositeOperation;
}

/* ---------------- canvas pool ---------------- */

const pool = new Map<string, HTMLCanvasElement>();

/** Reusable canvas of exactly w×h (contents undefined). */
function pooled(name: string, w: number, h: number): HTMLCanvasElement {
  const c = pool.get(name);
  if (c && c.width === w && c.height === h) return c;
  const n = createCanvas(w, h);
  pool.set(name, n);
  return n;
}

/** Reusable canvas of at least w×h (grow-only). */
function scratch(name: string, w: number, h: number): HTMLCanvasElement {
  const c = pool.get(name);
  if (c && c.width >= w && c.height >= h) return c;
  const n = createCanvas(Math.max(w, c?.width ?? 0, 64), Math.max(h, c?.height ?? 0, 64));
  pool.set(name, n);
  return n;
}

/** Rect of the stroke buffer that may still hold pixels from the previous session. */
let bufferGarbage: Rect | null = null;

export class CompositeSession {
  readonly target: PaintTarget;
  readonly buffer: HTMLCanvasElement;
  readonly bufferCtx: CanvasRenderingContext2D;
  readonly before: HTMLCanvasElement;
  mode: CompositeMode;
  private dirty: Rect | null = null;
  private frame: Rect | null = null;
  private raf = 0;
  private finished = false;

  constructor(target: PaintTarget, mode: CompositeMode) {
    this.target = target;
    this.mode = mode;
    const { width: w, height: h } = target;

    this.before = pooled('before', w, h);
    const bctx = ctx2d(this.before);
    bctx.save();
    bctx.globalCompositeOperation = 'copy';
    bctx.drawImage(target.canvas, 0, 0);
    bctx.restore();

    const fresh = pool.get('buffer');
    this.buffer = pooled('buffer', w, h);
    this.bufferCtx = ctx2d(this.buffer);
    if (fresh === this.buffer && bufferGarbage) {
      this.bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.bufferCtx.clearRect(bufferGarbage.x, bufferGarbage.y, bufferGarbage.width, bufferGarbage.height);
    }
    bufferGarbage = null;
    this.bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.bufferCtx.globalAlpha = 1;
    this.bufferCtx.globalCompositeOperation = 'source-over';
  }

  get isFinished() {
    return this.finished;
  }

  /** Union of everything touched so far (local px), or null. */
  get dirtyRect(): Rect | null {
    return this.dirty;
  }

  /** Mark a local-space rect of the buffer as changed; schedules a composite. */
  markDirty(r: Rect) {
    const pr = pixelRect(r, this.target.width, this.target.height, 1);
    if (!pr) return;
    this.frame = rectUnion(this.frame, pr);
    this.dirty = rectUnion(this.dirty, pr);
    this.schedule();
  }

  /** Clear part of the stroke buffer (for tools that redraw the buffer each frame). */
  clearBuffer(r: Rect | null) {
    if (!r) return;
    const ctx = this.bufferCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(r.x, r.y, r.width, r.height);
    ctx.restore();
  }

  private schedule() {
    if (this.raf || this.finished) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  /** Composite pending dirty rects into the layer bitmap now. */
  flush() {
    const r = this.frame;
    if (!r || this.finished) return;
    this.frame = null;
    this.composite(r);
    bitmaps.touch(this.target.bitmapId);
    viewport.requestRender();
  }

  /** Recomposite the whole touched area (e.g. after changing the mode mid-preview). */
  recompositeAll() {
    if (this.dirty) {
      this.frame = rectUnion(this.frame, this.dirty);
      this.schedule();
    }
  }

  private composite(r: Rect) {
    const t = this.target;
    const ctx = ctx2d(t.canvas);
    const { x, y, width: w, height: h } = r;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(this.before, x, y, w, h, x, y, w, h);

    // Stroke source, masked by the selection when there is one.
    let src: HTMLCanvasElement = this.buffer;
    let sx = x,
      sy = y;
    if (t.selection) {
      const xs = scratch('masked', w, h);
      const xc = ctx2d(xs);
      xc.save();
      xc.setTransform(1, 0, 0, 1, 0, 0);
      xc.imageSmoothingEnabled = false;
      xc.globalCompositeOperation = 'copy';
      xc.drawImage(this.buffer, x, y, w, h, 0, 0, w, h);
      xc.globalCompositeOperation = 'destination-in';
      xc.drawImage(t.selection, x, y, w, h, 0, 0, w, h);
      xc.restore();
      src = xs;
      sx = 0;
      sy = 0;
    }

    const { opacity, op } = this.mode;
    if (t.lockTransparency && op !== 'source-over') {
      // Blend into a copy of the original, then put it back only where pixels existed.
      const rs = scratch('locked', w, h);
      const rc = ctx2d(rs);
      rc.save();
      rc.setTransform(1, 0, 0, 1, 0, 0);
      rc.imageSmoothingEnabled = false;
      rc.globalCompositeOperation = 'copy';
      rc.drawImage(this.before, x, y, w, h, 0, 0, w, h);
      rc.globalCompositeOperation = op;
      rc.globalAlpha = opacity;
      rc.drawImage(src, sx, sy, w, h, 0, 0, w, h);
      rc.restore();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.drawImage(rs, 0, 0, w, h, x, y, w, h);
    } else {
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = t.lockTransparency ? 'source-atop' : op;
      ctx.drawImage(src, sx, sy, w, h, x, y, w, h);
    }
    ctx.restore();
  }

  /** Read the before-image of a rect (CPU). */
  readBefore(r: Rect): ImageData {
    return ctx2d(this.before, { willReadFrequently: true }).getImageData(r.x, r.y, r.width, r.height);
  }

  /**
   * Finish: composite pending pixels, record the patch for the touched area and commit one
   * history step. Returns false when nothing was painted.
   */
  commit(label: string, extra?: { activeLayerId?: string }): boolean {
    if (this.finished) return false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.flush();
    this.finished = true;
    const r = this.dirty;
    bufferGarbage = r;
    if (!r) return false;
    if (!targetStillValid(this.target)) return false;
    const before = this.readBefore(r);
    const after = bitmaps.read(this.target.bitmapId, r);
    useEditor.getState().commit(label, undefined, {
      patches: [{ bitmapId: this.target.bitmapId, x: r.x, y: r.y, before, after }],
      ...(extra?.activeLayerId ? { activeLayerId: extra.activeLayerId } : {}),
    });
    return true;
  }

  /** Abort: restore the original pixels. */
  cancel() {
    if (this.finished) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.finished = true;
    bufferGarbage = this.dirty;
    const r = this.dirty;
    if (!r || !targetStillValid(this.target)) return;
    const ctx = ctx2d(this.target.canvas);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.drawImage(this.before, 0, 0);
    ctx.restore();
    bitmaps.touch(this.target.bitmapId);
    viewport.requestRender();
  }
}
