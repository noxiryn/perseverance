/**
 * Stroke previews: an S-curve rendered with the real brush engine into a small canvas
 * (cached per preset). Used by the Brushes panel and the options-bar preset picker.
 */
import type { BrushPresetDef } from '../../../registry';
import { createCanvas, ctx2d } from '../../../core/canvas';
import { strokeConfig } from '../engine/config';
import { DabPainter, tipForPreset } from '../engine/dabs';
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
  // Fit the brush into the preview height.
  const pad = Math.min(h * 0.32, Math.max(4, Math.min(settings.size, h * 0.5) * 0.6));
  const size = Math.max(1.5, Math.min(settings.size, h * 0.5));
  const s: BrushSettings = { ...settings, size };
  const painter = new DabPainter({
    tip: tipForPreset(settings.presetId, settings.hardness),
    color: opts.color ?? PREVIEW_COLOR,
    base: new DOMMatrix().scaleSelf(ratio, ratio),
    maxSize: size,
  });
  const stroke = new BrushStroke({ ...strokeConfig(s, 0), seed: opts.seed ?? 7, curveStep: 1 });
  const N = 64;
  const amp = Math.max(0, h / 2 - pad) * 0.62;
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
  if (settings.opacity >= 0.999) return buffer;
  const out = createCanvas(W, H);
  const octx = ctx2d(out);
  octx.globalAlpha = settings.opacity;
  octx.drawImage(buffer, 0, 0);
  return out;
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
