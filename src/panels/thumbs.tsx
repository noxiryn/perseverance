/**
 * Cached, throttled layer / mask / document thumbnails.
 * Renders are keyed by the identity of the layer parts that affect pixels (immer keeps unchanged
 * sub-objects identical) plus bitmap versions, and are scheduled off the interaction path.
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Document, ID, Layer } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { cloneCanvas } from '../core/canvas';
import { renderThumbnail } from '../render/compositor';

/* ------------------------------------------------------------------ */
/* Bitmap version subscription (throttled)                             */
/* ------------------------------------------------------------------ */

/** Re-render when any of the given bitmaps change (at most every `throttle` ms). */
export function useBitmapVersions(ids: (ID | null | undefined)[], throttle = 250): number {
  const [tick, setTick] = useState(0);
  const key = ids.filter(Boolean).join('|');
  useEffect(() => {
    if (!key) return;
    const set = new Set(key.split('|'));
    let timer = 0;
    let last = 0;
    const unsub = bitmaps.subscribe((id) => {
      if (!set.has(id) || timer) return;
      const wait = Math.max(0, throttle - (performance.now() - last));
      timer = window.setTimeout(() => {
        timer = 0;
        last = performance.now();
        setTick((t) => t + 1);
      }, wait);
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [key, throttle]);
  return tick;
}

/* ------------------------------------------------------------------ */
/* Render scheduling                                                   */
/* ------------------------------------------------------------------ */

type Job = () => void;
const queue: Job[] = [];
let scheduled = false;

/** Run thumbnail renders in small batches after the current interaction frame. */
function schedule(job: Job) {
  queue.push(job);
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    const start = performance.now();
    while (queue.length && performance.now() - start < 12) {
      const j = queue.shift()!;
      try {
        j();
      } catch (err) {
        console.warn('[panels] thumbnail render failed', err);
      }
    }
    if (queue.length) window.setTimeout(run, 16);
    else scheduled = false;
  };
  window.setTimeout(run, 30);
}

/* ------------------------------------------------------------------ */
/* Keys & cache                                                        */
/* ------------------------------------------------------------------ */

/** Values that change whenever the layer's rendered pixels may change. */
export function layerThumbKey(doc: Document, l: Layer): unknown[] {
  const common: unknown[] = [doc.width, doc.height, l.type, l.effects, l.filters, l.mask, l.mask ? bitmaps.version(l.mask.bitmapId) : 0];
  switch (l.type) {
    case 'raster':
      return [...common, l.bitmapId, bitmaps.version(l.bitmapId), l.transform, l.width, l.height];
    case 'text':
      return [...common, l.text, l.transform];
    case 'shape':
      return [...common, l.shape, l.transform];
    case 'fill':
      return [...common, l.fill];
    default:
      return [...common, l];
  }
}

const sameKey = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

interface CacheEntry {
  key: unknown[];
  canvas: HTMLCanvasElement;
}
const layerCache = new Map<string, CacheEntry>();

function cacheKey(doc: Document, id: ID, size: number) {
  return `${doc.id}:${id}:${size}`;
}

function drawFitted(target: HTMLCanvasElement | null, src: HTMLCanvasElement | null) {
  if (!target) return;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);
  if (!src || !src.width || !src.height) return;
  const s = Math.min(target.width / src.width, target.height / src.height);
  const w = Math.max(1, src.width * s);
  const h = Math.max(1, src.height * s);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (target.width - w) / 2, (target.height - h) / 2, w, h);
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

const DPR = () => Math.min(2, window.devicePixelRatio || 1);

/** Thumbnail of one layer's pixels (renderThumbnail), drawn on a checkerboard tile. */
export const LayerThumbCanvas = memo(function LayerThumbCanvas({
  doc,
  layer,
  size,
  className,
  style,
}: {
  doc: Document;
  layer: Layer;
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bmpIds = [layer.type === 'raster' ? layer.bitmapId : null, layer.mask?.bitmapId];
  const tick = useBitmapVersions(bmpIds);
  const px = Math.round(size * DPR());
  const key = layerThumbKey(doc, layer);
  const ck = cacheKey(doc, layer.id, px);
  // Collapse the key into a version number so the effect deps keep a constant size.
  const keyRef = useRef<unknown[]>([]);
  const verRef = useRef(0);
  if (!sameKey(keyRef.current, key)) {
    keyRef.current = key;
    verRef.current++;
  }
  const ver = verRef.current;

  useEffect(() => {
    const cached = layerCache.get(ck);
    if (cached) drawFitted(ref.current, cached.canvas);
    if (sameKey(cached?.key, key)) return;
    let cancelled = false;
    // Snapshot what we render now; a newer effect run cancels this one.
    const docSnap = doc;
    const keySnap = key;
    schedule(() => {
      if (cancelled) return;
      // renderThumbnail returns a shared cached canvas: keep our own copy.
      const c = cloneCanvas(renderThumbnail(docSnap, layer.id, px));
      layerCache.set(ck, { key: keySnap, canvas: c });
      if (layerCache.size > 600) layerCache.delete(layerCache.keys().next().value as string);
      drawFitted(ref.current, c);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ck, tick, ver]);

  return <canvas ref={ref} width={px} height={px} className={className} style={{ width: size, height: size, ...style }} />;
});

/** Thumbnail of a layer mask (grayscale), cached by bitmap version. */
export const MaskThumbCanvas = memo(function MaskThumbCanvas({
  doc,
  bitmapId,
  size,
  className,
}: {
  doc: Document;
  bitmapId: ID;
  size: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tick = useBitmapVersions([bitmapId]);
  const px = Math.round(size * DPR());
  useEffect(() => {
    let cancelled = false;
    schedule(() => {
      if (cancelled) return;
      const src = bitmaps.tryGet(bitmapId);
      const el = ref.current;
      if (!el) return;
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      const s = Math.min(el.width / doc.width, el.height / doc.height);
      const w = doc.width * s;
      const h = doc.height * s;
      const x = (el.width - w) / 2;
      const y = (el.height - h) / 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
      if (!src) return;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, src.width, src.height, x, y, w, h);
    });
    return () => {
      cancelled = true;
    };
  }, [bitmapId, tick, px, doc.width, doc.height]);
  return <canvas ref={ref} width={px} height={px} className={className} style={{ width: size, height: size }} />;
});

/**
 * Whole-document thumbnail (renderThumbnail(doc, null)), re-rendered at most every `throttle` ms
 * after document or bitmap changes. Fills the given CSS size keeping the aspect ratio.
 */
export function useDocumentThumbnail(doc: Document | null, maxPx: number, throttle = 200): HTMLCanvasElement | null {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [bmpTick, setBmpTick] = useState(0);
  const docRef = useRef(doc);
  docRef.current = doc;
  const sizeRef = useRef(maxPx);
  sizeRef.current = maxPx;
  const timer = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    let t = 0;
    const unsub = bitmaps.subscribe(() => {
      if (t) return;
      t = window.setTimeout(() => {
        t = 0;
        setBmpTick((x) => x + 1);
      }, throttle);
    });
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, [throttle]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Throttle (not debounce): during continuous edits the thumbnail still refreshes every
  // `throttle` ms; the scheduled render always picks up the latest document.
  useEffect(() => {
    if (!doc || maxPx < 4) {
      window.clearTimeout(timer.current);
      timer.current = 0;
      setCanvas(null);
      return;
    }
    if (timer.current) return;
    const wait = Math.max(0, throttle - (performance.now() - last.current));
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      last.current = performance.now();
      const d = docRef.current;
      if (!d || sizeRef.current < 4) return;
      try {
        setCanvas(cloneCanvas(renderThumbnail(d, null, Math.round(sizeRef.current))));
      } catch (err) {
        console.warn('[panels] document thumbnail failed', err);
      }
    }, wait);
  }, [doc, bmpTick, maxPx, throttle]);

  return canvas;
}

/** Draws a given canvas fitted into a fixed-size element. */
export function CanvasView({ canvas, width, height, className }: { canvas: HTMLCanvasElement | null; width: number; height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = DPR();
  useEffect(() => drawFitted(ref.current, canvas), [canvas, width, height]);
  return (
    <canvas
      ref={ref}
      width={Math.max(1, Math.round(width * dpr))}
      height={Math.max(1, Math.round(height * dpr))}
      className={className}
      style={{ width, height }}
    />
  );
}
