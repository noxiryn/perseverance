/**
 * Mounts the canvas viewport from src/viewport/Viewport.tsx (export `Viewport`), loaded lazily via
 * import.meta.glob so the app builds whether or not the file exists yet. While it loads (or if it
 * is missing) a static, fitted preview of the active document is shown on the dotted canvas.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import { useActiveDoc } from '../../state/editor';
import { renderDocument } from '../../render/compositor';
import { ErrorBoundary } from './ErrorBoundary';

const modules = import.meta.glob<{ Viewport?: ComponentType }>('../../viewport/Viewport.tsx');
const loader = Object.values(modules)[0];

const LazyViewport = loader
  ? lazy(async () => {
      const m = await loader();
      return { default: m.Viewport ?? (() => <ViewportFallback message="Canvas viewport failed to load" />) };
    })
  : null;

export const hasViewport = !!loader;

/** Fit a w×h box inside an area with padding; never upscale beyond 1:1. */
export function fitScale(w: number, h: number, areaW: number, areaH: number, padding = 48): number {
  if (w <= 0 || h <= 0 || areaW <= 0 || areaH <= 0) return 0;
  return Math.max(0.01, Math.min(1, (areaW - padding * 2) / w, (areaH - padding * 2) / h));
}

/** Static composite of the active document, centered and fitted (read-only). */
function DocPreview() {
  const doc = useActiveDoc();
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scale = doc ? fitScale(doc.width, doc.height, size.w, size.h) : 0;

  useEffect(() => {
    const c = canvasRef.current;
    if (!doc || !c || !scale) return;
    const raf = requestAnimationFrame(() => {
      try {
        const dpr = window.devicePixelRatio || 1;
        const s = Math.min(1, scale * dpr);
        const src = renderDocument(doc, { scale: s });
        c.width = src.width;
        c.height = src.height;
        c.getContext('2d')?.drawImage(src, 0, 0);
      } catch (e) {
        console.warn('[shell] preview render failed', e);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [doc, scale]);

  return (
    <div ref={box} className="shell-canvas-fallback">
      {doc && scale > 0 && (
        <canvas
          ref={canvasRef}
          className="shell-doc-preview"
          style={{ width: Math.round(doc.width * scale), height: Math.round(doc.height * scale) }}
        />
      )}
    </div>
  );
}

export function ViewportFallback({ message }: { message?: string }) {
  return (
    <>
      <DocPreview />
      {message && (
        <div className="shell-canvas-fallback-note">
          <span className="shell-canvas-fallback-msg">{message}</span>
        </div>
      )}
    </>
  );
}

export function ViewportHost() {
  if (!LazyViewport) return <ViewportFallback message="Preview only — the canvas viewport is not available in this build" />;
  return (
    <ErrorBoundary name="Canvas">
      <Suspense fallback={<ViewportFallback />}>
        <LazyViewport />
      </Suspense>
    </ErrorBoundary>
  );
}
