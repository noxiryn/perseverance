/**
 * Pure SVG path toolkit used to author the shape presets library: builders (polygons, stars,
 * circles, mirrored outlines, tapered strokes, spirals), a robust path parser and an exact-ish
 * bounds computation (curves and arcs are sampled) so every preset gets a tight viewBox.
 * No DOM / canvas dependencies — unit-testable in jsdom.
 */
import type { ShapePresetDef } from '../../../registry';

export type Pt = [number, number];

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Compact number formatting (2 decimals, no trailing zeros, no "-0"). */
export function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (Object.is(r, -0) || r === 0) return '0';
  return String(r);
}

const P = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;

/* ------------------------------------------------------------------ */
/* Point helpers                                                       */
/* ------------------------------------------------------------------ */

export const DEG = Math.PI / 180;

/** Point on a circle/ellipse; angle in degrees, 0 = +x, 90 = down (screen coordinates). */
export function polar(cx: number, cy: number, r: number, deg: number, ry = r): Pt {
  return [cx + Math.cos(deg * DEG) * r, cy + Math.sin(deg * DEG) * ry];
}

export function rotatePt(p: Pt, deg: number, cx = 0, cy = 0): Pt {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const x = p[0] - cx;
  const y = p[1] - cy;
  return [cx + x * c - y * s, cy + x * s + y * c];
}

export function translatePts(pts: Pt[], dx: number, dy: number): Pt[] {
  return pts.map((p) => [p[0] + dx, p[1] + dy]);
}

export function scalePts(pts: Pt[], sx: number, sy = sx, cx = 0, cy = 0): Pt[] {
  return pts.map((p) => [cx + (p[0] - cx) * sx, cy + (p[1] - cy) * sy]);
}

export function rotatePts(pts: Pt[], deg: number, cx = 0, cy = 0): Pt[] {
  return pts.map((p) => rotatePt(p, deg, cx, cy));
}

/** Signed area (shoelace). Positive = clockwise on screen (y down). */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return a / 2;
}

/** Return the polygon with the requested orientation (cw = clockwise on screen). */
export function orient(pts: Pt[], cw = true): Pt[] {
  const a = signedArea(pts);
  return (a >= 0) === cw ? pts : [...pts].reverse();
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

/** Closed polygon path. */
export function poly(pts: Pt[]): string {
  if (!pts.length) return '';
  return `M${P(pts[0])}${pts
    .slice(1)
    .map((p) => `L${P(p)}`)
    .join('')}Z`;
}

/** Several closed polygons; `holes` are re-oriented counter-clockwise so nonzero fill cuts them. */
export function polys(solids: Pt[][], holes: Pt[][] = []): string {
  return [...solids.map((s) => poly(orient(s, true))), ...holes.map((h) => poly(orient(h, false)))].join('');
}

/** Circle as two arcs. `ccw` draws it counter-clockwise (a hole under nonzero fill). */
export function circle(cx: number, cy: number, r: number, ccw = false): string {
  return ellipse(cx, cy, r, r, ccw);
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, ccw = false, rotation = 0): string {
  const sweep = ccw ? 0 : 1;
  const a = rotatePt([cx - rx, cy], rotation, cx, cy);
  const b = rotatePt([cx + rx, cy], rotation, cx, cy);
  const rot = fmt(rotation);
  return `M${P(a)}A${fmt(rx)} ${fmt(ry)} ${rot} 1 ${sweep} ${P(b)}A${fmt(rx)} ${fmt(ry)} ${rot} 1 ${sweep} ${P(a)}Z`;
}

/** Rounded rectangle (clockwise; `ccw` for a hole). */
export function roundRect(x: number, y: number, w: number, h: number, r: number, ccw = false): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) {
    const pts: Pt[] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    return poly(ccw ? pts.reverse() : pts);
  }
  if (!ccw) {
    return (
      `M${P([x + rr, y])}L${P([x + w - rr, y])}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${P([x + w, y + rr])}` +
      `L${P([x + w, y + h - rr])}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${P([x + w - rr, y + h])}` +
      `L${P([x + rr, y + h])}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${P([x, y + h - rr])}` +
      `L${P([x, y + rr])}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${P([x + rr, y])}Z`
    );
  }
  return (
    `M${P([x + rr, y])}A${fmt(rr)} ${fmt(rr)} 0 0 0 ${P([x, y + rr])}L${P([x, y + h - rr])}` +
    `A${fmt(rr)} ${fmt(rr)} 0 0 0 ${P([x + rr, y + h])}L${P([x + w - rr, y + h])}` +
    `A${fmt(rr)} ${fmt(rr)} 0 0 0 ${P([x + w, y + h - rr])}L${P([x + w, y + rr])}` +
    `A${fmt(rr)} ${fmt(rr)} 0 0 0 ${P([x + w - rr, y])}Z`
  );
}

/** Rectangle points (clockwise). */
export function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** Regular polygon vertices (first vertex at `rot` degrees; -90 = pointing up). */
export function regularPts(n: number, cx: number, cy: number, r: number, rot = -90): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push(polar(cx, cy, r, rot + (i * 360) / n));
  return out;
}

/** Star vertices: n points, alternating outer/inner radius. `radii` may vary per point (bursts). */
export function starPts(n: number, cx: number, cy: number, rOuter: number | number[], rInner: number | number[], rot = -90, ry = 1): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const k = i >> 1;
    const r = i % 2 === 0 ? (Array.isArray(rOuter) ? rOuter[k % rOuter.length] : rOuter) : Array.isArray(rInner) ? rInner[k % rInner.length] : rInner;
    out.push(polar(cx, cy, r, rot + (i * 180) / n, r * ry));
  }
  return out;
}

/** Scalloped outline through points on an ellipse with outward circular bumps (clouds, seals). */
export function scallopPath(cx: number, cy: number, rx: number, ry: number, n: number, bulge = 1.1, rot = -90): string {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push(polar(cx, cy, rx, rot + (i * 360) / n, ry));
  let d = `M${P(pts[0])}`;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const r = (Math.hypot(b[0] - a[0], b[1] - a[1]) / 2) * bulge;
    d += `A${fmt(r)} ${fmt(r)} 0 0 1 ${P(b)}`;
  }
  return `${d}Z`;
}

/** Inset a convex polygon by distance d (edges moved inward, consecutive edges intersected). */
export function insetConvex(pts: Pt[], d: number): Pt[] {
  const p = orient(pts, true);
  const n = p.length;
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // Clockwise on screen: interior is to the right of travel → normal (-dy, dx).
    const nx = -dy / len;
    const ny = dx / len;
    lines.push({ px: a[0] + nx * d, py: a[1] + ny * d, dx, dy });
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-9) {
      out.push([l2.px, l2.py]);
      continue;
    }
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    out.push([l1.px + l1.dx * t, l1.py + l1.dy * t]);
  }
  return out;
}

/* ---------------- mirrored (symmetric) outlines ---------------- */

export type Seg = ['L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number];

/**
 * Build a closed outline symmetric about the vertical line x = axis. `start` lies on the axis;
 * `segs` trace the right half down to a point on the axis. The left half is mirrored back.
 */
export function symPath(start: Pt, segs: Seg[], axis: number): string {
  const m = (x: number) => 2 * axis - x;
  let d = `M${P(start)}`;
  const ends: Pt[] = [start];
  for (const s of segs) {
    if (s[0] === 'L') d += `L${fmt(s[1])} ${fmt(s[2])}`;
    else if (s[0] === 'Q') d += `Q${fmt(s[1])} ${fmt(s[2])} ${fmt(s[3])} ${fmt(s[4])}`;
    else d += `C${fmt(s[1])} ${fmt(s[2])} ${fmt(s[3])} ${fmt(s[4])} ${fmt(s[5])} ${fmt(s[6])}`;
    ends.push(s[0] === 'L' ? [s[1], s[2]] : s[0] === 'Q' ? [s[3], s[4]] : [s[5], s[6]]);
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const prev = ends[i];
    if (s[0] === 'L') {
      if (i > 0) d += `L${fmt(m(prev[0]))} ${fmt(prev[1])}`; // the last one would just repeat the start (Z closes)
    } else if (s[0] === 'Q') d += `Q${fmt(m(s[1]))} ${fmt(s[2])} ${fmt(m(prev[0]))} ${fmt(prev[1])}`;
    else d += `C${fmt(m(s[3]))} ${fmt(s[4])} ${fmt(m(s[1]))} ${fmt(s[2])} ${fmt(m(prev[0]))} ${fmt(prev[1])}`;
  }
  return `${d}Z`;
}

/** Mirror a right-half point list (top axis point → bottom axis point) into a full polygon. */
export function mirrorPts(half: Pt[], axis: number): Pt[] {
  const left = half
    .slice(1, -1)
    .reverse()
    .map((p) => [2 * axis - p[0], p[1]] as Pt);
  return [...half, ...left];
}

/** Mirror a polygon horizontally about x = axis (orientation is restored by `orient`). */
export function mirrorX(pts: Pt[], axis: number): Pt[] {
  return pts.map((p) => [2 * axis - p[0], p[1]] as Pt).reverse();
}

/* ---------------- curves & tapered strokes ---------------- */

/** Sample a cubic bezier (n segments, includes both ends). */
export function cubicPts(p0: Pt, c1: Pt, c2: Pt, p1: Pt, n = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
    ]);
  }
  return out;
}

/** Concatenate point runs, dropping duplicated joints. */
export function joinRuns(...runs: Pt[][]): Pt[] {
  const out: Pt[] = [];
  for (const r of runs) {
    for (const p of r) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
      out.push(p);
    }
  }
  return out;
}

/** Smooth logarithmic spiral from the outside in (radius r0 → r0·shrink^turns). */
export function spiralPts(cx: number, cy: number, r0: number, startDeg: number, turns: number, shrink = 0.35, dir: 1 | -1 = 1, n = 140): Pt[] {
  const out: Pt[] = [];
  const total = turns * 360;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = r0 * Math.pow(shrink, t * turns);
    out.push(polar(cx, cy, r, startDeg + dir * total * t));
  }
  return out;
}

/** Angular spiral: straight segments turning by `stepDeg`, each shorter by `shrink`. */
export function angularSpiralPts(start: Pt, startDeg: number, len0: number, steps: number, stepDeg = 72, shrink = 0.8, dir: 1 | -1 = 1): Pt[] {
  const out: Pt[] = [start];
  let [x, y] = start;
  let a = startDeg;
  let len = len0;
  for (let i = 0; i < steps; i++) {
    x += Math.cos(a * DEG) * len;
    y += Math.sin(a * DEG) * len;
    out.push([x, y]);
    a += dir * stepDeg;
    len *= shrink;
  }
  return out;
}

/**
 * Outline of a variable-width stroke along a polyline (miter joins). `width(t)` gives the full
 * width at parameter t ∈ [0,1] (by arc length). Returns a clockwise polygon.
 */
export function taperedStroke(pts: Pt[], width: (t: number) => number, opts: { miterLimit?: number } = {}): Pt[] {
  const n = pts.length;
  if (n < 2) return [];
  const lens = [0];
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = lens[n - 1] || 1;
  const segN = (i: number): Pt => {
    const a = pts[Math.max(0, i)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const limit = opts.miterLimit ?? 3;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let nx: number, ny: number;
    let scale = 1;
    if (i === 0) [nx, ny] = segN(0);
    else if (i === n - 1) [nx, ny] = segN(n - 2);
    else {
      const a = segN(i - 1);
      const b = segN(i);
      nx = a[0] + b[0];
      ny = a[1] + b[1];
      const l = Math.hypot(nx, ny);
      if (l < 1e-6) {
        [nx, ny] = b;
      } else {
        nx /= l;
        ny /= l;
        const dot = nx * b[0] + ny * b[1];
        scale = Math.min(limit, 1 / Math.max(1e-3, dot));
      }
    }
    const w = (Math.max(0, width(lens[i] / total)) / 2) * scale;
    left.push([pts[i][0] + nx * w, pts[i][1] + ny * w]);
    right.push([pts[i][0] - nx * w, pts[i][1] - ny * w]);
  }
  return orient([...left, ...right.reverse()], true);
}

/** Width profile helpers for taperedStroke. */
export const taper = {
  /** thick at start → point at end */
  out: (w0: number, w1 = 0) => (t: number) => w0 + (w1 - w0) * t,
  /** point → thick → point (sin) */
  both: (w: number, min = 0) => (t: number) => min + (w - min) * Math.sin(Math.PI * Math.min(1, Math.max(0, t))),
  /** constant */
  flat: (w: number) => () => w,
};

/* ------------------------------------------------------------------ */
/* Parsing & bounds                                                    */
/* ------------------------------------------------------------------ */

export type AbsCommand =
  | { c: 'M' | 'L'; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; rot: number; large: boolean; sweep: boolean; x: number; y: number }
  | { c: 'Z' };

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Tokenize path data into commands + numbers (arc flags may be written without separators). */
function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(d))) {
    const gap = d.slice(lastIndex, m.index);
    if (/[^\s,]/.test(gap)) throw new Error(`Invalid path data near "${gap.trim()}"`);
    lastIndex = re.lastIndex;
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]));
  }
  if (/[^\s,]/.test(d.slice(lastIndex))) throw new Error('Invalid trailing path data');
  return out;
}

/** Parse SVG path data into absolute commands (H/V/S/T expanded). Throws on invalid data. */
export function parsePath(d: string): AbsCommand[] {
  const toks = tokenize(d);
  const out: AbsCommand[] = [];
  let i = 0;
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  let lastCtrl: Pt | null = null;
  let lastQ: Pt | null = null;
  let cmd = '';
  const num = (): number => {
    const t = toks[i++];
    if (typeof t !== 'number') throw new Error(`Expected number in path, got "${String(t)}"`);
    return t;
  };
  // Arc flags can be glued ("011"): split numbers like 11 / 0.5 handled by tokenizer only when separated,
  // so we additionally accept flag tokens > 1 by splitting their digits.
  const flag = (): number => {
    const t = toks[i];
    if (typeof t !== 'number') throw new Error('Expected arc flag');
    if (t === 0 || t === 1) {
      i++;
      return t;
    }
    const s = String(t);
    if (/^[01]+(\.\d+)?$/.test(s)) {
      // e.g. "11" or "10.5": first char is the flag, the rest stays as the next token.
      toks[i] = parseFloat(s.slice(1));
      return s[0] === '1' ? 1 : 0;
    }
    throw new Error('Invalid arc flag');
  };
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        out.push({ c: 'Z' });
        cx = sx;
        cy = sy;
        lastCtrl = lastQ = null;
        continue;
      }
    } else if (!cmd) throw new Error('Path must start with a command');
    else if (cmd === 'Z' || cmd === 'z') throw new Error('Numbers after Z');
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (i + ARITY[up] > toks.length + (up === 'A' ? 2 : 0)) throw new Error(`Missing parameters for ${cmd}`);
    switch (up) {
      case 'M': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ c: 'M', x, y });
        cx = sx = x;
        cy = sy = y;
        cmd = rel ? 'l' : 'L'; // implicit lineto
        lastCtrl = lastQ = null;
        break;
      }
      case 'L': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ c: 'L', x, y });
        cx = x;
        cy = y;
        lastCtrl = lastQ = null;
        break;
      }
      case 'H': {
        const x = num() + (rel ? cx : 0);
        out.push({ c: 'L', x, y: cy });
        cx = x;
        lastCtrl = lastQ = null;
        break;
      }
      case 'V': {
        const y = num() + (rel ? cy : 0);
        out.push({ c: 'L', x: cx, y });
        cy = y;
        lastCtrl = lastQ = null;
        break;
      }
      case 'C': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const x1 = num() + ox,
          y1 = num() + oy,
          x2 = num() + ox,
          y2 = num() + oy,
          x = num() + ox,
          y = num() + oy;
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastCtrl = [x2, y2];
        lastQ = null;
        cx = x;
        cy = y;
        break;
      }
      case 'S': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const x1: number = lastCtrl ? 2 * cx - lastCtrl[0] : cx;
        const y1: number = lastCtrl ? 2 * cy - lastCtrl[1] : cy;
        const x2 = num() + ox,
          y2 = num() + oy,
          x = num() + ox,
          y = num() + oy;
        out.push({ c: 'C', x1, y1, x2, y2, x, y });
        lastCtrl = [x2, y2];
        lastQ = null;
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const x1 = num() + ox,
          y1 = num() + oy,
          x = num() + ox,
          y = num() + oy;
        out.push({ c: 'Q', x1, y1, x, y });
        lastQ = [x1, y1];
        lastCtrl = null;
        cx = x;
        cy = y;
        break;
      }
      case 'T': {
        const ox = rel ? cx : 0;
        const oy = rel ? cy : 0;
        const x1: number = lastQ ? 2 * cx - lastQ[0] : cx;
        const y1: number = lastQ ? 2 * cy - lastQ[1] : cy;
        const x = num() + ox,
          y = num() + oy;
        out.push({ c: 'Q', x1, y1, x, y });
        lastQ = [x1, y1];
        lastCtrl = null;
        cx = x;
        cy = y;
        break;
      }
      case 'A': {
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        const rot = num();
        const large = flag() === 1;
        const sweep = flag() === 1;
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ c: 'A', rx, ry, rot, large, sweep, x, y });
        cx = x;
        cy = y;
        lastCtrl = lastQ = null;
        break;
      }
      default:
        throw new Error(`Unsupported path command ${cmd}`);
    }
  }
  if (out.length && out[0].c !== 'M') throw new Error('Path must start with M');
  return out;
}

/** Sample points of an SVG elliptical arc (endpoint parameterization → center form, SVG spec F.6.5). */
export function arcPoints(x0: number, y0: number, a: Extract<AbsCommand, { c: 'A' }>, n = 32): Pt[] {
  let { rx, ry } = a;
  const { x, y } = a;
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [[x, y]];
  const phi = a.rot * DEG;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / (den || 1)));
  if (a.large === a.sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const d = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / d));
    return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(c);
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!a.sweep && dt > 0) dt -= 2 * Math.PI;
  else if (a.sweep && dt < 0) dt += 2 * Math.PI;
  const out: Pt[] = [];
  const steps = Math.max(4, Math.ceil((n * Math.abs(dt)) / (2 * Math.PI)) * 2);
  for (let i = 1; i <= steps; i++) {
    const t = t1 + (dt * i) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return out;
}

/** Flatten a path into polylines (one per subpath). */
export function flattenPath(d: string, curveSteps = 20): Pt[][] {
  const cmds = parsePath(d);
  const subs: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0,
    y = 0;
  for (const c of cmds) {
    switch (c.c) {
      case 'M':
        if (cur.length) subs.push(cur);
        cur = [[c.x, c.y]];
        x = c.x;
        y = c.y;
        break;
      case 'L':
        cur.push([c.x, c.y]);
        x = c.x;
        y = c.y;
        break;
      case 'C':
        cur.push(...cubicPts([x, y], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y], curveSteps).slice(1));
        x = c.x;
        y = c.y;
        break;
      case 'Q': {
        const c1: Pt = [x + (2 / 3) * (c.x1 - x), y + (2 / 3) * (c.y1 - y)];
        const c2: Pt = [c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y)];
        cur.push(...cubicPts([x, y], c1, c2, [c.x, c.y], curveSteps).slice(1));
        x = c.x;
        y = c.y;
        break;
      }
      case 'A':
        cur.push(...arcPoints(x, y, c));
        x = c.x;
        y = c.y;
        break;
      case 'Z':
        if (cur.length) {
          subs.push(cur);
          x = cur[0][0];
          y = cur[0][1];
        }
        cur = [];
        break;
    }
  }
  if (cur.length) subs.push(cur);
  return subs;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Tight bounds of the painted geometry of a path (curves/arcs sampled densely). */
export function pathBounds(d: string): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const sub of flattenPath(d, 48)) {
    for (const [x, y] of sub) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** viewBox [x, y, w, h] that tightly fits the path (rounded outward to 0.01). */
export function fitViewBox(d: string): [number, number, number, number] {
  const b = pathBounds(d);
  const x = Math.floor(b.minX * 100) / 100;
  const y = Math.floor(b.minY * 100) / 100;
  const w = Math.ceil((b.maxX - x) * 100) / 100;
  const h = Math.ceil((b.maxY - y) * 100) / 100;
  return [x, y, Math.max(0.01, w), Math.max(0.01, h)];
}

/* ------------------------------------------------------------------ */
/* Preset definition helper                                            */
/* ------------------------------------------------------------------ */

/** Define a preset; the viewBox is computed from the path so it is always tight. */
export function preset(id: string, name: string, category: string, path: string | string[], opts: { evenOdd?: boolean } = {}): ShapePresetDef {
  const d = Array.isArray(path) ? path.join('') : path;
  return { id, name, category, path: d, viewBox: fitViewBox(d), ...(opts.evenOdd ? { evenOdd: true } : {}) };
}
