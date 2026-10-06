/**
 * Replace Character / Replace Contents: swap a raster layer's pixels for another image while the
 * layer keeps its place in the composition — the new image is fitted into the old box (aspect
 * kept, centered; whole characters keep their feet planted, busts / head and waist-up renders fill
 * the part of the box on the canvas with their cut edge on the canvas edge) with the same rotation
 * and flip, and the layer keeps its smart filters, layer effects, mask, blend mode, clipping and
 * name. A template's placeholder becomes "your character" (renamed after the image, placeholder
 * flag cleared). Opaque images can have their background removed automatically on the way in.
 */
import type { Document, GeneratorSource, ID, Layer, RasterLayer } from '../../core/types';
import type { OpenedFile } from '../../platform';
import { extOf } from '../../platform';
import { bitmaps } from '../../core/bitmaps';
import { blobToCanvas, createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { resampleCanvas } from '../../io/open';
import { characterInGroup } from '../../looks/engine';
import { adoptTemplateStylingDraft } from '../../looks/characterStyling';
import { autoCutout, type AutoCutoutOutcome } from '../bg/core';
import { alphaBounds } from '../pixels';
import { canvasHasOpaqueBorder, clearMaskDraft, hasRemoveBgMask } from './cutout';
import { fitIntoBox, fitIntoBoxAtScale, isCutOffAtBottom, type FitAlign } from './fit';

/** Name given to a replaced placeholder when the image has no usable name (clipboard). */
export const REPLACED_PLACEHOLDER_NAME = 'Your Character';

export { IMAGE_FILE_EXTS, isReplaceableImage, sniffImageBytes } from './imageFiles';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

/** True for the template placeholder or a layer recorded/tagged as the Roblox character. */
export function isCharacterLayer(doc: Document | null | undefined, layer: Layer | null | undefined): layer is RasterLayer {
  if (!layer || layer.type !== 'raster') return false;
  const m = layer.meta;
  if (m?.placeholder === true || m?.kind === 'character') return true;
  const roblox = m?.roblox as { kind?: unknown } | undefined;
  if (roblox && roblox.kind === 'character') return true;
  return !!doc && doc.meta?.characterId === layer.id;
}

export function isPlaceholder(layer: Layer | null | undefined): boolean {
  return !!layer && layer.type === 'raster' && layer.meta?.placeholder === true;
}

/** The pixel layer a "Replace Contents" acts on: the active raster layer, or a group's character. */
export function contentsTarget(doc: Document | null | undefined, activeId: ID | null | undefined): RasterLayer | null {
  if (!doc || !activeId) return null;
  const l = doc.layers[activeId];
  if (l?.type === 'raster') return l;
  if (l?.type === 'group') {
    const ch = characterInGroup(doc, l.id);
    const c = ch ? doc.layers[ch] : null;
    if (c?.type === 'raster') return c;
  }
  return null;
}

/**
 * The layer a "Replace Character" acts on: the active layer when it is (or holds) the character,
 * else the document's recorded character or placeholder, else the active pixel layer.
 */
export function characterTarget(doc: Document | null | undefined, activeId: ID | null | undefined): RasterLayer | null {
  if (!doc) return null;
  const active = contentsTarget(doc, activeId);
  if (active && isCharacterLayer(doc, active)) return active;
  const recorded = doc.meta?.characterId;
  const rec = typeof recorded === 'string' ? doc.layers[recorded] : null;
  if (rec?.type === 'raster') return rec;
  const ph = Object.values(doc.layers).find((l): l is RasterLayer => l.type === 'raster' && isPlaceholder(l));
  return ph ?? active;
}

/** Decode an opened image file into a canvas. */
export async function decodeImageFile(file: OpenedFile): Promise<HTMLCanvasElement> {
  return blobToCanvas(new Blob([file.data], { type: MIME[extOf(file.name)] ?? '' }));
}

/** File name without folder and extension ("C:/x/my-avatar.png" → "my-avatar"). */
export function imageBaseName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

/**
 * What happened to the background of an incoming image: 'removed'; 'not-needed' (already
 * transparent); 'not-found' (nothing or everything would be removed); 'unsure' (the automatic
 * cut-out looked unreliable — e.g. it would eat into the subject — so the image was left as is);
 * 'off' (not requested).
 */
export type CutoutOutcome = AutoCutoutOutcome | 'not-needed' | 'off';

export interface PreparedImage {
  canvas: HTMLCanvasElement;
  cutout: CutoutOutcome;
  /** The image is cut off at the bottom (bust / waist-up / head-and-shoulders), see isCutOffAtBottom. */
  cutOff?: boolean;
}

/**
 * Get an incoming image ready to become a layer's content: optionally downscale it (keeps the
 * cut-out fast), remove an opaque background with Remove Background's Auto mode, and trim it to
 * its visible pixels so the fit uses the character's real extent.
 */
export function prepareReplacement(src: HTMLCanvasElement, opts: { cutout: boolean; maxSide?: number }): PreparedImage {
  let canvas = src;
  const maxSide = opts.maxSide ?? 0;
  if (maxSide > 0 && Math.max(src.width, src.height) > maxSide) {
    const k = maxSide / Math.max(src.width, src.height);
    canvas = resampleCanvas(src, src.width * k, src.height * k);
  } else {
    canvas = createCanvas(src.width, src.height);
    ctx2d(canvas).drawImage(src, 0, 0);
  }
  const ctx = ctxRead(canvas);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let cutout: CutoutOutcome = opts.cutout ? 'not-needed' : 'off';
  if (opts.cutout && canvasHasOpaqueBorder(canvas)) {
    // Auto mode with the default settings, applied in place only when the result can be trusted.
    cutout = autoCutout(img).outcome;
  }
  // Judged after the cut-out and before trimming: a bust reaches the image's bottom edge.
  const cutOff = isCutOffAtBottom(img);
  const b = alphaBounds(img, 0);
  if (!b) return { canvas, cutout, cutOff };
  const w = b.x1 - b.x0 + 1,
    h = b.y1 - b.y0 + 1;
  const out = createCanvas(w, h);
  ctx2d(out).putImageData(img, -b.x0, -b.y0, b.x0, b.y0, w, h);
  return { canvas: out, cutout, cutOff };
}

export interface ReplaceOptions {
  /** Name of the image (used to rename a replaced placeholder). */
  name?: string;
  /** Remove an opaque background automatically. */
  cutout?: boolean;
  /** History label (default "Replace Contents" / "Replace Character"). */
  label?: string;
  /**
   * Keep the image at its own resolution (scaled by the transform) and skip trimming — for
   * re-editable renders whose generator placement depends on the exact bitmap.
   */
  keepResolution?: boolean;
  /** Generator of the new content (e.g. a Pose Studio render); default: none. */
  generator?: GeneratorSource | null;
  /** Extra layer meta merged in (e.g. { roblox: { kind: 'character', source: 'rig' } }). */
  meta?: Record<string, unknown>;
  /**
   * The image is cut off at the bottom (a bust, headshot or head / waist-up render): replacing a
   * character, it fills the on-canvas part of the box with its cut edge on the canvas edge instead
   * of standing on the box bottom (fit.ts `cut`). Default: detected from the image (keepResolution
   * renders: false).
   */
  cutOff?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Replace a raster layer's pixels with `src`, keeping its place and treatment (one undo step).
 * Returns false (after a toast) when the layer can't be replaced.
 */
export function replaceLayerContents(layerId: ID, src: HTMLCanvasElement, opts: ReplaceOptions = {}): boolean {
  const s = activeSession();
  const doc = s?.doc;
  const layer = doc?.layers[layerId];
  if (!doc || !layer || layer.type !== 'raster') {
    toast('Select a pixel layer to replace its contents.', 'warning');
    return false;
  }
  if (layer.locks.all || layer.locks.pixels) {
    toast(`“${layer.name}” is locked — unlock its pixels to replace it.`, 'warning', 3600);
    return false;
  }
  if (src.width < 1 || src.height < 1) {
    toast('The image is empty.', 'warning');
    return false;
  }
  const character = isCharacterLayer(doc, layer);
  const wasPlaceholder = isPlaceholder(layer);
  const dispW = layer.width * Math.abs(layer.transform.scaleX || 1);
  const dispH = layer.height * Math.abs(layer.transform.scaleY || 1);
  // Characters: a whole figure keeps its feet planted on the box bottom; a bust / head / waist-up
  // image fills the part of the box that is on the canvas, its cut edge on the canvas edge.
  const alignFor = (cutOff: boolean | undefined): FitAlign => (!character ? 'center' : cutOff ? 'cut' : 'bottom');
  const canvasSize = { width: doc.width, height: doc.height };
  let prepared: PreparedImage;
  let fit: { width: number; height: number; transform: RasterLayer['transform'] };
  let bitmap: HTMLCanvasElement;
  if (opts.keepResolution) {
    prepared = { canvas: src, cutout: 'off', cutOff: !!opts.cutOff };
    bitmap = src;
    fit = {
      width: src.width,
      height: src.height,
      transform: fitIntoBoxAtScale(layer.transform, layer.width, layer.height, src.width, src.height, alignFor(opts.cutOff), canvasSize),
    };
  } else {
    // Work at no more than twice the size the image will be shown at (keeps the cut-out quick).
    prepared = prepareReplacement(src, { cutout: !!opts.cutout, maxSide: Math.max(256, Math.ceil(Math.max(dispW, dispH) * 2)) });
    const align = alignFor(opts.cutOff ?? prepared.cutOff);
    fit = fitIntoBox(layer.transform, layer.width, layer.height, prepared.canvas.width, prepared.canvas.height, align, canvasSize);
    bitmap = prepared.canvas.width === fit.width && prepared.canvas.height === fit.height ? prepared.canvas : resampleCanvas(prepared.canvas, fit.width, fit.height);
  }
  const bitmapId = bitmaps.add(bitmap);
  // A Remove Background mask belongs to the old pixels — the new image brings its own cut-out.
  const dropCutoutMask = hasRemoveBgMask(layer);
  const newName = wasPlaceholder ? opts.name?.trim() || REPLACED_PLACEHOLDER_NAME : layer.name;
  useEditor.getState().commit(
    opts.label ?? (character ? 'Replace Character' : 'Replace Contents'),
    (d) => {
      const l = d.layers[layerId];
      if (!l || l.type !== 'raster') return;
      adoptTemplateStylingDraft(l);
      l.bitmapId = bitmapId;
      l.width = fit.width;
      l.height = fit.height;
      l.transform = fit.transform;
      if (opts.generator) l.generator = opts.generator;
      else if (l.generator) l.generator = null;
      if (dropCutoutMask) clearMaskDraft(l);
      if (opts.meta) l.meta = { ...(l.meta ?? {}), ...opts.meta };
      if (wasPlaceholder) {
        const meta = { ...(l.meta ?? {}) };
        delete meta.placeholder;
        meta.kind = 'character';
        l.meta = meta;
        l.name = newName;
        if (typeof d.meta?.characterId !== 'string' || !d.layers[d.meta.characterId as string]) d.meta = { ...(d.meta ?? {}), characterId: layerId };
      }
    },
    { activeLayerId: layerId },
  );
  viewport.requestRender();
  const kept: string[] = [];
  if (layer.filters.length) kept.push(plural(layer.filters.length, 'smart filter'));
  if (layer.effects.length) kept.push(plural(layer.effects.length, 'effect'));
  if (layer.mask && !dropCutoutMask) kept.push('its mask');
  const keptText = kept.length ? ` — kept ${kept.length > 1 ? `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}` : kept[0]}` : '';
  const cut =
    prepared.cutout === 'removed'
      ? ' Background removed automatically (Ctrl+Z undoes it all).'
      : prepared.cutout === 'not-found'
        ? ' No clear background found — use Roblox ▸ Remove Background… to cut it out.'
        : prepared.cutout === 'unsure'
          ? ' The background was left in place: removing it automatically looked unreliable for this image — use Roblox ▸ Remove Background… to cut it out with a preview.'
          : '';
  const notice = prepared.cutout === 'not-found' || prepared.cutout === 'unsure';
  toast(`Replaced “${layer.name}”${wasPlaceholder ? ` with “${newName}”` : ''}${keptText}.${cut}`, notice ? 'info' : 'success', notice ? 6400 : cut ? 5200 : 3200);
  return true;
}
