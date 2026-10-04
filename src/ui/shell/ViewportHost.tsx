/**
 * Mounts the canvas viewport from src/viewport/Viewport.tsx (export `Viewport`), loaded lazily via
 * import.meta.glob so the app builds whether or not the file exists yet. Falls back to an empty
 * dotted canvas.
 */
import { lazy, Suspense, type ComponentType } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

const modules = import.meta.glob<{ Viewport?: ComponentType }>('../../viewport/Viewport.tsx');
const loader = Object.values(modules)[0];

const LazyViewport = loader
  ? lazy(async () => {
      const m = await loader();
      return { default: m.Viewport ?? ViewportFallback };
    })
  : null;

export const hasViewport = !!loader;

export function ViewportFallback({ message }: { message?: string }) {
  return (
    <div className="shell-canvas-fallback">
      {message && <div className="shell-canvas-fallback-msg">{message}</div>}
    </div>
  );
}

export function ViewportHost() {
  if (!LazyViewport) return <ViewportFallback message="Canvas viewport is not available in this build" />;
  return (
    <ErrorBoundary name="Canvas">
      <Suspense fallback={<ViewportFallback />}>
        <LazyViewport />
      </Suspense>
    </ErrorBoundary>
  );
}
