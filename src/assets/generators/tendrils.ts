/**
 * swirl-tendrils: bold black spiral tendrils with a thin colored rim (the "Birdcage" look).
 *
 * Each tendril is a centerline (a stem bezier flowing into a logarithmic spiral) turned into a
 * filled polygon with a tapered width profile (thick stem → pointed hooked tip). The angular
 * style samples the spiral coarsely so it reads as hand-cut paper with sharp corners. The rim is
 * a slightly larger copy of the same polygons, offset towards the light, drawn behind the black.
 */
import { cubic, positiveWinding, taperedOutline } from '../lib/geom';
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
  // angular: 5–7 irregular facets per turn, like a curl cut from paper with scissors
  const { pts: spiral, gaps } = curlPoints(t.curl, t.angular ? TAU / (5 + r() * 2) : TAU / 56, r, t.angular ? 0.5 : 0);
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
  // hooked tip: the last facet kinks sharply towards the curl's center
  const e = spiral[spiral.length - 1];
  const e0 = spiral[spiral.length - 2] ?? p0;
  const ev = { x: e.x - e0.x, y: e.y - e0.y };
  const el = Math.hypot(ev.x, ev.y) || 1;
  const inner = t.curl.R * Math.max(0.02, t.curl.endRatio);
  const hookLen = Math.min(t.width * 0.75, inner * 0.8);
  const hd = rotate({ x: ev.x / el, y: ev.y / el }, t.curl.dir * (1.75 + r() * 0.35));
  const hook = { x: e.x + hd.x * hookLen, y: e.y + hd.y * hookLen };
  const pts = stem.concat(spiral, [hook]);
  // arc length fractions
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const sStem = cum[nStem];
  const sEnd = cum[pts.length - 2];
  const W0 = t.width;
  const widths = pts.map((_, i) => {
    // stem: strong taper from 1.6× at the base to 0.9× where the curl begins
    if (i < nStem) return W0 * (1.6 - 0.7 * Math.pow(cum[i] / Math.max(1e-6, sStem), 0.85));
    if (i === pts.length - 1) return 0;
    // curl: keeps its weight on the outer arc, then thins steadily into the hook
    const q = (cum[i] - sStem) / Math.max(1e-6, sEnd - sStem);
    let w = W0 * 0.9 * (0.18 + 0.82 * Math.pow(1 - q, 0.75));
    w = Math.min(w, gaps[i - nStem] * 0.72);
    return Math.max(0, w);
  });
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

export interface Group {
  polys: Pt[][];
}

function rotate(v: Pt, a: number): Pt {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A placed curl (for spacing) and a sampled stem centerline (for crossing checks). */
export interface PlacedCurl {
  x: number;
  y: number;
  R: number;
  W: number;
}
export interface PlacedStem {
  pts: Pt[];
  W: number;
}

/** True when a circle of radius R (ribbon W) keeps clear of every placed curl. Pure. */
export function curlClear(curls: PlacedCurl[], x: number, y: number, R: number, W: number, slack = 1): boolean {
  return curls.every((c) => Math.hypot(c.x - x, c.y - y) >= (c.R + R + (c.W + W) * 0.7) * slack);
}

/** Entry point of a curl's spiral (where the stem joins it). */
function curlEntry(c: CurlSpec): Pt {
  const a0 = c.arrival - c.dir * (Math.PI / 2);
  return { x: c.cx + Math.cos(a0) * c.R, y: c.cy + Math.sin(a0) * c.R };
}

/** Sampled stem centerline (no jitter) from base to the curl entry. */
function stemSamples(base: Pt, baseDir: Pt, curl: CurlSpec, n = 18): Pt[] {
  const p0 = curlEntry(curl);
  const L = Math.hypot(p0.x - base.x, p0.y - base.y);
  const arr = { x: Math.cos(curl.arrival), y: Math.sin(curl.arrival) };
  const c1 = { x: base.x + baseDir.x * L * 0.42, y: base.y + baseDir.y * L * 0.42 };
  const c2 = { x: p0.x - arr.x * L * 0.42, y: p0.y - arr.y * L * 0.42 };
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(cubic(base, c1, c2, p0, i / n));
  return out;
}

/**
 * How badly a stem route collides with the layout (0 = clean): overlap depth with other curls,
 * with other stems, with its own curl (before it enters it) and leaving the side band. Pure.
 */
export function stemPenalty(stem: Pt[], W: number, own: PlacedCurl, curls: PlacedCurl[], stems: PlacedStem[], band: { maxX: number; minY: number }): number {
  let pen = 0;
  const n = stem.length;
  for (let i = 1; i < n; i++) {
    const q = stem[i];
    for (const c of curls) {
      const d = Math.hypot(q.x - c.x, q.y - c.y) - (c.R + c.W * 0.6 + W * 0.9);
      if (d < 0) pen -= d;
    }
    if (i < n * 0.8) {
      const d = Math.hypot(q.x - own.x, q.y - own.y) - (own.R + W * 0.6);
      if (d < 0) pen -= d * 0.8;
    }
    for (const s of stems) {
      for (let j = 0; j < s.pts.length; j += 2) {
        const d = Math.hypot(q.x - s.pts[j].x, q.y - s.pts[j].y) - (s.W + W) * 0.85;
        if (d < 0) pen -= d * 0.45;
      }
    }
    if (q.x > band.maxX) pen += (q.x - band.maxX) * 0.5;
    if (q.y < band.minY) pen += (band.minY - q.y) * 0.5;
  }
  return pen;
}

/**
 * Tendrils growing in from the left edge / bottom-left (mirrored for the right side). Returns the
 * polygon groups plus every placed curl (unmirrored, for tests). Pure.
 */
export function layoutSide(
  W: number,
  H: number,
  u: number,
  r: Rand,
  n: number,
  mirror: boolean,
  o: { width: number; scale: number; angular: boolean; spurs: number },
): { groups: Group[]; curls: PlacedCurl[] } {
  const reachX = Math.min(W * 0.34, Math.max(W * 0.2, H * 0.42));
  const band = { maxX: reachX * 1.15, minY: H * 0.12 };
  const curls: PlacedCurl[] = [];
  const stems: PlacedStem[] = [];

  // 1) curls: rejection-sample every center in the side band (from ~28% height down to ~85%)
  //    so each spiral reads as its own shape — a candidate whose circle touches a placed curl is
  //    rejected; the search widens, then the curl shrinks, and as a last resort it is skipped
  interface Plan {
    t: number;
    W0: number;
    curl: PlacedCurl;
    dir: 1 | -1;
    turns: number;
    endRatio: number;
  }
  const plans: Plan[] = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0.5 : k / (n - 1);
    const W0 = o.width * (0.85 + r() * 0.35);
    let R = W0 * (2.4 + r() * 0.7) * o.scale;
    const dir: 1 | -1 = r() < 0.5 ? 1 : -1;
    const turns = 1.45 + r() * 0.45;
    const endRatio = 0.22 + r() * 0.08;
    let spot: Pt | null = null;
    for (let shrink = 0; shrink < 3 && !spot; shrink++) {
      for (let tries = 0; tries < 18; tries++) {
        const spread = 0.09 + tries * 0.025;
        const cy = Math.min(H * 0.86, Math.max(H * 0.22 + R, H * (0.3 + 0.52 * t) + (r() - 0.5) * H * spread));
        // some curls hug the canvas edge, partly cut off (like the reference poster)
        const cx = k % 3 === 1 && r() < 0.6 ? R * (0.4 + r() * 0.5) : Math.min(reachX - R, R * 1.05 + W * 0.015 + r() * Math.max(0, reachX - R * 2.2));
        if (curlClear(curls, cx, cy, R, W0, 1.08)) {
          spot = { x: cx, y: cy };
          break;
        }
      }
      if (!spot) R *= 0.82;
    }
    if (!spot) continue;
    const curl = { x: spot.x, y: spot.y, R, W: W0 };
    curls.push(curl);
    plans.push({ t, W0, curl, dir, turns, endRatio });
  }

  // 2) stems: route the lowest curls first (short stems), then the higher ones around them —
  //    each picks, among a dozen candidate routes from the side edge or the bottom, the one that
  //    crosses the fewest curls and stems
  const order = plans.map((_, i) => i).sort((a, b) => plans[b].curl.y - plans[a].curl.y);
  const groups: (Group | null)[] = plans.map(() => null);
  const geos: (TendrilGeometry | null)[] = plans.map(() => null);
  for (const i of order) {
    const { t, W0, curl: own, dir, turns, endRatio } = plans[i];
    const others = curls.filter((c) => c !== own);
    let best: { spec: TendrilSpec; samples: Pt[]; pen: number } | null = null;
    for (let cand = 0; cand < 14; cand++) {
      const fromSide = cand % 2 === 0 ? t < 0.6 || r() < 0.3 : t >= 0.6 && r() < 0.3;
      const base = fromSide
        ? { x: -W0 * 1.5, y: Math.min(H + W0, own.y + own.R * (1.6 + r() * 2.8)) }
        : { x: Math.max(-W0, own.x + (r() - 0.62) * reachX * 0.8), y: H + W0 * 1.5 };
      const baseDir = fromSide ? rotate({ x: 1, y: 0 }, -(0.35 + r() * 0.5)) : rotate({ x: 0, y: -1 }, (r() - 0.5) * 0.6);
      const arrival = -Math.PI / 2 + (r() - 0.5) * 0.9;
      const curl: CurlSpec = { cx: own.x, cy: own.y, R: own.R, dir, turns, endRatio, arrival };
      const samples = stemSamples(base, baseDir, curl);
      const pen = stemPenalty(samples, W0 * 1.3, own, others, stems, band) + r() * 0.01;
      if (!best || pen < best.pen) best = { spec: { base, baseDir, curl, width: W0, angular: o.angular }, samples, pen };
      if (pen < 0.02) break;
    }
    if (!best) continue;
    stems.push({ pts: best.samples, W: W0 * 1.3 });
    geos[i] = tendrilGeometry(best.spec, r, u);
    groups[i] = { polys: [] };
  }

  // 3) side branches with smaller curls, only where they fit without touching anything
  for (let i = 0; i < plans.length; i++) {
    const geo = geos[i];
    const g = groups[i];
    if (!geo || !g) continue;
    const { W0, curl: own } = plans[i];
    const nb = r() < 0.5 ? 2 : r() < 0.9 ? 1 : 0;
    const parentStem = stems.find((st) => {
      const e = st.pts[st.pts.length - 1];
      return !!e && Math.hypot(e.x - geo.pts[geo.spiralStart].x, e.y - geo.pts[geo.spiralStart].y) < 1;
    });
    const otherStems = stems.filter((st) => st !== parentStem);
    let placed = 0;
    // several attempts per branch (different fork points, sides and lengths) — only clean fits
    for (let attempt = 0; attempt < nb * 6 && placed < nb; attempt++) {
      const idx = Math.max(1, Math.min(geo.spiralStart - 2, Math.floor(geo.spiralStart * (0.25 + r() * 0.55))));
      const a = geo.pts[idx];
      const nxt = geo.pts[idx + 1];
      const d = { x: nxt.x - a.x, y: nxt.y - a.y };
      const dl = Math.hypot(d.x, d.y) || 1;
      const side = r() < 0.5 ? 1 : -1;
      const R2 = own.R * (0.42 + r() * 0.18);
      const W2 = W0 * (0.5 + r() * 0.14);
      const dist = R2 * (2.4 + r() * 1.6);
      const ang = 0.5 + r() * 0.55;
      const turns2 = 1.4 + r() * 0.5;
      const bd = rotate({ x: d.x / dl, y: d.y / dl }, side * ang);
      const off = rotate(bd, side * 0.5);
      const c2 = { x: a.x + off.x * dist, y: a.y + off.y * dist };
      const onCanvas = c2.x > R2 * 0.6 && c2.x < reachX * 1.15 && c2.y > H * 0.1 + R2 && c2.y < H - R2 * 0.6;
      if (!onCanvas || !curlClear(curls, c2.x, c2.y, R2, W2, 1.05)) continue;
      // keep clear of every stem except the parent one it grows from
      if (otherStems.some((st) => st.pts.some((q) => Math.hypot(q.x - c2.x, q.y - c2.y) < R2 + (st.W + W2) * 0.6))) continue;
      const bOwn = { x: c2.x, y: c2.y, R: R2, W: W2 };
      const dir2: 1 | -1 = side > 0 ? 1 : -1;
      const spec: TendrilSpec = {
        base: a,
        baseDir: bd,
        curl: { cx: c2.x, cy: c2.y, R: R2, dir: dir2, turns: turns2, endRatio: 0.22, arrival: Math.atan2(bd.y, bd.x) + side * 0.6 },
        width: W2,
        angular: o.angular,
      };
      const samples = stemSamples(spec.base, spec.baseDir, spec.curl, 10);
      if (stemPenalty(samples.slice(2), W2, bOwn, curls.filter((c) => c !== own), otherStems, band) > W2 * 0.4) continue;
      curls.push(bOwn);
      stems.push({ pts: samples, W: W2 });
      otherStems.push(stems[stems.length - 1]);
      g.polys.push(...tendrilPolygons(spec, r, u, o.spurs * 0.5));
      placed++;
    }
    g.polys.push(...polygonsOf(geo, r, o.spurs));
    if (mirror) for (const poly of g.polys) for (const q of poly) q.x = W - q.x;
  }
  return { groups: groups.filter((g): g is Group => !!g), curls };
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
      P.num('thickness', 'Thickness', 6, 90, 32, { unit: 'px' }),
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
        width: Math.max(2, num(p, 'thickness', 32) * u),
        scale: num(p, 'scale', 1),
        angular: str(p, 'style', 'angular') !== 'smooth',
        spurs: num(p, 'spikes', 0),
      };
      let groups: Group[];
      if (side === 'both') {
        const nl = Math.ceil(count / 2);
        const left = layoutSide(W, H, u, r.fork(1), nl, false, o).groups;
        const right = count - nl > 0 ? layoutSide(W, H, u, r.fork(2), count - nl, true, o).groups : [];
        // interleave so neither side is consistently on top
        groups = [];
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          if (left[i]) groups.push(left[i]);
          if (right[i]) groups.push(right[i]);
        }
      } else groups = layoutSide(W, H, u, r, count, side === 'right', o).groups;
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
      // One silhouette for everything (all polygons share a winding, so nonzero = union): the
      // rim is a slightly grown copy offset towards the light, drawn behind the whole black
      // shape, so it only shows along the outer edge — like a cut-paper layer on a colored sheet.
      const path = new Path2D();
      for (const g of groups) for (const poly of g.polys) tracePoly(path, positiveWinding(poly));
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
      return c;
    },
  },
  { bg: 'paper' },
);
