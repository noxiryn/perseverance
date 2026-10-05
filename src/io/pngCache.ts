/**
 * PNG cache for project saves/autosaves: a bitmap is only re-encoded when it changed.
 *
 * Entries are keyed by bitmap id but are only valid for the exact canvas object (and version and
 * size) they were encoded from. Bitmap ids are not unique over time: when a project is closed its
 * bitmaps are garbage-collected, and opening another file that uses the same ids (a Save As copy,
 * an older version of the project) registers NEW canvases under those ids at version 1. Matching
 * on id + version alone would then write the first file's pixels into the second one.
 *
 * The canvas is held weakly so cached entries never keep dropped bitmaps alive. Pure logic (no DOM
 * APIs) so it can be unit-tested.
 */

interface Entry {
  canvas: WeakRef<object>;
  version: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface Sized {
  width: number;
  height: number;
}

export class PngCache {
  private map = new Map<string, Entry>();

  /** Cached PNG bytes of `canvas` registered as `id` at `version`, or null when stale/missing. */
  lookup(id: string, canvas: Sized, version: number): ArrayBuffer | null {
    const e = this.map.get(id);
    if (!e) return null;
    if (e.canvas.deref() !== canvas || e.version !== version || e.width !== canvas.width || e.height !== canvas.height) {
      this.map.delete(id);
      return null;
    }
    return e.data;
  }

  store(id: string, canvas: Sized, version: number, data: ArrayBuffer, size: Sized = canvas) {
    this.map.set(id, { canvas: new WeakRef(canvas), version, width: size.width, height: size.height, data });
  }

  /** Drop the entry for an id (e.g. the id is about to be reused by another canvas). */
  forget(id: string) {
    this.map.delete(id);
  }

  /** Drop entries whose ids are not in `keep` or whose canvas is gone. */
  prune(keep: Set<string>) {
    for (const [id, e] of this.map) if (!keep.has(id) || !e.canvas.deref()) this.map.delete(id);
  }

  get size() {
    return this.map.size;
  }
}

/**
 * Encode through the cache: returns cached bytes when `canvas` is unchanged, else calls `encode`
 * (which must snapshot the canvas synchronously, as canvas.toBlob does) and caches the result
 * under the version read BEFORE encoding — an edit during the async encode bumps the version, so
 * the next save re-encodes.
 */
export async function encodeCached<C extends Sized>(
  cache: PngCache,
  id: string,
  canvas: C,
  version: number,
  encode: (c: C) => Promise<ArrayBuffer>,
): Promise<{ data: ArrayBuffer; width: number; height: number; cached: boolean }> {
  const hit = cache.lookup(id, canvas, version);
  if (hit) return { data: hit, width: canvas.width, height: canvas.height, cached: true };
  const width = canvas.width;
  const height = canvas.height;
  const data = await encode(canvas);
  cache.store(id, canvas, version, data, { width, height });
  return { data, width, height, cached: false };
}
