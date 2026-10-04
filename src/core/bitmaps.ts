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
 */
import type { BitmapPatch, ID, Rect } from './types';
import { createCanvas, ctx2d } from './canvas';
import { uid } from './ids';

interface Entry {
  canvas: HTMLCanvasElement;
  version: number;
  created: number;
}

type Listener = (id: ID) => void;

class BitmapStoreImpl {
  private map = new Map<ID, Entry>();
  private listeners = new Set<Listener>();

  /** Register a canvas as a new bitmap. The store takes ownership of the canvas. */
  add(canvas: HTMLCanvasElement, id: ID = uid('bmp_')): ID {
    this.map.set(id, { canvas, version: 1, created: Date.now() });
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

  /** Mark a bitmap as changed (bumps version, notifies listeners → re-render). */
  touch(id: ID) {
    const e = this.map.get(id);
    if (!e) return;
    e.version++;
    this.listeners.forEach((l) => l(id));
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
    ctx2d(c).putImageData(side === 'before' ? p.before : p.after, p.x, p.y);
    this.touch(p.bitmapId);
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
