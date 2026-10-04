/**
 * Paint Bucket (G): flood-fill similar colors with the foreground color or a pattern asset.
 * Tolerance, contiguous, anti-alias, sample all layers; respects the selection, opacity,
 * blend mode, lock transparency and layer masks.
 */
import { PaintBucket } from 'lucide-react';
import type { Rect } from '../../../core/types';
import type { ToolDef } from '../../../registry';
import { assets } from '../../../registry';
import { createCanvas, ctx2d, ctxRead } from '../../../core/canvas';
import { resolveParams } from '../../../filters/engine';
import { renderDocument } from '../../../render/compositor';
import { activeSession, toolOptions } from '../../../state/editor';
import { toast } from '../../../state/ui';
import { transformRect } from '../engine/dabs';
import { floodMask, maskToAlpha } from '../engine/fill';
import { CompositeSession } from '../engine/session';
import { docToLocal, paintColorFor, resolvePaintTarget } from '../engine/target';
import { BUCKET_DEFAULTS, brushCompositeOp } from '../options';
import { BucketOptionsBar } from '../ui/OptionsBars';
import { colors, handleBrushKeys } from './common';

const patternCache = new Map<string, HTMLCanvasElement>();

/** Pattern tile for an asset (document-sized assets render at document size). */
export function patternCanvas(assetId: string, docW: number, docH: number): HTMLCanvasElement | null {
  const def = assets.get(assetId);
  if (!def) return null;
  const size = def.sizing === 'document' ? { width: docW, height: docH } : def.sizing;
  const key = `${assetId}|${size.width}x${size.height}`;
  const hit = patternCache.get(key);
  if (hit) return hit;
  try {
    const c = def.generate(resolveParams(def, {}), { width: Math.round(size.width), height: Math.round(size.height) });
    if (patternCache.size > 8) patternCache.delete(patternCache.keys().next().value as string);
    patternCache.set(key, c);
    return c;
  } catch (err) {
    console.error(`[paint] pattern ${assetId} failed`, err);
    return null;
  }
}

export const bucketTool: ToolDef = {
  id: 'paint-bucket',
  name: 'Paint Bucket',
  shortcut: 'G',
  icon: PaintBucket,
  group: 'gradient',
  order: 100,
  cursor: 'crosshair',
  OptionsBar: BucketOptionsBar,
  defaultOptions: BUCKET_DEFAULTS,

  onPointerDown(e) {
    if (e.button !== 0) return;
    const target = resolvePaintTarget({ toolName: 'Paint Bucket' });
    if (!target) return;
    const doc = activeSession()!.doc;
    const o = toolOptions('paint-bucket', BUCKET_DEFAULTS);

    // Sample either the merged document (doc space) or the target bitmap (local space).
    const docSpace = o.allLayers && target.kind === 'content';
    let src: HTMLCanvasElement;
    let seed: { x: number; y: number };
    if (docSpace) {
      src = renderDocument(doc, { background: true });
      seed = { x: e.docX, y: e.docY };
    } else {
      src = target.canvas;
      seed = docToLocal(target, e.docX, e.docY);
    }
    const W = src.width,
      H = src.height;
    if (seed.x < 0 || seed.y < 0 || seed.x >= W || seed.y >= H) {
      toast('Paint Bucket: click inside the layer', 'info');
      return;
    }
    const data = ctx2d(src).getImageData(0, 0, W, H).data;
    const flood = floodMask(data, W, H, seed.x, seed.y, o.tolerance, o.contiguous);
    const cov = maskToAlpha(flood, W, H, o.antiAlias);
    if (!cov) return;
    const rect: Rect = cov.rect;

    // Coverage mask canvas.
    const mask = createCanvas(rect.width, rect.height);
    const mctx = ctxRead(mask);
    const mimg = mctx.createImageData(rect.width, rect.height);
    for (let i = 0, p = 3; i < cov.alpha.length; i++, p += 4) mimg.data[p] = cov.alpha[i];
    mctx.putImageData(mimg, 0, 0);

    // Fill content.
    const fill = createCanvas(rect.width, rect.height);
    const fctx = ctx2d(fill);
    let painted = false;
    if (o.source === 'pattern' && target.kind === 'content') {
      const tile = o.patternId ? patternCanvas(o.patternId, doc.width, doc.height) : null;
      const pattern = tile ? fctx.createPattern(tile, 'repeat') : null;
      if (pattern) {
        // Anchor the pattern to the document origin.
        let m = new DOMMatrix().translateSelf(-rect.x, -rect.y);
        if (!docSpace && target.toLocal) m = m.multiply(target.toLocal);
        m.scaleSelf(Math.max(0.05, o.patternScale));
        pattern.setTransform(m);
        fctx.fillStyle = pattern;
        fctx.fillRect(0, 0, rect.width, rect.height);
        painted = true;
      } else {
        toast('Paint Bucket: choose a pattern in the options bar — using the foreground color', 'info');
      }
    }
    if (!painted) {
      fctx.fillStyle = paintColorFor(target, colors().primary);
      fctx.fillRect(0, 0, rect.width, rect.height);
    }
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(mask, 0, 0);

    const session = new CompositeSession(target, {
      opacity: o.opacity,
      op: target.kind === 'mask' ? 'source-over' : brushCompositeOp(o.blendMode),
    });
    const bctx = session.bufferCtx;
    const base = docSpace ? target.toLocal : null;
    if (base) bctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
    else bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.drawImage(fill, rect.x, rect.y);
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    session.markDirty(base ? transformRect(rect, base) : rect);
    session.commit('Paint Bucket');
  },

  onKeyDown: (e) => handleBrushKeys('paint-bucket', e, { digits: 'opacity' }),
};
