/**
 * Borders & Frames: torn-border, film-frame, rounded-frame, brush-border, polaroid.
 */
import type { AssetDef } from '../../registry';
import { createNoise2D } from '../../core/noise';
import { fieldDims, noiseField, paintField } from '../lib/field';
import { FONT } from '../lib/fonts';
import { tornBorder } from './torn';
import { blob, tornLine } from '../lib/geom';
import { P, defineAsset } from '../lib/params';
import { drawScratches, drawSpecks, paintPaper } from '../lib/surface';
import type { Pt, Rand, RGB } from '../lib/util';
import { TAU, bool, drawUpscaled, makeRand, newCanvas, num, rgbOf, rgba, shade, smoothstep, str, tracePoly, unitOf } from '../lib/util';

/* ------------------------------------------------------------------ */
/* film-frame                                                          */
/* ------------------------------------------------------------------ */

const filmFrame = defineAsset(
  {
    id: 'film-frame',
    name: 'Film Frame',
    category: 'Borders & Frames',
    tags: ['film', '35mm', 'negative', 'sprockets', 'cinema', 'frame', 'retro'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Film color', '#0c0b0a'),
      P.select('orientation', 'Orientation', ['horizontal', 'vertical'], 'horizontal'),
      P.num('band', 'Band size', 30, 200, 92, { unit: 'px' }),
      P.bool('holes', 'Sprocket holes', true),
      P.bool('text', 'Edge print', true),
      P.color('textColor', 'Print color', '#e0862e'),
      P.text('label', 'Edge label', 'PRSV 400  SAFETY FILM'),
      P.pct('wear', 'Wear', 0.4),
      P.seed(5),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 5));
      const vertical = str(p, 'orientation', 'horizontal') === 'vertical';
      const color = str(p, 'color', '#0c0b0a');
      const band = num(p, 'band', 92) * u;
      const [c, ctx] = newCanvas(W, H);
      // work in a rotated frame for vertical orientation
      const LW = vertical ? H : W;
      const LH = vertical ? W : H;
      ctx.save();
      if (vertical) {
        ctx.translate(W, 0);
        ctx.rotate(Math.PI / 2);
      }
      const frame = new Path2D();
      frame.rect(0, 0, LW, LH);
      const innerR = 14 * u;
      frame.roundRect(band * 0.15, band, LW - band * 0.3, LH - band * 2, innerR);
      ctx.fillStyle = color;
      ctx.fill(frame, 'evenodd');
      // frame separators (thin bars where frames meet), drawn at the left/right edges
      ctx.fillRect(0, 0, band * 0.15, LH);
      ctx.fillRect(LW - band * 0.15, 0, band * 0.15, LH);
      ctx.globalCompositeOperation = 'source-atop';
      const wear = num(p, 'wear', 0.4);
      drawScratches(ctx, LW, LH, u, '#ffffff', r, 120 * wear, { angle: 0, angleJitter: 0.1, alpha: 0.18, maxLen: 200 });
      ctx.globalCompositeOperation = 'source-over';
      if (bool(p, 'holes', true)) {
        const hw = band * 0.34;
        const hh = band * 0.44;
        const pitch = band * 0.95;
        ctx.globalCompositeOperation = 'destination-out';
        for (const yy of [band * 0.28, LH - band * 0.28 - hh]) {
          for (let x = pitch * 0.35; x < LW; x += pitch) {
            ctx.beginPath();
            ctx.roundRect(x, yy, hw, hh, hw * 0.22);
            ctx.fill();
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      if (bool(p, 'text', true)) {
        const tc = str(p, 'textColor', '#e0862e');
        const label = str(p, 'label', 'PRSV 400  SAFETY FILM');
        const fs = band * 0.16;
        ctx.font = `700 ${fs}px ${FONT.cond}`;
        ctx.fillStyle = rgba(tc, 0.9);
        ctx.textBaseline = 'middle';
        const yText = band * 0.86;
        let frameNo = r.int(1, 30);
        for (let x = band * 0.6; x < LW - band; x += band * 4.2) {
          ctx.fillText(`${label}`, x, yText);
          ctx.fillText(`▸ ${frameNo}`, x + band * 2.6, yText);
          ctx.fillText(`${frameNo}A`, x + band * 1.2, LH - band * 0.86);
          frameNo++;
        }
      }
      ctx.restore();
      return c;
    },
  },
  { bg: 'paper', fonts: true },
);

/* ------------------------------------------------------------------ */
/* rounded-frame                                                       */
/* ------------------------------------------------------------------ */

const roundedFrame = defineAsset(
  {
    id: 'rounded-frame',
    name: 'Rounded Frame',
    category: 'Borders & Frames',
    tags: ['frame', 'border', 'rounded', 'icon', 'clean', 'outline'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#111111'),
      P.num('thickness', 'Thickness', 2, 200, 34, { unit: 'px' }),
      P.num('radius', 'Corner radius', 0, 400, 70, { unit: 'px' }),
      P.num('inset', 'Inset', 0, 200, 0, { unit: 'px' }),
      P.color('accent', 'Accent line', '#8b7cf6'),
      P.num('accentWidth', 'Accent width', 0, 40, 6, { unit: 'px' }),
      P.num('accentGap', 'Accent gap', 0, 80, 10, { unit: 'px' }),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const t = num(p, 'thickness', 34) * u;
      const rad = num(p, 'radius', 70) * u;
      const inset = num(p, 'inset', 0) * u;
      const [c, ctx] = newCanvas(W, H);
      const path = new Path2D();
      path.roundRect(inset, inset, W - inset * 2, H - inset * 2, rad + t * 0.5);
      path.roundRect(inset + t, inset + t, W - (inset + t) * 2, H - (inset + t) * 2, rad);
      ctx.fillStyle = str(p, 'color', '#111111');
      ctx.fill(path, 'evenodd');
      const aw = num(p, 'accentWidth', 6) * u;
      if (aw > 0) {
        const g = num(p, 'accentGap', 10) * u + t + inset;
        ctx.strokeStyle = str(p, 'accent', '#8b7cf6');
        ctx.lineWidth = aw;
        ctx.beginPath();
        ctx.roundRect(g + aw / 2, g + aw / 2, W - (g + aw / 2) * 2, H - (g + aw / 2) * 2, Math.max(0, rad - (g - t - inset) - aw / 2));
        ctx.stroke();
      }
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* brush-border                                                        */
/* ------------------------------------------------------------------ */

function bristleStroke(ctx: CanvasRenderingContext2D, x0: number, x1: number, depth: number, u: number, r: Rand, color: RGB, dry: number) {
  // A horizontal dry-brush stroke along the top edge occupying y ∈ [0, depth] (local coords).
  const bristles = Math.max(6, Math.round(depth / (2.2 * u)));
  for (let b = 0; b < bristles; b++) {
    const y = (b / bristles) * depth + (r() - 0.5) * 2 * u;
    const outer = 1 - b / bristles; // bristles near the paper side are drier
    const skipStart = r() * (x1 - x0) * 0.25 * dry * (1 - outer);
    const skipEnd = r() * (x1 - x0) * 0.35 * dry * (1 - outer);
    const sx = x0 + skipStart;
    const ex = x1 - skipEnd;
    if (ex <= sx) continue;
    ctx.strokeStyle = rgba(color, 0.65 + r() * 0.35);
    ctx.lineWidth = u * (1.2 + r() * 2.6);
    ctx.beginPath();
    ctx.moveTo(sx, y);
    // broken bristles: gaps along the stroke
    let x = sx;
    while (x < ex) {
      const seg = (20 + r() * 140) * u;
      const nx = Math.min(ex, x + seg);
      ctx.lineTo(nx, y + (r() - 0.5) * 1.5 * u);
      x = nx;
      if (r() < 0.25 * dry * (1 - outer * 0.7)) {
        x += (4 + r() * 20) * u;
        ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  }
}

const brushBorder = defineAsset(
  {
    id: 'brush-border',
    name: 'Brush Border',
    category: 'Borders & Frames',
    tags: ['brush', 'paint', 'border', 'frame', 'dry brush', 'grunge'],
    sizing: 'document',
    defaultBlendMode: 'normal',
    params: [
      P.color('color', 'Color', '#0b0b0b'),
      P.num('thickness', 'Thickness', 10, 260, 70, { unit: 'px' }),
      P.pct('roughness', 'Dryness', 0.6),
      P.seed(6),
    ],
    generate(p, { width: W, height: H }) {
      const u = unitOf(W, H);
      const r = makeRand(num(p, 'seed', 6));
      const color = rgbOf(str(p, 'color', '#0b0b0b'));
      const T = num(p, 'thickness', 70) * u;
      const dry = num(p, 'roughness', 0.6);
      const [c, ctx] = newCanvas(W, H);
      ctx.lineCap = 'round';
      const sides: [number, number, number][] = [
        [0, 0, 0],
        [W, 0, Math.PI / 2],
        [W, H, Math.PI],
        [0, H, -Math.PI / 2],
      ];
      sides.forEach(([tx, ty, rot], i) => {
        const len = i % 2 === 0 ? W : H;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(rot);
        // solid core
        ctx.fillStyle = rgba(color, 1);
        ctx.fillRect(-T, -T, len + T * 2, T * 1.45);
        const strokes = Math.round(len / (T * 1.4)) + 3;
        for (let k = 0; k < strokes; k++) {
          const x0 = -T + (k / strokes) * (len + T) + (r() - 0.5) * T;
          const x1 = x0 + T * (1.8 + r() * 3);
          bristleStroke(ctx, x0, x1, T * (0.7 + r() * 0.7), u, r, color, dry);
        }
        ctx.restore();
      });
      return c;
    },
  },
  { bg: 'paper' },
);

/* ------------------------------------------------------------------ */
/* polaroid                                                            */
/* ------------------------------------------------------------------ */

const polaroid = defineAsset(
  {
    id: 'polaroid',
    name: 'Polaroid',
    category: 'Borders & Frames',
    tags: ['polaroid', 'photo', 'instant', 'frame', 'memory', 'scrapbook'],
    sizing: { width: 760, height: 900 },
    defaultBlendMode: 'normal',
    params: [
      P.color('tone', 'Frame color', '#f3f1ea'),
      P.text('caption', 'Caption', ''),
      P.color('captionColor', 'Caption color', '#2b2b2b'),
      P.select(
        'photo',
        'Photo area',
        [
          ['clear', 'Transparent'],
          ['dark', 'Dark'],
          ['faded', 'Faded'],
        ],
        'clear',
      ),
      P.pct('shadow', 'Shadow', 0.5),
      P.pct('aging', 'Aging', 0.3),
      P.seed(8),
    ],
    generate(p, { width: W, height: H }) {
      const u = Math.min(W, H) / 760;
      const seed = num(p, 'seed', 8);
      const r = makeRand(seed);
      const tone = rgbOf(str(p, 'tone', '#f3f1ea'));
      const shadow = num(p, 'shadow', 0.5);
      const m = 26 * u;
      const fx = m;
      const fy = m;
      const fwid = W - m * 2;
      const fhgt = H - m * 2;
      const side = fwid * 0.065;
      const win = { x: fx + side, y: fy + side, w: fwid - side * 2, h: Math.min(fwid - side * 2, fhgt - side * 3.6) };
      const [c, ctx] = newCanvas(W, H);
      if (shadow > 0) {
        ctx.save();
        ctx.shadowColor = rgba('#000000', 0.55 * shadow);
        ctx.shadowBlur = 22 * u * shadow;
        ctx.shadowOffsetY = 8 * u * shadow;
        ctx.fillStyle = rgba(tone, 1);
        ctx.fillRect(fx, fy, fwid, fhgt);
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, fy, fwid, fhgt);
      ctx.clip();
      ctx.translate(fx, fy);
      paintPaper(ctx, fwid, fhgt, u * 0.8, tone, seed, { grain: 0.4, fibers: 0.25, mottle: 0.5 + num(p, 'aging', 0.3), specks: num(p, 'aging', 0.3) });
      const aging = num(p, 'aging', 0.3);
      if (aging > 0) {
        const g = ctx.createRadialGradient(fwid / 2, fhgt / 2, fwid * 0.3, fwid / 2, fhgt / 2, fhgt * 0.75);
        g.addColorStop(0, rgba('#ffffff', 0));
        g.addColorStop(1, rgba('#8a6a3a', 0.35 * aging));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, fwid, fhgt);
      }
      ctx.restore();
      // photo window
      const photo = str(p, 'photo', 'clear');
      if (photo === 'clear') {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(win.x, win.y, win.w, win.h);
        ctx.restore();
      } else {
        const g = ctx.createLinearGradient(win.x, win.y, win.x + win.w, win.y + win.h);
        if (photo === 'dark') {
          g.addColorStop(0, '#26262a');
          g.addColorStop(1, '#0d0d10');
        } else {
          g.addColorStop(0, '#c9bfae');
          g.addColorStop(1, '#8f8576');
        }
        ctx.fillStyle = g;
        ctx.fillRect(win.x, win.y, win.w, win.h);
      }
      // inner edge shading of the window
      ctx.save();
      ctx.strokeStyle = rgba('#000000', 0.25);
      ctx.lineWidth = Math.max(1, 1.5 * u);
      ctx.strokeRect(win.x + 0.5, win.y + 0.5, win.w - 1, win.h - 1);
      ctx.restore();
      const caption = str(p, 'caption', '');
      if (caption) {
        const cy = win.y + win.h + (fy + fhgt - (win.y + win.h)) / 2;
        let size = 64 * u;
        ctx.font = `400 ${size}px ${FONT.hand}`;
        const tw = ctx.measureText(caption).width;
        if (tw > win.w * 0.95) size *= (win.w * 0.95) / tw;
        ctx.font = `400 ${size}px ${FONT.hand}`;
        ctx.fillStyle = str(p, 'captionColor', '#2b2b2b');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(W / 2, cy);
        ctx.rotate((r() - 0.5) * 0.05);
        ctx.fillText(caption, 0, 0);
        ctx.restore();
      }
      return c;
    },
  },
  { bg: 'dark', fonts: true },
);

export const frameAssets: AssetDef[] = [tornBorder, filmFrame, roundedFrame, brushBorder, polaroid];
export { tornLine };
