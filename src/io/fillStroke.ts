/**
 * Edit ▸ Fill… and Edit ▸ Stroke…: fill the selection (or the whole layer) with a color/pattern,
 * or stroke the selection outline, on the active pixel layer or the mask being edited.
 */
import type { BlendMode, DocSession, Document } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../core/canvas';
import { makeRasterLayer, nextLayerName } from '../core/document';
import { parseColor } from '../core/color';
import { assets } from '../registry';
import { defaultParams } from '../filters/engine';
import { activeSession, useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { askChoice } from './dialogs/ChoiceDialog';
import { strokeCoverage, clampRect, type StrokeLocation } from './math';
import { drawDocCanvasOnMask, drawDocCanvasOnRaster, pixelTarget, selectionClippedFill, selectionRect } from './pixels';
import { requireSession } from './util';

export type FillContents = 'foreground' | 'background' | 'color' | 'pattern' | 'black' | 'gray' | 'white';

export type FillSpec = {
  contents: FillContents;
  color: string;
  patternId: string | null;
  patternScale: number;
  blendMode: BlendMode;
  opacity: number;
  preserveTransparency: boolean;
};

export type StrokeSpec = {
  width: number;
  color: string;
  location: StrokeLocation;
  blendMode: BlendMode;
  opacity: number;
  preserveTransparency: boolean;
};

export const BLEND_OPTIONS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'linear-dodge', label: 'Linear Dodge (Add)' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

/** Resolve a fill's solid color (null for patterns). */
export function fillColorOf(spec: FillSpec): string | null {
  const st = useEditor.getState();
  switch (spec.contents) {
    case 'foreground':
      return st.primaryColor;
    case 'background':
      return st.secondaryColor;
    case 'color':
      return spec.color;
    case 'black':
      return '#000000';
    case 'gray':
      return '#808080';
    case 'white':
      return '#ffffff';
    default:
      return null;
  }
}

/** Pattern tile (element assets) or full-document texture (document assets). */
export function patternSource(doc: Document, assetId: string, scale: number): { kind: 'doc' | 'tile'; canvas: HTMLCanvasElement } | null {
  const def = assets.get(assetId);
  if (!def) return null;
  const params = { ...defaultParams(def.params) };
  try {
    if (def.sizing === 'document') return { kind: 'doc', canvas: def.generate(params, { width: doc.width, height: doc.height }) };
    const w = Math.max(4, Math.round(def.sizing.width * scale));
    const h = Math.max(4, Math.round(def.sizing.height * scale));
    return { kind: 'tile', canvas: def.generate(params, { width: w, height: h }) };
  } catch (e) {
    console.error('[io] pattern generation failed', e);
    return null;
  }
}

/** Ensure there is a pixel target; offers to create a new layer otherwise. */
async function resolveTarget(s: DocSession, action: string): Promise<ReturnType<typeof pixelTarget> | 'new' | null> {
  const t = pixelTarget(s);
  const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (t) {
    if (l && (l.locks.all || l.locks.pixels)) {
      toast(`“${l.name}” is locked. Unlock it to ${action}.`, 'warning');
      return null;
    }
    return t;
  }
  const choice = await askChoice({
    title: action === 'fill' ? 'Fill' : 'Stroke',
    message: l ? `“${l.name}” is a ${l.type} layer, which can't hold painted pixels.` : 'There is no active layer.',
    detail: `Create a new pixel layer to ${action} on?`,
    choices: [
      { value: 'cancel', label: 'Cancel' },
      { value: 'new', label: 'New Layer', variant: 'primary' },
    ],
  });
  return choice === 'new' ? 'new' : null;
}

/** Apply a doc-space source canvas to the target (one undo step). */
function applySource(s: DocSession, target: Exclude<ReturnType<typeof pixelTarget>, null> | 'new', src: HTMLCanvasElement, rect: ReturnType<typeof selectionRect>, label: string, o: { blendMode: BlendMode; opacity: number; preserveTransparency: boolean }) {
  const doc = s.doc;
  if (target === 'new') {
    const bmp = createCanvas(doc.width, doc.height);
    const ctx = ctx2d(bmp);
    ctx.globalAlpha = o.opacity;
    ctx.drawImage(src, 0, 0);
    const layer = makeRasterLayer({ name: nextLayerName(doc), bitmapId: bitmaps.add(bmp), width: doc.width, height: doc.height });
    if (o.blendMode !== 'normal') layer.blendMode = o.blendMode;
    useEditor.getState().addLayer(layer, { label });
  } else {
    const patch =
      target.kind === 'mask'
        ? drawDocCanvasOnMask(target.bitmapId, src, rect, o)
        : drawDocCanvasOnRaster(target.layer, src, rect, o);
    if (!patch) {
      toast('The area does not overlap the layer.', 'info');
      return;
    }
    useEditor.getState().commit(label, undefined, { patches: [patch] });
  }
  viewport.requestRender();
}

export function buildFillSource(doc: Document, spec: FillSpec): HTMLCanvasElement | null {
  const color = fillColorOf(spec);
  if (color) {
    return selectionClippedFill(doc, (ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
    });
  }
  if (!spec.patternId) return null;
  const pat = patternSource(doc, spec.patternId, spec.patternScale);
  if (!pat) return null;
  return selectionClippedFill(doc, (ctx, w, h) => {
    if (pat.kind === 'doc') ctx.drawImage(pat.canvas, 0, 0, w, h);
    else {
      ctx.fillStyle = ctx.createPattern(pat.canvas, 'repeat')!;
      ctx.fillRect(0, 0, w, h);
    }
  });
}

export async function fillWith(spec: FillSpec) {
  const s = activeSession();
  if (!s) return;
  const target = await resolveTarget(s, 'fill');
  if (!target) return;
  const src = buildFillSource(s.doc, spec);
  if (!src) {
    toast('Choose a pattern to fill with.', 'info');
    return;
  }
  applySource(s, target, src, selectionRect(s.doc), 'Fill', spec);
}

/** Doc-space canvas containing the selection outline stroke. */
export function buildStrokeSource(doc: Document, spec: StrokeSpec): HTMLCanvasElement | null {
  const sel = doc.selection ? bitmaps.tryGet(doc.selection.bitmapId) : null;
  if (!sel || !doc.selection) return null;
  const pad = Math.ceil(spec.width) + 3;
  const b = doc.selection.bounds;
  const r = clampRect({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }, doc.width, doc.height);
  if (!r) return null;
  // Work on a padded copy so strokes touching the canvas edge stay correct.
  const w = r.width + 2;
  const h = r.height + 2;
  const tmp = createCanvas(w, h);
  ctxRead(tmp).drawImage(sel, -r.x + 1, -r.y + 1);
  const data = ctxRead(tmp).getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];
  const cov = strokeCoverage(alpha, w, h, Math.max(1, spec.width), spec.location);
  const { r: cr, g: cg, b: cb, a: ca } = parseColor(spec.color);
  const img = new ImageData(w, h);
  const o = img.data;
  for (let i = 0; i < w * h; i++) {
    const a = cov[i];
    if (!a) continue;
    const j = i * 4;
    o[j] = cr;
    o[j + 1] = cg;
    o[j + 2] = cb;
    o[j + 3] = Math.round(a * ca);
  }
  const out = createCanvas(doc.width, doc.height);
  ctx2d(out).putImageData(img, r.x - 1, r.y - 1, 1, 1, r.width, r.height);
  return out;
}

export async function strokeWith(spec: StrokeSpec) {
  const s = activeSession();
  if (!s || !s.doc.selection) return;
  const target = await resolveTarget(s, 'stroke');
  if (!target) return;
  const src = buildStrokeSource(s.doc, spec);
  if (!src) {
    toast('Nothing to stroke.', 'info');
    return;
  }
  const b = s.doc.selection.bounds;
  const pad = Math.ceil(spec.width) + 2;
  const rect = clampRect({ x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }, s.doc.width, s.doc.height);
  applySource(s, target, src, rect, 'Stroke', spec);
}

/* ---------------- dialogs ---------------- */

export async function showFillDialog() {
  const s = requireSession('fill');
  if (!s) return;
  const { FillDialog } = await import('./dialogs/FillDialog');
  const spec = await openDialog<FillSpec>(FillDialog, {});
  if (spec) await fillWith(spec);
}

export async function showStrokeDialog() {
  const s = requireSession('stroke');
  if (!s) return;
  if (!s.doc.selection) {
    toast('Make a selection first — Stroke outlines the selection edge.', 'info', 3200);
    return;
  }
  const { StrokeDialog } = await import('./dialogs/StrokeDialog');
  const spec = await openDialog<StrokeSpec>(StrokeDialog, {});
  if (spec) await strokeWith(spec);
}
