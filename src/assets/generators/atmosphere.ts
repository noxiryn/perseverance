/**
 * Smoke & Atmosphere: smoke, fog, clouds.
 */
import type { AssetDef } from '../../registry';
import { createNoise2D } from '../../core/noise';
import { fieldDims, fillGrain, noiseField, paintField } from '../lib/field';
import { P, defineAsset } from '../lib/params';
import { drawUpscaled, mixRGB, newCanvas, num, rgbOf, shade, smoothstep, str, unitOf } from '../lib/util';

/** Coverage mask for a side placement, nx/ny normalized coordinates (0..1), wobble ~[-1,1]. */
export function sideMask(side: string, nx: number, ny: number, coverage: number, wobble: number, aspect: number): number {
  const w = wobble * 0.22;
  switch (side) {
    case 'left':
      return smoothstep(0.5 - coverage * 0.45, 1.02 - coverage * 0.32, 1 - nx + w) * (0.55 + 0.45 * smoothstep(-0.2, 0.75, ny + w));
    case 'right':
      return smoothstep(0.5 - coverage * 0.45, 1.02 - coverage * 0.32, nx + w) * (0.55 + 0.45 * smoothstep(-0.2, 0.75, ny + w));
    case 'bottom':
      return smoothstep(0.55 - coverage * 0.5, 1.05 - coverage * 0.25, ny + w);
    case 'center': {
      const dx = (nx - 0.5) * aspect;
      const dy = ny - 0.55;
      const d = Math.sqrt(dx * dx + dy * dy) + w * 0.6;
      return 1 - smoothstep(0.1 + coverage * 0.3, 0.45 + coverage * 0.55, d);
    }
    default:
      return 0.35 + 0.65 * coverage + w * 0.5;
  }
}

const SIDE_OPTS: [string, string][] = [
  ['right', 'Right'],
  ['left', 'Left'],
  ['center', 'Center'],
  ['bottom', 'Bottom'],
  ['full', 'Full'],
];

/* ------------------------------------------------------------------ */
/* smoke                                                               */
/* ------------------------------------------------------------------ */

const smoke = defineAsset(
  {
    id: 'smoke',
    name: 'Smoke',
    category: 'Smoke & Atmosphere',
    tags: ['smoke', 'red', 'billowing', 'crimson', 'fire', 'mist', 'volumetric'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#c4141c'),
      P.pct('density', 'Density', 0.75),
      P.num('scale', 'Scale', 0.3, 3, 1, { step: 0.05, unit: '×' }),
      P.pct('turbulence', 'Turbulence', 0.6),
      P.pct('coverage', 'Coverage', 0.6),
      P.select('side', 'Placement', SIDE_OPTS, 'right'),
      P.pct('glow', 'Lit edges', 0.6),
      P.seed(19),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 19);
      const color = rgbOf(str(p, 'color', '#c4141c'));
      const density = num(p, 'density', 0.75);
      const scale = Math.max(0.1, num(p, 'scale', 1));
      const turb = num(p, 'turbulence', 0.6);
      const coverage = num(p, 'coverage', 0.6);
      const side = str(p, 'side', 'right');
      const glow = num(p, 'glow', 0.6);
      const { fw, fh, s } = fieldDims(W, H, 150_000);
      const up = s / u; // field px per unit
      const k = 2.4 / scale / 1000 / up; // noise units per field px
      const n0 = createNoise2D(seed);
      const n1 = createNoise2D(seed + 1);
      const n2 = createNoise2D(seed + 2);
      const n3 = createNoise2D(seed + 3);
      const fbm3 = (n: (x: number, y: number) => number, x: number, y: number) =>
        (n(x, y) + 0.5 * n(x * 2.03 + 11.1, y * 2.03 - 7.3) + 0.25 * n(x * 4.01 - 3.7, y * 4.01 + 5.9)) / 1.75;
      const dens = new Float32Array(fw * fh);
      const wisp = new Float32Array(fw * fh);
      const aspect = W / H;
      const warpA = 1.2 + turb * 2.6;
      for (let j = 0; j < fh; j++) {
        for (let i = 0; i < fw; i++) {
          const x = i * k;
          const y = j * k;
          // two-level domain warp (billows curl into each other)
          const qx = fbm3(n1, x, y);
          const qy = fbm3(n2, x + 5.2, y + 1.3);
          const rx = fbm3(n1, x + warpA * qx + 1.7, y + warpA * qy + 9.2);
          const ry = fbm3(n2, x + warpA * qx + 8.3, y + warpA * qy + 2.8);
          const wx = x + warpA * rx;
          const wy = y + warpA * ry;
          let f = 0;
          let amp = 1;
          let fr = 1;
          let norm = 0;
          for (let o = 0; o < 5; o++) {
            f += amp * n0(wx * fr + o * 13.7, wy * fr - o * 7.1);
            norm += amp;
            amp *= 0.52;
            fr *= 2.02;
          }
          f /= norm;
          const m = sideMask(side, i / fw, j / fh, coverage, qx, aspect);
          const base = smoothstep(-0.32, 0.55, f + (m - 0.5) * 0.9);
          const d = Math.max(0, Math.min(1, base * Math.min(1, m * 1.25)));
          const idx = j * fw + i;
          dens[idx] = d;
          wisp[idx] = n3(wx * 6, wy * 6);
        }
      }
      const core = shade(color, -0.6);
      const bright = shade(color, 0.32);
      const hot = mixRGB(shade(color, 0.55), { r: 255, g: 220, b: 200 }, 0.25);
      const Lx = -0.6;
      const Ly = -0.8;
      const img = paintField(fw, fh, (i, x, y, px, o) => {
        const d = dens[i];
        if (d <= 0.002) {
          px[o + 3] = 0;
          return;
        }
        const gx = dens[i + (x < fw - 1 ? 1 : 0)] - dens[i - (x > 0 ? 1 : 0)];
        const gy = dens[i + (y < fh - 1 ? fw : 0)] - dens[i - (y > 0 ? fw : 0)];
        const lit = Math.max(0, Math.min(1, 0.5 - (gx * Lx + gy * Ly) * 9));
        const rim = smoothstep(0.04, 0.22, d) * (1 - smoothstep(0.28, 0.62, d)) * glow;
        const t = Math.min(1, d * 1.1);
        let c = mixRGB(core, color, t);
        c = mixRGB(c, bright, lit * 0.55 * (0.4 + t));
        c = mixRGB(c, hot, rim * 0.5 * lit + rim * 0.15);
        const a = Math.min(1, Math.pow(d, 1.15) * (0.82 + 0.18 * wisp[i]) * density * 1.45);
        px[o] = c.r;
        px[o + 1] = c.g;
        px[o + 2] = c.b;
        px[o + 3] = a * 255;
      });
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, img, W, H);
      // fine particulate texture inside the smoke
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 0.18;
      ctx.globalCompositeOperation = 'overlay';
      fillGrain(ctx, W, H, seed, Math.max(1, 2.5 * u), 1.2);
      ctx.restore();
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* fog                                                                 */
/* ------------------------------------------------------------------ */

const fog = defineAsset(
  {
    id: 'fog',
    name: 'Fog',
    category: 'Smoke & Atmosphere',
    tags: ['fog', 'mist', 'haze', 'atmosphere', 'horror', 'ground fog'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#d9dee6'),
      P.pct('density', 'Density', 0.6),
      P.pct('height', 'Height', 0.5),
      P.num('scale', 'Scale', 0.3, 3, 1, { step: 0.05, unit: '×' }),
      P.select(
        'placement',
        'Placement',
        [
          ['ground', 'Ground'],
          ['top', 'Top'],
          ['full', 'Full'],
        ],
        'ground',
      ),
      P.seed(41),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 41);
      const color = rgbOf(str(p, 'color', '#d9dee6'));
      const density = num(p, 'density', 0.6);
      const height = num(p, 'height', 0.5);
      const scale = Math.max(0.1, num(p, 'scale', 1));
      const placement = str(p, 'placement', 'ground');
      const { fw, fh, s } = fieldDims(W, H, 70_000);
      const f = noiseField(fw, fh, s / u, { seed, freq: 2 / scale, octaves: 5, warp: 0.8, stretchX: 2.6 });
      const g = noiseField(fw, fh, s / u, { seed: seed + 1, freq: 6 / scale, octaves: 3, stretchX: 3 });
      const img = paintField(fw, fh, (i, _x, y, px, o) => {
        const ny = y / fh;
        let m = 1;
        if (placement === 'ground') m = smoothstep(1 - height - 0.15, 1 - height * 0.35, ny + f[i] * 0.12);
        else if (placement === 'top') m = 1 - smoothstep(height * 0.35, height + 0.15, ny - f[i] * 0.12);
        const v = smoothstep(-0.45, 0.6, f[i] + g[i] * 0.25);
        px[o] = color.r;
        px[o + 1] = color.g;
        px[o + 2] = color.b;
        px[o + 3] = Math.min(1, v * m * density * 1.3) * 255;
      });
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, img, W, H);
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* clouds                                                              */
/* ------------------------------------------------------------------ */

const clouds = defineAsset(
  {
    id: 'clouds',
    name: 'Clouds',
    category: 'Smoke & Atmosphere',
    tags: ['clouds', 'sky', 'cumulus', 'weather', 'heaven', 'background'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Light color', '#ffffff'),
      P.color('shadow', 'Shadow color', '#8e98ae'),
      P.pct('coverage', 'Coverage', 0.5),
      P.num('scale', 'Scale', 0.3, 3, 1, { step: 0.05, unit: '×' }),
      P.pct('softness', 'Softness', 0.4),
      P.select(
        'sky',
        'Sky',
        [
          ['none', 'Transparent'],
          ['day', 'Day'],
          ['sunset', 'Sunset'],
          ['night', 'Night'],
        ],
        'none',
      ),
      P.seed(43),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const seed = num(p, 'seed', 43);
      const light = rgbOf(str(p, 'color', '#ffffff'));
      const shadowC = rgbOf(str(p, 'shadow', '#8e98ae'));
      const coverage = num(p, 'coverage', 0.5);
      const scale = Math.max(0.1, num(p, 'scale', 1));
      const soft = num(p, 'softness', 0.4);
      const sky = str(p, 'sky', 'none');
      const { fw, fh, s } = fieldDims(W, H, 150_000);
      const up = s / u;
      const f = noiseField(fw, fh, up, { seed, freq: 2.2 / scale, octaves: 6, kind: 'billow', warp: 0.35, stretchX: 1.6 });
      const t0 = 0.35 - coverage * 0.75;
      const dens = new Float32Array(fw * fh);
      for (let i = 0; i < dens.length; i++) dens[i] = smoothstep(t0, t0 + 0.12 + soft * 0.35, f[i]);
      const img = paintField(fw, fh, (i, x, y, px, o) => {
        const d = dens[i];
        if (d <= 0.001) {
          px[o + 3] = 0;
          return;
        }
        // light from above: compare with density a few px above
        const up1 = dens[Math.max(0, y - 3) * fw + x];
        const lit = Math.max(0, Math.min(1, 0.65 + (d - up1) * 3.5));
        const c = mixRGB(shadowC, light, lit);
        px[o] = c.r;
        px[o + 1] = c.g;
        px[o + 2] = c.b;
        px[o + 3] = d * 255;
      });
      const [c, ctx] = newCanvas(W, H);
      if (sky !== 'none') {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        const stops: Record<string, string[]> = {
          day: ['#3d7fd6', '#8cc0f0', '#d8ecfb'],
          sunset: ['#2b2a5e', '#c2577a', '#f7b267'],
          night: ['#03060f', '#0d1630', '#1d2a4d'],
        };
        const st = stops[sky] ?? stops.day;
        st.forEach((col, i) => g.addColorStop(i / (st.length - 1), col));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      drawUpscaled(ctx, img, W, H);
      return c;
    },
  },
  { bg: 'mid' },
);

export const atmosphereAssets: AssetDef[] = [smoke, fog, clouds];
