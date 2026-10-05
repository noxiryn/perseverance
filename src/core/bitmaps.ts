/**
 * BitmapStore — owns all pixel data (raster layer contents, masks, selections).
 *
 * Documents reference bitmaps by id. A bitmap is mutated ONLY:
 *   1. live during a tool interaction (e.g. a brush stroke) — call `touch(id)` after drawing,
 *      and record a BitmapPatch (before/after ImageData of the dirty rect) for history; or
 *   2. by history undo/redo applying patches.
 * Creating a new bitmap for a new state (e.g. a filter applied destructively) is also fine.
 *
 * `version(id)` increments on every change so render caches can be invalidated.
 *
 * Dirty regions: `touch(id, rect)` records WHERE a bitmap changed (bitmap-local px). The store
 * keeps a short log of the regions touched per version, so a cache that rendered version `v` can
 * ask `dirtySince(id, v)` for the union of everything that changed since (null = unknown / the
 * whole bitmap) and re-render only that part (live brush strokes re-composite just the stroke
 * area). `touch(id)` without a rect still means "everything changed".
 */
import type { BitmapPatch, ID, Rect } from './types';
import { createCanvas, ctx2d } from './canvas';
import { uid } from './ids';

interface Entry {
  canvas: HTMLCanvasElement;
  version: number;
  created: number;
  /** Region touched by each recent version (null = whole bitmap), oldest first. */
  log: { v: number; r: Rect | null }[];
}

/** `rect` is the changed region (bitmap-local px) when the toucher knew it; undefined = everything. */
type Listener = (id: ID, rect?: Rect) => void;

/** Versions remembered per bitmap for `dirtySince` (a long stroke at 60 fps ≈ 4 s). */
const DIRTY_LOG = 256;

const EMPTY_RECT: Readonly<Rect> = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

/** Integer rect covering `r`, clipped to [0,w]×[0,h] (may come out empty). */
function clampRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.floor(Number.isFinite(r.x) ? r.x : 0));
  const y0 = Math.max(0, Math.floor(Number.isFinite(r.y) ? r.y : 0));
  const x1 = Math.min(w, Math.ceil(Number.isFinite(r.x + r.width) ? r.x + r.width : w));
  const y1 = Math.min(h, Math.ceil(Number.isFinite(r.y + r.height) ? r.y + r.height : h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: x0, y: y0, width: 0, height: 0 };
}

class BitmapStoreImpl {
  private map = new Map<ID, Entry>();
  private listeners = new Set<Listener>();

  /** Register a canvas as a new bitmap. The store takes ownership of the canvas. */
  add(canvas: HTMLCanvasElement, id: ID = uid('bmp_')): ID {
    const old = this.map.get(id);
    // Re-adding an id replaces its pixels: the version keeps increasing (caches keyed by version
    // must not mistake the new pixels for an old render) and the change is "everything".
    const version = old ? old.version + 1 : 1;
    this.map.set(id, { canvas, version, created: Date.now(), log: old ? [{ v: version, r: null }] : [] });
    return id;
  }

  /** Create an empty (transparent) bitmap. */
  create(width: number, height: number, fill?: string): ID {
    const c = createCanvas(width, height);
    if (fill) {
      const ctx = ctx2d(c);
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    return this.add(c);
  }

  has(id: ID | null | undefined): boolean {
    return !!id && this.map.has(id);
  }

  /** Returns the live canvas. Do not mutate it without recording a patch + calling touch(). */
  get(id: ID): HTMLCanvasElement {
    const e = this.map.get(id);
    if (!e) throw new Error(`Bitmap not found: ${id}`);
    return e.canvas;
  }

  tryGet(id: ID | null | undefined): HTMLCanvasElement | null {
    if (!id) return null;
    return this.map.get(id)?.canvas ?? null;
  }

  version(id: ID | null | undefined): number {
    if (!id) return 0;
    return this.map.get(id)?.version ?? 0;
  }

  /**
   * Mark a bitmap as changed (bumps version, notifies listeners → re-render). `rect` (bitmap-local
   * px) limits the change to a region — renderers then re-composite only that part; omit it when
   * the change is not known to be local.
   */
  touch(id: ID, rect?: Rect | null) {
    const e = this.map.get(id);
    if (!e) return;
    e.version++;
    const r = rect ? clampRect(rect, e.canvas.width, e.canvas.height) : null;
    e.log.push({ v: e.version, r });
    if (e.log.length > DIRTY_LOG) e.log.splice(0, e.log.length - DIRTY_LOG);
    if (r) this.listeners.forEach((l) => l(id, { ...r }));
    else this.listeners.forEach((l) => l(id));
  }

  /**
   * Union of the regions (bitmap-local px) changed after `version`: an empty rect (width 0) when
   * nothing changed, null when unknown (a touch without a rect, a version older than the log
   * remembers, an unknown bitmap or a version from the future).
   */
  dirtySince(id: ID | null | undefined, version: number): Rect | null {
    const e = id ? this.map.get(id) : undefined;
    if (!e || !Number.isFinite(version)) return null;
    if (version === e.version) return { ...EMPTY_RECT };
    if (version > e.version) return null;
    const log = e.log;
    // Every version in (version, e.version] must be in the log.
    if (!log.length || log[0].v > version + 1 || log[log.length - 1].v !== e.version) return null;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = log.length - 1; i >= 0 && log[i].v > version; i--) {
      const r = log[i].r;
      if (!r) return null;
      if (r.width <= 0 || r.height <= 0) continue;
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.width);
      y1 = Math.max(y1, r.y + r.height);
    }
    return x1 > x0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { ...EMPTY_RECT };
  }

  /** Copy of a bitmap as a new bitmap id. */
  duplicate(id: ID): ID {
    const src = this.get(id);
    const c = createCanvas(src.width, src.height);
    ctx2d(c).drawImage(src, 0, 0);
    return this.add(c);
  }

  /** Read the pixels in a rect (clamped to the bitmap). */
  read(id: ID, rect?: Rect): ImageData {
    const c = this.get(id);
    const r = rect ?? { x: 0, y: 0, width: c.width, height: c.height };
    return ctx2d(c, { willReadFrequently: true }).getImageData(r.x, r.y, Math.max(1, r.width), Math.max(1, r.height));
  }

  /** Apply a patch side (used by history). */
  applyPatch(p: BitmapPatch, side: 'before' | 'after') {
    const c = this.tryGet(p.bitmapId);
    if (!c) return;
    const img = side === 'before' ? p.before : p.after;
    ctx2d(c).putImageData(img, p.x, p.y);
    this.touch(p.bitmapId, { x: p.x, y: p.y, width: img.width, height: img.height });
  }

  /**
   * Helper to perform a destructive edit with automatic patch recording.
   * `rect` limits the recorded area (defaults to the full bitmap).
   */
  edit(id: ID, draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void, rect?: Rect): BitmapPatch {
    const c = this.get(id);
    const r = rect ?? { x: 0, y: 0, width: c.width, height: c.height };
    const before = this.read(id, r);
    const ctx = ctx2d(c);
    ctx.save();
    draw(ctx, c);
    ctx.restore();
    const after = this.read(id, r);
    this.touch(id);
    return { bitmapId: id, x: r.x, y: r.y, before, after };
  }

  /**
   * Remove bitmaps that are not in `keep` (garbage collection after history trimming).
   * Bitmaps younger than `graceMs` are kept: a tool may have created them and not committed yet.
   */
  retainOnly(keep: Set<ID>, graceMs = 30000) {
    const cutoff = Date.now() - graceMs;
    for (const [id, e] of this.map) if (!keep.has(id) && e.created < cutoff) this.map.delete(id);
  }

  /** Keep a bitmap alive regardless of document references (e.g. clipboard). */
  pin(id: ID) {
    const e = this.map.get(id);
    if (e) e.created = Number.MAX_SAFE_INTEGER;
  }

  ids(): ID[] {
    return [...this.map.keys()];
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const bitmaps = new BitmapStoreImpl();
export type BitmapStore = BitmapStoreImpl;
