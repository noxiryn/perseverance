/**
 * Pure placement math for Pose Studio renders: output frame size, crop padding, and the layer
 * transform that maps a cropped render back into the document (also when re-editing a layer
 * that the user has moved/scaled/rotated since).
 */
import type { Transform } from '../../core/types';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  /** Render frame size in px. */
  frameW: number;
  frameH: number;
  /** Crop of the frame kept in the bitmap. */
  crop: CropRect;
}

export const MAX_RENDER = 4096;

/** Output frame size for the 'document' setting or a long-side px value. */
export function outputFrameSize(size: 'document' | number, docW: number | null, docH: number | null): { width: number; height: number } {
  const dw = docW && docW > 0 ? docW : 1024;
  const dh = docH && docH > 0 ? docH : 1024;
  let w: number, h: number;
  if (size === 'document') {
    w = dw;
    h = dh;
  } else {
    const long = Math.max(64, Math.min(MAX_RENDER, Math.round(size)));
    if (dw >= dh) {
      w = long;
      h = Math.round((long * dh) / dw);
    } else {
      h = long;
      w = Math.round((long * dw) / dh);
    }
  }
  const k = Math.min(1, MAX_RENDER / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Expand opaque bounds by a padding (so smart filters/effects have room) and clamp to the frame. */
export function padCrop(b: CropRect, frameW: number, frameH: number, pad: number): CropRect {
  const x0 = Math.max(0, Math.floor(b.x - pad));
  const y0 = Math.max(0, Math.floor(b.y - pad));
  const x1 = Math.min(frameW, Math.ceil(b.x + b.width + pad));
  const y1 = Math.min(frameH, Math.ceil(b.y + b.height + pad));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Transform for a new layer: the frame fitted (contain) and centered in the document. */
export function freshTransform(p: Placement, docW: number, docH: number): Transform {
  const s = Math.min(docW / p.frameW, docH / p.frameH);
  const offX = (docW - p.frameW * s) / 2;
  const offY = (docH - p.frameH * s) / 2;
  const cx = offX + (p.crop.x + p.crop.width / 2) * s;
  const cy = offY + (p.crop.y + p.crop.height / 2) * s;
  return {
    x: cx - p.crop.width / 2,
    y: cy - p.crop.height / 2,
    scaleX: s,
    scaleY: s,
    rotation: 0,
    skewX: 0,
  };
}

/**
 * Transform for a re-rendered layer that keeps the old layer's frame → document mapping
 * (including any move/scale/rotation the user applied after the first render).
 */
export function reeditTransform(old: Placement, oldT: Transform, next: Placement): Transform {
  // Frame px of the new render → frame px of the old render.
  const k = old.frameW / next.frameW;
  const oc = { x: old.crop.x + old.crop.width / 2, y: old.crop.y + old.crop.height / 2 };
  const nc = { x: (next.crop.x + next.crop.width / 2) * k, y: (next.crop.y + next.crop.height / 2) * k };
  // Old box center in document space.
  const C0 = { x: oldT.x + old.crop.width / 2, y: oldT.y + old.crop.height / 2 };
  const rad = ((oldT.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  const dx = (nc.x - oc.x) * oldT.scaleX;
  const dy = (nc.y - oc.y) * oldT.scaleY;
  const C1 = { x: C0.x + dx * cos - dy * sin, y: C0.y + dx * sin + dy * cos };
  return {
    x: C1.x - next.crop.width / 2,
    y: C1.y - next.crop.height / 2,
    scaleX: oldT.scaleX * k,
    scaleY: oldT.scaleY * k,
    rotation: oldT.rotation,
    skewX: oldT.skewX ?? 0,
  };
}

/** Read a stored placement from generator params (defensive). */
export function readPlacement(v: unknown): Placement | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Partial<Placement>;
  const c = p.crop as Partial<CropRect> | undefined;
  if (
    typeof p.frameW !== 'number' ||
    typeof p.frameH !== 'number' ||
    !c ||
    typeof c.x !== 'number' ||
    typeof c.y !== 'number' ||
    typeof c.width !== 'number' ||
    typeof c.height !== 'number'
  )
    return null;
  return { frameW: p.frameW, frameH: p.frameH, crop: { x: c.x, y: c.y, width: c.width, height: c.height } };
}
