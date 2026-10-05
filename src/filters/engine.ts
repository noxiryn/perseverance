/**
 * Filter engine: runs registered FilterDefs over canvases/ImageData.
 * Used by the compositor (smart filters + adjustment layers) and by destructive Filter commands.
 */
import type { BlendMode, FilterInstance, ParamDef, ParamValues } from '../core/types';
import { filters, type FilterContext, type FilterDef } from '../registry';
import { createCanvas, ctx2d } from '../core/canvas';
import { useEditor } from '../state/editor';

/** Map our blend modes to canvas globalCompositeOperation values. */
export function compositeOp(mode: BlendMode | 'pass-through' | undefined): GlobalCompositeOperation {
  switch (mode) {
    case undefined:
    case 'normal':
    case 'pass-through':
      return 'source-over';
    case 'linear-dodge':
      return 'lighter';
    default:
      return mode as GlobalCompositeOperation;
  }
}

/** Default values for a param list. */
export function defaultParams(defs: ParamDef[]): ParamValues {
  const out: ParamValues = {};
  for (const d of defs) {
    const v = d.default as ParamValues[string];
    out[d.key] = v && typeof v === 'object' ? (structuredClone(v) as ParamValues[string]) : v;
  }
  return out;
}

/** Params merged over defaults (so filters can rely on every key being present). */
export function resolveParams(def: { params: ParamDef[] }, params: ParamValues | undefined): ParamValues {
  return { ...defaultParams(def.params), ...(params ?? {}) };
}

export function makeFilterContext(partial: Partial<FilterContext> & { docWidth: number; docHeight: number }): FilterContext {
  const st = useEditor.getState();
  return {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    primaryColor: st.primaryColor,
    secondaryColor: st.secondaryColor,
    ...partial,
  };
}

/** Run one filter definition on ImageData (returns possibly new ImageData of same size). */
export function runFilter(def: FilterDef, img: ImageData, params: ParamValues | undefined, ctx: FilterContext): ImageData {
  try {
    const out = def.apply(img, resolveParams(def, params), ctx);
    return out ?? img;
  } catch (err) {
    console.error(`Filter ${def.id} failed`, err);
    return img;
  }
}

/**
 * Apply a filter instance to a canvas, honoring the instance's opacity/blend (smart filter
 * blending). Returns a NEW canvas; the input is not modified.
 */
export function applyFilterInstanceToCanvas(src: HTMLCanvasElement, inst: FilterInstance, ctx: FilterContext): HTMLCanvasElement {
  const def = filters.get(inst.filterId);
  const out = createCanvas(src.width, src.height);
  const octx = ctx2d(out, { willReadFrequently: true });
  if (!def || !inst.enabled) {
    octx.drawImage(src, 0, 0);
    return out;
  }
  octx.drawImage(src, 0, 0);
  const img = octx.getImageData(0, 0, out.width, out.height);
  const res = runFilter(def, img, inst.params, ctx);
  const opacity = inst.opacity ?? 1;
  const blend = inst.blendMode ?? 'normal';
  if (opacity >= 0.999 && blend === 'normal') {
    octx.putImageData(res, 0, 0);
    return out;
  }
  // Blend the filtered result over the original.
  const tmp = createCanvas(src.width, src.height);
  ctx2d(tmp).putImageData(res, 0, 0);
  octx.save();
  octx.globalAlpha = opacity;
  octx.globalCompositeOperation = compositeOp(blend);
  octx.drawImage(tmp, 0, 0);
  octx.restore();
  // Keep the original alpha (filters blended with a mode shouldn't grow coverage).
  octx.save();
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(src, 0, 0);
  octx.restore();
  return out;
}

/** Apply a stack of filter instances in order. Returns the input canvas if no filter is enabled. */
export function applyFilterStack(src: HTMLCanvasElement, stack: FilterInstance[], ctx: FilterContext): HTMLCanvasElement {
  let cur = src;
  for (const inst of stack) {
    if (!inst.enabled) continue;
    cur = applyFilterInstanceToCanvas(cur, inst, ctx);
  }
  return cur;
}

/** Look up filters usable as adjustment layers. */
export function adjustmentFilters(): FilterDef[] {
  return filters.list().filter((f) => f.adjustment && !f.hidden);
}
