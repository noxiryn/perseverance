/**
 * Layer masks are doc-space bitmaps, so when layers move/transform their masks must be re-drawn
 * under the same document-space delta to stay "linked" (Photoshop behaviour). A MaskFollower
 * copies each mask once into a fresh bitmap and re-draws it under the current delta on every
 * preview frame; the recipe it returns points the layers at those bitmaps. Undo keeps working
 * because the original bitmaps are never modified.
 */
import type { Document, ID } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../core/canvas';
import type { Affine } from './math/affine';
import { isPositionLocked, parentMap } from './layers';

/** Color for mask areas uncovered by a move: majority of the mask's four corners (white = reveal). */
export function maskBackground(c: HTMLCanvasElement): string {
  try {
    const ctx = ctxRead(c);
    const w = c.width - 1;
    const h = c.height - 1;
    let white = 0;
    for (const [x, y] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ]) {
      if (ctx.getImageData(x, y, 1, 1).data[0] >= 128) white++;
    }
    return white >= 2 ? '#ffffff' : '#000000';
  } catch {
    return '#ffffff';
  }
}

interface Entry {
  layerId: ID;
  src: HTMLCanvasElement;
  dstId: ID;
  dst: HTMLCanvasElement;
  bg: string;
}

export class MaskFollower {
  private entries: Entry[] = [];

  /**
   * Masks of `ids` and all their descendants (groups included), skipping position-locked layers.
   * Returns null when there is nothing to follow.
   */
  static forLayers(doc: Document, ids: ID[]): MaskFollower | null {
    const parents = parentMap(doc);
    const seen = new Set<ID>();
    const f = new MaskFollower();
    const visit = (id: ID) => {
      if (seen.has(id)) return;
      seen.add(id);
      const l = doc.layers[id];
      if (!l) return;
      if (l.mask && !isPositionLocked(doc, id, parents)) {
        const src = bitmaps.tryGet(l.mask.bitmapId);
        if (src) {
          const dst = createCanvas(src.width, src.height);
          const dstId = bitmaps.add(dst);
          f.entries.push({ layerId: id, src, dstId, dst, bg: maskBackground(src) });
        }
      }
      if (l.type === 'group') l.childIds.forEach(visit);
    };
    ids.forEach(visit);
    return f.entries.length ? f : null;
  }

  /** Re-draw every followed mask under `D` (doc-space delta) and return the draft recipe. */
  update(D: Affine): (d: Document) => void {
    for (const e of this.entries) {
      const ctx = ctx2d(e.dst);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.fillStyle = e.bg;
      ctx.fillRect(0, 0, e.dst.width, e.dst.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(D.a, D.b, D.c, D.d, D.e, D.f);
      // Masks are opaque grayscale, so drawing over the background replaces it exactly.
      ctx.drawImage(e.src, 0, 0);
      ctx.restore();
      bitmaps.touch(e.dstId);
    }
    const entries = this.entries;
    return (d: Document) => {
      for (const e of entries) {
        const l = d.layers[e.layerId];
        if (l?.mask) l.mask.bitmapId = e.dstId;
      }
    };
  }
}
