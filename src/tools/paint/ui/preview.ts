/**
 * Stroke previews: an S-curve rendered with the real brush engine into a small canvas
 * (cached per preset). Used by the Brushes panel and the options-bar preset picker.
 */
import type { BrushPresetDef } from '../../../registry';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { strokeConfig } from '../engine/config';
import { COVERAGE, DabPainter, tipForPreset } from '../engine/dabs';
import { BrushStroke } from '../engine/stroke';
import type { BrushSettings } from '../options';
import { presetSettings } from '../presets/presets';
import { pencilTip, roundTip, textureTip } from '../engine/tips';
import { brushPresets } from '../../../registry';

export const PREVIEW_COLOR = '#e6e6e6';

export function dpr(): number {
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

/** Render a brush stroke preview (CSS size w×h, rendered at `ratio`). */
export function renderStrokePreview(settings: BrushSettings, w: number, h: number, opts: { color?: string; ratio?: number; seed?: number } = {}): HTMLCanvasElement {
  const ratio = opts.ratio ?? dpr();
  const W = Math.max(1, Math.round(w * ratio));
  const H = Math.max(1, Math.round(h * ratio));
  const buffer = createCanvas(W, H);
  const bctx = ctx2d(buffer);
  const s = previewSettings(settings, w, h);
  const size = s.size;
  const pad = Math.min(h * 0.32, Math.max(4, size * 0.6));
  // Coverage dabs, tinted once at the end (see CompositeMode.color for why).
  const painter = new DabPainter({
    tip: tipForPreset(settings.presetId, settings.hardness),
    color: COVERAGE,
    base: new DOMMatrix().scaleSelf(ratio, ratio),
    maxSize: size,
  });
  const stroke = new BrushStroke({ ...strokeConfig(s, 0), seed: opts.seed ?? 7, curveStep: 1 });
  const N = 64;
  // Scattered brushes spread around the path on their own: flatten the curve for them.
  const amp = Math.max(0, h / 2 - pad) * 0.62 * (1 - Math.min(0.8, s.scatter * 3));
  const point = (t: number) => ({
    x: pad + t * (w - pad * 2),
    y: h / 2 - Math.sin(t * Math.PI * 2) * amp,
    pressure: Math.max(0.08, Math.pow(Math.sin(Math.PI * t), 0.65)),
  });
  const draw = (dabs: ReturnType<BrushStroke['move']>) => {
    for (const d of dabs) painter.draw(bctx, d);
  };
  draw(stroke.begin(point(0)));
  for (let i = 1; i <= N; i++) draw(stroke.move(point(i / N)));
  draw(stroke.end(point(1)));
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.globalAlpha = 1;
  bctx.globalCompositeOperation = 'source-in';
  bctx.fillStyle = opts.color ?? PREVIEW_COLOR;
  bctx.fillRect(0, 0, W, H);
  bctx.globalCompositeOperation = 'source-over';
  if (settings.opacity >= 0.999) return buffer;
  const out = createCanvas(W, H);
  const octx = ctx2d(out);
  octx.globalAlpha = settings.opacity;
  octx.drawImage(buffer, 0, 0);
  return out;
}

/**
 * Settings adapted to a w×h preview: the tip is scaled to fit the height, scattered dabs are
 * kept inside the box and sparse stamp brushes (stars, splatter…) show at least a few stamps.
 * Only previews use this — real strokes paint exactly what the settings say.
 */
export function previewSettings(settings: BrushSettings, w: number, h: number): BrushSettings {
  const sparse = settings.spacing >= 0.5;
  const size = Math.max(1.5, Math.min(settings.size, h * (sparse ? 0.62 : 0.5)));
  // Max scatter offset is 2·scatter·size (see computeDab): keep it within the free height.
  const room = Math.max(0, h / 2 - size / 2 - 1);
  const scatter = Math.min(settings.scatter, (room / (2 * size)) * 0.9);
  // At least ~6 stamps across the preview.
  const run = Math.max(1, w - size * 1.2);
  const spacing = sparse ? Math.max(0.35, Math.min(settings.spacing, run / (size * 6))) : settings.spacing;
  return { ...settings, size, scatter, spacing };
}

const presetCache = new Map<string, HTMLCanvasElement>();

/** Cached stroke preview of a registered preset. */
export function presetPreview(preset: BrushPresetDef, w: number, h: number): HTMLCanvasElement {
  const ratio = dpr();
  const key = `${preset.id}|${w}|${h}|${ratio}|${preset.size}|${preset.spacing}|${preset.flow}`;
  const hit = presetCache.get(key);
  if (hit) return hit;
  let c: HTMLCanvasElement;
  try {
    c = renderStrokePreview(presetSettings(preset), w, h, { ratio });
  } catch (err) {
    console.error('[paint] preview failed', preset.id, err);
    c = createCanvas(w * ratio, h * ratio);
  }
  presetCache.set(key, c);
  return c;
}

/** The tip shape itself, drawn centered in an n×n (CSS px) canvas. */
export function tipThumbnail(presetId: string, hardness: number, n: number, opts: { square?: boolean; pencil?: boolean } = {}): HTMLCanvasElement {
  const ratio = dpr();
  const N = Math.round(n * ratio);
  const c = createCanvas(N, N);
  const ctx = ctx2d(c);
  const preset = brushPresets.get(presetId);
  let tip: HTMLCanvasElement;
  if (opts.pencil) tip = pencilTip(Math.max(1, Math.round(N * 0.7)), !!opts.square);
  else if (preset?.tip) tip = textureTip(preset, N) ?? roundTip(N, hardness);
  else tip = roundTip(N, hardness);
  const s = N * 0.86;
  ctx.drawImage(tip, (N - s) / 2, (N - s) / 2, s, s);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = PREVIEW_COLOR;
  ctx.fillRect(0, 0, N, N);
  return c;
}
