/**
 * PixelSession — CPU pipeline for the retouch tools. Pixels are read lazily in 256px tiles
 * the first time a dab touches them (one readback per tile per stroke), edited in a
 * full-size working ImageData, and pushed back with putImageData for the dirty rect once per
 * frame. The original tile pixels double as the patch "before" image.
 */
import type { Rect } from '../../../core/types';
import { bitmaps } from '../../../core/bitmaps';
import { ctx2d, ctxRead } from '../../../core/canvas';
import { pixelRect, rectUnion } from '../../../core/geometry';
import { viewport } from '../../../editor/viewport';
import { useEditor } from '../../../state/editor';
import { targetStillValid, type PaintTarget } from './target';
import type { PixelBuf } from './pixelOps';

const TILE = 256;

let workPool: ImageData | null = null;
let origPool: Uint8ClampedArray | null = null;
let covPool: Float32Array | null = null;

export class PixelSession {
  readonly target: PaintTarget;
  readonly work: ImageData;
  readonly buf: PixelBuf;
  readonly orig: Uint8ClampedArray;
  /** Selection alpha per local pixel (null = everything selected). */
  readonly sel: Uint8Array | null;
  private loaded: Uint8Array;
  private tilesX: number;
  private dirty: Rect | null = null;
  private frame: Rect | null = null;
  private raf = 0;
  private finished = false;
  private cov: Float32Array | null = null;

  constructor(target: PaintTarget) {
    this.target = target;
    const { width: w, height: h } = target;
    if (!workPool || workPool.width !== w || workPool.height !== h) {
      workPool = new ImageData(w, h);
      origPool = new Uint8ClampedArray(w * h * 4);
    }
    this.work = workPool;
    this.orig = origPool!;
    this.buf = { data: this.work.data, width: w, height: h };
    this.tilesX = Math.ceil(w / TILE);
    this.loaded = new Uint8Array(this.tilesX * Math.ceil(h / TILE));
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
    const x0 = Math.max(0, Math.floor(r.x / TILE));
    const y0 = Math.max(0, Math.floor(r.y / TILE));
    const x1 = Math.min(this.tilesX - 1, Math.floor((r.x + r.width - 1) / TILE));
    const y1 = Math.min(Math.ceil(H / TILE) - 1, Math.floor((r.y + r.height - 1) / TILE));
    if (x1 < x0 || y1 < y0) return;
    const ctx = ctx2d(this.target.canvas);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ti = ty * this.tilesX + tx;
        if (this.loaded[ti]) continue;
        this.loaded[ti] = 1;
        const px = tx * TILE,
          py = ty * TILE;
        const tw = Math.min(TILE, W - px),
          th = Math.min(TILE, H - py);
        const img = ctx.getImageData(px, py, tw, th);
        const src = img.data;
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

  markDirty(r: Rect) {
    const pr = pixelRect(r, this.target.width, this.target.height);
    if (!pr) return;
    this.frame = rectUnion(this.frame, pr);
    this.dirty = rectUnion(this.dirty, pr);
    if (!this.raf && !this.finished) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.flush();
      });
    }
  }

  flush() {
    const r = this.frame;
    if (!r || this.finished) return;
    this.frame = null;
    ctx2d(this.target.canvas).putImageData(this.work, 0, 0, r.x, r.y, r.width, r.height);
    bitmaps.touch(this.target.bitmapId);
    viewport.requestRender();
  }

  private region(src: Uint8ClampedArray, r: Rect): ImageData {
    const W = this.target.width;
    const out = new ImageData(r.width, r.height);
    for (let y = 0; y < r.height; y++) {
      const o = ((r.y + y) * W + r.x) * 4;
      out.data.set(src.subarray(o, o + r.width * 4), y * r.width * 4);
    }
    return out;
  }

  commit(label: string): boolean {
    if (this.finished) return false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.flush();
    this.finished = true;
    const r = this.dirty;
    if (!r || !targetStillValid(this.target)) return false;
    const before = this.region(this.orig, r);
    const after = this.region(this.work.data, r);
    useEditor.getState().commit(label, undefined, { patches: [{ bitmapId: this.target.bitmapId, x: r.x, y: r.y, before, after }] });
    return true;
  }

  cancel() {
    if (this.finished) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.finished = true;
    const r = this.dirty;
    if (!r || !targetStillValid(this.target)) return;
    ctx2d(this.target.canvas).putImageData(this.region(this.orig, r), r.x, r.y);
    bitmaps.touch(this.target.bitmapId);
    viewport.requestRender();
  }
}
