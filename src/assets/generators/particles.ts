/**
 * Particles: sparks-embers, dust-particles, snow, rain, stars, petals.
 * Particles are sprite based (a cached soft disc drawn scaled) so hundreds stay cheap.
 */
import type { AssetDef } from '../../registry';
import { P, defineAsset } from '../lib/params';
import { softSprite, tintSprite } from '../lib/raster';
import type { Rand } from '../lib/util';
import { TAU, makeRand, mixRGB, newCanvas, num, rgbOf, rgba, cssRGB, str, unitOf } from '../lib/util';

/** Depth layers: [fraction of particles, blur px (×u), size multiplier, alpha multiplier]. */
type Depth = [number, number, number, number];

function depthLayers(depth: number): Depth[] {
  return [
    [0.55, 0, 0.6, 0.9],
    [0.3, 1.5 * depth, 1, 0.75],
    [0.15, 7 * depth, 2.4, 0.45 + 0.2 * (1 - depth)],
  ];
}

/** Position biased by a placement mode. */
function placeXY(r: Rand, W: number, H: number, mode: string): [number, number] {
  switch (mode) {
    case 'bottom':
      return [r() * W, H * (1 - r() ** 1.7)];
    case 'top':
      return [r() * W, H * r() ** 1.7];
    case 'sides': {
      const left = r() < 0.5;
      const x = (r() ** 1.6) * W * 0.45;
      return [left ? x : W - x, r() * H];
    }
    case 'center': {
      const a = r() * TAU;
      const d = Math.sqrt(r()) * 0.45;
      return [W * (0.5 + Math.cos(a) * d), H * (0.5 + Math.sin(a) * d)];
    }
    default:
      return [r() * W, r() * H];
  }
}

const PLACE: [string, string][] = [
  ['full', 'Everywhere'],
  ['bottom', 'Rising from bottom'],
  ['top', 'Top'],
  ['sides', 'Sides'],
  ['center', 'Center'],
];

/* ------------------------------------------------------------------ */
/* sparks-embers                                                       */
/* ------------------------------------------------------------------ */

const sparksEmbers = defineAsset(
  {
    id: 'sparks-embers',
    name: 'Sparks & Embers',
    category: 'Particles',
    tags: ['sparks', 'embers', 'fire', 'ash', 'glow', 'particles', 'hot', 'inferno'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Ember color', '#ff6a1a'),
      P.color('hot', 'Hot core', '#ffd98a'),
      P.num('count', 'Count', 10, 800, 180),
      P.num('size', 'Size', 1, 20, 4, { step: 0.5, unit: 'px' }),
      P.angle('direction', 'Direction', 75),
      P.pct('streak', 'Motion streaks', 0.6),
      P.pct('glow', 'Glow', 0.6),
      P.select('placement', 'Placement', PLACE, 'bottom'),
      P.seed(131),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 131));
      const col = rgbOf(str(p, 'color', '#ff6a1a'));
      const hot = rgbOf(str(p, 'hot', '#ffd98a'));
      const n = Math.round(num(p, 'count', 180));
      const size = num(p, 'size', 4) * u;
      const dir = (-num(p, 'direction', 75) * Math.PI) / 180;
      const streak = num(p, 'streak', 0.6);
      const glow = num(p, 'glow', 0.6);
      const mode = str(p, 'placement', 'bottom');
      const [c, ctx] = newCanvas(W, H);
      ctx.globalCompositeOperation = 'lighter';
      const glowSprite = tintSprite(softSprite(64, 0), cssRGB(col), 'ember-g');
      const blurSprite = tintSprite(softSprite(64, 0.55), cssRGB(mixRGB(col, hot, 0.3)), 'ember-b');
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const [x, y] = placeXY(r, W, H, mode);
        const s = size * (0.35 + r() ** 2.2 * 1.6);
        const heat = r();
        const c1 = mixRGB(col, hot, heat * 0.85);
        if (r() < 0.12) {
          // out-of-focus ember
          const rad = s * (3 + r() * 5);
          ctx.globalAlpha = 0.25 + r() * 0.3;
          ctx.drawImage(blurSprite, x - rad, y - rad, rad * 2, rad * 2);
          continue;
        }
        const len = streak * s * (4 + r() * 16);
        const a = dir + (r() - 0.5) * 0.7;
        const tx = x - Math.cos(a) * len;
        const ty = y - Math.sin(a) * len;
        if (len > s * 0.8) {
          // curved streak: tail fades out
          const g = ctx.createLinearGradient(x, y, tx, ty);
          g.addColorStop(0, rgba(c1, 0.95));
          g.addColorStop(1, rgba(col, 0));
          ctx.strokeStyle = g;
          ctx.lineWidth = s;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          const bend = (r() - 0.5) * len * 0.5;
          ctx.quadraticCurveTo((x + tx) / 2 - Math.sin(a) * bend, (y + ty) / 2 + Math.cos(a) * bend, tx, ty);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = rgba(mixRGB(c1, { r: 255, g: 255, b: 255 }, heat * 0.4), 1);
        ctx.beginPath();
        ctx.arc(x, y, s * 0.6, 0, TAU);
        ctx.fill();
        if (glow > 0) {
          const gr = s * (3 + glow * 6);
          ctx.globalAlpha = 0.35 * glow;
          ctx.drawImage(glowSprite, x - gr, y - gr, gr * 2, gr * 2);
        }
      }
      ctx.globalAlpha = 1;
      return c;
    },
  },
  { bg: 'dark', onLight: {} },
);

/* ------------------------------------------------------------------ */
/* dust-particles                                                      */
/* ------------------------------------------------------------------ */

const dustParticles = defineAsset(
  {
    id: 'dust-particles',
    name: 'Dust Particles',
    category: 'Particles',
    tags: ['dust', 'particles', 'floating', 'motes', 'atmosphere', 'light', 'magic'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#fff4e0'),
      P.num('count', 'Count', 10, 1500, 320),
      P.num('size', 'Size', 0.5, 12, 2.5, { step: 0.5, unit: 'px' }),
      P.pct('depth', 'Depth of field', 0.6),
      P.pct('brightness', 'Brightness', 0.7),
      P.select('placement', 'Placement', PLACE, 'full'),
      P.seed(137),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 137));
      const color = str(p, 'color', '#fff4e0');
      const n = Math.round(num(p, 'count', 320));
      const size = num(p, 'size', 2.5) * u;
      const depth = num(p, 'depth', 0.6);
      const bright = num(p, 'brightness', 0.7);
      const mode = str(p, 'placement', 'full');
      const sharp = tintSprite(softSprite(32, 0.6), color, 'dust-s');
      const soft = tintSprite(softSprite(64, 0.25), color, 'dust-b');
      const [c, ctx] = newCanvas(W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (const [frac, , sm, am] of depthLayers(depth)) {
        const k = Math.round(n * frac);
        for (let i = 0; i < k; i++) {
          const [x, y] = placeXY(r, W, H, mode);
          const big = sm > 2;
          const s = size * sm * (0.5 + r() ** 2 * 1.5) * (big ? 1 + depth * 3 : 1);
          ctx.globalAlpha = Math.min(1, am * bright * (0.3 + r() * 0.7));
          ctx.drawImage(big ? soft : sharp, x - s, y - s, s * 2, s * 2);
        }
      }
      ctx.globalAlpha = 1;
      return c;
    },
  },
  { bg: 'dark', onLight: {} },
);

/* ------------------------------------------------------------------ */
/* snow                                                                */
/* ------------------------------------------------------------------ */

const snow = defineAsset(
  {
    id: 'snow',
    name: 'Snow',
    category: 'Particles',
    tags: ['snow', 'winter', 'flakes', 'christmas', 'cold', 'weather'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#ffffff'),
      P.num('count', 'Flakes', 20, 2000, 500),
      P.num('size', 'Size', 1, 20, 4, { step: 0.5, unit: 'px' }),
      P.pct('depth', 'Depth of field', 0.6),
      P.angle('wind', 'Fall direction', -80),
      P.pct('motion', 'Motion blur', 0.25),
      P.seed(139),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 139));
      const color = str(p, 'color', '#ffffff');
      const n = Math.round(num(p, 'count', 500));
      const size = num(p, 'size', 4) * u;
      const depth = num(p, 'depth', 0.6);
      const wind = (-num(p, 'wind', -80) * Math.PI) / 180;
      const motion = num(p, 'motion', 0.25);
      const flake = tintSprite(softSprite(32, 0.75), color, 'snow-s');
      const soft = tintSprite(softSprite(64, 0.35), color, 'snow-b');
      const [c, ctx] = newCanvas(W, H);
      for (const [frac, blur, sm, am] of depthLayers(depth)) {
        const [lc, lctx] = newCanvas(W, H);
        const k = Math.round(n * frac);
        for (let i = 0; i < k; i++) {
          const x = r() * W;
          const y = r() * H;
          const s = size * sm * (0.4 + r() ** 2 * 1.3) * (blur > 3 ? 1 + depth : 1);
          lctx.globalAlpha = Math.min(1, am * (0.55 + r() * 0.45));
          const st = motion * s * 3;
          if (st > s * 0.3) {
            lctx.save();
            lctx.translate(x, y);
            lctx.rotate(wind);
            lctx.drawImage(blur > 3 ? soft : flake, -s - st, -s, (s + st) * 2, s * 2);
            lctx.restore();
          } else lctx.drawImage(blur > 3 ? soft : flake, x - s, y - s, s * 2, s * 2);
        }
        if (blur > 0) ctx.filter = `blur(${blur * u}px)`;
        ctx.drawImage(lc, 0, 0);
        ctx.filter = 'none';
      }
      return c;
    },
  },
  { bg: 'dark' },
);

/* ------------------------------------------------------------------ */
/* rain                                                                */
/* ------------------------------------------------------------------ */

const rain = defineAsset(
  {
    id: 'rain',
    name: 'Rain',
    category: 'Particles',
    tags: ['rain', 'storm', 'weather', 'drops', 'moody', 'wet'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#cfe2ff'),
      P.num('count', 'Drops', 50, 3000, 900),
      P.angle('angle', 'Angle', -78),
      P.num('length', 'Length', 5, 200, 55, { unit: 'px' }),
      P.num('thickness', 'Thickness', 0.5, 6, 1.2, { step: 0.1, unit: 'px' }),
      P.pct('depth', 'Depth', 0.5),
      P.pct('splashes', 'Splashes', 0.3),
      P.seed(149),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 149));
      const color = str(p, 'color', '#cfe2ff');
      const n = Math.round(num(p, 'count', 900));
      const a = (-num(p, 'angle', -78) * Math.PI) / 180;
      const L = num(p, 'length', 55) * u;
      const th = num(p, 'thickness', 1.2) * u;
      const depth = num(p, 'depth', 0.5);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const [c, ctx] = newCanvas(W, H);
      ctx.lineCap = 'round';
      // alpha × width buckets: far (thin, faint) → near (thick, brighter, blurred)
      const buckets: { alpha: number; width: number; blur: number; lenK: number; path: Path2D; frac: number }[] = [
        { alpha: 0.22, width: 0.6, blur: 0, lenK: 0.6, path: new Path2D(), frac: 0.5 },
        { alpha: 0.38, width: 1, blur: 0, lenK: 1, path: new Path2D(), frac: 0.35 },
        { alpha: 0.3, width: 2.2, blur: 2.5 * depth, lenK: 1.8, path: new Path2D(), frac: 0.15 },
      ];
      for (const b of buckets) {
        const k = Math.round(n * b.frac);
        for (let i = 0; i < k; i++) {
          const x = r() * (W + L * 2) - L;
          const y = r() * (H + L * 2) - L;
          const len = L * b.lenK * (0.5 + r());
          b.path.moveTo(x, y);
          b.path.lineTo(x + dx * len, y + dy * len);
        }
        ctx.strokeStyle = rgba(color, b.alpha);
        ctx.lineWidth = Math.max(0.5, th * b.width);
        if (b.blur > 0) ctx.filter = `blur(${b.blur * u}px)`;
        ctx.stroke(b.path);
        ctx.filter = 'none';
      }
      const splashes = num(p, 'splashes', 0.3);
      if (splashes > 0) {
        const sp = new Path2D();
        const k = Math.round(120 * splashes * (W / (1000 * u)));
        for (let i = 0; i < k; i++) {
          const x = r() * W;
          const y = H * (0.82 + r() * 0.18);
          const rw = (3 + r() * 9) * u;
          sp.moveTo(x + rw, y);
          sp.ellipse(x, y, rw, rw * 0.25, 0, Math.PI, TAU);
        }
        ctx.strokeStyle = rgba(color, 0.35);
        ctx.lineWidth = Math.max(0.5, 0.8 * u);
        ctx.stroke(sp);
      }
      return c;
    },
  },
  { bg: 'dark', onLight: {} },
);

/* ------------------------------------------------------------------ */
/* stars (sparkles)                                                    */
/* ------------------------------------------------------------------ */

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number, color: string, glow: HTMLCanvasElement, glowAmt: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = color;
  // 4-point star with concave sides
  const w = s * 0.12;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.quadraticCurveTo(w, -w, s, 0);
  ctx.quadraticCurveTo(w, w, 0, s);
  ctx.quadraticCurveTo(-w, w, -s, 0);
  ctx.quadraticCurveTo(-w, -w, 0, -s);
  ctx.fill();
  // secondary diagonal rays
  ctx.rotate(Math.PI / 4);
  const s2 = s * 0.42;
  ctx.globalAlpha *= 0.7;
  ctx.beginPath();
  ctx.moveTo(0, -s2);
  ctx.quadraticCurveTo(w * 0.6, -w * 0.6, s2, 0);
  ctx.quadraticCurveTo(w * 0.6, w * 0.6, 0, s2);
  ctx.quadraticCurveTo(-w * 0.6, w * 0.6, -s2, 0);
  ctx.quadraticCurveTo(-w * 0.6, -w * 0.6, 0, -s2);
  ctx.fill();
  ctx.restore();
  if (glowAmt > 0) {
    const g = s * 0.9 * (0.6 + glowAmt);
    ctx.save();
    ctx.globalAlpha = 0.6 * glowAmt;
    ctx.drawImage(glow, x - g, y - g, g * 2, g * 2);
    ctx.restore();
  }
}

const stars = defineAsset(
  {
    id: 'stars',
    name: 'Sparkle Stars',
    category: 'Particles',
    tags: ['stars', 'sparkles', 'twinkle', 'shine', 'glitter', 'magic', 'glint'],
    sizing: 'document',
    defaultBlendMode: 'screen',
    params: [
      P.color('color', 'Color', '#ffffff'),
      P.num('count', 'Sparkles', 1, 300, 36),
      P.num('size', 'Size', 4, 200, 30, { unit: 'px' }),
      P.pct('glow', 'Glow', 0.5),
      P.pct('dots', 'Tiny dots', 0.5),
      P.select('placement', 'Placement', PLACE, 'full'),
      P.seed(151),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 151));
      const color = str(p, 'color', '#ffffff');
      const n = Math.round(num(p, 'count', 36));
      const size = num(p, 'size', 30) * u;
      const glowAmt = num(p, 'glow', 0.5);
      const mode = str(p, 'placement', 'full');
      const glow = tintSprite(softSprite(64, 0), color, 'spark-g');
      const [c, ctx] = newCanvas(W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const [x, y] = placeXY(r, W, H, mode);
        const s = size * (0.25 + r() ** 2.5 * 1.5);
        ctx.globalAlpha = 0.6 + r() * 0.4;
        sparkle(ctx, x, y, s, (r() - 0.5) * 0.3, color, glow, glowAmt);
      }
      const dots = num(p, 'dots', 0.5);
      if (dots > 0) {
        const k = Math.round(n * 6 * dots);
        const dot = tintSprite(softSprite(32, 0.5), color, 'spark-d');
        for (let i = 0; i < k; i++) {
          const [x, y] = placeXY(r, W, H, mode);
          const s = u * (1 + r() ** 3 * 4);
          ctx.globalAlpha = 0.3 + r() * 0.7;
          ctx.drawImage(dot, x - s, y - s, s * 2, s * 2);
        }
      }
      ctx.globalAlpha = 1;
      return c;
    },
  },
  { bg: 'dark', onLight: {} },
);

/* ------------------------------------------------------------------ */
/* petals                                                              */
/* ------------------------------------------------------------------ */

function petalPath(len: number, wid: number): Path2D {
  // sakura petal: rounded body with a notch at the tip
  const p = new Path2D();
  p.moveTo(0, 0);
  p.bezierCurveTo(wid * 0.9, -len * 0.15, wid * 0.75, -len * 0.85, wid * 0.22, -len);
  p.lineTo(0, -len * 0.88);
  p.lineTo(-wid * 0.22, -len);
  p.bezierCurveTo(-wid * 0.75, -len * 0.85, -wid * 0.9, -len * 0.15, 0, 0);
  p.closePath();
  return p;
}

const petals = defineAsset(
  {
    id: 'petals',
    name: 'Petals',
    category: 'Particles',
    tags: ['petals', 'sakura', 'cherry blossom', 'flowers', 'spring', 'anime', 'falling'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Petal color', '#f5a3bd'),
      P.color('tip', 'Tip color', '#fff0f4'),
      P.num('count', 'Petals', 5, 400, 70),
      P.num('size', 'Size', 6, 120, 30, { unit: 'px' }),
      P.pct('depth', 'Depth of field', 0.5),
      P.select('placement', 'Placement', PLACE, 'full'),
      P.seed(157),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 157));
      const base = rgbOf(str(p, 'color', '#f5a3bd'));
      const tip = rgbOf(str(p, 'tip', '#fff0f4'));
      const n = Math.round(num(p, 'count', 70));
      const size = num(p, 'size', 30) * u;
      const depth = num(p, 'depth', 0.5);
      const mode = str(p, 'placement', 'full');
      const [c, ctx] = newCanvas(W, H);
      for (const [frac, blur, sm, am] of depthLayers(depth)) {
        const [lc, lctx] = newCanvas(W, H);
        const k = Math.round(n * frac);
        for (let i = 0; i < k; i++) {
          const [x, y] = placeXY(r, W, H, mode);
          const len = size * sm * (0.6 + r() * 0.7);
          const wid = len * (0.75 + r() * 0.2);
          const path = petalPath(len, wid);
          lctx.save();
          lctx.translate(x, y);
          lctx.rotate(r() * TAU);
          // flip/turn in 3D → squash one axis
          lctx.scale(0.35 + r() * 0.65, 1);
          lctx.globalAlpha = Math.min(1, am + 0.15);
          const g = lctx.createLinearGradient(0, 0, 0, -len);
          g.addColorStop(0, cssRGB(mixRGB(base, { r: 200, g: 60, b: 110 }, 0.25)));
          g.addColorStop(0.45, cssRGB(base));
          g.addColorStop(1, cssRGB(tip));
          lctx.fillStyle = g;
          lctx.fill(path);
          // center vein
          lctx.strokeStyle = rgba(mixRGB(base, { r: 180, g: 50, b: 100 }, 0.4), 0.35);
          lctx.lineWidth = Math.max(0.5, len * 0.025);
          lctx.beginPath();
          lctx.moveTo(0, -len * 0.05);
          lctx.lineTo(0, -len * 0.7);
          lctx.stroke();
          lctx.restore();
        }
        if (blur > 0) ctx.filter = `blur(${blur * u}px)`;
        ctx.drawImage(lc, 0, 0);
        ctx.filter = 'none';
      }
      return c;
    },
  },
  { bg: 'dark' },
);

export const particleAssets: AssetDef[] = [sparksEmbers, dustParticles, snow, rain, stars, petals];
