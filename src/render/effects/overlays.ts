/** Color, gradient and pattern overlays (clipped to the content by the compositor). */
import type { Gradient, ParamDef } from '../../core/types';
import { assets } from '../../registry';
import { assetImage, fillWithPaint } from '../paint';
import { DEFAULT_GRADIENT, P, clamp01, defineEffect, isGradient, num, regionOf, str } from './common';

export const colorOverlay = defineEffect(
  {
    id: 'color-overlay',
    name: 'Color Overlay',
    stage: 'above',
    order: 30,
    params: [P.color('color', 'Color', '#ff2a2a'), P.blend('normal'), P.opacity(1)],
    render(args) {
      const p = args.params;
      const t = args.target;
      t.save();
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalAlpha = clamp01(num(p.opacity, 1));
      t.fillStyle = str(p.color, '#ff2a2a');
      t.fillRect(0, 0, t.canvas.width, t.canvas.height);
      t.restore();
    },
  },
  { reach: () => 0, cacheable: false },
);

export const gradientOverlay = defineEffect(
  {
    id: 'gradient-overlay',
    name: 'Gradient Overlay',
    stage: 'above',
    order: 20,
    params: [
      { key: 'gradient', label: 'Gradient', type: 'gradient', default: DEFAULT_GRADIENT },
      P.blend('normal'),
      P.opacity(1),
      P.angle(90),
      { key: 'scale', label: 'Scale', type: 'number', min: 0.1, max: 1.5, step: 0.01, default: 1, unit: '%', displayScale: 100 },
    ],
    render(args) {
      const p = args.params;
      const src: Gradient = isGradient(p.gradient) ? p.gradient : DEFAULT_GRADIENT;
      const g: Gradient = { ...src, angle: num(p.angle, src.angle ?? 90), scale: Math.max(0.05, num(p.scale, 1)) };
      // Gradient geometry follows the layer's layout box (not its overflow).
      const b = regionOf(args).paintBox;
      const t = args.target;
      const W = t.canvas.width;
      const H = t.canvas.height;
      const area = new Path2D();
      area.rect(0, 0, W, H);
      t.save();
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalAlpha = clamp01(num(p.opacity, 1));
      fillWithPaint(t, { type: 'gradient', gradient: g }, { x: b.x, y: b.y, width: Math.max(1, b.w), height: Math.max(1, b.h) }, area);
      t.restore();
    },
  },
  { reach: () => 0, cacheable: false },
);

/** Document-sized assets usable as overlay textures (live: assets register after this module). */
export function documentAssetOptions(): { value: string; label: string }[] {
  const list = assets
    .list()
    .filter((a) => a.sizing === 'document' && a.category !== 'My Assets')
    .map((a) => ({ value: a.id, label: a.name }));
  return list.length ? list : [{ value: 'paper-texture', label: 'Paper Texture' }];
}

const assetParam = {
  key: 'assetId',
  label: 'Pattern',
  type: 'select',
  default: 'paper-texture',
  get options() {
    return documentAssetOptions();
  },
} as ParamDef;

/** Largest side of a generated overlay texture. */
const MAX_PATTERN_SIDE = 4096;

export const patternOverlay = defineEffect(
  {
    id: 'pattern-overlay',
    name: 'Pattern Overlay',
    stage: 'above',
    order: 10,
    params: [
      assetParam,
      P.blend('multiply'),
      P.opacity(1),
      { key: 'scale', label: 'Scale', type: 'number', min: 0.1, max: 4, step: 0.01, default: 1, unit: '%', displayScale: 100 },
      { key: 'seed', label: 'Seed', type: 'seed', default: 1 },
    ],
    render(args) {
      const p = args.params;
      const id = str(p.assetId, 'paper-texture');
      if (!assets.get(id)) return;
      const ps = Math.max(0.05, num(p.scale, 1));
      const docW = Math.max(1, args.docWidth);
      const docH = Math.max(1, args.docHeight);
      let gw = docW / ps;
      let gh = docH / ps;
      const cap = MAX_PATTERN_SIDE / Math.max(gw, gh);
      if (cap < 1) {
        gw *= cap;
        gh *= cap;
      }
      const img = assetImage(id, { seed: num(p.seed, 1) }, Math.max(8, gw), Math.max(8, gh));
      if (!img) return;
      const t = args.target;
      const pat = t.createPattern(img, 'repeat');
      if (!pat) return;
      const reg = regionOf(args);
      // The image spans (gw·ps × gh·ps) doc px (= the whole document unless capped, then it tiles);
      // image px → doc px → output px, anchored to the document origin.
      const sx = (gw * ps * args.scale) / img.width;
      const sy = (gh * ps * args.scale) / img.height;
      pat.setTransform(new DOMMatrix().translateSelf(-reg.x, -reg.y).scaleSelf(sx, sy));
      t.save();
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalAlpha = clamp01(num(p.opacity, 1));
      t.fillStyle = pat;
      t.fillRect(0, 0, t.canvas.width, t.canvas.height);
      t.restore();
    },
  },
  { reach: () => 0, docAnchored: true },
);
