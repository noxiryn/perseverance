/**
 * Ornaments: swirl-tendrils, thorns, chains, barbed-wire, ornate-corners, crosses.
 */
import type { AssetDef } from '../../registry';
import { arcFractions, catmullRom, cubic, dist, resample, spiralPoints, spiralStartTangent, taperedOutline } from '../lib/geom';
import type { SpiralSpec } from '../lib/geom';
import { P, defineAsset } from '../lib/params';
import { drawSpecks } from '../lib/surface';
import type { Pt, Rand } from '../lib/util';
import { TAU, makeRand, newCanvas, num, rgbOf, rgba, shade, str, tracePoly, traceSmooth, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* swirl-tendrils                                                      */
/* ------------------------------------------------------------------ */

export interface TendrilSpec {
  base: Pt;
  grow: Pt;
  spiral: SpiralSpec;
  width: number;
  angular: boolean;
  spikes: number;
}

/** Centerline + width profile → filled outline polygon of one tendril (pure). */
export function tendrilOutline(t: TendrilSpec, r: Rand, u: number): Pt[] {
  const s = t.spiral;
  const p0 = { x: s.cx + Math.cos(s.startAngle) * s.radius, y: s.cy + Math.sin(s.startAngle) * s.radius };
  const tan = spiralStartTangent(s);
  const L = dist(t.base, p0);
  const c1 = { x: t.base.x + t.grow.x * L * 0.5, y: t.base.y + t.grow.y * L * 0.5 };
  const c2 = { x: p0.x - tan.x * L * 0.45, y: p0.y - tan.y * L * 0.45 };
  const stem: Pt[] = [];
  const nStem = t.angular ? Math.max(3, Math.round(L / (55 * u))) : Math.max(8, Math.round(L / (12 * u)));
  for (let i = 0; i < nStem; i++) {
    const q = cubic(t.base, c1, c2, p0, i / nStem);
    if (t.angular && i > 0) {
      const j = (r() - 0.5) * 14 * u;
      q.x += j;
      q.y += (r() - 0.5) * 14 * u;
    }
    stem.push(q);
  }
  const step = t.angular ? TAU / r.int(5, 7) : TAU / 40;
  let spiral = spiralPoints(s, step, t.angular ? 0.45 : 0, r);
  if (!t.angular) spiral = catmullRom(spiral, 2);
  const path = stem.concat(spiral);
  // hooked tip: a sharp barb turning back from the spiral end
  const a = path[path.length - 2];
  const b = path[path.length - 1];
  const dl = dist(a, b) || 1;
  const dx = (b.x - a.x) / dl;
  const dy = (b.y - a.y) / dl;
  const hookA = s.dir * 2.2;
  const hookLen = Math.max(4 * u, s.radius * s.endRatio * 1.3);
  path.push({ x: b.x + (dx * Math.cos(hookA) - dy * Math.sin(hookA)) * hookLen, y: b.y + (dx * Math.sin(hookA) + dy * Math.cos(hookA)) * hookLen });
  const fr = arcFractions(path);
  const n = path.length;
  const widths = fr.map((f, i) => {
    const base = t.width * Math.pow(1 - f, 0.85) + t.width * 0.07;
    const jit = t.angular ? 0.82 + r() * 0.36 : 1;
    return i >= n - 1 ? 0.6 * u : i === n - 2 ? t.width * 0.22 : base * jit;
  });
  // outward thorn spikes on the stem (angular style)
  const spikes = path.map((_, i) => (t.angular && i > 0 && i < nStem && r() < t.spikes * 0.55 ? widths[i] * (0.5 + r() * 0.9) : 0));
  // spikes must land on the outer side: for clockwise spirals the outer side is the right side
  if (s.dir === 1) {
    return taperedOutline(path.slice().reverse(), widths.slice().reverse(), 2.8, spikes.slice().reverse());
  }
  return taperedOutline(path, widths, 2.8, spikes);
}

interface TendrilGroup {
  parts: Pt[][];
}

function layoutTendrils(
  W: number,
  H: number,
  u: number,
  r: Rand,
  side: 'left' | 'right',
  n: number,
  o: { width: number; scale: number; angular: boolean; spikes: number },
): TendrilGroup[] {
  const M = Math.min(W, H);
  const groups: TendrilGroup[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k + 0.3 + r() * 0.4) / n;
    const R = M * (0.055 + r() * 0.05) * o.scale;
    const cx = W * 0.03 + R * 1.1 + r() * W * 0.1;
    const cy = H * (0.2 + 0.62 * t) + (r() - 0.5) * H * 0.06;
    const dir: 1 | -1 = r() < 0.5 ? 1 : -1;
    const startAngle = (dir === 1 ? Math.PI : 0) + (r() - 0.5) * 0.7;
    const fromBottom = t > 0.55 || r() < 0.45;
    const base = fromBottom
      ? { x: Math.max(-20 * u, cx + (r() - 0.6) * W * 0.12), y: H + 30 * u }
      : { x: -30 * u, y: Math.min(H + 20 * u, cy + R * (1.8 + r() * 2.4)) };
    const grow = fromBottom ? { x: (r() - 0.5) * 0.5, y: -1 } : { x: 0.75, y: -0.65 };
    const gl = Math.hypot(grow.x, grow.y);
    const spiral: SpiralSpec = { cx, cy, radius: R, startAngle, turns: 1.7 + r() * 0.9, dir, endRatio: 0.16 + r() * 0.06 };
    const main: TendrilSpec = {
      base,
      grow: { x: grow.x / gl, y: grow.y / gl },
      spiral,
      width: o.width * (0.8 + r() * 0.4),
      angular: o.angular,
      spikes: o.spikes,
    };
    const parts: Pt[][] = [];
    // branch curl off the stem
    if (r() < 0.75) {
      const p0 = { x: cx + Math.cos(startAngle) * R, y: cy + Math.sin(startAngle) * R };
      const f = 0.35 + r() * 0.3;
      const bp = { x: base.x + (p0.x - base.x) * f, y: base.y + (p0.y - base.y) * f };
      const R2 = R * (0.42 + r() * 0.2);
      const away = r() < 0.5 ? -1 : 1;
      const dir2: 1 | -1 = away > 0 ? 1 : -1;
      const sp2: SpiralSpec = {
        cx: bp.x + away * R2 * (1.6 + r() * 0.8),
        cy: bp.y - R2 * (1.2 + r() * 1.2),
        radius: R2,
        startAngle: (dir2 === 1 ? Math.PI : 0) + (r() - 0.5) * 0.6,
        turns: 1.5 + r() * 0.8,
        dir: dir2,
        endRatio: 0.2,
      };
      parts.push(
        tendrilOutline(
          { base: bp, grow: { x: away * 0.6, y: -0.8 }, spiral: sp2, width: main.width * 0.5, angular: o.angular, spikes: o.spikes * 0.6 },
          r,
          u,
        ),
      );
    }
    parts.push(tendrilOutline(main, r, u));
    if (side === 'right') for (const poly of parts) for (const q of poly) q.x = W - q.x;
    groups.push({ parts });
  }
  return groups;
}

const swirlTendrils = defineAsset(
  {
    id: 'swirl-tendrils',
    name: 'Swirl Tendrils',
    category: 'Ornaments',
    tags: ['swirl', 'spiral', 'tendrils', 'gothic', 'curls', 'vines', 'birdcage', 'ornament'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.color('outlineColor', 'Rim color', '#6f63c9'),
      P.num('outlineWidth', 'Rim width', 0, 20, 4, { step: 0.5, unit: 'px' }),
      P.num('count', 'Count', 1, 16, 6),
      P.num('thickness', 'Thickness', 6, 90, 30, { unit: 'px' }),
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
      P.num('scale', 'Curl size', 0.4, 2.5, 1, { step: 0.05, unit: '×' }),
      P.select(
        'style',
        'Style',
        [
          ['angular', 'Angular (cut paper)'],
          ['smooth', 'Smooth'],
        ],
        'angular',
      ),
      P.pct('spikes', 'Thorns', 0.45),
      P.angle('rimAngle', 'Rim direction', 125),
      P.seed(17),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 17));
      const count = Math.max(1, Math.round(num(p, 'count', 6)));
      const side = str(p, 'side', 'both');
      const o = {
        width: num(p, 'thickness', 30) * u,
        scale: num(p, 'scale', 1),
        angular: str(p, 'style', 'angular') !== 'smooth',
        spikes: num(p, 'spikes', 0.45),
      };
      let groups: TendrilGroup[] = [];
      if (side === 'both') {
        const nl = Math.ceil(count / 2);
        groups = layoutTendrils(W, H, u, r.fork(1), 'left', nl, o).concat(layoutTendrils(W, H, u, r.fork(2), 'right', count - nl, o));
      } else groups = layoutTendrils(W, H, u, r, side === 'right' ? 'right' : 'left', count, o);
      const ow = num(p, 'outlineWidth', 4) * u;
      const ra = (num(p, 'rimAngle', 125) * Math.PI) / 180;
      const ox = Math.cos(ra) * ow * 0.9;
      const oy = -Math.sin(ra) * ow * 0.9;
      const color = str(p, 'color', '#0b0b0b');
      const rim = str(p, 'outlineColor', '#6f63c9');
      const [c, ctx] = newCanvas(W, H);
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 3;
      for (const g of groups) {
        const path = new Path2D();
        for (const poly of g.parts) tracePoly(path, poly);
        if (ow > 0) {
          ctx.save();
          ctx.translate(ox, oy);
          ctx.fillStyle = rim;
          ctx.strokeStyle = rim;
          ctx.lineWidth = ow * 0.7;
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

/* ------------------------------------------------------------------ */
/* thorns                                                              */
/* ------------------------------------------------------------------ */

function thornVine(path: Path2D, start: Pt, heading: number, L: number, width: number, thornAmt: number, u: number, r: Rand) {
  const ctrl: Pt[] = [start];
  let a = heading;
  let x = start.x;
  let y = start.y;
  const seg = 70 * u;
  const n = Math.max(3, Math.round(L / seg));
  let bend = (r() - 0.5) * 0.5;
  for (let i = 0; i < n; i++) {
    bend += (r() - 0.5) * 0.35;
    bend *= 0.85;
    a += bend;
    x += Math.cos(a) * seg;
    y += Math.sin(a) * seg;
    ctrl.push({ x, y });
  }
  const pts = resample(catmullRom(ctrl, 8), 6 * u);
  const fr = arcFractions(pts);
  const widths = fr.map((f) => Math.max(0.8 * u, width * (1 - f * 0.9)));
  tracePoly(path, taperedOutline(pts, widths));
  // thorns
  let side = 1;
  let next = 18 * u;
  let travelled = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    travelled += dist(pts[i - 1], pts[i]);
    if (travelled < next) continue;
    next = travelled + (22 + r() * 30) * u / Math.max(0.2, thornAmt);
    const dx = pts[i + 1].x - pts[i - 1].x;
    const dy = pts[i + 1].y - pts[i - 1].y;
    const dl = Math.hypot(dx, dy) || 1;
    const tx = dx / dl;
    const ty = dy / dl;
    const nx = -ty * side;
    const ny = tx * side;
    const w = widths[i];
    const tl = (8 + r() * 12) * u * (0.5 + w / width);
    const bw = w * 0.9 + 2 * u;
    const bx = pts[i].x + nx * w * 0.35;
    const by = pts[i].y + ny * w * 0.35;
    path.moveTo(bx - tx * bw, by - ty * bw);
    path.lineTo(bx + nx * tl + tx * tl * 0.55, by + ny * tl + ty * tl * 0.55);
    path.lineTo(bx + tx * bw * 0.6, by + ty * bw * 0.6);
    path.closePath();
    side = r() < 0.75 ? -side : side;
    // occasional twig
    if (r() < 0.06 && w > 3 * u) {
      thornVine(path, pts[i], Math.atan2(ny, nx) + (r() - 0.5) * 0.6 + Math.atan2(ty, tx) * 0, L * 0.25, w * 0.6, thornAmt, u, r);
    }
  }
}

const thorns = defineAsset(
  {
    id: 'thorns',
    name: 'Thorns',
    category: 'Ornaments',
    tags: ['thorns', 'vines', 'briar', 'gothic', 'horror', 'roses', 'branches'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('count', 'Vines', 1, 16, 6),
      P.num('thickness', 'Thickness', 3, 50, 14, { unit: 'px' }),
      P.pct('thorns', 'Thorn density', 0.6),
      P.num('length', 'Reach', 0.2, 1.5, 0.7, { step: 0.05, unit: '×' }),
      P.select(
        'side',
        'Grow from',
        [
          ['corners', 'Corners'],
          ['bottom', 'Bottom'],
          ['sides', 'Sides'],
          ['all', 'All edges'],
        ],
        'corners',
      ),
      P.seed(23),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 23));
      const n = Math.max(1, Math.round(num(p, 'count', 6)));
      const side = str(p, 'side', 'corners');
      const width = num(p, 'thickness', 14) * u;
      const reach = num(p, 'length', 0.7) * Math.min(W, H);
      const thornAmt = num(p, 'thorns', 0.6);
      const path = new Path2D();
      for (let i = 0; i < n; i++) {
        let start: Pt;
        let heading: number;
        const pick = side === 'all' ? r.pick(['corners', 'bottom', 'sides']) : side;
        if (pick === 'corners') {
          const corner = i % 4;
          const cx = corner % 2 === 0 ? 0 : W;
          const cy = corner < 2 ? 0 : H;
          start = { x: cx + (r() - 0.5) * 40 * u, y: cy + (r() - 0.5) * 40 * u };
          heading = Math.atan2(H / 2 - cy, W / 2 - cx) + (r() - 0.5) * 1.1;
        } else if (pick === 'bottom') {
          start = { x: W * r(), y: H + 10 * u };
          heading = -Math.PI / 2 + (r() - 0.5) * 1.2;
        } else {
          const left = i % 2 === 0;
          start = { x: left ? -10 * u : W + 10 * u, y: H * (0.1 + r() * 0.8) };
          heading = (left ? 0 : Math.PI) + (r() - 0.5) * 1.2;
        }
        thornVine(path, start, heading, reach * (0.6 + r() * 0.6), width * (0.7 + r() * 0.5), thornAmt, u, r);
      }
      const [c, ctx] = newCanvas(W, H);
      ctx.fillStyle = str(p, 'color', '#0b0b0b');
      ctx.fill(path, 'nonzero');
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* chains                                                              */
/* ------------------------------------------------------------------ */

function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u1 = 1 - t;
  return { x: u1 * u1 * a.x + 2 * u1 * t * c.x + t * t * b.x, y: u1 * u1 * a.y + 2 * u1 * t * c.y + t * t * b.y };
}

function drawChain(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, sag: number, link: number, metal: string) {
  const ctrl = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag };
  const raw: Pt[] = [];
  for (let i = 0; i <= 200; i++) raw.push(quadPoint(a, ctrl, b, i / 200));
  const pts = resample(raw, link * 0.74);
  const base = rgbOf(metal);
  const thick = link * 0.2;
  const drawLink = (i: number, face: boolean) => {
    const p0 = pts[i];
    const p1 = pts[Math.min(pts.length - 1, i + 1)];
    const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const cx = (p0.x + p1.x) / 2;
    const cy = (p0.y + p1.y) / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, -link * 0.35, 0, link * 0.35);
    g.addColorStop(0, rgba(shade(base, 0.75), 1));
    g.addColorStop(0.3, rgba(base, 1));
    g.addColorStop(0.62, rgba(shade(base, -0.55), 1));
    g.addColorStop(0.85, rgba(shade(base, 0.15), 1));
    g.addColorStop(1, rgba(shade(base, -0.7), 1));
    if (face) {
      ctx.lineWidth = thick + 2;
      ctx.strokeStyle = rgba('#000000', 0.75);
      ctx.beginPath();
      ctx.ellipse(0, 0, link * 0.5, link * 0.3, 0, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = thick;
      ctx.strokeStyle = g;
      ctx.stroke();
      // specular glint
      ctx.lineWidth = thick * 0.25;
      ctx.strokeStyle = rgba('#ffffff', 0.55);
      ctx.beginPath();
      ctx.ellipse(0, 0, link * 0.5, link * 0.3, 0, Math.PI * 1.15, Math.PI * 1.55);
      ctx.stroke();
    } else {
      ctx.fillStyle = rgba('#000000', 0.75);
      ctx.beginPath();
      ctx.roundRect(-link * 0.52 - 1, -thick * 0.65 - 1, link * 1.04 + 2, thick * 1.3 + 2, thick * 0.6);
      ctx.fill();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(-link * 0.52, -thick * 0.65, link * 1.04, thick * 1.3, thick * 0.6);
      ctx.fill();
    }
    ctx.restore();
  };
  for (let i = 1; i < pts.length - 1; i += 2) drawLink(i, false);
  for (let i = 0; i < pts.length - 1; i += 2) drawLink(i, true);
}

const chains = defineAsset(
  {
    id: 'chains',
    name: 'Chains',
    category: 'Ornaments',
    tags: ['chains', 'metal', 'links', 'prison', 'hanging', 'steel'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Metal', '#9b9b9b'),
      P.num('count', 'Chains', 1, 6, 2),
      P.num('size', 'Link size', 12, 140, 46, { unit: 'px' }),
      P.pct('sag', 'Sag', 0.35),
      P.select(
        'layout',
        'Layout',
        [
          ['top', 'Draped across top'],
          ['cross', 'Crossed'],
          ['hanging', 'Hanging'],
        ],
        'top',
      ),
      P.seed(29),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 29));
      const n = Math.max(1, Math.round(num(p, 'count', 2)));
      const link = num(p, 'size', 46) * u;
      const sag = num(p, 'sag', 0.35);
      const layout = str(p, 'layout', 'top');
      const metal = str(p, 'color', '#9b9b9b');
      const [c, ctx] = newCanvas(W, H);
      for (let i = 0; i < n; i++) {
        if (layout === 'hanging') {
          const x = W * ((i + 0.5) / n) + (r() - 0.5) * W * 0.08;
          drawChain(ctx, { x, y: -link }, { x: x + (r() - 0.5) * 60 * u, y: H * (0.3 + r() * 0.6) }, (r() - 0.5) * 30 * u, link, metal);
        } else if (layout === 'cross') {
          const down = i % 2 === 0;
          drawChain(ctx, { x: -link, y: down ? H * 0.05 : H * 0.95 }, { x: W + link, y: down ? H * 0.95 : H * 0.05 }, sag * H * 0.3, link, metal);
        } else {
          const y0 = H * (0.02 + i * 0.07) + (r() - 0.5) * H * 0.04;
          drawChain(ctx, { x: -link, y: y0 }, { x: W + link, y: y0 + (r() - 0.5) * H * 0.1 }, sag * H * (0.45 + r() * 0.3), link, metal);
        }
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* barbed-wire                                                         */
/* ------------------------------------------------------------------ */

function drawWire(ctx: CanvasRenderingContext2D, pts: Pt[], th: number, color: string, highlight: boolean) {
  const path = new Path2D();
  tracePoly(path, pts, false);
  ctx.lineWidth = th;
  ctx.strokeStyle = color;
  ctx.stroke(path);
  if (highlight) {
    ctx.save();
    ctx.translate(-th * 0.18, -th * 0.22);
    ctx.lineWidth = th * 0.3;
    ctx.strokeStyle = rgba('#ffffff', 0.35);
    ctx.stroke(path);
    ctx.restore();
  }
}

const barbedWire = defineAsset(
  {
    id: 'barbed-wire',
    name: 'Barbed Wire',
    category: 'Ornaments',
    tags: ['barbed wire', 'fence', 'war', 'prison', 'danger', 'horror'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#161616'),
      P.num('strands', 'Strands', 1, 5, 2),
      P.num('thickness', 'Wire thickness', 1, 12, 3.5, { step: 0.5, unit: 'px' }),
      P.num('spacing', 'Barb spacing', 30, 300, 95, { unit: 'px' }),
      P.pct('sag', 'Sag', 0.15),
      P.bool('highlight', 'Highlight', true),
      P.seed(31),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 31));
      const n = Math.max(1, Math.round(num(p, 'strands', 2)));
      const th = num(p, 'thickness', 3.5) * u;
      const spacing = num(p, 'spacing', 95) * u;
      const sag = num(p, 'sag', 0.15);
      const color = str(p, 'color', '#161616');
      const hl = p.highlight !== false;
      const [c, ctx] = newCanvas(W, H);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let s = 0; s < n; s++) {
        const y0 = n === 1 ? H * 0.12 : H * (0.08 + (0.84 * s) / (n - 1)) + (r() - 0.5) * H * 0.05;
        const a = { x: -30 * u, y: y0 };
        const b = { x: W + 30 * u, y: y0 + (r() - 0.5) * H * 0.12 };
        const ctrl = { x: W / 2, y: (a.y + b.y) / 2 + sag * H * 0.5 * (s % 2 === 0 ? 1 : -0.6) };
        const raw: Pt[] = [];
        for (let i = 0; i <= 300; i++) raw.push(quadPoint(a, ctrl, b, i / 300));
        const axis = resample(raw, 3 * u);
        const twist = 26 * u;
        const amp = th * 0.9;
        const w1: Pt[] = [];
        const w2: Pt[] = [];
        for (let i = 0; i < axis.length; i++) {
          const q = axis[i];
          const nq = axis[Math.min(axis.length - 1, i + 1)];
          const pq = axis[Math.max(0, i - 1)];
          const dx = nq.x - pq.x;
          const dy = nq.y - pq.y;
          const dl = Math.hypot(dx, dy) || 1;
          const nx = -dy / dl;
          const ny = dx / dl;
          const ph = ((i * 3 * u) / twist) * TAU;
          w1.push({ x: q.x + nx * Math.sin(ph) * amp, y: q.y + ny * Math.sin(ph) * amp });
          w2.push({ x: q.x - nx * Math.sin(ph) * amp, y: q.y - ny * Math.sin(ph) * amp });
        }
        drawWire(ctx, w2, th, color, hl);
        drawWire(ctx, w1, th, color, hl);
        // barbs
        let next = spacing * (0.3 + r() * 0.5);
        let acc = 0;
        for (let i = 1; i < axis.length - 1; i++) {
          acc += 3 * u;
          if (acc < next) continue;
          next += spacing * (0.85 + r() * 0.3);
          const q = axis[i];
          const dx = axis[i + 1].x - axis[i - 1].x;
          const dy = axis[i + 1].y - axis[i - 1].y;
          const ang = Math.atan2(dy, dx);
          const bl = (16 + r() * 8) * u;
          ctx.lineWidth = th * 0.85;
          ctx.strokeStyle = color;
          for (const d of [0.9 + (r() - 0.5) * 0.3, -0.9 + (r() - 0.5) * 0.3]) {
            const aa = ang + Math.PI / 2 + d * 0.6;
            ctx.beginPath();
            ctx.moveTo(q.x - Math.cos(aa) * bl, q.y - Math.sin(aa) * bl);
            ctx.lineTo(q.x + Math.cos(aa) * bl, q.y + Math.sin(aa) * bl);
            ctx.stroke();
          }
          // coil wrapped around the wire
          ctx.lineWidth = th * 0.7;
          for (let k = -1; k <= 1; k++) {
            const cx = q.x + Math.cos(ang) * k * th * 1.1;
            const cy = q.y + Math.sin(ang) * k * th * 1.1;
            ctx.beginPath();
            ctx.ellipse(cx, cy, th * 0.6, th * 2.1, ang, 0, TAU);
            ctx.stroke();
          }
        }
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* ornate-corners                                                      */
/* ------------------------------------------------------------------ */

function scrollPath(path: Path2D, s: SpiralSpec, base: Pt, width: number, u: number, r: Rand) {
  const p0 = { x: s.cx + Math.cos(s.startAngle) * s.radius, y: s.cy + Math.sin(s.startAngle) * s.radius };
  const tan = spiralStartTangent(s);
  const L = dist(base, p0);
  const stem: Pt[] = [];
  for (let i = 0; i < 16; i++) stem.push(cubic(base, { x: base.x + (p0.x - base.x) * 0.3, y: base.y }, { x: p0.x - tan.x * L * 0.4, y: p0.y - tan.y * L * 0.4 }, p0, i / 16));
  const pts = resample(stem.concat(spiralPoints(s, TAU / 40)), 3 * u);
  const fr = arcFractions(pts);
  const widths = fr.map((f) => Math.max(0.7 * u, width * (0.25 + 0.75 * Math.sin(Math.min(1, f * 1.3) * Math.PI) ** 0.7)));
  tracePoly(path, taperedOutline(pts, widths));
  // terminal dot
  const end = pts[pts.length - 1];
  path.moveTo(end.x + width * 0.6, end.y);
  path.arc(end.x, end.y, width * 0.6, 0, TAU);
  void r;
}

function leaf(path: Path2D, at: Pt, ang: number, len: number, wid: number) {
  const tip = { x: at.x + Math.cos(ang) * len, y: at.y + Math.sin(ang) * len };
  const nx = -Math.sin(ang) * wid;
  const ny = Math.cos(ang) * wid;
  path.moveTo(at.x, at.y);
  path.quadraticCurveTo(at.x + Math.cos(ang) * len * 0.5 + nx, at.y + Math.sin(ang) * len * 0.5 + ny, tip.x, tip.y);
  path.quadraticCurveTo(at.x + Math.cos(ang) * len * 0.5 - nx, at.y + Math.sin(ang) * len * 0.5 - ny, at.x, at.y);
  path.closePath();
}

/** One corner ornament in local coordinates (corner at 0,0, growing into +x/+y). */
function cornerOrnament(size: number, th: number, u: number, r: Rand, lines: boolean, W: number, H: number): Path2D {
  const path = new Path2D();
  const half = (mirror: boolean) => {
    const sp: SpiralSpec = {
      cx: size * 0.62,
      cy: size * 0.2,
      radius: size * 0.16,
      startAngle: Math.PI * 0.9,
      turns: 1.35,
      dir: 1,
      endRatio: 0.28,
    };
    const sp2: SpiralSpec = { cx: size * 0.3, cy: size * 0.42, radius: size * 0.1, startAngle: -Math.PI * 0.2, turns: 1.2, dir: -1, endRatio: 0.3 };
    const p1 = new Path2D();
    scrollPath(p1, sp, { x: size * 0.08, y: size * 0.08 }, th * 1.6, u, r);
    scrollPath(p1, sp2, { x: size * 0.1, y: size * 0.12 }, th * 1.1, u, r);
    leaf(p1, { x: size * 0.2, y: size * 0.13 }, -0.15, size * 0.22, size * 0.045);
    leaf(p1, { x: size * 0.42, y: size * 0.1 }, -0.65, size * 0.12, size * 0.03);
    leaf(p1, { x: size * 0.4, y: size * 0.24 }, 0.55, size * 0.12, size * 0.03);
    const m = mirror ? new DOMMatrix([0, 1, 1, 0, 0, 0]) : new DOMMatrix();
    path.addPath(p1, m);
  };
  half(false);
  half(true);
  // corner jewel
  path.moveTo(size * 0.1 + th * 2.2, size * 0.1);
  path.arc(size * 0.1, size * 0.1, th * 2.2, 0, TAU);
  // diamond
  const d = size * 0.07;
  path.moveTo(size * 0.2, size * 0.2 - d);
  path.lineTo(size * 0.2 + d, size * 0.2);
  path.lineTo(size * 0.2, size * 0.2 + d);
  path.lineTo(size * 0.2 - d, size * 0.2);
  path.closePath();
  if (lines) {
    // double edge rules running to the middle of each side
    const lw = Math.max(0.8, th * 0.5);
    for (const off of [size * 0.05, size * 0.05 + th * 1.6]) {
      path.rect(size * 0.75, off, W / 2 - size * 0.75 + 2, lw);
      path.rect(off, size * 0.75, lw, H / 2 - size * 0.75 + 2);
    }
  }
  return path;
}

const ornateCorners = defineAsset(
  {
    id: 'ornate-corners',
    name: 'Ornate Corners',
    category: 'Ornaments',
    tags: ['ornate', 'corners', 'filigree', 'victorian', 'baroque', 'frame', 'decorative'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#151515'),
      P.num('size', 'Size', 100, 600, 300, { unit: 'px' }),
      P.num('thickness', 'Line weight', 1, 20, 6, { step: 0.5, unit: 'px' }),
      P.num('inset', 'Inset', 0, 200, 30, { unit: 'px' }),
      P.bool('lines', 'Edge rules', true),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(1);
      const size = num(p, 'size', 300) * u;
      const th = num(p, 'thickness', 6) * u;
      const inset = num(p, 'inset', 30) * u;
      const lines = p.lines !== false;
      const orn = cornerOrnament(size, th, u, r, lines, W - inset * 2, H - inset * 2);
      const [c, ctx] = newCanvas(W, H);
      ctx.fillStyle = str(p, 'color', '#151515');
      const corners: [number, number, number, number][] = [
        [inset, inset, 1, 1],
        [W - inset, inset, -1, 1],
        [inset, H - inset, 1, -1],
        [W - inset, H - inset, -1, -1],
      ];
      for (const [x, y, sx, sy] of corners) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(sx, sy);
        ctx.fill(orn, 'nonzero');
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* crosses                                                             */
/* ------------------------------------------------------------------ */

function crossPath(style: string, w: number, h: number): Path2D {
  const p = new Path2D();
  const cx = w / 2;
  const bar = w * 0.17;
  const armY = h * 0.3;
  const span = w * 0.86;
  switch (style) {
    case 'pattee': {
      const c = { x: cx, y: h * 0.36 };
      const flare = w * 0.2;
      const pinch = bar * 0.4;
      const arms: [number, number, number][] = [
        [0, -1, h * 0.34],
        [0, 1, h * 0.62],
        [-1, 0, w * 0.44],
        [1, 0, w * 0.44],
      ];
      for (const [dx, dy, L] of arms) {
        const nx = -dy;
        const ny = dx;
        p.moveTo(c.x + nx * pinch, c.y + ny * pinch);
        p.lineTo(c.x + dx * L + nx * flare, c.y + dy * L + ny * flare);
        p.quadraticCurveTo(c.x + dx * L * 0.94, c.y + dy * L * 0.94, c.x + dx * L - nx * flare, c.y + dy * L - ny * flare);
        p.lineTo(c.x - nx * pinch, c.y - ny * pinch);
        p.closePath();
      }
      p.moveTo(c.x + bar * 0.7, c.y);
      p.arc(c.x, c.y, bar * 0.7, 0, TAU);
      break;
    }
    case 'orthodox': {
      p.rect(cx - bar / 2, h * 0.03, bar, h * 0.94);
      p.rect(cx - span * 0.24, h * 0.12, span * 0.48, bar * 0.6);
      p.rect(cx - span / 2, armY, span, bar);
      p.moveTo(cx - span * 0.3, h * 0.66);
      p.lineTo(cx + span * 0.3, h * 0.6);
      p.lineTo(cx + span * 0.3, h * 0.6 + bar * 0.7);
      p.lineTo(cx - span * 0.3, h * 0.66 + bar * 0.7);
      p.closePath();
      break;
    }
    case 'gothic': {
      // budded cross with trefoil terminals and a pointed foot
      p.rect(cx - bar / 2, h * 0.08, bar, h * 0.78);
      p.rect(cx - span / 2 + bar * 0.6, armY, span - bar * 1.2, bar);
      const bud = (x: number, y: number, dx: number, dy: number) => {
        const rr = bar * 0.62;
        const nx = -dy;
        const ny = dx;
        for (const [ox, oy] of [
          [dx * rr * 0.9, dy * rr * 0.9],
          [nx * rr * 0.85, ny * rr * 0.85],
          [-nx * rr * 0.85, -ny * rr * 0.85],
        ]) {
          p.moveTo(x + ox + rr, y + oy);
          p.arc(x + ox, y + oy, rr, 0, TAU);
        }
      };
      bud(cx, h * 0.08, 0, -1);
      bud(cx - span / 2 + bar * 0.6, armY + bar / 2, -1, 0);
      bud(cx + span / 2 - bar * 0.6, armY + bar / 2, 1, 0);
      p.moveTo(cx - bar * 0.9, h * 0.86);
      p.lineTo(cx + bar * 0.9, h * 0.86);
      p.lineTo(cx, h * 0.99);
      p.closePath();
      break;
    }
    case 'celtic': {
      p.rect(cx - bar / 2, h * 0.02, bar, h * 0.96);
      p.rect(cx - span / 2, armY, span, bar);
      const cy = armY + bar / 2;
      const R = w * 0.27;
      p.moveTo(cx + R, cy);
      p.arc(cx, cy, R, 0, TAU);
      p.moveTo(cx + R - bar * 0.45, cy);
      p.arc(cx, cy, R - bar * 0.45, 0, TAU, true);
      break;
    }
    default: {
      p.rect(cx - bar / 2, h * 0.02, bar, h * 0.96);
      p.rect(cx - span / 2, armY, span, bar);
    }
  }
  return p;
}

const crosses = defineAsset(
  {
    id: 'crosses',
    name: 'Crosses',
    category: 'Ornaments',
    tags: ['cross', 'gothic', 'grave', 'religious', 'holy', 'horror'],
    sizing: { width: 520, height: 760 },
    defaultBlendMode: 'normal',
    params: [
      P.select(
        'style',
        'Style',
        [
          ['latin', 'Latin'],
          ['gothic', 'Gothic (budded)'],
          ['celtic', 'Celtic'],
          ['pattee', 'Pattée'],
          ['orthodox', 'Orthodox'],
        ],
        'gothic',
      ),
      P.color('color', 'Color', '#0d0d0d'),
      P.color('outlineColor', 'Outline', '#f2f2f2'),
      P.num('outlineWidth', 'Outline width', 0, 40, 0, { unit: 'px' }),
      P.num('count', 'Count', 1, 5, 1),
      P.pct('distress', 'Distress', 0.2),
      P.seed(37),
    ],
    generate(p, { width: W, height: H }) {
      const r = makeRand(num(p, 'seed', 37));
      const n = Math.max(1, Math.round(num(p, 'count', 1)));
      const style = str(p, 'style', 'gothic');
      const ow = num(p, 'outlineWidth', 0) * (Math.min(W, H) / 520);
      const [c, ctx] = newCanvas(W, H);
      const pad = ow + 4;
      for (let i = 0; i < n; i++) {
        const scale = n === 1 ? 1 : 0.55 + r() * 0.35 - (i === Math.floor(n / 2) ? -0.15 : 0.05);
        const cw = ((W - pad * 2) / Math.max(1, n * 0.62)) * scale;
        const ch = (H - pad * 2) * scale;
        const fw = Math.min(cw, (ch * 520) / 760);
        const fh = (fw * 760) / 520;
        const x = n === 1 ? (W - fw) / 2 : pad + (i / (n - 1)) * (W - pad * 2 - fw);
        const y = H - pad - fh;
        const path = crossPath(style, fw, fh);
        ctx.save();
        ctx.translate(x, y);
        if (n > 1) {
          ctx.translate(fw / 2, fh);
          ctx.rotate((r() - 0.5) * 0.2);
          ctx.translate(-fw / 2, -fh);
        }
        if (ow > 0) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = ow * 2;
          ctx.strokeStyle = str(p, 'outlineColor', '#f2f2f2');
          ctx.stroke(path);
          ctx.fillStyle = str(p, 'outlineColor', '#f2f2f2');
          ctx.fill(path, 'evenodd');
        }
        ctx.fillStyle = str(p, 'color', '#0d0d0d');
        ctx.fill(path, style === 'celtic' ? 'evenodd' : 'nonzero');
        ctx.restore();
      }
      const distress = num(p, 'distress', 0.2);
      if (distress > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        const u = Math.min(W, H) / 1000;
        drawSpecks(ctx, W, H, u * 1.6, { r: 0, g: 0, b: 0 }, r, distress * 3);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'paper' },
);

export const ornamentAssets: AssetDef[] = [swirlTendrils, thorns, chains, barbedWire, ornateCorners, crosses];
export { traceSmooth };
