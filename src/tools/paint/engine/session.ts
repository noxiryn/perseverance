/**
 * CompositeSession — the live painting pipeline for GPU-drawn tools (brush, pencil, eraser,
 * clone, gradient, bucket).
 *
 *   stroke buffer S (dabs at flow)  ──►  T = before ⊕ (fill(S) · selection) at opacity / blend
 *
 * Brush-like tools paint WHITE coverage dabs into S and the color (or the clone source image)
 * is applied once per composite (`mode.color` / `mode.fill`), which keeps low-alpha edges
 * color-exact. Only dirty rects are recomposited each frame (one rAF), the before-image is a
 * GPU copy of the layer taken at stroke start, and the history patches are read back once on
 * commit — one per run of touched 64px cells (see DirtyGrid), so history memory scales with
 * the painted area rather than the stroke's bounding box.
 */
import type { BitmapPatch, Rect } from '../../../core/types';
import { bitmaps } from '../../../core/bitmaps';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { pixelRect, rectUnion } from '../../../core/geometry';
import { viewport } from '../../../editor/viewport';
import { useEditor } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { restoreIfAlive, type GuardedSession } from './guard';
import { targetStillValid, type PaintTarget } from './target';
import { DirtyGrid, bandsOf, cropImageData } from './tiles';

export interface CompositeMode {
  /** 0..1 stroke opacity cap. */
  opacity: number;
  /** Composite op used to apply the stroke buffer to the layer. */
  op: GlobalCompositeOperation;
  /**
   * Tint color for coverage-only strokes. When set, the stroke buffer holds WHITE dabs (a pure
   * alpha mask) and the color is applied once per composite. White survives 8-bit premultiplied
   * accumulation exactly, so soft edges of low-flow strokes (airbrush, smoke…) keep their true
   * color instead of drifting to black.
   */
  color?: string;
  /**
   * Image fill for coverage strokes (clone stamp): `image` drawn through `matrix` (image → bitmap
   * local space) and masked by the stroke coverage. Takes precedence over `color`. The image
   * 'before' means the session's own stroke-start copy of the layer (local space).
   */
  fill?: { image: CanvasImageSource | 'before'; matrix: DOMMatrix };
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

/**
 * Rect of the pooled stroke buffer that may hold pixels from earlier sessions. Grown on every
 * markDirty (not only on commit/cancel), so even an abandoned session can't leak old dabs into
 * the next stroke.
 */
let bufferGarbage: Rect | null = null;

export class CompositeSession implements GuardedSession {
  readonly target: PaintTarget;
  readonly buffer: HTMLCanvasElement;
  readonly bufferCtx: CanvasRenderingContext2D;
  readonly before: HTMLCanvasElement;
  mode: CompositeMode;
  /** Bounding box of everything touched (local px). */
  private dirty: Rect | null = null;
  /** Touched cells — what the history patches and restores cover. */
  private cells: DirtyGrid;
  private frame: Rect | null = null;
  private raf = 0;
  private finished = false;

  constructor(target: PaintTarget, mode: CompositeMode) {
    this.target = target;
    this.mode = mode;
    const { width: w, height: h } = target;
    this.cells = new DirtyGrid(w, h);

    this.before = pooled('before', w, h);
    const bctx = ctx2d(this.before);
    bctx.save();
    bctx.globalCompositeOperation = 'copy';
    bctx.drawImage(target.canvas, 0, 0);
    bctx.restore();

    const fresh = pool.get('buffer');
    this.buffer = pooled('buffer', w, h);
    this.bufferCtx = ctx2d(this.buffer);
    this.bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (fresh === this.buffer && bufferGarbage) {
      this.bufferCtx.clearRect(bufferGarbage.x, bufferGarbage.y, bufferGarbage.width, bufferGarbage.height);
    }
    bufferGarbage = null;
    this.bufferCtx.globalAlpha = 1;
    this.bufferCtx.globalCompositeOperation = 'source-over';
    this.bufferCtx.imageSmoothingEnabled = true;
    this.bufferCtx.imageSmoothingQuality = 'high';
  }

  /** Mark a local-space rect of the buffer as changed; schedules a composite. */
  markDirty(r: Rect) {
    const pr = pixelRect(r, this.target.width, this.target.height, 1);
    if (!pr) return;
    this.frame = rectUnion(this.frame, pr);
    this.dirty = rectUnion(this.dirty, pr);
    this.cells.add(pr);
    bufferGarbage = rectUnion(bufferGarbage, pr);
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

    // Stroke source: filled/tinted (coverage strokes) and masked by the selection when needed.
    // Every step draws over the whole w×h region, so nothing depends on how the browser treats
    // pixels outside a drawn image with unbounded composite ops.
    const { opacity, op, color, fill } = this.mode;
    let src: HTMLCanvasElement = this.buffer;
    let sx = x,
      sy = y;
    if (t.selection || color || fill) {
      const xs = scratch('masked', w, h);
      const xc = ctx2d(xs);
      xc.save();
      xc.setTransform(1, 0, 0, 1, 0, 0);
      xc.imageSmoothingEnabled = false;
      if (fill) {
        // Image (e.g. the clone source) in local space, then keep it where the stroke covers.
        xc.clearRect(0, 0, w, h);
        const m = fill.matrix;
        xc.save();
        xc.beginPath();
        xc.rect(0, 0, w, h);
        xc.clip();
        xc.setTransform(m.a, m.b, m.c, m.d, m.e - x, m.f - y);
        xc.imageSmoothingEnabled = true;
        xc.imageSmoothingQuality = 'high';
        xc.drawImage(fill.image === 'before' ? this.before : fill.image, 0, 0);
        xc.restore();
        xc.globalCompositeOperation = 'destination-in';
        xc.drawImage(this.buffer, x, y, w, h, 0, 0, w, h);
      } else {
        xc.globalCompositeOperation = 'copy';
        xc.drawImage(this.buffer, x, y, w, h, 0, 0, w, h);
      }
      if (t.selection) {
        xc.globalCompositeOperation = 'destination-in';
        xc.drawImage(t.selection, x, y, w, h, 0, 0, w, h);
      }
      if (color && !fill) {
        xc.globalCompositeOperation = 'source-in';
        xc.fillStyle = color;
        xc.fillRect(0, 0, w, h);
      }
      xc.restore();
      src = xs;
      sx = 0;
      sy = 0;
    }

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

  /**
   * History patches for the touched cells: one per run of touched cells in a cell row, read back
   * with one getImageData per row band (before + after) instead of one per rect.
   */
  private buildPatches(): BitmapPatch[] {
    const t = this.target;
    const beforeCtx = ctx2d(this.before);
    const afterCtx = ctx2d(t.canvas);
    const patches: BitmapPatch[] = [];
    for (const { band, rects } of bandsOf(this.cells.rects())) {
      const b = beforeCtx.getImageData(band.x, band.y, band.width, band.height);
      const a = afterCtx.getImageData(band.x, band.y, band.width, band.height);
      for (const r of rects) {
        patches.push({ bitmapId: t.bitmapId, x: r.x, y: r.y, before: cropImageData(b, band, r), after: cropImageData(a, band, r) });
      }
    }
    return patches;
  }

  /**
   * Finish: composite pending pixels, record the patches for the touched area and commit one
   * history step. Returns false when nothing was painted (or the stroke had to be discarded).
   */
  commit(label: string, extra?: { activeLayerId?: string }): boolean {
    if (this.finished) return false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!targetStillValid(this.target)) {
      // The document changed under the stroke: leave no unrecorded pixels behind.
      this.finished = true;
      if (this.dirty && restoreIfAlive(this)) toast('Stroke discarded — the document changed while painting', 'warning');
      return false;
    }
    this.flush();
    this.finished = true;
    if (this.cells.isEmpty) return false;
    useEditor.getState().commit(label, undefined, {
      patches: this.buildPatches(),
      ...(extra?.activeLayerId ? { activeLayerId: extra.activeLayerId } : {}),
    });
    return true;
  }

  /** Abort: restore the original pixels. */
  cancel() {
    if (this.finished) return;
    this.kill();
    // Restores even when another document became active: the stroke was never recorded.
    if (this.dirty) restoreIfAlive(this);
  }

  /** GuardedSession: stop live updates without touching pixels. */
  kill() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.finished = true;
  }

  /** GuardedSession: copy the stroke-start pixels back over the touched cells. */
  restoreBefore() {
    const rects = this.cells.rects();
    if (!rects.length) return;
    const ctx = ctx2d(this.target.canvas);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = false;
    ctx.beginPath();
    for (const r of rects) ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    ctx.drawImage(this.before, 0, 0);
    ctx.restore();
  }
}
