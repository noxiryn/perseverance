/**
 * Comic & Halftone: halftone-dots, speed-lines, motion-lines, comic-burst, manga-screentone.
 */
import type { AssetDef } from '../../registry';
import { FONT } from '../lib/fonts';
import { P, defineAsset } from '../lib/params';
import type { Pt } from '../lib/util';
import { TAU, clamp01, makeRand, newCanvas, num, pointParam, rgba, smoothstep, str, tracePoly, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* shared: tone ramps                                                  */
/* ------------------------------------------------------------------ */

const RAMPS: [string, string][] = [
  ['bottom', 'Bottom → up'],
  ['top', 'Top → down'],
  ['left', 'Left → right'],
  ['right', 'Right → left'],
  ['edges', 'Edges (vignette)'],
  ['center', 'Center out'],
  ['corner', 'Corner'],
  ['uniform', 'Uniform'],
];

/**
 * Tone 0..1 at normalized position (nx, ny) for a ramp direction. `coverage` = how far the
 * ramp reaches into the canvas. Pure (exported for tests).
 */
export function rampTone(dir: string, nx: number, ny: number, coverage: number, aspect = 1): number {
  const c = Math.max(0.02, coverage);
  let t: number;
  switch (dir) {
    case 'top':
      t = 1 - ny / c;
      break;
    case 'left':
      t = 1 - nx / c;
      break;
    case 'right':
      t = 1 - (1 - nx) / c;
      break;
    case 'edges': {
      const dx = (nx - 0.5) * aspect;
      const dy = ny - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(0.25 * aspect * aspect + 0.25);
      t = (d - (1 - c)) / c;
      break;
    }
    case 'center': {
      const dx = (nx - 0.5) * aspect;
      const dy = ny - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(0.25 * aspect * aspect + 0.25);
      t = 1 - d / c;
      break;
    }
    case 'corner':
      t = 1 - Math.sqrt(((1 - nx) * (1 - nx) + (1 - ny) * (1 - ny)) / 2) / c;
      break;
    case 'uniform':
      t = c;
      break;
    default:
      t = 1 - (1 - ny) / c;
  }
  return clamp01(t);
}

/* ------------------------------------------------------------------ */
/* halftone-dots                                                       */
/* ------------------------------------------------------------------ */

const halftoneDots = defineAsset(
  {
    id: 'halftone-dots',
    name: 'Halftone Dots',
    category: 'Comic & Halftone',
    tags: ['halftone', 'dots', 'comic', 'print', 'pop art', 'gradient', 'noir', 'screen'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    params: [
      P.num('size', 'Cell size', 3, 80, 14, { unit: 'px' }),
      P.angle('angle', 'Screen angle', 45),
      P.select('direction', 'Direction', RAMPS, 'edges'),
      P.color('color', 'Color', '#111111'),
      P.pct('coverage', 'Coverage', 0.6),
      P.pct('maxDot', 'Max dot', 0.9),
      P.select('shape', 'Dot shape', ['circle', 'square', 'diamond', 'line'], 'circle'),
      P.pct('grit', 'Grit', 0.15),
      P.seed(83),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 83));
      const cell = Math.max(2, num(p, 'size', 14) * u);
      const ang = (num(p, 'angle', 45) * Math.PI) / 180;
      const dir = str(p, 'direction', 'edges');
      const cov = num(p, 'coverage', 0.6);
      const maxDot = num(p, 'maxDot', 0.9);
      const shape = str(p, 'shape', 'circle');
      const grit = num(p, 'grit', 0.15);
      const aspect = W / H;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const half = Math.hypot(W, H) / 2;
      const n = Math.ceil(half / cell) + 1;
      const cx = W / 2;
      const cy = H / 2;
      const [c, ctx] = newCanvas(W, H);
      const path = new Path2D();
      const rMax = cell * 0.5 * 1.42 * maxDot;
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const lx = i * cell;
          const ly = j * cell;
          const x = cx + lx * cs - ly * sn;
          const y = cy + lx * sn + ly * cs;
          if (x < -cell || y < -cell || x > W + cell || y > H + cell) continue;
          let t = rampTone(dir, x / W, y / H, cov, aspect);
          if (grit > 0) t = clamp01(t * (1 + (r() - 0.5) * grit));
          if (t <= 0.01) continue;
          const rad = rMax * Math.sqrt(t);
          if (rad < 0.25) continue;
          if (shape === 'square') {
            const k = rad * 0.8;
            const pts: Pt[] = [
              { x: x + (-k * cs + k * sn), y: y + (-k * sn - k * cs) },
              { x: x + (k * cs + k * sn), y: y + (k * sn - k * cs) },
              { x: x + (k * cs - k * sn), y: y + (k * sn + k * cs) },
              { x: x + (-k * cs - k * sn), y: y + (-k * sn + k * cs) },
            ];
            tracePoly(path, pts);
          } else if (shape === 'diamond') {
            tracePoly(path, [
              { x: x + cs * rad, y: y + sn * rad },
              { x: x - sn * rad, y: y + cs * rad },
              { x: x - cs * rad, y: y - sn * rad },
              { x: x + sn * rad, y: y - cs * rad },
            ]);
          } else if (shape === 'line') {
            const hw = Math.min(cell / 2, rad * 0.7);
            const hl = cell / 2 + 0.5;
            tracePoly(path, [
              { x: x - cs * hl - sn * hw, y: y - sn * hl + cs * hw },
              { x: x + cs * hl - sn * hw, y: y + sn * hl + cs * hw },
              { x: x + cs * hl + sn * hw, y: y + sn * hl - cs * hw },
              { x: x - cs * hl + sn * hw, y: y - sn * hl - cs * hw },
            ]);
          } else {
            path.moveTo(x + rad, y);
            path.arc(x, y, rad, 0, TAU);
          }
        }
      }
      ctx.fillStyle = str(p, 'color', '#111111');
      ctx.fill(path);
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* speed-lines (radial)                                                */
/* ------------------------------------------------------------------ */

const speedLines = defineAsset(
  {
    id: 'speed-lines',
    name: 'Speed Lines',
    category: 'Comic & Halftone',
    tags: ['speed lines', 'focus lines', 'manga', 'anime', 'radial', 'action', 'impact'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('count', 'Lines', 20, 600, 220),
      P.point('center', 'Focus', { x: 0.5, y: 0.5 }),
      P.pct('inner', 'Clear area', 0.42),
      P.num('thickness', 'Thickness', 0.5, 40, 7, { step: 0.5, unit: 'px' }),
      P.pct('jitter', 'Randomness', 0.6),
      P.bool('clumps', 'Clumped lines', true),
      P.seed(89),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 89));
      const n = Math.round(num(p, 'count', 220));
      const ctr = pointParam(p, 'center', { x: 0.5, y: 0.5 });
      const cx = ctr.x * W;
      const cy = ctr.y * H;
      const R = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.08;
      const inner = num(p, 'inner', 0.42);
      const th = num(p, 'thickness', 7) * u;
      const jit = num(p, 'jitter', 0.6);
      const clumps = p.clumps !== false;
      const [c, ctx] = newCanvas(W, H);
      const path = new Path2D();
      // elliptical clear zone matching the canvas aspect
      const ex = (W / 2) * inner * 1.25;
      const ey = (H / 2) * inner * 1.25;
      for (let i = 0; i < n; i++) {
        const a = ((i + (r() - 0.5) * jit * 1.6) / n) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // radius of the clear ellipse along this direction
        const re = 1 / Math.sqrt((ca * ca) / (ex * ex) + (sa * sa) / (ey * ey));
        const start = re * (1 + r() * jit * 0.9 + (clumps && r() < 0.15 ? 0.4 : 0));
        let w = th * (0.25 + r() ** 2 * 1.6);
        if (clumps && r() < 0.08) w *= 2.6;
        const half = w / 2 / R;
        path.moveTo(cx + ca * start, cy + sa * start);
        path.lineTo(cx + Math.cos(a - half) * R, cy + Math.sin(a - half) * R);
        path.lineTo(cx + Math.cos(a + half) * R, cy + Math.sin(a + half) * R);
        path.closePath();
      }
      ctx.fillStyle = str(p, 'color', '#0b0b0b');
      ctx.fill(path);
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* motion-lines (parallel)                                             */
/* ------------------------------------------------------------------ */

const motionLines = defineAsset(
  {
    id: 'motion-lines',
    name: 'Motion Lines',
    category: 'Comic & Halftone',
    tags: ['motion lines', 'speed', 'streaks', 'manga', 'slash', 'dash', 'action'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.angle('angle', 'Angle', 0),
      P.num('count', 'Lines', 4, 400, 70),
      P.num('thickness', 'Thickness', 0.5, 30, 4, { step: 0.5, unit: 'px' }),
      P.num('length', 'Length', 0.05, 1.5, 0.45, { step: 0.01, unit: '×' }),
      P.pct('clear', 'Clear band', 0.3),
      P.pct('taper', 'Taper', 0.8),
      P.seed(97),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 97));
      const ang = (-num(p, 'angle', 0) * Math.PI) / 180;
      const n = Math.round(num(p, 'count', 70));
      const th = num(p, 'thickness', 4) * u;
      const D = Math.hypot(W, H);
      const L = D * num(p, 'length', 0.45);
      const clear = num(p, 'clear', 0.3);
      const taper = num(p, 'taper', 0.8);
      const [c, ctx] = newCanvas(W, H);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(ang);
      const path = new Path2D();
      for (let i = 0; i < n; i++) {
        // offset across the motion direction, avoiding a central clear band
        let off = (r() - 0.5) * D;
        if (Math.abs(off) < (clear * D) / 4) off = Math.sign(off || 1) * ((clear * D) / 4 + r() * D * 0.05);
        const len = L * (0.25 + r() * 0.75);
        const x0 = (r() - 0.5) * (D - len * 0.5) - len / 2;
        const w = th * (0.3 + r() ** 2 * 1.5);
        const hw = w / 2;
        const tp = (1 - taper) * hw;
        // lens/needle shape: thick in the middle, pointed (or blunt) ends
        path.moveTo(x0, off - tp);
        path.quadraticCurveTo(x0 + len * 0.5, off - hw * 1.6, x0 + len, off - tp);
        path.lineTo(x0 + len, off + tp);
        path.quadraticCurveTo(x0 + len * 0.5, off + hw * 1.6, x0, off + tp);
        path.closePath();
      }
      ctx.fillStyle = str(p, 'color', '#0b0b0b');
      ctx.fill(path);
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* comic-burst (element)                                               */
/* ------------------------------------------------------------------ */

function burstPoly(cx: number, cy: number, rx: number, ry: number, spikes: number, irregular: number, r: () => number, innerRatio = 0.68): Pt[] {
  const pts: Pt[] = [];
  const a0 = r() * TAU;
  for (let i = 0; i < spikes; i++) {
    const a = a0 + (i / spikes) * TAU + (r() - 0.5) * (TAU / spikes) * 0.5 * irregular;
    const ro = 1 - r() * 0.22 * irregular - (r() < 0.2 * irregular ? 0.12 : 0);
    pts.push({ x: cx + Math.cos(a) * rx * ro, y: cy + Math.sin(a) * ry * ro });
    const am = a + (TAU / spikes) * (0.5 + (r() - 0.5) * 0.3 * irregular);
    const ri = innerRatio * (1 + (r() - 0.5) * 0.18 * irregular);
    pts.push({ x: cx + Math.cos(am) * rx * ri, y: cy + Math.sin(am) * ry * ri });
  }
  return pts;
}

const comicBurst = defineAsset(
  {
    id: 'comic-burst',
    name: 'Comic Burst',
    category: 'Comic & Halftone',
    tags: ['comic', 'burst', 'pow', 'boom', 'explosion', 'sticker', 'pop art', 'badge'],
    sizing: { width: 900, height: 700 },
    defaultBlendMode: 'normal',
    params: [
      P.text('text', 'Text', 'POW!'),
      P.color('fill', 'Fill', '#ffd23f'),
      P.color('innerColor', 'Inner burst', '#ff3b1f'),
      P.pct('innerScale', 'Inner size', 0.72, { max: 0.95 }),
      P.color('outline', 'Outline', '#111111'),
      P.num('outlineWidth', 'Outline width', 0, 40, 14, { unit: 'px' }),
      P.num('spikes', 'Spikes', 6, 40, 16),
      P.pct('irregular', 'Irregularity', 0.6),
      P.color('textColor', 'Text color', '#ffffff'),
      P.pct('shadow', 'Hard shadow', 0.6),
      P.bool('dots', 'Halftone dots', true),
      P.seed(101),
    ],
    generate(p, { width: W, height: H }) {
      const u = Math.min(W, H) / 700;
      const r = makeRand(num(p, 'seed', 101));
      const ow = num(p, 'outlineWidth', 14) * u;
      const spikes = Math.round(num(p, 'spikes', 16));
      const irr = num(p, 'irregular', 0.6);
      const shadow = num(p, 'shadow', 0.6);
      const pad = ow + 18 * u + shadow * 26 * u;
      const cx = W / 2 - shadow * 8 * u;
      const cy = H / 2 - shadow * 8 * u;
      const rx = W / 2 - pad;
      const ry = H / 2 - pad;
      const outer = burstPoly(cx, cy, rx, ry, spikes, irr, r);
      const [c, ctx] = newCanvas(W, H);
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 6;
      const op = new Path2D();
      tracePoly(op, outer);
      const outline = str(p, 'outline', '#111111');
      if (shadow > 0) {
        ctx.save();
        ctx.translate(shadow * 22 * u, shadow * 22 * u);
        ctx.fillStyle = outline;
        ctx.fill(op);
        if (ow > 0) {
          ctx.lineWidth = ow * 2;
          ctx.strokeStyle = outline;
          ctx.stroke(op);
        }
        ctx.restore();
      }
      if (ow > 0) {
        ctx.lineWidth = ow * 2;
        ctx.strokeStyle = outline;
        ctx.stroke(op);
      }
      ctx.fillStyle = str(p, 'fill', '#ffd23f');
      ctx.fill(op);
      if (p.dots !== false) {
        // halftone shading in the lower-right of the burst
        ctx.save();
        ctx.clip(op);
        const dots = new Path2D();
        const cell = 16 * u;
        for (let y = cy - ry; y < cy + ry; y += cell) {
          for (let x = cx - rx; x < cx + rx; x += cell) {
            const t = smoothstep(0.1, 1.1, ((x - cx) / rx + (y - cy) / ry) * 0.7 + 0.3);
            const rad = cell * 0.5 * t;
            if (rad < 0.6) continue;
            dots.moveTo(x + rad, y);
            dots.arc(x, y, rad, 0, TAU);
          }
        }
        ctx.fillStyle = rgba('#e0561a', 0.55);
        ctx.fill(dots);
        ctx.restore();
      }
      const is = num(p, 'innerScale', 0.72);
      if (is > 0.05) {
        const inner = burstPoly(cx, cy, rx * is, ry * is, Math.max(6, Math.round(spikes * 0.8)), irr, r, 0.72);
        const ip = new Path2D();
        tracePoly(ip, inner);
        if (ow > 0) {
          ctx.lineWidth = ow * 1.2;
          ctx.strokeStyle = outline;
          ctx.stroke(ip);
        }
        ctx.fillStyle = str(p, 'innerColor', '#ff3b1f');
        ctx.fill(ip);
      }
      const text = str(p, 'text', 'POW!').trim();
      if (text) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-0.12 + (r() - 0.5) * 0.08);
        let size = ry * 0.9;
        ctx.font = `400 ${size}px ${FONT.comic}`;
        const tw = ctx.measureText(text).width;
        const maxW = rx * 1.25;
        if (tw > maxW) size *= maxW / tw;
        ctx.font = `400 ${size}px ${FONT.comic}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        // 3D extrude
        for (let k = Math.round(size * 0.07); k > 0; k--) {
          ctx.fillStyle = outline;
          ctx.fillText(text, k, k + size * 0.04);
        }
        ctx.lineWidth = Math.max(2, size * 0.09);
        ctx.strokeStyle = outline;
        ctx.strokeText(text, 0, size * 0.04);
        ctx.fillStyle = str(p, 'textColor', '#ffffff');
        ctx.fillText(text, 0, size * 0.04);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'checker', fonts: true },
);

/* ------------------------------------------------------------------ */
/* manga-screentone                                                    */
/* ------------------------------------------------------------------ */

const mangaScreentone = defineAsset(
  {
    id: 'manga-screentone',
    name: 'Manga Screentone',
    category: 'Comic & Halftone',
    tags: ['screentone', 'manga', 'tone', 'dots', 'lines', 'crosshatch', 'shading'],
    sizing: 'document',
    defaultBlendMode: 'multiply',
    params: [
      P.select('pattern', 'Pattern', ['dots', 'lines', 'crosshatch', 'noise', 'waves'], 'dots'),
      P.pct('tone', 'Tone', 0.35),
      P.num('size', 'Pitch', 2, 40, 7, { step: 0.5, unit: 'px' }),
      P.angle('angle', 'Angle', 45),
      P.color('color', 'Ink', '#111111'),
      P.select('gradient', 'Gradation', RAMPS, 'uniform'),
      P.seed(103),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 103));
      const pattern = str(p, 'pattern', 'dots');
      const tone = num(p, 'tone', 0.35);
      const pitch = Math.max(1.5, num(p, 'size', 7) * u);
      const ang = (num(p, 'angle', 45) * Math.PI) / 180;
      const grad = str(p, 'gradient', 'uniform');
      const aspect = W / H;
      const toneAt = (x: number, y: number) => (grad === 'uniform' ? tone : tone * rampTone(grad, x / W, y / H, 0.95, aspect) * 1.6);
      const [c, ctx] = newCanvas(W, H);
      const path = new Path2D();
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const half = Math.hypot(W, H) / 2;
      const n = Math.ceil(half / pitch) + 1;
      const cx = W / 2;
      const cy = H / 2;
      if (pattern === 'dots') {
        for (let j = -n; j <= n; j++)
          for (let i = -n; i <= n; i++) {
            const x = cx + i * pitch * cs - j * pitch * sn;
            const y = cy + i * pitch * sn + j * pitch * cs;
            if (x < -pitch || y < -pitch || x > W + pitch || y > H + pitch) continue;
            const t = clamp01(toneAt(x, y));
            const rad = pitch * 0.5 * 1.3 * Math.sqrt(t);
            if (rad < 0.2) continue;
            path.moveTo(x + rad, y);
            path.arc(x, y, rad, 0, TAU);
          }
        ctx.fillStyle = str(p, 'color', '#111111');
        ctx.fill(path);
      } else if (pattern === 'lines' || pattern === 'crosshatch' || pattern === 'waves') {
        const passes = pattern === 'crosshatch' ? [ang, ang + Math.PI / 2] : [ang];
        const BK = 14;
        const buckets = Array.from({ length: BK + 1 }, () => new Path2D());
        const used = new Array<boolean>(BK + 1).fill(false);
        const segLen = 10 * u;
        for (const a of passes) {
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const segs = Math.ceil((half * 2) / segLen);
          const wave = pattern === 'waves' ? pitch * 0.35 : 0;
          for (let j = -n; j <= n; j++) {
            const ox = -j * pitch * sa;
            const oy = j * pitch * ca;
            // line thickness follows the local tone: emit short segments into width buckets
            for (let k = 0; k < segs; k++) {
              const s0 = -half + k * segLen;
              const s1 = s0 + segLen + 0.5;
              const w0 = Math.sin((s0 / pitch) * 0.9) * wave;
              const w1 = Math.sin((s1 / pitch) * 0.9) * wave;
              const x0 = cx + ox + s0 * ca - w0 * sa;
              const y0 = cy + oy + s0 * sa + w0 * ca;
              const x1 = cx + ox + s1 * ca - w1 * sa;
              const y1 = cy + oy + s1 * sa + w1 * ca;
              if ((x0 < -10 && x1 < -10) || (x0 > W + 10 && x1 > W + 10) || (y0 < -10 && y1 < -10) || (y0 > H + 10 && y1 > H + 10)) continue;
              const t = clamp01(toneAt((x0 + x1) / 2, (y0 + y1) / 2) * (pattern === 'crosshatch' ? 0.6 : 1));
              const b = Math.round(t * BK);
              if (b <= 0) continue;
              buckets[b].moveTo(x0, y0);
              buckets[b].lineTo(x1, y1);
              used[b] = true;
            }
          }
        }
        ctx.strokeStyle = str(p, 'color', '#111111');
        ctx.lineCap = 'butt';
        for (let b = 1; b <= BK; b++) {
          if (!used[b]) continue;
          ctx.lineWidth = Math.max(0.3, (pitch * b) / BK);
          ctx.stroke(buckets[b]);
        }
      } else {
        // stochastic dots (noise tone)
        const area = W * H;
        const count = Math.round((area / (pitch * pitch)) * 1.6);
        for (let i = 0; i < count; i++) {
          const x = r() * W;
          const y = r() * H;
          if (r() > toneAt(x, y)) continue;
          const rad = pitch * (0.18 + r() * 0.2);
          path.moveTo(x + rad, y);
          path.arc(x, y, rad, 0, TAU);
        }
        ctx.fillStyle = str(p, 'color', '#111111');
        ctx.fill(path);
      }
      return c;
    },
  },
  { bg: 'paper' },
);

export const comicAssets: AssetDef[] = [halftoneDots, speedLines, motionLines, comicBurst, mangaScreentone];
