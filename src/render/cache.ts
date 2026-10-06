/**
 * Render caches.
 *
 *  - `objId(o)`: stable small integer per immutable document object (cheap cache-key fragments).
 *  - `PixelLRU`: string-keyed LRU with a pixel budget (generated assets, pattern tiles).
 *  - `SlotCache`: per-identity slots holding the few most recent versions of something (a layer
 *    render, a text raster, a document composite). Live edits produce a new version every frame;
 *    slots keep only the latest couple of versions per identity, so a drag never floods the cache
 *    and evicts the renders of unrelated layers. Soft pixel budget with LRU eviction by slot: the
 *    working set (slots used in the last moments, and the renders displayed documents depend on,
 *    see setKeepAlive) may overflow it up to a hard cap, and the cache shrinks back when idle.
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
  /** Render scale tag (see SlotSetOptions.scale). */
  scale?: string;
  /** Last use (get / set), in `now()` ms. */
  t: number;
}

export interface SlotSetOptions {
  layerId?: ID;
  composite?: boolean;
  max?: number;
  /** Shared resources held by the value (counted once across all entries). */
  res?: (Resource | null | undefined)[];
  /** Render scale the value was made at: with `layerId`, what setKeepAlive is asked about. */
  scale?: string;
}

export interface SlotCacheOptions {
  /**
   * Hard limit (px). The working set (recently used / kept-alive slots) may exceed the budget up
   * to here; past it even working-set slots are evicted, least recently used first. Default 3×
   * the budget.
   */
  hardCap?: number;
  /** Slots used this recently (ms) belong to the working set (a render pass, an interaction). */
  recentMs?: number;
  /** Once the cache has been idle this long (ms), it shrinks back to its budget. */
  trimMs?: number;
  /** Clock (ms; tests). */
  now?: () => number;
}

/** `(layerId, scale)` of a slot → whether a displayed document needs it (kept while over budget). */
export type KeepAlive = (layerId: ID, scale: string) => boolean;

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Eviction. Plain LRU with a fixed budget has a cliff: once the renders a document needs exceed
 * the budget, every insert evicts renders that the next frame needs again (painting re-rendered
 * every layer on every frame). So the budget is soft:
 *  - on insert over budget, slots OUTSIDE the working set are evicted (least recently used first)
 *    down to 85% of the budget. The working set: slots used in the last `recentMs` (the render
 *    pass in progress, an interaction) and slots a displayed document needs (the keep-alive hook:
 *    the layer renders of the live composites, which while painting are only touched when a
 *    stroke reaches new tiles of the below cache);
 *  - past the hard cap, working-set slots go too (least recently used first) down to the cap;
 *  - while over budget, an idle timer shrinks the cache back to the budget once nothing used it
 *    for `trimMs` (everything not kept alive by a displayed document), and keeps checking while
 *    kept-alive slots hold it above the budget (they expire when their document is no longer
 *    displayed).
 */
export class SlotCache {
  private map = new Map<string, Slot>();
  private total = 0;
  private refs = new Map<object, { n: number; px: number }>();
  /** Hard limit (px), see SlotCacheOptions.hardCap. */
  hardCap: number;
  private readonly recentMs: number;
  private readonly trimMs: number;
  private readonly now: () => number;
  private keepAlive: KeepAlive | null = null;
  private lastUse = 0;
  private trimTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    public budget = 40 * 1024 * 1024,
    public perKey = 2,
    opts: SlotCacheOptions = {},
  ) {
    this.hardCap = opts.hardCap ?? budget * 3;
    this.recentMs = opts.recentMs ?? 1500;
    this.trimMs = opts.trimMs ?? 2000;
    this.now = opts.now ?? clock;
  }

  /** Install the keep-alive hook (slots stored with a layerId and a scale are asked about). */
  setKeepAlive(fn: KeepAlive | null) {
    this.keepAlive = fn;
  }

  private use(slot: Slot) {
    slot.t = this.lastUse = this.now();
  }

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
    this.use(slot);
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
    if (!slot) slot = { entries: [], layerId: opts.layerId, composite: opts.composite, scale: opts.scale, t: 0 };
    else this.map.delete(key);
    this.use(slot);
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
    this.dropSlot(key, slot);
  }

  private dropSlot(key: string, slot: Slot) {
    for (const e of slot.entries) this.dropEntry(e);
    this.map.delete(key);
  }

  /** Drop every slot whose key (and composite flag) matches. */
  deleteWhere(pred: (key: string, composite: boolean) => boolean) {
    for (const [k, s] of this.map) {
      if (!pred(k, !!s.composite)) continue;
      for (const e of s.entries) this.dropEntry(e);
      this.map.delete(k);
    }
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

  /** Whether a slot belongs to the working set (see the eviction notes above the class). */
  private working(s: Slot, now: number): boolean {
    if (now - s.t < this.recentMs) return true;
    return s.layerId !== undefined && s.scale !== undefined && !!this.keepAlive?.(s.layerId, s.scale);
  }

  private evict(keep: string) {
    if (this.total <= this.budget) return;
    const now = this.now();
    const target = this.budget * 0.85;
    for (const [k, s] of this.map) {
      if (this.total <= target) break;
      if (k === keep || this.working(s, now)) continue;
      this.dropSlot(k, s);
    }
    if (this.total > this.hardCap) {
      for (const [k, s] of this.map) {
        if (this.total <= this.hardCap) break;
        if (k === keep) continue;
        this.dropSlot(k, s);
      }
    }
    if (this.total > this.budget) this.armTrim(this.trimMs);
  }

  private armTrim(ms: number) {
    if (this.trimTimer !== null || typeof setTimeout === 'undefined') return;
    const t = setTimeout(() => {
      this.trimTimer = null;
      this.idleTrim();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    this.trimTimer = t;
  }

  private idleTrim() {
    if (this.total <= this.budget) return;
    const idle = this.now() - this.lastUse;
    // Still in use: check again once it has been idle for trimMs.
    if (idle < this.trimMs) return this.armTrim(this.trimMs - idle);
    this.trim();
    // Kept-alive slots hold it above the budget: they expire when their document is no longer
    // displayed — check again later.
    if (this.total > this.budget) this.armTrim(this.trimMs * 5);
  }

  /**
   * Shrink back to the budget now: evict every slot outside the working set, least recently used
   * first, until the budget is met (the idle trim calls this).
   */
  trim() {
    const now = this.now();
    for (const [k, s] of this.map) {
      if (this.total <= this.budget) break;
      if (this.working(s, now)) continue;
      this.dropSlot(k, s);
    }
  }
}

/**
 * Hard cap of the render cache (px): how far the working set may exceed the budget, by device
 * memory (navigator.deviceMemory, GB; Chromium reports at most 8).
 */
export function hardCapFor(budget: number, deviceMemoryGB: number | undefined): number {
  if (!deviceMemoryGB || !Number.isFinite(deviceMemoryGB)) return budget * 3;
  if (deviceMemoryGB <= 2) return budget * 1.5;
  if (deviceMemoryGB <= 4) return budget * 2.5;
  return budget * 4;
}

/** Generated assets / pattern tiles (keyed by asset definition identity + size + params). */
export const renderCache = new PixelLRU(24 * 1024 * 1024);

/** `layerId` tag of asset-cache entries that must not survive a full invalidation (user images). */
export const VOLATILE_ASSETS = '\u0000volatile-assets';

/**
 * Layer renders, text/shape rasters, masks, composites, thumbnails. Soft budget 64M px (≈256 MB):
 * the renders of a document with ≈7 full-canvas 1080p layers with effects (a doc-sized layer with
 * Drop Shadow + Stroke holds ≈6–8M px: content, behind pieces, distance fields while its effects
 * are edited; ≈4× that at 4K) plus composites. The working set of the displayed documents may
 * exceed it up to the hard cap (≈1 GB with ≥ 8 GB of memory), see SlotCache.
 */
const SLOT_BUDGET = 64 * 1024 * 1024;
export const slots = new SlotCache(SLOT_BUDGET, 2, {
  hardCap: hardCapFor(SLOT_BUDGET, typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined),
});

/** Font-load / global invalidation generation (part of text cache keys). */
let generation = 0;
export function cacheGeneration() {
  return generation;
}

export function bumpGeneration() {
  generation++;
}
