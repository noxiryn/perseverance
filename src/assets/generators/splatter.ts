/**
 * Splatter & Ink: ink-splatter, paint-splatter, brush-strokes, ink-drips.
 */
import type { AssetDef } from '../../registry';
import { createNoise2D } from '../../core/noise';
import { arcFractions, blob, catmullRom, resample } from '../lib/geom';
import { P, defineAsset } from '../lib/params';
import { gooShape } from '../lib/raster';
import type { Pt, Rand } from '../lib/util';
import { TAU, makeRand, newCanvas, num, rgba, str, traceSmooth, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* shared splat geometry                                               */
/* ------------------------------------------------------------------ */

interface Splat {
  x: number;
  y: number;
  size: number;
}

/** Draw one splat's merged body (arms, core, near droplets) as white shapes into ctx. */
function splatBody(ctx: CanvasRenderingContext2D, s: Splat, r: Rand, spread: number) {
  const S = s.size;
  // core: a few overlapping blobs
  const core = new Path2D();
  traceSmooth(core, blob(s.x, s.y, S * 0.32, r, 14, 0.45));
  for (let i = 0; i < 4; i++) {
    const a = r() * TAU;
    const d = S * 0.15 * r();
    traceSmooth(core, blob(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, S * (0.12 + r() * 0.16), r, 10, 0.5));
  }
  ctx.fill(core);
  // arms: tapered radial streaks ending in a droplet
  const arms = 8 + Math.floor(r() * 12 * (0.5 + spread));
  for (let i = 0; i < arms; i++) {
    const a = r() * TAU;
    const L = S * (0.35 + r() ** 1.6 * 1.1 * (0.6 + spread));
    const w = S * (0.025 + r() * 0.07);
    const x0 = s.x + Math.cos(a) * S * 0.2;
    const y0 = s.y + Math.sin(a) * S * 0.2;
    const bend = (r() - 0.5) * 0.25;
    const ex = s.x + Math.cos(a + bend) * L;
    const ey = s.y + Math.sin(a + bend) * L;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    ctx.beginPath();
    ctx.moveTo(x0 + nx * w * 1.6, y0 + ny * w * 1.6);
    ctx.quadraticCurveTo((x0 + ex) / 2 + nx * w * 0.5, (y0 + ey) / 2 + ny * w * 0.5, ex + nx * w * 0.25, ey + ny * w * 0.25);
    ctx.lineTo(ex - nx * w * 0.25, ey - ny * w * 0.25);
    ctx.quadraticCurveTo((x0 + ex) / 2 - nx * w * 0.5, (y0 + ey) / 2 - ny * w * 0.5, x0 - nx * w * 1.6, y0 - ny * w * 1.6);
    ctx.closePath();
    ctx.fill();
    // terminal droplet slightly detached
    if (r() < 0.8) {
      const dd = L + w * (1 + r() * 2.5);
      const dr = w * (0.9 + r() * 1.1);
      ctx.beginPath();
      ctx.ellipse(s.x + Math.cos(a + bend) * dd, s.y + Math.sin(a + bend) * dd, dr * 1.25, dr, a + bend, 0, TAU);
      ctx.fill();
    }
    // drops along the arm
    if (r() < 0.4) {
      const t = 0.5 + r() * 0.4;
      ctx.beginPath();
      ctx.arc(x0 + (ex - x0) * t + nx * w * (r() - 0.5) * 4, y0 + (ey - y0) * t + ny * w * (r() - 0.5) * 4, w * (0.5 + r() * 0.6), 0, TAU);
      ctx.fill();
    }
  }
}

/** Crisp satellite droplets and mist around a splat (drawn after the goo pass). */
function splatSpray(path: Path2D, s: Splat, r: Rand, spread: number, u: number) {
  const S = s.size;
  const n = Math.round((30 + 90 * spread) * (0.4 + S / (400 * u)));
  for (let i = 0; i < n; i++) {
    const a = r() * TAU;
    const d = S * (0.45 + r() ** 0.8 * 1.6 * (0.5 + spread));
    const rad = Math.max(0.6 * u, S * 0.03 * r() ** 2.2 * (1.4 - d / (S * 2.6)));
    const x = s.x + Math.cos(a) * d;
    const y = s.y + Math.sin(a) * d;
    if (r() < 0.3) {
      // elongated drop pointing away from the center
      path.moveTo(x + Math.cos(a) * rad * 2.2, y + Math.sin(a) * rad * 2.2);
      path.ellipse(x, y, rad * 2.2, rad * 0.8, a, 0, TAU);
    } else {
      path.moveTo(x + rad, y);
      path.arc(x, y, rad, 0, TAU);
    }
  }
}

function placeSplats(W: number, H: number, n: number, size: number, placement: string, r: Rand): Splat[] {
  const out: Splat[] = [];
  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    if (placement === 'corners') {
      const k = i % 4;
      x = (k % 2 ? W : 0) + (k % 2 ? -1 : 1) * r() * W * 0.18;
      y = (k < 2 ? 0 : H) + (k < 2 ? 1 : -1) * r() * H * 0.2;
    } else if (placement === 'center') {
      x = W * (0.5 + (r() - 0.5) * 0.35);
      y = H * (0.5 + (r() - 0.5) * 0.35);
    } else if (placement === 'edges') {
      const side = i % 4;
      const t = r();
      x = side === 0 ? r() * W * 0.08 : side === 1 ? W - r() * W * 0.08 : t * W;
      y = side === 2 ? r() * H * 0.08 : side === 3 ? H - r() * H * 0.08 : t * H;
    } else {
      x = W * (0.08 + r() * 0.84);
      y = H * (0.08 + r() * 0.84);
    }
    out.push({ x, y, size: size * (0.55 + r() * 0.7) * (i === 0 ? 1.25 : 1) });
  }
  return out;
}

const PLACEMENT: [string, string][] = [
  ['scattered', 'Scattered'],
  ['corners', 'Corners'],
  ['edges', 'Edges'],
  ['center', 'Center'],
];

/* ------------------------------------------------------------------ */
/* ink-splatter                                                        */
/* ------------------------------------------------------------------ */

const inkSplatter = defineAsset(
  {
    id: 'ink-splatter',
    name: 'Ink Splatter',
    category: 'Splatter & Ink',
    tags: ['ink', 'splatter', 'splash', 'blood', 'paint', 'grunge', 'drops'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('count', 'Splats', 1, 14, 4),
      P.num('size', 'Size', 40, 700, 230, { unit: 'px' }),
      P.pct('spread', 'Spray', 0.6),
      P.select('placement', 'Placement', PLACEMENT, 'scattered'),
      P.seed(107),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 107));
      const color = str(p, 'color', '#0b0b0b');
      const spread = num(p, 'spread', 0.6);
      const splats = placeSplats(W, H, Math.round(num(p, 'count', 4)), num(p, 'size', 230) * u, str(p, 'placement', 'scattered'), r);
      const avg = splats.reduce((a, s) => a + s.size, 0) / Math.max(1, splats.length);
      const body = gooShape(
        W,
        H,
        color,
        Math.max(2 * u, avg * 0.022),
        (ctx) => {
          for (const s of splats) splatBody(ctx, s, r, spread);
        },
        { lo: 0.46, hi: 0.54 },
      );
      const [c, ctx] = newCanvas(W, H);
      ctx.drawImage(body, 0, 0);
      const spray = new Path2D();
      for (const s of splats) splatSpray(spray, s, r, spread, u);
      ctx.fillStyle = color;
      ctx.fill(spray);
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* paint-splatter                                                      */
/* ------------------------------------------------------------------ */

function drips(ctx: CanvasRenderingContext2D, s: Splat, r: Rand, amount: number, H: number) {
  const n = Math.round(amount * (2 + r() * 5));
  for (let i = 0; i < n; i++) {
    const x = s.x + (r() - 0.5) * s.size * 0.6;
    const y0 = s.y + s.size * (0.05 + r() * 0.2);
    const len = Math.min(H - y0, s.size * (0.4 + r() ** 1.5 * 2.2));
    const w = s.size * (0.025 + r() * 0.04);
    ctx.beginPath();
    ctx.moveTo(x - w, y0);
    ctx.lineTo(x - w * 0.7, y0 + len);
    ctx.lineTo(x + w * 0.7, y0 + len);
    ctx.lineTo(x + w, y0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y0 + len, w * 1.25, 0, TAU);
    ctx.fill();
  }
}

const paintSplatter = defineAsset(
  {
    id: 'paint-splatter',
    name: 'Paint Splatter',
    category: 'Splatter & Ink',
    tags: ['paint', 'splatter', 'colorful', 'graffiti', 'splash', 'drips', 'pop'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color1', 'Color 1', '#ff2e63'),
      P.color('color2', 'Color 2', '#08d9d6'),
      P.color('color3', 'Color 3', '#ffd31d'),
      P.num('count', 'Splats', 1, 14, 5),
      P.num('size', 'Size', 40, 700, 200, { unit: 'px' }),
      P.pct('spread', 'Spray', 0.5),
      P.pct('drips', 'Drips', 0.5),
      P.select('placement', 'Placement', PLACEMENT, 'scattered'),
      P.seed(109),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 109));
      const cols = [str(p, 'color1', '#ff2e63'), str(p, 'color2', '#08d9d6'), str(p, 'color3', '#ffd31d')];
      const spread = num(p, 'spread', 0.5);
      const dripAmt = num(p, 'drips', 0.5);
      const all = placeSplats(W, H, Math.round(num(p, 'count', 5)), num(p, 'size', 200) * u, str(p, 'placement', 'scattered'), r);
      const [c, ctx] = newCanvas(W, H);
      cols.forEach((col, k) => {
        const mine = all.filter((_, i) => i % 3 === k);
        if (!mine.length) return;
        const avg = mine.reduce((a, s) => a + s.size, 0) / mine.length;
        const body = gooShape(
          W,
          H,
          col,
          Math.max(2 * u, avg * 0.022),
          (g) => {
            for (const s of mine) {
              splatBody(g, s, r, spread);
              if (dripAmt > 0) drips(g, s, r, dripAmt, H);
            }
          },
          { lo: 0.46, hi: 0.54, maxPx: 1_600_000 },
        );
        ctx.drawImage(body, 0, 0);
        const spray = new Path2D();
        for (const s of mine) splatSpray(spray, s, r, spread * 0.8, u);
        ctx.fillStyle = col;
        ctx.fill(spray);
      });
      // wet gloss highlights on the paint
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.filter = `blur(${Math.max(1, 3 * u)}px)`;
      ctx.translate(-3 * u, -3 * u);
      ctx.globalAlpha = 0.18;
      ctx.drawImage(c, 0, 0);
      ctx.restore();
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* brush-strokes                                                       */
/* ------------------------------------------------------------------ */

/** One dry-brush stroke along a centerline: overlapping bristle polylines with dry gaps. */
function dryStroke(ctx: CanvasRenderingContext2D, center: Pt[], width: number, color: string, dryness: number, u: number, r: Rand, seed: number) {
  const pts = resample(center, Math.max(2, 3 * u));
  if (pts.length < 3) return;
  const fr = arcFractions(pts);
  const n = createNoise2D(seed);
  const normals = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: -dy / L, y: dx / L };
  });
  const bristles = Math.max(16, Math.round(width / (1.2 * u)));
  const BK = 4;
  const paths = Array.from({ length: BK }, () => new Path2D());
  // the stroke wanders slightly in width along its length (pressure)
  const press = (f: number) => 0.82 + 0.18 * n(f * 3.1, 9.7) - 0.3 * Math.max(0, f - 0.7) / 0.3;
  for (let b = 0; b < bristles; b++) {
    const off = ((b + r()) / bristles - 0.5) * width;
    const edge = Math.abs(off) / (width / 2); // 0 center → 1 edge
    const start = r() * (0.01 + edge * edge * 0.12);
    const end = 1 - r() * (0.03 + edge * edge * 0.3) * (0.5 + dryness);
    const path = paths[Math.min(BK - 1, Math.floor(r() * BK))];
    let pen = false;
    const salt = b * 7.13;
    for (let i = 0; i < pts.length; i++) {
      const f = fr[i];
      const env = press(f);
      if (f < start || f > end || edge > env + 0.02) {
        pen = false;
        continue;
      }
      // dry gaps: streaky noise (stretched along the stroke), stronger near edges/end
      const g = n(f * 14 + salt * 0.01, b * 0.21) * 0.5 + 0.5;
      const thr = dryness * (0.08 + edge * 0.55 + f * f * 0.45);
      if (g < thr) {
        pen = false;
        continue;
      }
      const x = pts[i].x + normals[i].x * off;
      const y = pts[i].y + normals[i].y * off;
      if (!pen) path.moveTo(x, y);
      else path.lineTo(x, y);
      pen = true;
    }
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const lw = width / bristles;
  for (let k = 0; k < BK; k++) {
    ctx.strokeStyle = rgba(color, 0.75 + k * 0.08);
    ctx.lineWidth = Math.max(0.8, lw * (1.6 + k * 0.5));
    ctx.stroke(paths[k]);
  }
  ctx.restore();
}

const brushStrokes = defineAsset(
  {
    id: 'brush-strokes',
    name: 'Brush Strokes',
    category: 'Splatter & Ink',
    tags: ['brush', 'strokes', 'dry brush', 'paint', 'grunge', 'ink', 'swipe'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('count', 'Strokes', 1, 10, 3),
      P.num('thickness', 'Thickness', 20, 500, 150, { unit: 'px' }),
      P.pct('dryness', 'Dryness', 0.5),
      P.angle('angle', 'Angle', 8),
      P.pct('curve', 'Curvature', 0.35),
      P.seed(113),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 113);
      const r = makeRand(seed);
      const color = str(p, 'color', '#0b0b0b');
      const n = Math.max(1, Math.round(num(p, 'count', 3)));
      const th = num(p, 'thickness', 150) * u;
      const dry = num(p, 'dryness', 0.5);
      const ang = (-num(p, 'angle', 8) * Math.PI) / 180;
      const curve = num(p, 'curve', 0.35);
      const [c, ctx] = newCanvas(W, H);
      const D = Math.hypot(W, H);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const cx = W / 2 + (r() - 0.5) * W * 0.2;
        const cy = H * (0.15 + 0.7 * t) + (r() - 0.5) * H * 0.1;
        const a = ang + (r() - 0.5) * 0.25;
        const len = D * (0.35 + r() * 0.4);
        const ctrl: Pt[] = [];
        for (let i = 0; i <= 4; i++) {
          const s = (i / 4 - 0.5) * len;
          const bow = Math.sin((i / 4) * Math.PI) * curve * len * 0.12 * (r() < 0.5 ? 1 : -1) * 0.5 + (r() - 0.5) * curve * th * 0.6;
          ctrl.push({ x: cx + Math.cos(a) * s - Math.sin(a) * bow, y: cy + Math.sin(a) * s + Math.cos(a) * bow });
        }
        dryStroke(ctx, catmullRom(ctrl, 12), th * (0.7 + r() * 0.5), color, dry, u, r, seed + k * 31);
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* ink-drips                                                           */
/* ------------------------------------------------------------------ */

const inkDrips = defineAsset(
  {
    id: 'ink-drips',
    name: 'Ink Drips',
    category: 'Splatter & Ink',
    tags: ['drips', 'dripping', 'ink', 'paint', 'slime', 'blood', 'horror', 'melting'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('count', 'Drips', 3, 120, 34),
      P.num('length', 'Length', 0.05, 1, 0.42, { step: 0.01, unit: '×' }),
      P.num('width', 'Drip width', 2, 60, 16, { unit: 'px' }),
      P.num('edge', 'Top band', 0, 300, 60, { unit: 'px' }),
      P.bool('gloss', 'Wet highlight', true),
      P.seed(127),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 127));
      const color = str(p, 'color', '#0b0b0b');
      const n = Math.round(num(p, 'count', 34));
      const maxLen = H * num(p, 'length', 0.42);
      const dw = num(p, 'width', 16) * u;
      const edge = num(p, 'edge', 60) * u;
      const dripsList: { x: number; w: number; len: number }[] = [];
      for (let i = 0; i < n; i++) {
        const x = ((i + r()) / n) * W;
        const w = dw * (0.4 + r() * 1.1);
        const len = edge + maxLen * (0.08 + r() ** 1.8 * 0.92);
        dripsList.push({ x, w, len });
      }
      const body = gooShape(W, H, color, 6 * u, (g) => {
        // wavy top band
        g.fillRect(-10, -10, W + 20, edge + 10);
        const bumps = Math.ceil(W / (40 * u));
        for (let i = 0; i <= bumps; i++) {
          const x = (i / bumps) * W;
          g.beginPath();
          g.ellipse(x, edge, (20 + r() * 26) * u, (6 + r() * 18) * u, 0, 0, TAU);
          g.fill();
        }
        for (const d of dripsList) {
          const top = edge * 0.5;
          const neck = d.len - d.w * 1.4;
          g.beginPath();
          g.moveTo(d.x - d.w * 0.9, top);
          g.bezierCurveTo(d.x - d.w * 0.55, top + (neck - top) * 0.3, d.x - d.w * 0.4, neck * 0.9, d.x - d.w * 0.42, neck);
          g.lineTo(d.x + d.w * 0.42, neck);
          g.bezierCurveTo(d.x + d.w * 0.4, neck * 0.9, d.x + d.w * 0.55, top + (neck - top) * 0.3, d.x + d.w * 0.9, top);
          g.closePath();
          g.fill();
          // bulb
          g.beginPath();
          g.ellipse(d.x, d.len - d.w * 0.7, d.w * 0.62, d.w * 0.8, 0, 0, TAU);
          g.fill();
          // detached falling drop
          if (r() < 0.22) {
            g.beginPath();
            g.ellipse(d.x, d.len + d.w * (2 + r() * 4), d.w * 0.38, d.w * 0.52, 0, 0, TAU);
            g.fill();
          }
        }
      });
      const [c, ctx] = newCanvas(W, H);
      ctx.drawImage(body, 0, 0);
      if (p.gloss !== false) {
        // thin specular streak on each drip and the band
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.strokeStyle = rgba('#ffffff', 0.22);
        ctx.lineCap = 'round';
        for (const d of dripsList) {
          if (d.w < 4 * u) continue;
          ctx.lineWidth = Math.max(0.8, d.w * 0.14);
          ctx.beginPath();
          ctx.moveTo(d.x - d.w * 0.18, edge + d.w);
          ctx.lineTo(d.x - d.w * 0.2, d.len - d.w * 1.6);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(d.x - d.w * 0.22, d.len - d.w * 0.95, d.w * 0.12, 0, TAU);
          ctx.fillStyle = rgba('#ffffff', 0.35);
          ctx.fill();
        }
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'paper' },
);

export const splatterAssets: AssetDef[] = [inkSplatter, paintSplatter, brushStrokes, inkDrips];
