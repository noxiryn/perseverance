/**
 * Binary-grid boundary tracing → polygons (pure, no DOM).
 *
 * Every boundary edge between a filled and an empty cell is emitted with the filled cell on its
 * right (screen coordinates, y down), so outer contours come out clockwise and holes
 * counter-clockwise — exactly what nonzero filling needs. Ambiguous saddle vertices turn right,
 * which keeps diagonally-touching cells as separate loops.
 *
 * Used by the pixel-art presets and by Type ▸ Convert to Shape (tracing rasterized glyphs).
 */
import type { Pt } from './presets/pathKit';

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** Trace the boundaries of the filled cells of a w×h grid. Loops are in cell units, collinear points removed. */
export function traceGrid(w: number, h: number, filled: (x: number, y: number) => boolean): Pt[][] {
  const VW = w + 1;
  const V = VW * (h + 1);
  // Up to two outgoing edges per vertex (saddles): directions 0..3, -1 = none.
  const outA = new Int8Array(V).fill(-1);
  const outB = new Int8Array(V).fill(-1);
  const add = (x: number, y: number, dir: number) => {
    const v = y * VW + x;
    if (outA[v] < 0) outA[v] = dir;
    else outB[v] = dir;
  };
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && filled(x, y);
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) (add(x, y, 0), edges++); // top edge → right
      if (!at(x + 1, y)) (add(x + 1, y, 1), edges++); // right edge → down
      if (!at(x, y + 1)) (add(x + 1, y + 1, 2), edges++); // bottom edge → left
      if (!at(x - 1, y)) (add(x, y + 1, 3), edges++); // left edge → up
    }
  }
  const loops: Pt[][] = [];
  if (!edges) return loops;
  const has = (v: number, d: number) => outA[v] === d || outB[v] === d;
  const remove = (v: number, d: number) => {
    if (outA[v] === d) {
      outA[v] = outB[v];
      outB[v] = -1;
    } else if (outB[v] === d) outB[v] = -1;
  };
  for (let start = 0; start < V; start++) {
    while (outA[start] >= 0) {
      const loop: Pt[] = [];
      const firstDir = outA[start];
      remove(start, firstDir);
      let v = start;
      let dir = firstDir;
      let prevDir = -1;
      let guard = 0;
      while (guard++ <= edges) {
        const x = v % VW;
        const y = (v - x) / VW;
        if (dir !== prevDir) loop.push([x, y]);
        prevDir = dir;
        v = (y + DY[dir]) * VW + (x + DX[dir]);
        // Prefer a right turn, then straight, then left (saddles stay separated).
        const order = [(dir + 1) % 4, dir, (dir + 3) % 4];
        let next = -1;
        for (const d of order) {
          if (v === start && d === firstDir) {
            next = -2; // closed
            break;
          }
          if (has(v, d)) {
            next = d;
            break;
          }
        }
        if (next < 0) break;
        remove(v, next);
        dir = next;
      }
      // Drop the start point when it sits in the middle of a straight run.
      if (loop.length > 1 && prevDir === firstDir) loop.shift();
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker simplification of a closed polygon. */
export function simplifyClosed(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 4 || eps <= 0) return pts;
  // Split at the two farthest-apart points to simplify as two open polylines.
  let i0 = 0;
  let i1 = 0;
  let best = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  if (i1 === i0) return pts;
  const a = rdp(pts.slice(i0, i1 + 1), eps);
  const b = rdp([...pts.slice(i1), pts[0]], eps);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : pts;
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Closed polygon → smooth SVG subpath: gentle corners become quadratic curves through edge
 * midpoints, sharp corners (turn > cornerDeg) stay crisp.
 */
export function smoothClosedPath(pts: Pt[], cornerDeg = 62, f = (n: number) => String(Math.round(n * 100) / 100)): string {
  const n = pts.length;
  if (n < 3) return '';
  const sharp = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n];
    const c = pts[i];
    const q = pts[(i + 1) % n];
    const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]);
    const a2 = Math.atan2(q[1] - c[1], q[0] - c[0]);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    sharp[i] = turn > (cornerDeg * Math.PI) / 180 ? 1 : 0;
  }
  const mid = (i: number): Pt => {
    const a = pts[i % n];
    const b = pts[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const P = (p: Pt) => `${f(p[0])} ${f(p[1])}`;
  let d = `M${P(mid(n - 1))}`;
  for (let i = 0; i < n; i++) {
    const c = pts[i];
    if (sharp[i]) d += `L${P(c)}L${P(mid(i))}`;
    else d += `Q${P(c)} ${P(mid(i))}`;
  }
  return `${d}Z`;
}
