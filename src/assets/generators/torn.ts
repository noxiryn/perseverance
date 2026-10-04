/**
 * torn-border: an irregular torn / burnt black frame (the "Birdcage" gothic poster look).
 *
 * The frame edge is an implicit curve: a pixel belongs to the frame when its depth from the
 * canvas edge (rounded-box distance) is smaller than a noisy threshold E(x, y). E is built from
 * large waves, mid-size tears, sharp ridged notches and a few deep bites (computed on a coarse
 * grid), plus fine fibrous detail evaluated per pixel only inside the thin band around the edge.
 * Because E varies in 2D, paper islands inside the black and black flecks on the paper appear
 * naturally near the tear. The black is textured with worn print scuffs, scratches and dust.
 */
import { blob } from '../lib/geom';
import { grainField, simplex } from '../lib/noise';
import { P, defineAsset } from '../lib/params';
import { sampleField } from '../lib/raster';
import { drawScratches } from '../lib/surface';
import { TAU, makeRand, newCanvas, num, rgbOf, rgba, shade, smoothstep, str, tracePoly, unitOf } from '../lib/util';

/** Depth of (x, y) from the canvas border, with rounded corners of radius rc. Pure. */
export function borderDepth(x: number, y: number, W: number, H: number, rc: number): number {
  const dx = x < W - x ? x : W - x;
  const dy = y < H - y ? y : H - y;
  if (dx < rc && dy < rc) {
    const ax = rc - dx;
    const ay = rc - dy;
    return rc - Math.sqrt(ax * ax + ay * ay);
  }
  return dx < dy ? dx : dy;
}

/** Point on the border at perimeter position s (0..1) with its inward normal. Pure. */
export function perimeterPoint(s: number, W: number, H: number): { x: number; y: number; nx: number; ny: number } {
  const P2 = 2 * (W + H);
  let d = (((s % 1) + 1) % 1) * P2;
  if (d < W) return { x: d, y: 0, nx: 0, ny: 1 };
  d -= W;
  if (d < H) return { x: W, y: d, nx: -1, ny: 0 };
  d -= H;
  if (d < W) return { x: W - d, y: H, nx: 0, ny: -1 };
  d -= W;
  return { x: 0, y: H - d, nx: 1, ny: 0 };
}

export const tornBorder = defineAsset(
  {
    id: 'torn-border',
    name: 'Torn Border',
    category: 'Borders & Frames',
    tags: ['torn', 'burnt', 'border', 'frame', 'gothic', 'grunge', 'edges', 'birdcage', 'poster'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    defaultOpacity: 1,
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('thickness', 'Thickness', 10, 260, 64, { unit: 'px' }),
      P.pct('roughness', 'Roughness', 0.65),
      P.pct('burn', 'Burnt edge', 0.5),
      P.pct('flecks', 'Flecks', 0.6),
      P.pct('texture', 'Scuffs', 0.55),
      P.seed(11),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 11);
      const r = makeRand(seed);
      const color = rgbOf(str(p, 'color', '#0b0b0b'));
      const T = Math.max(2, num(p, 'thickness', 64) * u);
      const rough = num(p, 'roughness', 0.65);
      const burn = num(p, 'burn', 0.45);
      const fleckAmt = num(p, 'flecks', 0.6);
      const texture = num(p, 'texture', 0.55);
      const rc = Math.min(T * 1.7, Math.min(W, H) * 0.2);

      /* ---------- coarse threshold grid ---------- */
      const cell = Math.max(1, Math.min(4, Math.round(Math.min(W, H) / 220)));
      const gw = Math.ceil(W / cell) + 2;
      const gh = Math.ceil(H / cell) + 2;
      const E = new Float32Array(gw * gh);
      const nBig = simplex(seed + 1);
      const nMid = simplex(seed + 2);
      const nSmall = simplex(seed + 3);
      const nWear = simplex(seed + 4);
      const nFine = simplex(seed + 5);
      const nFib = simplex(seed + 6);
      const kBig = 1 / (300 * u);
      const kMid = 1 / (80 * u);
      const kSmall = 1 / (26 * u);
      const reach = T * (1 + 1.4 * rough) + 4 * u;
      // deep bites into the paper and a few retreats
      const chunks = Array.from({ length: Math.round(4 + 12 * rough) }, () => {
        const q = perimeterPoint(r(), W, H);
        const w = (14 + r() * 70) * u;
        return {
          x: q.x + q.nx * T,
          y: q.y + q.ny * T,
          w2: 1 / (w * w),
          h: T * (r() < 0.7 ? 0.4 + r() * 1.1 : -(0.3 + r() * 0.35)) * (0.4 + rough * 0.8),
          sharp: r() < 0.55,
        };
      });
      for (let j = 0; j < gh; j++) {
        const y = (j - 0.5) * cell;
        for (let i = 0; i < gw; i++) {
          const x = (i - 0.5) * cell;
          const d = borderDepth(Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y)), W, H, rc);
          if (d > reach * 1.6) {
            E[j * gw + i] = T;
            continue;
          }
          const big = nBig(x * kBig, y * kBig) + 0.5 * nBig(x * kBig * 2.1 + 9.1, y * kBig * 2.1 - 3.3);
          // domain-warped mid noise → irregular chunky tears
          const wx = x * kMid + 0.9 * nSmall(x * kMid * 0.5 + 3.3, y * kMid * 0.5);
          const wy = y * kMid + 0.9 * nSmall(x * kMid * 0.5 - 8.1, y * kMid * 0.5 + 5.2);
          const mid = nMid(wx, wy) + 0.5 * nMid(wx * 2.2 - 5.7, wy * 2.2 + 1.9);
          // ridged → sharp V-shaped notches instead of soft waves
          const small = 0.5 - Math.abs(nSmall(x * kSmall, y * kSmall)) - 0.35 * Math.abs(nSmall(x * kSmall * 2.3 + 4.4, y * kSmall * 2.3));
          let e = 1 + rough * (0.5 * big + 0.34 * mid + 0.34 * small);
          let bite = 0;
          for (const c of chunks) {
            const dx = x - c.x;
            const dy = y - c.y;
            const q = (dx * dx + dy * dy) * c.w2;
            if (q > 9) continue;
            bite += c.h * (c.sharp ? Math.max(0, 1 - Math.sqrt(q)) ** 1.5 : Math.exp(-q * 1.6));
          }
          e = T * Math.max(0.15, e) + bite;
          E[j * gw + i] = e;
        }
      }

      /* ---------- per-pixel frame alpha (grainy burnt dissolve) and worn print ---------- */
      const [c, ctx] = newCanvas(W, H);
      const img = ctx.createImageData(W, H);
      const px = img.data;
      const fineAmp = T * (0.025 + 0.05 * rough) + 1.4 * u;
      const kF1 = 1 / (6 * u);
      const kF2 = 1 / (2.6 * u);
      // width of the speckled transition between black and paper
      const dissolve = T * (0.05 + 0.62 * burn) + 1.5 * u;
      const kWear = 1 / (55 * u);
      const kWear2 = 1 / (13 * u);
      const kStreak = 1 / (160 * u);
      const light = shade(color, 0.3);
      const pale = shade(color, 0.62);
      const g1 = grainField(seed, 256, 1);
      const g2 = grainField(seed + 1, 256, 3);
      const gs = Math.max(1, Math.round(u * 1.4)); // grain clump scale in px
      const band = fineAmp + dissolve * 1.1 + 2;
      const limit = reach * 1.6 + band;
      for (let y = 0; y < H; y++) {
        const gy = (y + 0.5) / cell + 0.5;
        const dyEdge = y + 0.5 < H - y - 0.5 ? y + 0.5 : H - y - 0.5;
        const gRow = ((y / gs) & 255) * 256;
        const gRow2 = (((y / gs) | 0) & 255) * 256;
        for (let x = 0; x < W; x++) {
          const dxEdge = x + 0.5 < W - x - 0.5 ? x + 0.5 : W - x - 0.5;
          if (dxEdge > limit && dyEdge > limit) {
            // interior of this row is clean paper: jump to the right band
            const jump = W - Math.ceil(limit) - 1;
            if (x < jump) x = jump;
            continue;
          }
          const depth = borderDepth(x + 0.5, y + 0.5, W, H, rc);
          const e = sampleField(E, gw, gh, (x + 0.5) / cell + 0.5, gy);
          let v = depth - e;
          if (v > band) continue; // clean paper
          const grain = g1[gRow + ((x / gs) & 255)];
          const grain2 = g2[gRow2 + (((x / gs) | 0) & 255)];
          let a = 1;
          if (v > -band) {
            // fibrous tear detail + speckled dissolve, only near the edge
            v -= fineAmp * (0.9 - 1.3 * Math.abs(nFine(x * kF1, y * kF1)) + 0.45 * nFine(x * kF2 + 17.3, y * kF2 - 4.1));
            const t = 0.5 - v / dissolve + (grain - 0.5) * 1.25 + (grain2 - 0.5) * 0.9;
            a = t <= 0.44 ? 0 : t >= 0.56 ? 1 : (t - 0.44) / 0.12;
            if (a <= 0) continue;
          }
          const o = (y * W + x) * 4;
          // worn print inside the black: blotchy lighter scuffs, pale streaks, grain and specks
          let k = 0;
          if (texture > 0) {
            const wv = nWear(x * kWear, y * kWear) * 0.8 + nWear(x * kWear2 + 7.7, y * kWear2 + 3.1) * 0.2;
            const worn = smoothstep(0.05, 0.95, wv);
            const outer = 1 - smoothstep(0, T * 0.9, depth);
            const streak = smoothstep(0.2, 0.9, nFib(x * kStreak, y * kStreak)) * outer;
            const speck = grain > 0.93 && grain2 > 0.55 ? 1 : 0;
            k = texture * (worn * (0.15 + grain * 0.85) * 0.38 + grain * 0.14 + streak * (0.25 + grain * 0.5) + speck * 0.75 * (0.3 + worn));
            if (k > 1) k = 1;
          }
          const tc = k > 0.6 ? pale : light;
          const kk = k > 0.6 ? (k - 0.6) / 0.4 : k / 0.6;
          const base = k > 0.6 ? light : color;
          px[o] = base.r + (tc.r - base.r) * kk;
          px[o + 1] = base.g + (tc.g - base.g) * kk;
          px[o + 2] = base.b + (tc.b - base.b) * kk;
          px[o + 3] = a * 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      /* ---------- scratches and dust inside the black ---------- */
      if (texture > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const per = (2 * (W + H) * T) / (u * u * 1e5);
        drawScratches(ctx, W, H, u, '#d8d8d8', r, 26 * texture * per, { angle: 0, angleJitter: 0.22, alpha: 0.32, maxLen: 120, width: 0.6 });
        drawScratches(ctx, W, H, u, '#d8d8d8', r, 12 * texture * per, { angle: Math.PI / 2, angleJitter: 0.25, alpha: 0.28, maxLen: 80, width: 0.55 });
        const dust = new Path2D();
        const nd = Math.round(60 * texture * per);
        for (let i = 0; i < nd; i++) {
          const q = perimeterPoint(r(), W, H);
          const d = r() * T * 1.1;
          const x = q.x + q.nx * d + (r() - 0.5) * 2 * u;
          const y = q.y + q.ny * d;
          const rad = u * (0.35 + r() ** 3 * 2.2);
          dust.moveTo(x + rad, y);
          dust.ellipse(x, y, rad, rad * (0.5 + r() * 0.5), r() * Math.PI, 0, TAU);
        }
        ctx.fillStyle = rgba('#e6e6e6', 0.55);
        ctx.fill(dust);
        ctx.restore();
      }

      /* ---------- flecks and fibers on the paper just inside the tear ---------- */
      const edgeAt = (s: number): { x: number; y: number; nx: number; ny: number } | null => {
        const q = perimeterPoint(s, W, H);
        // march inwards until we leave the frame (coarse threshold)
        let d = T * 0.3;
        while (d < reach * 1.8) {
          const x = q.x + q.nx * d;
          const y = q.y + q.ny * d;
          if (x < 0 || y < 0 || x > W || y > H) return null;
          const depth = borderDepth(x, y, W, H, rc);
          if (depth > sampleField(E, gw, gh, x / cell + 0.5, y / cell + 0.5)) return { x, y, nx: q.nx, ny: q.ny };
          d += Math.max(1, 1.5 * u);
        }
        return null;
      };
      const perim = (2 * (W + H)) / u / 1000;
      if (fleckAmt > 0) {
        const fl = new Path2D();
        const n = Math.round(perim * 330 * fleckAmt);
        // flecks cluster: use a slow noise along the perimeter as density
        for (let i = 0; i < n; i++) {
          const s = r();
          const dens = 0.5 + 0.5 * nBig(Math.cos(s * TAU) * 6, Math.sin(s * TAU) * 6);
          if (r() > dens * 1.2) continue;
          const e = edgeAt(s);
          if (!e) continue;
          const d = -Math.log(1 - r() * 0.993) * T * 0.16 + 0.8 * u;
          const tj = (r() - 0.5) * 8 * u;
          const x = e.x + e.nx * d - e.ny * tj;
          const y = e.y + e.ny * d + e.nx * tj;
          const big = r() < 0.06;
          const size = u * (big ? 2.5 + r() * 4 : 0.4 + r() ** 2.5 * 2.6) * (1 - 0.55 * smoothstep(0, T * 0.8, d));
          tracePoly(fl, blob(x, y, size, r, r.int(5, 8), big ? 0.6 : 0.8));
        }
        ctx.fillStyle = rgba(color, 0.92);
        ctx.fill(fl);
      }
      // paper fibers crossing the torn edge
      {
        const fib = new Path2D();
        const n = Math.round(perim * 160 * (0.3 + rough));
        for (let i = 0; i < n; i++) {
          const e = edgeAt(r());
          if (!e) continue;
          const len = (2.5 + r() * 9) * u;
          const ang = Math.atan2(e.ny, e.nx) + (r() - 0.5) * 2.2;
          const sx = e.x - e.nx * 2 * u;
          const sy = e.y - e.ny * 2 * u;
          const ex = sx + Math.cos(ang) * len;
          const ey = sy + Math.sin(ang) * len;
          fib.moveTo(sx, sy);
          fib.quadraticCurveTo((sx + ex) / 2 + (r() - 0.5) * len * 0.6, (sy + ey) / 2 + (r() - 0.5) * len * 0.6, ex, ey);
        }
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(color, 0.6);
        ctx.lineWidth = Math.max(0.45, 0.55 * u);
        ctx.stroke(fib);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'paper' },
);
