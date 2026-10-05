/**
 * DirtyGrid — tracks which fixed-size cells of a bitmap a stroke touched, with the exact dirty
 * bounds inside each cell. Patches and live writes are built from these cells instead of the
 * stroke's bounding box, so a long diagonal stroke only records (and writes) the pixels near the
 * stroke, not the whole rectangle around it. Pure logic (no DOM) — unit-tested in tiles.test.ts.
 */
import type { Rect } from '../../../core/types';

/** Cell size used for history patches (divides the PixelSession load tile size). */
export const DIRTY_CELL = 64;

export class DirtyGrid {
  readonly cols: number;
  readonly rows: number;
  /** Per-cell dirty bounds (x1/y1 exclusive). Only meaningful where `marked` is set. */
  private x0: Int32Array;
  private y0: Int32Array;
  private x1: Int32Array;
  private y1: Int32Array;
  private marked: Uint8Array;
  private list: number[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell = DIRTY_CELL,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    const n = this.cols * this.rows;
    this.x0 = new Int32Array(n);
    this.y0 = new Int32Array(n);
    this.x1 = new Int32Array(n);
    this.y1 = new Int32Array(n);
    this.marked = new Uint8Array(n);
  }

  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  /** Number of touched cells. */
  get count(): number {
    return this.list.length;
  }

  /** Mark an integer rect (clipped to the grid's bounds). */
  add(r: Rect) {
    const rx0 = Math.max(0, Math.floor(r.x));
    const ry0 = Math.max(0, Math.floor(r.y));
    const rx1 = Math.min(this.width, Math.ceil(r.x + r.width));
    const ry1 = Math.min(this.height, Math.ceil(r.y + r.height));
    if (rx1 <= rx0 || ry1 <= ry0) return;
    const c = this.cell;
    const cx0 = Math.floor(rx0 / c);
    const cy0 = Math.floor(ry0 / c);
    const cx1 = Math.floor((rx1 - 1) / c);
    const cy1 = Math.floor((ry1 - 1) / c);
    for (let cy = cy0; cy <= cy1; cy++) {
      const top = cy * c;
      const a = Math.max(ry0, top);
      const b = Math.min(ry1, top + c);
      for (let cx = cx0; cx <= cx1; cx++) {
        const left = cx * c;
        const l = Math.max(rx0, left);
        const rr = Math.min(rx1, left + c);
        const i = cy * this.cols + cx;
        if (!this.marked[i]) {
          this.marked[i] = 1;
          this.list.push(i);
          this.x0[i] = l;
          this.y0[i] = a;
          this.x1[i] = rr;
          this.y1[i] = b;
        } else {
          if (l < this.x0[i]) this.x0[i] = l;
          if (a < this.y0[i]) this.y0[i] = a;
          if (rr > this.x1[i]) this.x1[i] = rr;
          if (b > this.y1[i]) this.y1[i] = b;
        }
      }
    }
  }

  /** Forget everything (cost proportional to the touched cells, not the grid). */
  clear() {
    for (const i of this.list) this.marked[i] = 0;
    this.list.length = 0;
  }

  /** Bounding box of all touched pixels, or null. */
  bounds(): Rect | null {
    if (!this.list.length) return null;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const i of this.list) {
      if (this.x0[i] < x0) x0 = this.x0[i];
      if (this.y0[i] < y0) y0 = this.y0[i];
      if (this.x1[i] > x1) x1 = this.x1[i];
      if (this.y1[i] > y1) y1 = this.y1[i];
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /**
   * Rects covering every touched pixel: runs of horizontally adjacent touched cells in a cell
   * row are merged into one rect (spanning the run's dirty bounds), so a stroke yields a handful
   * of rects instead of one per cell. Every pixel of a rect lies in a touched cell. Rects are
   * ordered by cell row, then x; `row` is the cell row (rects of one row share a band).
   */
  rects(): (Rect & { row: number })[] {
    const out: (Rect & { row: number })[] = [];
    if (!this.list.length) return out;
    // Visit only the rows that have touched cells.
    const rows = new Set<number>();
    for (const i of this.list) rows.add((i / this.cols) | 0);
    const sorted = [...rows].sort((a, b) => a - b);
    for (const cy of sorted) {
      let cx = 0;
      const base = cy * this.cols;
      while (cx < this.cols) {
        if (!this.marked[base + cx]) {
          cx++;
          continue;
        }
        const first = base + cx;
        let top = this.y0[first];
        let bottom = this.y1[first];
        let last = first;
        cx++;
        while (cx < this.cols && this.marked[base + cx]) {
          last = base + cx;
          if (this.y0[last] < top) top = this.y0[last];
          if (this.y1[last] > bottom) bottom = this.y1[last];
          cx++;
        }
        out.push({ x: this.x0[first], y: top, width: this.x1[last] - this.x0[first], height: bottom - top, row: cy });
      }
    }
    return out;
  }
}

/** Group rects (as returned by DirtyGrid.rects) by cell row: [band bounds, rects in the band]. */
export function bandsOf(rects: (Rect & { row: number })[]): { band: Rect; rects: Rect[] }[] {
  const out: { band: Rect; rects: Rect[] }[] = [];
  let cur: { band: Rect; rects: Rect[]; row: number } | null = null;
  for (const r of rects) {
    if (!cur || cur.row !== r.row) {
      cur = { band: { x: r.x, y: r.y, width: r.width, height: r.height }, rects: [], row: r.row };
      out.push(cur);
    } else {
      const b = cur.band;
      const x0 = Math.min(b.x, r.x);
      const y0 = Math.min(b.y, r.y);
      const x1 = Math.max(b.x + b.width, r.x + r.width);
      const y1 = Math.max(b.y + b.height, r.y + r.height);
      cur.band = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    cur.rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  return out.map(({ band, rects }) => ({ band, rects }));
}

/** Copy a sub-rect out of an ImageData that covers `src` (both in the same pixel space). */
export function cropImageData(img: ImageData, src: Rect, r: Rect): ImageData {
  if (r.x === src.x && r.y === src.y && r.width === img.width && r.height === img.height) return img;
  const out = new ImageData(r.width, r.height);
  const sw = img.width;
  for (let y = 0; y < r.height; y++) {
    const o = ((r.y - src.y + y) * sw + (r.x - src.x)) * 4;
    out.data.set(img.data.subarray(o, o + r.width * 4), y * r.width * 4);
  }
  return out;
}
