/**
 * PixelSession — CPU pipeline for the retouch tools. Pixels are read lazily in 256px tiles
 * the first time a dab touches them (one readback per tile per stroke) into a full-size working
 * buffer, edited there, and pushed back once per frame.
 *
 * The working/original buffers are pooled across strokes, so only LOADED tiles hold valid
 * pixels. Everything that leaves the session — live writes, history patches, restores — is
 * therefore built from the touched 64px cells (DirtyGrid), each of which lies inside a loaded
 * tile, never from a bounding box that could span tiles the brush never visited.
 */
import type { BitmapPatch, Rect } from '../../../core/types';
import { bitmaps } from '../../../core/bitmaps';
import { ctx2d, ctxRead } from '../../../core/canvas';
import { pixelRect } from '../../../core/geometry';
import { viewport } from '../../../editor/viewport';
import { useEditor } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { restoreIfAlive, type GuardedSession } from './guard';
import { targetStillValid, type PaintTarget } from './target';
import { DIRTY_CELL, DirtyGrid } from './tiles';
import type { PixelBuf } from './pixelOps';

/** Load tile size (a multiple of DIRTY_CELL, so every dirty cell lies inside one load tile). */
export const LOAD_TILE = DIRTY_CELL * 4;

let workPool: ImageData | null = null;
let origPool: ImageData | null = null;
let covPool: Float32Array | null = null;

/** Copy rect `r` of a full-width RGBA buffer into a new ImageData. */
function region(src: Uint8ClampedArray, W: number, r: Rect): ImageData {
  const out = new ImageData(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const o = ((r.y + y) * W + r.x) * 4;
    out.data.set(src.subarray(o, o + r.width * 4), y * r.width * 4);
  }
  return out;
}

export class PixelSession implements GuardedSession {
  readonly target: PaintTarget;
  readonly work: ImageData;
  readonly buf: PixelBuf;
  readonly orig: Uint8ClampedArray;
  private readonly origImg: ImageData;
  /** Selection alpha per local pixel (null = everything selected). */
  readonly sel: Uint8Array | null;
  private loaded: Uint8Array;
  private tilesX: number;
  private tilesY: number;
  /** Cells touched during the whole stroke (patches / restore). */
  private dirty: DirtyGrid;
  /** Cells touched since the last flush (live writes). */
  private frame: DirtyGrid;
  private raf = 0;
  private finished = false;
  private cov: Float32Array | null = null;

  constructor(target: PaintTarget) {
    this.target = target;
    const { width: w, height: h } = target;
    if (!workPool || workPool.width !== w || workPool.height !== h) {
      workPool = new ImageData(w, h);
      origPool = new ImageData(w, h);
    }
    this.work = workPool;
    this.origImg = origPool!;
    this.orig = this.origImg.data;
    this.buf = { data: this.work.data, width: w, height: h };
    this.tilesX = Math.ceil(w / LOAD_TILE);
    this.tilesY = Math.ceil(h / LOAD_TILE);
    this.loaded = new Uint8Array(this.tilesX * this.tilesY);
    this.dirty = new DirtyGrid(w, h);
    this.frame = new DirtyGrid(w, h);
    if (target.selection) {
      const sc = target.selection;
      const data = ctxRead(sc).getImageData(0, 0, sc.width, sc.height).data;
      const sel = new Uint8Array(w * h);
      for (let i = 0, p = 3; i < sel.length; i++, p += 4) sel[i] = data[p];
      this.sel = sel;
    } else this.sel = null;
  }

  /** Per-pixel coverage buffer for the tone tools (zeroed for this stroke). */
  coverage(): Float32Array {
    if (this.cov) return this.cov;
    const n = this.target.width * this.target.height;
    if (!covPool || covPool.length !== n) covPool = new Float32Array(n);
    else covPool.fill(0);
    this.cov = covPool;
    return this.cov;
  }

  /** Make sure all tiles intersecting `r` (local px) are loaded into the working buffer. */
  ensure(r: Rect) {
    const { width: W, height: H } = this.target;
    const x0 = Math.max(0, Math.floor(r.x / LOAD_TILE));
    const y0 = Math.max(0, Math.floor(r.y / LOAD_TILE));
    const x1 = Math.min(this.tilesX - 1, Math.floor((r.x + r.width - 1) / LOAD_TILE));
    const y1 = Math.min(this.tilesY - 1, Math.floor((r.y + r.height - 1) / LOAD_TILE));
    if (x1 < x0 || y1 < y0) return;
    let ctx: CanvasRenderingContext2D | null = null;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ti = ty * this.tilesX + tx;
        if (this.loaded[ti]) continue;
        this.loaded[ti] = 1;
        ctx ??= ctx2d(this.target.canvas);
        const px = tx * LOAD_TILE,
          py = ty * LOAD_TILE;
        const tw = Math.min(LOAD_TILE, W - px),
          th = Math.min(LOAD_TILE, H - py);
        const src = ctx.getImageData(px, py, tw, th).data;
        for (let y = 0; y < th; y++) {
          const so = y * tw * 4;
          const dO = ((py + y) * W + px) * 4;
          const row = src.subarray(so, so + tw * 4);
          this.work.data.set(row, dO);
          this.orig.set(row, dO);
        }
      }
    }
  }

  /** Mark a local rect as edited (its tiles are loaded if they were not yet). */
  markDirty(r: Rect) {
    const pr = pixelRect(r, this.target.width, this.target.height);
    if (!pr || this.finished) return;
    this.ensure(pr);
    this.frame.add(pr);
    this.dirty.add(pr);
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.flush();
      });
    }
  }

  /** Push the cells edited since the last frame into the layer bitmap. */
  flush() {
    if (this.finished || this.frame.isEmpty) return;
    const ctx = ctx2d(this.target.canvas);
    for (const r of this.frame.rects()) ctx.putImageData(this.work, 0, 0, r.x, r.y, r.width, r.height);
    this.frame.clear();
    bitmaps.touch(this.target.bitmapId);
    viewport.requestRender();
  }

  /** One patch per run of touched cells (memory scales with the painted area). */
  private buildPatches(): BitmapPatch[] {
    const W = this.target.width;
    return this.dirty.rects().map((r) => ({
      bitmapId: this.target.bitmapId,
      x: r.x,
      y: r.y,
      before: region(this.orig, W, r),
      after: region(this.work.data, W, r),
    }));
  }

  commit(label: string): boolean {
    if (this.finished) return false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!targetStillValid(this.target)) {
      this.finished = true;
      if (!this.dirty.isEmpty && restoreIfAlive(this)) toast('Stroke discarded — the document changed while painting', 'warning');
      return false;
    }
    this.flush();
    this.finished = true;
    if (this.dirty.isEmpty) return false;
    useEditor.getState().commit(label, undefined, { patches: this.buildPatches() });
    return true;
  }

  cancel() {
    if (this.finished) return;
    this.kill();
    if (!this.dirty.isEmpty) restoreIfAlive(this);
  }

  /** GuardedSession: stop live updates without touching pixels. */
  kill() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.finished = true;
  }

  /** GuardedSession: put the original pixels back over the touched cells. */
  restoreBefore() {
    const ctx = ctx2d(this.target.canvas);
    for (const r of this.dirty.rects()) ctx.putImageData(this.origImg, 0, 0, r.x, r.y, r.width, r.height);
  }
}
