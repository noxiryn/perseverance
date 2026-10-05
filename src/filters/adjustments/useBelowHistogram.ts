/**
 * React hooks: histogram of the composite *below* an adjustment layer (what the adjustment
 * receives), recomputed only when something below actually changes; element width observer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Document, ID } from '../../core/types';
import { bitmaps } from '../../core/bitmaps';
import { flattenIds } from '../../core/document';
import { ctx2d } from '../../core/canvas';
import { useActiveDoc } from '../../state/editor';
import { renderDocument } from '../../render/compositor';
import { computeHistogram, type Histogram } from './histogram';
import { analysisMask } from './auto';

const MAX_SIDE = 420;

/** Bitmaps (layer pixels and masks) of the layers below `layerId`. */
export function belowBitmapIds(doc: Document, layerId: ID): Set<ID> {
  const order = flattenIds(doc);
  const idx = order.indexOf(layerId);
  const out = new Set<ID>();
  for (const id of idx < 0 ? order : order.slice(0, idx)) {
    const l = doc.layers[id];
    if (l?.type === 'raster') out.add(l.bitmapId);
    if (l?.mask) out.add(l.mask.bitmapId);
  }
  return out;
}

/** Identity-based signature of everything that influences the composite below `layerId`. */
function belowSignature(doc: Document, layerId: ID): unknown[] {
  const order = flattenIds(doc);
  const idx = order.indexOf(layerId);
  const sig: unknown[] = [doc.width, doc.height, doc.background];
  for (const id of idx < 0 ? order : order.slice(0, idx)) {
    const l = doc.layers[id];
    sig.push(l);
    if (l?.type === 'raster') sig.push(bitmaps.version(l.bitmapId));
    if (l?.mask) sig.push(bitmaps.version(l.mask.bitmapId));
  }
  return sig;
}

/**
 * A counter that increases when one of the bitmaps below `layerId` changes. Pixel-only commits
 * (Auto Tone, brush strokes) and undo/redo of them keep the same document object, so the
 * document alone can't tell the histogram to refresh. Coalesced to one bump per frame.
 */
function useBelowBitmapTick(doc: Document | null, layerId: ID | null, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  const ids = useMemo(
    () => (enabled && doc && layerId && doc.layers[layerId] ? belowBitmapIds(doc, layerId) : new Set<ID>()),
    [doc, layerId, enabled],
  );
  const relevant = useRef(ids);
  relevant.current = ids;
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const unsub = bitmaps.subscribe((id) => {
      if (raf || !relevant.current.has(id)) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setTick((t) => t + 1);
      });
    });
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled]);
  return tick;
}

function sameSig(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function computeBelowHistogram(doc: Document, layerId: ID): Histogram {
  const scale = Math.min(1, MAX_SIDE / Math.max(doc.width, doc.height, 1));
  const c = renderDocument(doc, { below: layerId, scale });
  const img = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  return computeHistogram(img, { mask: analysisMask(img) });
}

export function useBelowHistogram(layerId: ID | null, enabled = true): Histogram | null {
  const doc = useActiveDoc();
  const [hist, setHist] = useState<Histogram | null>(null);
  const sigRef = useRef<{ layerId: ID; sig: unknown[] } | null>(null);
  const tick = useBelowBitmapTick(doc, layerId, enabled);

  useEffect(() => {
    if (!enabled || !doc || !layerId || !doc.layers[layerId]) {
      sigRef.current = null;
      setHist(null);
      return;
    }
    const sig = belowSignature(doc, layerId);
    const prev = sigRef.current;
    if (prev && prev.layerId === layerId && sameSig(prev.sig, sig)) return;
    if (prev && prev.layerId !== layerId) setHist(null);
    const t = window.setTimeout(
      () => {
        sigRef.current = { layerId, sig };
        try {
          setHist(computeBelowHistogram(doc, layerId));
        } catch (err) {
          console.warn('[adjustments] histogram failed', err);
        }
      },
      prev ? 160 : 0,
    );
    return () => window.clearTimeout(t);
    // `tick` re-runs the signature check when pixels below change without a new document.
  }, [doc, layerId, enabled, tick]);

  return hist;
}

/** Observe an element's content width (for canvases that should fill the panel). Callback ref. */
export function useElementWidth<T extends HTMLElement>(fallback = 240): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const cs = getComputedStyle(el);
      const cw = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (cw > 0) setW(Math.floor(cw));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}
