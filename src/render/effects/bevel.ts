/** Bevel & Emboss (distance-field height map + Lambert shading) and Satin. */
import { ctx2d } from '../../core/canvas';
import { acquire, release } from '../surface';
import {
  P,
  blurredCopy,
  bool,
  clamp01,
  defineEffect,
  fieldsOf,
  finish,
  num,
  offsetDir,
  readAlpha,
  rgbOf,
  sizeSigma,
  str,
  workRect,
  type EffectArgsExt,
  type LocalRect,
} from './common';
import { bevelMaps } from './math';

function mapCanvas(W: number, H: number, r: LocalRect, map: Uint8Array, color: string, opacity: number): HTMLCanvasElement {
  const [cr, cg, cb] = rgbOf(color);
  const img = new ImageData(r.w, r.h);
  // One 32-bit store per covered pixel (RGBA bytes in memory order = little-endian ABGR word).
  const px32 = new Uint32Array(img.data.buffer);
  const rgb = (cb << 16) | (cg << 8) | cr;
  const o = clamp01(opacity);
  const lut = new Uint32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = ((Math.round(v * o) << 24) | rgb) >>> 0;
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    if (v) px32[i] = lut[v];
  }
  const c = acquire(W, H);
  ctx2d(c).putImageData(img, r.x, r.y);
  return c;
}

export const bevel = defineEffect(
  {
    id: 'bevel',
    name: 'Bevel & Emboss',
    stage: 'above',
    order: 70,
    params: [
      {
        key: 'style',
        label: 'Style',
        type: 'select',
        options: [
          { value: 'inner', label: 'Inner Bevel' },
          { value: 'emboss', label: 'Emboss' },
        ],
        default: 'inner',
      },
      { key: 'depth', label: 'Depth', type: 'number', min: 0.01, max: 10, step: 0.01, default: 1, unit: '%', displayScale: 100 },
      P.px('size', 'Size', 8, 250),
      P.px('soften', 'Soften', 0, 16),
      { ...P.angle(120), group: 'Shading' },
      { key: 'altitude', label: 'Altitude', type: 'number', min: 0, max: 90, step: 1, default: 30, unit: '°', group: 'Shading' },
      { ...P.color('highlightColor', 'Highlight', '#ffffff'), group: 'Shading' },
      { ...P.opacity(0.75, 'highlightOpacity', 'Highlight Opacity'), group: 'Shading' },
      { ...P.color('shadowColor', 'Shadow', '#000000'), group: 'Shading' },
      { ...P.opacity(0.75, 'shadowOpacity', 'Shadow Opacity'), group: 'Shading' },
    ],
    render(args) {
      const p = args.params;
      const s = args.scale;
      const size = Math.max(0, num(p.size, 8)) * s;
      if (size < 0.25) return;
      const emboss = str(p.style, 'inner') === 'emboss';
      const r = workRect(args, emboss ? size / 2 + 2 : 2);
      if (!r) return;
      const fields = fieldsOf(args);
      const a = fields.alpha(r);
      const { hi, sh } = bevelMaps(
        a,
        r.w,
        r.h,
        {
          size,
          depth: Math.max(0, num(p.depth, 1)),
          angle: num(p.angle, 120),
          altitude: num(p.altitude, 30),
          style: emboss ? 'emboss' : 'inner',
          soften: Math.max(0, num(p.soften, 0)) * s,
        },
        (mode, maxDist) => fields.distance(mode, maxDist, r),
      );
      const W = args.content.width;
      const H = args.content.height;
      const hc = mapCanvas(W, H, r, hi, str(p.highlightColor, '#ffffff'), num(p.highlightOpacity, 0.75));
      const sc = mapCanvas(W, H, r, sh, str(p.shadowColor, '#000000'), num(p.shadowOpacity, 0.75));
      const ext = args as EffectArgsExt;
      if (ext.addPiece) {
        ext.addPiece(sc, 'multiply');
        ext.addPiece(hc, 'screen');
        release(sc, hc);
      } else {
        finish(args.target, sc, 1);
        finish(args.target, hc, 1);
      }
    },
  },
  {
    clip: (p) => str(p.style, 'inner') !== 'emboss',
    reach: (p, s) => (str(p.style, 'inner') === 'emboss' ? (Math.max(0, num(p.size, 8)) / 2) * s + 3 : 0),
  },
);

export const satin = defineEffect(
  {
    id: 'satin',
    name: 'Satin',
    stage: 'above',
    order: 40,
    params: [
      P.color('color', 'Color', '#000000'),
      P.blend('multiply'),
      P.opacity(0.5),
      P.angle(19),
      P.px('distance', 'Distance', 11, 250),
      P.px('size', 'Size', 14, 250),
      { key: 'invert', label: 'Invert', type: 'boolean', default: true },
    ],
    render(args) {
      const p = args.params;
      const s = args.scale;
      const dist = Math.max(0, num(p.distance, 11)) * s;
      const size = Math.max(0, num(p.size, 14)) * s;
      const dir = offsetDir(num(p.angle, 19));
      const r = workRect(args, 2);
      if (!r) return;
      const A = blurredCopy(args.content, sizeSigma(size), dir.x * dist, dir.y * dist);
      const B = blurredCopy(args.content, sizeSigma(size), -dir.x * dist, -dir.y * dist);
      const a = readAlpha(A, r);
      const b = readAlpha(B, r);
      release(A, B);
      const inv = bool(p.invert, true);
      const [cr, cg, cb] = rgbOf(str(p.color, '#000000'));
      const img = new ImageData(r.w, r.h);
      const d = img.data;
      for (let i = 0, j = 0; i < a.length; i++, j += 4) {
        const v = Math.abs(a[i] - b[i]);
        d[j] = cr;
        d[j + 1] = cg;
        d[j + 2] = cb;
        d[j + 3] = inv ? 255 - v : v;
      }
      const c = acquire(args.content.width, args.content.height);
      ctx2d(c).putImageData(img, r.x, r.y);
      finish(args.target, c, num(p.opacity, 0.5));
    },
  },
  { reach: () => 0 },
);
