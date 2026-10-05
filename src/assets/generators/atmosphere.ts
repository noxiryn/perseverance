/**
 * Smoke & Atmosphere: smoke, fog, clouds.
 *
 * All three are volumetric-looking density fields computed on a reduced grid (≈ 150–200k samples)
 * and up-scaled with smoothing — soft media hide the up-scaling and keep 1080p renders fast.
 *  - smoke: billow noise (puffs inside puffs) over a soft plume mass, gently warped, feathered
 *    towards the open side; each puff is lit by comparing it with a copy shifted towards the
 *    light (bright rims, dark creases), plus faint ridged wisps in the thin outer smoke.
 *  - fog: horizontally stretched, warped wisps layered in depth bands with soft falloff.
 *  - clouds: billowy fbm with a cauliflower edge, self-shadowed from above (lit tops, gray bases).
 */
import type { AssetDef } from '../../registry';
import { fieldDims, fillGrain } from '../lib/field';
import { blurField, fbm2, ridged2, simplex } from '../lib/noise';
import type { Noise2 } from '../lib/noise';
import { P, defineAsset } from '../lib/params';
import type { RGB } from '../lib/util';
import { clamp01, drawUpscaled, mixRGB, newCanvas, num, rgbOf, shade, smoothstep, str, unitOf } from '../lib/util';

/**
 * Coverage mask for a placement, nx/ny normalized coordinates (0..1), wobble ≈ [-1, 1]. Pure.
 * 'right'/'left' rise towards that side (and a little towards the bottom), 'center' is a soft
 * blob slightly below the middle, 'bottom' rises from the bottom edge, 'full' is uniform.
 */
export function sideMask(side: string, nx: number, ny: number, coverage: number, wobble: number, aspect: number): number {
  const w = wobble * 0.18;
  const c = clamp01(coverage);
  switch (side) {
    case 'left':
    case 'right': {
      const t = side === 'right' ? nx : 1 - nx;
      const edge = 1 - c * 0.85;
      return smoothstep(edge - 0.26, edge + 0.4, t + w) * (0.7 + 0.3 * smoothstep(0, 0.9, ny + w * 0.5));
    }
    case 'bottom': {
      const edge = 1 - c * 0.8;
      return smoothstep(edge - 0.15, edge + 0.3, ny + w);
    }
    case 'center': {
      const dx = (nx - 0.5) * aspect;
      const dy = (ny - 0.56) * 1.15;
      const d = Math.sqrt(dx * dx + dy * dy) + w * 0.7;
      return 1 - smoothstep(0.1 + c * 0.3, 0.42 + c * 0.6, d);
    }
    default:
      return 0.45 + 0.55 * c + w * 0.4;
  }
}

const SIDE_OPTS: [string, string][] = [
  ['right', 'Right'],
  ['left', 'Left'],
  ['center', 'Center'],
  ['bottom', 'Bottom'],
  ['full', 'Full'],
];

/** Light direction (unit, screen space pointing FROM the light) for a placement. */
function lightFor(side: string): { x: number; y: number } {
  switch (side) {
    case 'right':
      return { x: 0.8, y: 0.6 };
    case 'left':
      return { x: -0.8, y: 0.6 };
    default:
      return { x: 0.35, y: 0.94 };
  }
}

/** Overlay-blend a soft grain only inside existing pixels of ctx (keeps transparency intact). */
function grainInside(ctx: CanvasRenderingContext2D, W: number, H: number, seed: number, scale: number, alpha: number) {
  const [g, gctx] = newCanvas(W, H);
  fillGrain(gctx, W, H, seed, scale, 0.8);
  gctx.globalCompositeOperation = 'destination-in';
  gctx.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha;
  ctx.drawImage(g, 0, 0);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* smoke                                                               */
/* ------------------------------------------------------------------ */

const smoke = defineAsset(
  {
    id: 'smoke',
    name: 'Smoke',
    category: 'Smoke & Atmosphere',
    tags: ['smoke', 'red', 'billowing', 'crimson', 'fire', 'mist', 'volumetric', 'aura'],
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
      P.pct('wisps', 'Wisps', 0.5),
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
      const wisps = num(p, 'wisps', 0.5);
      const { fw, fh, s } = fieldDims(W, H, 125_000);
      const fu = s * u; // field px per length unit
      const k = 1 / ((520 * fu) / scale); // noise units per field px (billows ≈ 520 units)
      const nA = simplex(seed);
      const nB = simplex(seed + 1);
      const nC = simplex(seed + 2);
      const nD = simplex(seed + 3);
      // a gentle, LOW-frequency domain warp: strong or fast warps marble the density into
      // contour-like veins; real smoke billows only lean and curl a little
      // (its gradient must stay small: steep displacement folds the fine octaves into streaks)
      const warp = 0.05 + turb * 0.08;
      const aspect = W / H;
      const n = fw * fh;
      const dens = new Float32Array(n);
      const puffs = new Float32Array(n);
      const wisp = new Float32Array(n);
      for (let j = 0; j < fh; j++) {
        for (let i = 0; i < fw; i++) {
          const x = i * k;
          const y = j * k;
          const qx = nA(x * 0.55, y * 0.55);
          const qy = nA(x * 0.55 + 5.2, y * 0.55 + 1.3);
          const m = sideMask(side, i / fw, j / fh, coverage, qx * 1.5 + qy * 0.55, aspect);
          if (m < 0.012) continue; // nothing can show here (open side of the placement)
          const wx = x + warp * qx;
          const wy = y + warp * qy;
          // billow noise (sum of |noise|): rounded puffs inside puffs, separated by creases —
          // the cauliflower structure of thick smoke
          let pf = 0;
          let amp = 1;
          let norm = 0;
          let fq = 1.6;
          for (let oc = 0; oc < 4; oc++) {
            pf += amp * Math.abs(nD(wx * fq + oc * 19.19, wy * fq - oc * 7.37));
            norm += amp;
            amp *= 0.52;
            fq *= 2.03;
          }
          pf = Math.min(1, (pf / norm) * 1.55);
          // the large mass of the plume
          const mass = fbm2(nC, wx * 0.8, wy * 0.8, 3) * 0.5 + 0.5;
          const f = mass * 0.68 + pf * 0.32;
          // soft threshold + a wide falloff towards the open side: feathered, never a hard rim
          const d = smoothstep(0.36, 0.92, f + (m - 0.55) * 0.8) * smoothstep(0.02, 0.8, m);
          const idx = j * fw + i;
          dens[idx] = d;
          puffs[idx] = pf;
          if (wisps > 0 && d < 0.97 && m > 0.05) {
            // faint drifting strands in the thin outer smoke
            const rr = ridged2(nB, wx * 1.2 + qy * 0.5, wy * 1.2 - qx * 0.5, 2);
            wisp[idx] = smoothstep(0.6, 1, rr) * smoothstep(0.05, 0.4, m) * (1 - d) * (0.5 + 0.5 * pf);
          }
        }
      }
      // lighting: each puff is lit on the side facing the light — compare the puff field with a
      // copy shifted towards the light (it drops there → lit rim; it rises → shadowed crease);
      // the whole plume also gets a broad rim from the blurred density
      const soft = blurField(Float32Array.from(dens), fw, fh, Math.max(1, 6 * fu), 2);
      // puffs are lit from a softened copy: lighting the finest octaves looks embossed
      const puffL = blurField(Float32Array.from(puffs), fw, fh, Math.max(1, 1.6 * fu), 2);
      const L = lightFor(side);
      const offP = Math.max(1, 3.5 * fu);
      const pox = Math.round(-L.x * offP);
      const poy = Math.round(-L.y * offP);
      const offD = Math.max(1.5, 14 * fu);
      const dox = Math.round(-L.x * offD);
      const doy = Math.round(-L.y * offD);
      const deep = shade(color, -0.86);
      const dark = shade(color, -0.5);
      const mid = color;
      // brighter, more saturated versions of the color (no washing out to pink/white)
      const lit = { r: Math.min(255, color.r * 1.25 + 30), g: Math.min(255, color.g * 1.12 + 12), b: Math.min(255, color.b * 1.1 + 12) };
      const hot = { r: Math.min(255, color.r * 1.4 + 58), g: Math.min(255, color.g * 1.35 + 40), b: Math.min(255, color.b * 1.3 + 32) };
      const [lo, lctx] = newCanvas(fw, fh);
      const img = lctx.createImageData(fw, fh);
      const px = img.data;
      for (let j = 0; j < fh; j++) {
        const pj = Math.min(fh - 1, Math.max(0, j + poy)) * fw;
        const dj = Math.min(fh - 1, Math.max(0, j + doy)) * fw;
        for (let i = 0; i < fw; i++) {
          const idx = j * fw + i;
          const d = dens[idx];
          const wv = wisp[idx] * wisps;
          const o = idx * 4;
          if (d <= 0.003 && wv <= 0.01) continue;
          const pf = puffs[idx];
          const pl = puffL[idx];
          const pTow = puffL[pj + Math.min(fw - 1, Math.max(0, i + pox))];
          const dTow = soft[dj + Math.min(fw - 1, Math.max(0, i + dox))];
          const puffRim = clamp01((pl - pTow) * 5);
          const crease = clamp01((pTow - pl) * 3.5);
          const plumeRim = clamp01((soft[idx] - dTow) * 2.4);
          // body: thicker puffs scatter more light; creases between puffs sink to black-red
          const body = d * (0.35 + 0.65 * pf);
          let c: RGB = mixRGB(deep, dark, clamp01(body * 1.9));
          c = mixRGB(c, mid, clamp01((body - 0.28) * 1.7));
          c = mixRGB(c, deep, crease * 0.6 * d);
          // the thickest puffs glow (scattered light), the gaps between them stay dark
          c = mixRGB(c, lit, clamp01((pf - 0.5) * 1.6) * clamp01(d * 1.3) * glow);
          c = mixRGB(c, lit, clamp01((puffRim * 0.9 + plumeRim * 0.8) * glow * 1.3) * clamp01(d * 1.5));
          c = mixRGB(c, hot, clamp01((puffRim + plumeRim - 0.75) * 1.3 * glow) * d);
          if (wv > 0) c = mixRGB(c, dark, clamp01(wv * (1 - d)));
          const a = clamp01(Math.pow(d, 1.2) * (0.75 + 0.35 * pf) * density * 1.35 + wv * 0.22 * density);
          px[o] = c.r;
          px[o + 1] = c.g;
          px[o + 2] = c.b;
          px[o + 3] = a * 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, lo, W, H);
      grainInside(ctx, W, H, seed, Math.max(1, 1.6 * u), 0.12);
      // diffuse colored haze around the billows (scattered light), blurred at field resolution
      const [hz, hctx] = newCanvas(fw, fh);
      hctx.filter = `blur(${Math.max(1, 10 * fu)}px)`;
      hctx.drawImage(lo, 0, 0);
      hctx.filter = 'none';
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.globalAlpha = clamp01(0.6 * density + 0.1);
      drawUpscaled(ctx, hz, W, H);
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
      P.pct('wisps', 'Wispiness', 0.5),
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
      const wisps = num(p, 'wisps', 0.5);
      const { fw, fh, s } = fieldDims(W, H, 110_000);
      const fu = s * u;
      const k = 1 / ((520 * fu) / scale);
      const nA = simplex(seed);
      const nB = simplex(seed + 1);
      const nC = simplex(seed + 2);
      const [lo, lctx] = newCanvas(fw, fh);
      const img = lctx.createImageData(fw, fh);
      const px = img.data;
      for (let j = 0; j < fh; j++) {
        const ny = j / fh;
        for (let i = 0; i < fw; i++) {
          // horizontally stretched coordinates → drifting banks
          const x = i * k * 0.45;
          const y = j * k * 1.3;
          const wx = x + 0.45 * fbm2(nA, x * 0.6, y * 0.6, 3);
          const wy = y + 0.25 * fbm2(nA, x * 0.6 + 7.1, y * 0.6 - 3.3, 3);
          const f = fbm2(nB, wx, wy, 5, 0.5) * 0.5 + 0.5;
          // a second, larger and fainter layer for depth
          const g = fbm2(nC, x * 0.45 + 11.3, y * 0.5 - 2.7, 3) * 0.5 + 0.5;
          let m = 1;
          const edgeN = (f - 0.5) * 0.3;
          if (placement === 'ground') m = smoothstep(1 - height - 0.15, 1 - height * 0.2, ny + edgeN);
          else if (placement === 'top') m = 1 - smoothstep(height * 0.2, height + 0.15, ny - edgeN);
          else m = 0.7 + 0.3 * smoothstep(0, 1, ny);
          const v = smoothstep(0.22 + wisps * 0.12, 0.85, f) * (0.7 + 0.3 * g) + 0.12 * g;
          const a = clamp01(v * m * density * 1.25);
          const o = (j * fw + i) * 4;
          px[o] = color.r;
          px[o + 1] = color.g;
          px[o + 2] = color.b;
          px[o + 3] = a * 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      drawUpscaled(ctx, lo, W, H);
      return c;
    },
  },
  { bg: 'dark', onLight: {} },
);

/* ------------------------------------------------------------------ */
/* clouds                                                              */
/* ------------------------------------------------------------------ */

const SKIES: Record<string, string[]> = {
  day: ['#2f6fd0', '#73aee9', '#cfe6fa'],
  sunset: ['#26285c', '#b8507a', '#f6ae62'],
  night: ['#03060f', '#0c1430', '#1c2950'],
  storm: ['#1d2229', '#3a434f', '#6b7480'],
};

function cloudDensity(nA: Noise2, nB: Noise2, x: number, y: number, cover: number, soft: number): number {
  // large rounded masses + billowy (|n|) puffs → cumulus-like lumpy outlines
  const big = fbm2(nA, x, y, 4, 0.5) * 0.5 + 0.5;
  let b = 0;
  let amp = 0.5;
  let f = 2.3;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    b += amp * Math.abs(nB(x * f + o * 3.1, y * f - o * 1.7));
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  b /= norm;
  const v = big * 0.85 + b * 0.32;
  const t0 = 0.78 - cover * 0.5;
  return smoothstep(t0, t0 + 0.06 + soft * 0.24, v);
}

const clouds = defineAsset(
  {
    id: 'clouds',
    name: 'Clouds',
    category: 'Smoke & Atmosphere',
    tags: ['clouds', 'sky', 'cumulus', 'weather', 'heaven', 'background', 'storm'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Light color', '#ffffff'),
      P.color('shadow', 'Shadow color', '#8e98ae'),
      P.pct('coverage', 'Coverage', 0.5),
      P.num('scale', 'Scale', 0.3, 3, 1, { step: 0.05, unit: '×' }),
      P.pct('softness', 'Softness', 0.5),
      P.angle('light', 'Sun direction', 70),
      P.select(
        'sky',
        'Sky',
        [
          ['none', 'Transparent'],
          ['day', 'Day'],
          ['sunset', 'Sunset'],
          ['night', 'Night'],
          ['storm', 'Storm'],
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
      const cover = num(p, 'coverage', 0.5);
      const scale = Math.max(0.1, num(p, 'scale', 1));
      const soft = num(p, 'softness', 0.5);
      const la = (num(p, 'light', 70) * Math.PI) / 180;
      const sky = str(p, 'sky', 'none');
      const { fw, fh, s } = fieldDims(W, H, 170_000);
      const fu = s * u;
      const k = 1 / ((380 * fu) / scale);
      const nA = simplex(seed);
      const nB = simplex(seed + 1);
      const n = fw * fh;
      const dens = new Float32Array(n);
      const puff = new Float32Array(n);
      for (let j = 0; j < fh; j++) {
        for (let i = 0; i < fw; i++) {
          // slightly flattened clouds (wider than tall)
          const x = i * k * 0.8;
          const y = j * k * 1.25;
          const d = cloudDensity(nA, nB, x, y, cover, soft);
          dens[j * fw + i] = d;
          // interior lumps (only where there is cloud)
          if (d > 0.01) puff[j * fw + i] = fbm2(nB, x * 5.3 + 4.1, y * 5.3 - 2.2, 2);
        }
      }
      // self-shadowing: light coming from the sun direction; sample density towards the sun
      const lx = Math.cos(la);
      const ly = -Math.sin(la);
      const blur = blurField(Float32Array.from(dens), fw, fh, Math.max(1, 4 * fu), 2);
      const off = Math.max(1, 14 * fu);
      const [lo, lctx] = newCanvas(fw, fh);
      const img = lctx.createImageData(fw, fh);
      const px = img.data;
      for (let j = 0; j < fh; j++) {
        for (let i = 0; i < fw; i++) {
          const idx = j * fw + i;
          const d = dens[idx];
          if (d <= 0.002) continue;
          const si = Math.min(fw - 1, Math.max(0, Math.round(i + lx * off)));
          const sj = Math.min(fh - 1, Math.max(0, Math.round(j + ly * off)));
          const toward = blur[sj * fw + si];
          const si2 = Math.min(fw - 1, Math.max(0, Math.round(i + lx * off * 2.4)));
          const sj2 = Math.min(fh - 1, Math.max(0, Math.round(j + ly * off * 2.4)));
          const toward2 = blur[sj2 * fw + si2];
          // facing the sun (less cloud towards it) → bright; far side / deep inside → shadowed
          const here = blur[idx];
          const lightT = clamp01(0.62 + (here - toward) * 3.2 - (toward2 - here) * 0.5 - here * 0.18);
          let c = mixRGB(shadowC, light, clamp01(lightT + puff[idx] * 0.22));
          // thin wisps let the light through
          const thin = 1 - smoothstep(0.15, 0.7, here);
          c = mixRGB(c, light, thin * 0.35);
          const o = idx * 4;
          px[o] = c.r;
          px[o + 1] = c.g;
          px[o + 2] = c.b;
          px[o + 3] = clamp01(d * (0.75 + 0.25 * blur[idx]) * 1.1) * 255;
        }
      }
      lctx.putImageData(img, 0, 0);
      const [c, ctx] = newCanvas(W, H);
      if (sky !== 'none') {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        const st = SKIES[sky] ?? SKIES.day;
        st.forEach((col, i) => g.addColorStop(i / (st.length - 1), col));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      drawUpscaled(ctx, lo, W, H);
      return c;
    },
  },
  { bg: 'mid' },
);

export const atmosphereAssets: AssetDef[] = [smoke, fog, clouds];
