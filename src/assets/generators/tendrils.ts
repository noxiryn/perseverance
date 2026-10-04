/**
 * swirl-tendrils: bold black spiral tendrils with a thin colored rim (the "Birdcage" look).
 *
 * Each tendril is a centerline (a stem bezier flowing into a logarithmic spiral) turned into a
 * filled polygon with a tapered width profile (thick stem → pointed hooked tip). The angular
 * style samples the spiral coarsely so it reads as hand-cut paper with sharp corners. The rim is
 * a slightly larger copy of the same polygons, offset towards the light, drawn behind the black.
 */
import { cubic, taperedOutline } from '../lib/geom';
import { P, defineAsset } from '../lib/params';
import type { Pt, Rand } from '../lib/util';
import { TAU, makeRand, newCanvas, num, str, tracePoly, unitOf } from '../lib/util';

export interface CurlSpec {
  cx: number;
  cy: number;
  /** Outer radius where the stem enters the curl. */
  R: number;
  /** +1 clockwise (screen space), -1 counter-clockwise. */
  dir: 1 | -1;
  turns: number;
  /** Final radius relative to R. */
  endRatio: number;
  /** Direction of travel (radians) when entering the curl. */
  arrival: number;
}

export interface TendrilSpec {
  base: Pt;
  /** Initial growth direction (unit). */
  baseDir: Pt;
  curl: CurlSpec;
  /** Ribbon width at the start of the curl. */
  width: number;
  angular: boolean;
}

export interface TendrilGeometry {
  /** Centerline from base to tip. */
  pts: Pt[];
  widths: number[];
  /** Index of the first spiral point in `pts`. */
  spiralStart: number;
}

/** Spiral points (outer → inner) of a curl, plus the per-point local gap between turns. Pure. */
export function curlPoints(c: CurlSpec, step: number, r?: Rand, jitter = 0): { pts: Pt[]; gaps: number[] } {
  const thetaMax = c.turns * TAU;
  const k = -Math.log(Math.max(0.02, c.endRatio)) / thetaMax;
  const perTurn = 1 - Math.exp(-k * TAU);
  const a0 = c.arrival - c.dir * (Math.PI / 2);
  const pts: Pt[] = [];
  const gaps: number[] = [];
  let th = 0;
  let first = true;
  while (th <= thetaMax + 1e-6) {
    const jt = !first && r && jitter ? (r() - 0.5) * step * jitter : 0;
    const t = Math.min(thetaMax, th + jt);
    const rr = c.R * Math.exp(-k * t) * (!first && r && jitter ? 1 + (r() - 0.5) * 0.12 * jitter : 1);
    const a = a0 + c.dir * t;
    pts.push({ x: c.cx + Math.cos(a) * rr, y: c.cy + Math.sin(a) * rr });
    gaps.push(rr * perTurn);
    first = false;
    if (th >= thetaMax) break;
    th = Math.min(thetaMax, th + step);
  }
  return { pts, gaps };
}

/** Centerline + width profile of one tendril. Pure (deterministic for a given Rand). */
export function tendrilGeometry(t: TendrilSpec, r: Rand, u: number): TendrilGeometry {
  const { pts: spiral, gaps } = curlPoints(t.curl, t.angular ? TAU / (5.2 + r() * 1.6) : TAU / 56, r, t.angular ? 0.35 : 0);
  const p0 = spiral[0];
  const arr = { x: Math.cos(t.curl.arrival), y: Math.sin(t.curl.arrival) };
  const L = Math.hypot(p0.x - t.base.x, p0.y - t.base.y);
  const c1 = { x: t.base.x + t.baseDir.x * L * 0.42, y: t.base.y + t.baseDir.y * L * 0.42 };
  const c2 = { x: p0.x - arr.x * L * 0.42, y: p0.y - arr.y * L * 0.42 };
  const nStem = t.angular ? Math.max(3, Math.round(L / (70 * u)) + 2) : Math.max(10, Math.round(L / (10 * u)));
  const stem: Pt[] = [];
  for (let i = 0; i < nStem; i++) {
    const q = cubic(t.base, c1, c2, p0, i / nStem);
    if (t.angular && i > 0) {
      // cut-paper wobble perpendicular-ish to the stem
      q.x += (r() - 0.5) * 10 * u;
      q.y += (r() - 0.5) * 10 * u;
    }
    stem.push(q);
  }
  const pts = stem.concat(spiral);
  // arc length fractions
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1] || 1;
  const sStem = cum[nStem] / total;
  const W0 = t.width;
  const widths = pts.map((_, i) => {
    const s = cum[i] / total;
    if (i < nStem) return W0 * (1.3 - 0.3 * (s / Math.max(1e-6, sStem)));
    const q = (s - sStem) / Math.max(1e-6, 1 - sStem);
    let w = q < 0.6 ? W0 * (1 - 0.25 * q) : W0 * 0.85 * Math.pow(Math.max(0, 1 - (q - 0.6) / 0.4), 0.7);
    w = Math.min(w, gaps[i - nStem] * 0.7);
    return Math.max(0, w);
  });
  widths[widths.length - 1] = 0;
  return { pts, widths, spiralStart: nStem };
}

/** Filled outline polygon(s) of a tendril, including small thorn spurs on the stem. */
export function tendrilPolygons(t: TendrilSpec, r: Rand, u: number, spurs: number): Pt[][] {
  return polygonsOf(tendrilGeometry(t, r, u), r, spurs);
}

function polygonsOf(g: TendrilGeometry, r: Rand, spurs: number): Pt[][] {
  const out: Pt[][] = [taperedOutline(g.pts, g.widths, 3.2)];
  // thorn spurs: small forward-leaning triangles on either side of the stem
  for (let i = 1; i < g.spiralStart - 1; i++) {
    if (r() > spurs * 0.6) continue;
    const a = g.pts[i];
    const b = g.pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const tx = dx / L;
    const ty = dy / L;
    const side = r() < 0.5 ? 1 : -1;
    const nx = -ty * side;
    const ny = tx * side;
    const f = 0.2 + r() * 0.6;
    const w = g.widths[i] * (1 - f) + g.widths[i + 1] * f;
    const cx = a.x + dx * f + nx * w * 0.45;
    const cy = a.y + dy * f + ny * w * 0.45;
    const len = w * (0.35 + r() * 0.45);
    const half = w * (0.25 + r() * 0.15);
    out.push([
      { x: cx - tx * half, y: cy - ty * half },
      { x: cx + nx * len + tx * len * 0.6, y: cy + ny * len + ty * len * 0.6 },
      { x: cx + tx * half, y: cy + ty * half },
      { x: cx - nx * w * 0.4, y: cy - ny * w * 0.4 },
    ]);
  }
  return out;
}

interface Group {
  polys: Pt[][];
}

function rotate(v: Pt, a: number): Pt {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Tendrils growing in from the left edge / bottom-left (mirrored for the right side). */
function layoutSide(W: number, H: number, u: number, r: Rand, n: number, mirror: boolean, o: { width: number; scale: number; angular: boolean; spurs: number }): Group[] {
  const groups: Group[] = [];
  const reachX = Math.min(W * 0.34, Math.max(W * 0.2, H * 0.42));
  /** placed curls (for spacing) */
  const curls: { x: number; y: number; R: number }[] = [];
  const crowded = (x: number, y: number, R: number, slack = 0.92) => curls.some((c) => Math.hypot(c.x - x, c.y - y) < (c.R + R) * slack);
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1);
    const W0 = o.width * (0.85 + r() * 0.35);
    const R = W0 * (3.1 + r() * 1.2) * o.scale;
    const dir: 1 | -1 = r() < 0.5 ? 1 : -1;
    // curls spread over the side band from ~28% height down to ~85%
    let cy = 0;
    let cx = 0;
    for (let tries = 0; tries < 6; tries++) {
      cy = H * (0.3 + 0.52 * t) + (r() - 0.5) * H * 0.09;
      cx = Math.min(reachX - R, R * 1.05 + W * 0.015 + r() * Math.max(0, reachX - R * 2.2));
      if (!crowded(cx, cy, R)) break;
    }
    curls.push({ x: cx, y: cy, R });
    const fromSide = t < 0.45 ? r() < 0.75 : r() < 0.2;
    const base = fromSide
      ? { x: -W0 * 1.5, y: Math.min(H + W0, cy + R * (2.2 + r() * 2.2)) }
      : { x: Math.max(-W0, cx + (r() - 0.65) * reachX * 0.7), y: H + W0 * 1.5 };
    const baseDir = fromSide ? rotate({ x: 1, y: 0 }, -(0.35 + r() * 0.5)) : rotate({ x: 0, y: -1 }, (r() - 0.5) * 0.6);
    const arrival = -Math.PI / 2 + (r() - 0.5) * 0.9;
    const main: TendrilSpec = {
      base,
      baseDir,
      curl: { cx, cy, R, dir, turns: 1.2 + r() * 0.45, endRatio: 0.3 + r() * 0.08, arrival },
      width: W0,
      angular: o.angular,
    };
    const polys: Pt[][] = [];
    // side branches with smaller curls
    const geo = tendrilGeometry(main, r, u);
    const nb = r() < 0.4 ? 2 : r() < 0.85 ? 1 : 0;
    for (let b = 0; b < nb; b++) {
      const idx = Math.max(1, Math.min(geo.spiralStart - 2, Math.floor(geo.spiralStart * (0.3 + r() * 0.45))));
      const a = geo.pts[idx];
      const nxt = geo.pts[idx + 1];
      const d = { x: nxt.x - a.x, y: nxt.y - a.y };
      const dl = Math.hypot(d.x, d.y) || 1;
      let side = b === 0 ? (r() < 0.5 ? 1 : -1) : -1;
      const R2 = R * (0.42 + r() * 0.16);
      const W2 = W0 * (0.5 + r() * 0.12);
      const dist = R2 * (2.6 + r() * 1.2);
      const ang = 0.55 + r() * 0.45;
      const place = (sd: number) => {
        const bd = rotate({ x: d.x / dl, y: d.y / dl }, sd * ang);
        const off = rotate(bd, sd * 0.5);
        return { bd, c2: { x: a.x + off.x * dist, y: a.y + off.y * dist } };
      };
      let pl = place(side);
      // keep branch curls on the canvas (and on this side of it)
      const inside = (q: Pt) => q.x > R2 * 1.1 && q.x < reachX * 1.15 && q.y > R2 * 1.1 && q.y < H - R2 * 0.6 && !crowded(q.x, q.y, R2, 0.9);
      if (!inside(pl.c2)) {
        side = -side;
        pl = place(side);
        if (!inside(pl.c2)) continue;
      }
      const { bd, c2 } = pl;
      curls.push({ x: c2.x, y: c2.y, R: R2 });
      const dir2: 1 | -1 = side > 0 ? 1 : -1;
      polys.push(
        ...tendrilPolygons(
          {
            base: a,
            baseDir: bd,
            curl: { cx: c2.x, cy: c2.y, R: R2, dir: dir2, turns: 1.3 + r() * 0.5, endRatio: 0.24, arrival: Math.atan2(bd.y, bd.x) + side * 0.6 },
            width: W2,
            angular: o.angular,
          },
          r,
          u,
          o.spurs * 0.5,
        ),
      );
    }
    polys.push(...polygonsOf(geo, r, o.spurs));
    if (mirror) for (const poly of polys) for (const q of poly) q.x = W - q.x;
    groups.push({ polys });
  }
  return groups;
}

export const swirlTendrils = defineAsset(
  {
    id: 'swirl-tendrils',
    name: 'Swirl Tendrils',
    category: 'Ornaments',
    tags: ['swirl', 'spiral', 'tendrils', 'gothic', 'curls', 'vines', 'birdcage', 'ornament', 'cut paper'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.color('outlineColor', 'Rim color', '#6f63c9'),
      P.num('outlineWidth', 'Rim width', 0, 20, 4, { step: 0.5, unit: 'px' }),
      P.num('count', 'Count', 1, 16, 6),
      P.num('thickness', 'Thickness', 6, 90, 28, { unit: 'px' }),
      P.select(
        'side',
        'Side',
        [
          ['both', 'Both sides'],
          ['left', 'Left'],
          ['right', 'Right'],
        ],
        'both',
      ),
      P.num('scale', 'Curl size', 0.5, 2, 1, { step: 0.05, unit: '×' }),
      P.select(
        'style',
        'Style',
        [
          ['angular', 'Angular (cut paper)'],
          ['smooth', 'Smooth'],
        ],
        'angular',
      ),
      P.pct('spikes', 'Thorns', 0),
      P.angle('rimAngle', 'Rim direction', 135),
      P.seed(17),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 17));
      const count = Math.max(1, Math.round(num(p, 'count', 6)));
      const side = str(p, 'side', 'both');
      const o = {
        width: Math.max(2, num(p, 'thickness', 28) * u),
        scale: num(p, 'scale', 1),
        angular: str(p, 'style', 'angular') !== 'smooth',
        spurs: num(p, 'spikes', 0),
      };
      let groups: Group[];
      if (side === 'both') {
        const nl = Math.ceil(count / 2);
        const left = layoutSide(W, H, u, r.fork(1), nl, false, o);
        const right = count - nl > 0 ? layoutSide(W, H, u, r.fork(2), count - nl, true, o) : [];
        // interleave so neither side is consistently on top
        groups = [];
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          if (left[i]) groups.push(left[i]);
          if (right[i]) groups.push(right[i]);
        }
      } else groups = layoutSide(W, H, u, r, count, side === 'right', o);
      const ow = num(p, 'outlineWidth', 4) * u;
      const ra = (num(p, 'rimAngle', 135) * Math.PI) / 180;
      // rim offset towards the light (angle measured counter-clockwise from +x, y up)
      const ox = Math.cos(ra) * ow;
      const oy = -Math.sin(ra) * ow;
      const color = str(p, 'color', '#0b0b0b');
      const rim = str(p, 'outlineColor', '#6f63c9');
      const [c, ctx] = newCanvas(W, H);
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 4;
      // back-most first: lower curls (larger index) are in front
      for (const g of groups) {
        const path = new Path2D();
        for (const poly of g.polys) tracePoly(path, poly);
        if (ow > 0) {
          ctx.save();
          ctx.translate(ox, oy);
          ctx.fillStyle = rim;
          ctx.strokeStyle = rim;
          ctx.lineWidth = ow * 0.55;
          ctx.fill(path, 'nonzero');
          ctx.stroke(path);
          ctx.restore();
        }
        ctx.fillStyle = color;
        ctx.fill(path, 'nonzero');
      }
      return c;
    },
  },
  { bg: 'paper' },
);
