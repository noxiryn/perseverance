/**
 * Render caches: one LRU keyed by strings with a pixel budget (canvases dominate memory), plus
 * object identity tokens so cache keys can reference immutable document objects cheaply.
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

/* ---------------- LRU ---------------- */

export interface CacheEntry<T = unknown> {
  value: T;
  /** Approximate pixel count held (for the budget). */
  pixels: number;
  /** Layer this entry belongs to (for targeted invalidation). */
  layerId?: ID;
}

/** Pixel budget ≈ 256 MB of RGBA canvases. */
const DEFAULT_BUDGET = 64 * 1024 * 1024;

export class PixelLRU {
  private map = new Map<string, CacheEntry>();
  private total = 0;
  constructor(public budget = DEFAULT_BUDGET) {}

  get<T>(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    // refresh recency
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

  /** Remove entries whose key starts with a prefix. */
  clearPrefix(prefix: string) {
    for (const [k, e] of this.map) {
      if (k.startsWith(prefix)) {
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

/** The shared render cache. */
export const renderCache = new PixelLRU();

/** Font-load / global invalidation generation (part of text cache keys). */
let generation = 0;
export function cacheGeneration() {
  return generation;
}

export function bumpGeneration() {
  generation++;
  // Identity tokens can stay (objects are immutable); keys include the generation.
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
