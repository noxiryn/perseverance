/**
 * Lazy asset thumbnail: requests a cached render only when the card scrolls into view.
 */
import { useEffect, useRef, useState } from 'react';
import type { ParamValues } from '../../core/types';
import { getThumb, requestThumb, stableKey } from '../lib/thumbs';

export function AssetThumb({
  assetId,
  params,
  size = 128,
  square,
  badge,
  onCanvas,
}: {
  assetId: string;
  params?: ParamValues;
  size?: number;
  square?: boolean;
  badge?: string;
  /** Receives the rendered thumbnail (used as the drag image). */
  onCanvas?: (c: HTMLCanvasElement) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const pk = params ? stableKey(params) : '';
  const onCanvasRef = useRef(onCanvas);
  onCanvasRef.current = onCanvas;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const draw = (c: HTMLCanvasElement) => {
      const cv = canvas.current;
      if (!cv) return;
      cv.width = c.width;
      cv.height = c.height;
      cv.getContext('2d')?.drawImage(c, 0, 0);
      setReady(true);
      onCanvasRef.current?.(c);
    };
    const hit = getThumb(assetId, params, size);
    if (hit) {
      draw(hit);
      return;
    }
    setReady(false);
    let cancel: (() => void) | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          cancel = requestThumb(assetId, draw, params, size);
        }
      },
      { rootMargin: '160px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancel?.();
    };
    // params are tracked through their stable key (pk)
  }, [assetId, size, pk]);

  return (
    <div ref={wrap} className={`assets-thumb${square ? ' square' : ''}`}>
      {!ready && <div className="assets-skel" />}
      <canvas ref={canvas} className={ready ? undefined : 'empty'} />
      {badge && <span className="assets-badge">{badge}</span>}
    </div>
  );
}
