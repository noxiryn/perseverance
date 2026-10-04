/**
 * Pure geometry helpers for vector-ish assets: tapered stroke outlines, spirals, torn edges.
 * No DOM access here (unit-tested in jsdom).
 */
import type { Pt, Rand } from './util';
import { TAU } from './util';

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polylineLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Cumulative arc-length fractions (0..1) for each vertex. */
export function arcFractions(pts: Pt[]): number[] {
  const out = [0];
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += dist(pts[i - 1], pts[i]);
    out.push(L);
  }
  return out.map((v) => (L > 0 ? v / L : 0));
}

/** Sample a cubic bezier. */
export function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Resample a polyline at (approximately) uniform spacing. */
export function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.25) out.push(last);
  return out;
}

/** Catmull-Rom spline through points, `seg` samples per span. */
export function catmullRom(pts: Pt[], seg = 8): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < seg; s++) {
      const t = s / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Outline polygon of a variable-width stroke along `pts` (miter joins, clamped). Returns the
 * left side followed by the reversed right side — fill it with the nonzero rule.
 * `spikes[i]` (optional) pushes the left (outer) offset of vertex i further out → thorn tips.
 */
export function taperedOutline(pts: Pt[], widths: number[], miterLimit = 2.6, spikes?: number[]): Pt[] {
  const n = pts.length;
  if (n < 2) return [];
  const left: Pt[] = [];
  const right: Pt[] = [];
  const normals: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const L = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / L, y: dx / L });
  }
  for (let i = 0; i < n; i++) {
    const n0 = normals[Math.max(0, i - 1)];
    const n1 = normals[Math.min(n - 2, i)];
    let mx = n0.x + n1.x;
    let my = n0.y + n1.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = n1.x;
      my = n1.y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = Math.max(1 / miterLimit, mx * n1.x + my * n1.y);
    const hw = (widths[i] ?? widths[widths.length - 1]) / 2 / cos;
    const sp = spikes?.[i] ?? 0;
    left.push({ x: pts[i].x + mx * (hw + sp), y: pts[i].y + my * (hw + sp) });
    right.push({ x: pts[i].x - mx * hw, y: pts[i].y - my * hw });
  }
  return left.concat(right.reverse());
}

export interface SpiralSpec {
  /** Spiral center. */
  cx: number;
  cy: number;
  /** Outer radius where the spiral starts. */
  radius: number;
  /** Angle (radians) of the outer starting point relative to the center. */
  startAngle: number;
  /** Number of turns. */
  turns: number;
  /** +1 = clockwise in screen space (y down), -1 = counter-clockwise. */
  dir: 1 | -1;
  /** Radius at the end relative to `radius` (0..1). */
  endRatio: number;
}

/** Logarithmic spiral points from the outside inwards. `stepAngle` = angular sampling step. */
export function spiralPoints(s: SpiralSpec, stepAngle: number, jitter = 0, rand?: Rand): Pt[] {
  const thetaMax = s.turns * TAU;
  const k = -Math.log(Math.max(0.01, s.endRatio)) / thetaMax;
  const pts: Pt[] = [];
  let th = 0;
  while (th <= thetaMax + 1e-9) {
    const jt = jitter && rand && th > 0 ? (rand() - 0.5) * jitter * stepAngle : 0;
    const t = Math.min(thetaMax, th + jt);
    const r = s.radius * Math.exp(-k * t) * (jitter && rand && th > 0 ? 1 + (rand() - 0.5) * jitter * 0.18 : 1);
    const a = s.startAngle + s.dir * t;
    pts.push({ x: s.cx + Math.cos(a) * r, y: s.cy + Math.sin(a) * r });
    th += stepAngle;
  }
  return pts;
}

/** Unit tangent of the spiral at its outer start (direction of travel inwards). */
export function spiralStartTangent(s: SpiralSpec): Pt {
  const thetaMax = s.turns * TAU;
  const k = -Math.log(Math.max(0.01, s.endRatio)) / thetaMax;
  const a = s.startAngle;
  // d/dθ of r(θ)·(cos(a+dir θ), sin(a+dir θ)) at θ = 0 with r = R·e^{-kθ}
  const tx = -k * Math.cos(a) - s.dir * Math.sin(a);
  const ty = -k * Math.sin(a) + s.dir * Math.cos(a);
  const L = Math.hypot(tx, ty) || 1;
  return { x: tx / L, y: ty / L };
}

/**
 * Fractal midpoint displacement between two points (torn paper edges). Returns points from
 * a to b (inclusive). `rough` = displacement relative to segment length.
 */
export function tornLine(a: Pt, b: Pt, rand: Rand, rough = 0.12, minSeg = 3): Pt[] {
  const out: Pt[] = [a];
  const rec = (p: Pt, q: Pt, depth: number) => {
    const L = dist(p, q);
    if (L < minSeg || depth > 14) {
      out.push(q);
      return;
    }
    const nx = -(q.y - p.y) / L;
    const ny = (q.x - p.x) / L;
    const d = (rand() - 0.5) * 2 * rough * L;
    const t = 0.5 + (rand() - 0.5) * 0.2;
    const m = { x: p.x + (q.x - p.x) * t + nx * d, y: p.y + (q.y - p.y) * t + ny * d };
    rec(p, m, depth + 1);
    rec(m, q, depth + 1);
  };
  rec(a, b, 0);
  return out;
}

/** Random irregular blob polygon (for flecks, stones, droplets). */
export function blob(cx: number, cy: number, r: number, rand: Rand, verts = 9, irregular = 0.35): Pt[] {
  const pts: Pt[] = [];
  const a0 = rand() * TAU;
  for (let i = 0; i < verts; i++) {
    const a = a0 + (i / verts) * TAU + (rand() - 0.5) * (TAU / verts) * 0.6;
    const rr = r * (1 - irregular / 2 + rand() * irregular);
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  return pts;
}

/** Rotate a point around a center. */
export function rotateAround(p: Pt, c: Pt, a: number): Pt {
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
}
