/**
 * Render caches.
 *
 *  - `objId(o)`: stable small integer per immutable document object (cheap cache-key fragments).
 *  - `PixelLRU`: string-keyed LRU with a pixel budget (generated assets, pattern tiles).
 *  - `SlotCache`: per-identity slots holding the few most recent versions of something (a layer
 *    render, a text raster, a document composite). Live edits produce a new version every frame;
 *    slots keep only the latest couple of versions per identity, so a drag never floods the cache
 *    and evicts the renders of unrelated layers. Global pixel budget with LRU eviction by slot.
 */
import type { ID } from '../core/types';

/* ---------------- identity tokens ---------------- */

let nextObjId = 1;
let objIds = new WeakMap<object, number>();

/** Stable small integer for an object (immutable document parts → cache key fragments). */
export function objId(o: object | null | undefined): number {
  if (!o) return 0;
  let id = objIds.get(o);
  if (id === undefined) {
    id = nextObjId++;
    objIds.set(o, id);
  }
  return id;
}

/** Reset identity tokens (tests). */
export function resetObjIds() {
  objIds = new WeakMap();
  nextObjId = 1;
}

/** Canvas pixel count helper. */
export function px(c: { width: number; height: number } | null | undefined): number {
  return c ? c.width * c.height : 0;
}

/* ---------------- LRU ---------------- */

export interface CacheEntry<T = unknown> {
  value: T;
  /** Approximate pixel count held (for the budget). */
  pixels: number;
  /** Layer this entry belongs to (for targeted invalidation). */
  layerId?: ID;
}

export class PixelLRU {
  private map = new Map<string, CacheEntry>();
  private total = 0;
  constructor(public budget = 16 * 1024 * 1024) {}

  get<T>(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value as T;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set<T>(key: string, value: T, pixels: number, layerId?: ID): T {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.pixels;
      this.map.delete(key);
    }
    this.map.set(key, { value, pixels, layerId });
    this.total += pixels;
    this.evict();
    return value;
  }

  delete(key: string) {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.pixels;
    this.map.delete(key);
  }

  /** Drop entries of one layer (or everything). */
  clear(layerId?: ID) {
    if (layerId === undefined) {
      this.map.clear();
      this.total = 0;
      return;
    }
    for (const [k, e] of this.map) {
      if (e.layerId === layerId) {
        this.total -= e.pixels;
        this.map.delete(k);
      }
    }
  }

  get size() {
    return this.map.size;
  }

  get pixels() {
    return this.total;
  }

  private evict() {
    if (this.total <= this.budget) return;
    for (const [k, e] of this.map) {
      if (this.total <= this.budget * 0.85) break;
      this.total -= e.pixels;
      this.map.delete(k);
    }
  }
}

/* ---------------- slots ---------------- */

/**
 * A memory-holding object shared between cache entries (a canvas, a typed array). Entries list
 * their resources; each resource counts once against the budget however many entries hold it
 * (e.g. a moved layer's shifted render shares the canvases of the render it was made from).
 */
export type Resource = HTMLCanvasElement | OffscreenCanvas | ArrayBufferView | { width: number; height: number };

/** Pixel-equivalent size of a resource (typed arrays: 4 bytes = 1 px). */
export function resourcePixels(o: Resource): number {
  if (ArrayBuffer.isView(o)) return Math.ceil(o.byteLength / 4);
  const c = o as { width?: number; height?: number };
  return (c.width ?? 0) * (c.height ?? 0);
}

interface SlotEntry {
  sig: string;
  value: unknown;
  pixels: number;
  res: Resource[] | null;
}

interface Slot {
  entries: SlotEntry[];
  layerId?: ID;
  /** Composite entries (documents, groups, snapshots) are dropped by any targeted invalidation. */
  composite?: boolean;
}

export interface SlotSetOptions {
  layerId?: ID;
  composite?: boolean;
  max?: number;
  /** Shared resources held by the value (counted once across all entries). */
  res?: (Resource | null | undefined)[];
}

export class SlotCache {
  private map = new Map<string, Slot>();
  private total = 0;
  private refs = new Map<object, { n: number; px: number }>();
  constructor(
    public budget = 40 * 1024 * 1024,
    public perKey = 2,
  ) {}

  private addEntry(e: SlotEntry) {
    this.total += e.pixels;
    if (!e.res) return;
    for (const r of e.res) {
      const ref = this.refs.get(r);
      if (ref) ref.n++;
      else {
        const px = resourcePixels(r);
        this.refs.set(r, { n: 1, px });
        this.total += px;
      }
    }
  }

  private dropEntry(e: SlotEntry) {
    this.total -= e.pixels;
    if (!e.res) return;
    for (const r of e.res) {
      const ref = this.refs.get(r);
      if (!ref) continue;
      if (--ref.n <= 0) {
        this.refs.delete(r);
        this.total -= ref.px;
      }
    }
  }

  get<T>(key: string, sig: string): T | undefined {
    const slot = this.map.get(key);
    if (!slot) return undefined;
    const i = slot.entries.findIndex((e) => e.sig === sig);
    if (i < 0) return undefined;
    const e = slot.entries[i];
    if (i > 0) {
      slot.entries.splice(i, 1);
      slot.entries.unshift(e);
    }
    this.map.delete(key);
    this.map.set(key, slot);
    return e.value as T;
  }

  /** Most recent entry of a slot regardless of its signature. */
  peek<T>(key: string): { sig: string; value: T } | undefined {
    const e = this.map.get(key)?.entries[0];
    return e ? { sig: e.sig, value: e.value as T } : undefined;
  }

  /** Values of every entry of a slot, most recent first (does not touch the LRU order). */
  values<T>(key: string): T[] {
    const slot = this.map.get(key);
    return slot ? slot.entries.map((e) => e.value as T) : [];
  }

  set<T>(key: string, sig: string, value: T, pixels: number, opts: SlotSetOptions = {}): T {
    let slot = this.map.get(key);
    if (!slot) slot = { entries: [], layerId: opts.layerId, composite: opts.composite };
    else this.map.delete(key);
    const old = slot.entries.findIndex((e) => e.sig === sig);
    let res: Resource[] | null = null;
    if (opts.res) {
      const seen = new Set<object>();
      for (const r of opts.res) if (r && !seen.has(r)) seen.add(r);
      res = seen.size ? ([...seen] as Resource[]) : null;
    }
    const entry: SlotEntry = { sig, value, pixels, res };
    // Count the new entry before dropping the old one so shared resources never hit zero refs.
    this.addEntry(entry);
    if (old >= 0) this.dropEntry(slot.entries.splice(old, 1)[0]);
    slot.entries.unshift(entry);
    const max = Math.max(1, opts.max ?? this.perKey);
    while (slot.entries.length > max) this.dropEntry(slot.entries.pop()!);
    this.map.set(key, slot);
    this.evict(key);
    return value;
  }

  /** Drop one slot. */
  delete(key: string) {
    const slot = this.map.get(key);
    if (!slot) return;
    for (const e of slot.entries) this.dropEntry(e);
    this.map.delete(key);
  }

  /**
   * Clear everything, or the slots tagged with `layerId` plus (unless `composites` is false)
   * every composite slot.
   */
  clear(layerId?: ID, opts: { composites?: boolean } = {}) {
    if (layerId === undefined) {
      this.map.clear();
      this.refs.clear();
      this.total = 0;
      return;
    }
    const composites = opts.composites !== false;
    for (const [k, s] of this.map) {
      if (s.layerId === layerId || (composites && s.composite)) {
        for (const e of s.entries) this.dropEntry(e);
        this.map.delete(k);
      }
    }
  }

  get size() {
    return this.map.size;
  }

  get pixels() {
    return this.total;
  }

  private evict(keep: string) {
    if (this.total <= this.budget) return;
    for (const [k, s] of this.map) {
      if (this.total <= this.budget * 0.85) break;
      if (k === keep) continue;
      for (const e of s.entries) this.dropEntry(e);
      this.map.delete(k);
    }
  }
}

/** Generated assets / pattern tiles (keyed by asset definition identity + size + params). */
export const renderCache = new PixelLRU(24 * 1024 * 1024);

/** `layerId` tag of asset-cache entries that must not survive a full invalidation (user images). */
export const VOLATILE_ASSETS = '\u0000volatile-assets';

/**
 * Layer renders, text/shape rasters, masks, composites, thumbnails. 64M px (≈256 MB): enough
 * for the working set of a heavy 1080p document (≈10 full-canvas layers with effects plus
 * composites and adjustment snapshots) so live edits never thrash.
 */
export const slots = new SlotCache(64 * 1024 * 1024, 2);

/** Font-load / global invalidation generation (part of text cache keys). */
let generation = 0;
export function cacheGeneration() {
  return generation;
}

export function bumpGeneration() {
  generation++;
}
