/**
 * <Viewport/> — the canvas viewport (fills its parent). Two stacked DPR-aware canvases
 * (document + overlay) over a dotted canvas background; all drawing and input is handled by
 * ViewportEngine. Mounted by the shell (src/ui/shell/ViewportHost.tsx) and the ?view=1 harness.
 */
import { useEffect, useRef } from 'react';
import { useEditor } from '../state/editor';
import { ViewportEngine } from './engine';
import './lifecycle';
import './viewport.css';

export function Viewport() {
  const rootRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const hasDoc = useEditor((s) => !!s.activeDocId && !!s.sessions[s.activeDocId]);

  useEffect(() => {
    const root = rootRef.current;
    const dc = docRef.current;
    const oc = ovRef.current;
    if (!root || !dc || !oc) return;
    const engine = new ViewportEngine(root, dc, oc);
    engine.mount();
    return () => engine.unmount();
  }, []);

  return (
    <div ref={rootRef} className="viewport-root" tabIndex={-1} data-viewport="">
      <canvas ref={docRef} className="viewport-doc" />
      <canvas ref={ovRef} className="viewport-overlay" />
      {!hasDoc && (
        <div className="viewport-empty">
          <span>No document open — create one with Ctrl+N or open an image with Ctrl+O</span>
        </div>
      )}
    </div>
  );
}

export default Viewport;
