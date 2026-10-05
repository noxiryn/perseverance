/**
 * Navigator panel (id 'navigator'): document thumbnail with the visible viewport area (drag to
 * pan, click to jump, wheel to zoom), Fit / 100% / 150% / 200% pills, log-scale zoom slider.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Compass } from 'lucide-react';
import { useEditor } from '../state/editor';
import { useUI } from '../state/ui';
import { viewport } from '../editor/viewport';
import { NumberField, Slider } from '../ui/controls';
import { CanvasView, useDocumentThumbnail } from './thumbs';
import './panels.css';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;
const PRESETS: { label: string; zoom: number | 'fit' }[] = [
  { label: 'Fit', zoom: 'fit' },
  { label: '100%', zoom: 1 },
  { label: '150%', zoom: 1.5 },
  { label: '200%', zoom: 2 },
];
const PAD = 12;
const PILLS_H = 34;

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * Re-render whenever the viewport element changes size (viewport.getSize() is not reactive):
 * dock resizes, collapsing / opening panel groups and window resizes all move the visible area.
 * The element is observed with a ResizeObserver, re-attached when the viewport (re)mounts.
 */
function useViewportSizeTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    let observed: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;
    const bump = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setTick((t) => t + 1));
    };
    const attach = () => {
      const el = viewport.element();
      if (el === observed) return;
      ro?.disconnect();
      ro = null;
      observed = el;
      if (el) {
        ro = new ResizeObserver(bump);
        ro.observe(el);
      }
      bump();
    };
    attach();
    // The viewport may mount after us or be re-created (e.g. when the first document opens).
    const unsubEditor = useEditor.subscribe((s, p) => {
      if (s.activeDocId !== p.activeDocId || s.docOrder !== p.docOrder) window.setTimeout(attach, 0);
    });
    const unsubUI = useUI.subscribe((s, p) => {
      if (s.dockWidth !== p.dockWidth || s.dockVisible !== p.dockVisible || s.workspace !== p.workspace) {
        attach();
        bump();
      }
    });
    const poll = window.setInterval(attach, 1500);
    window.addEventListener('resize', bump);
    return () => {
      ro?.disconnect();
      unsubEditor();
      unsubUI();
      window.clearInterval(poll);
      window.removeEventListener('resize', bump);
      cancelAnimationFrame(raf);
    };
  }, []);
}

export function NavigatorPanel() {
  const doc = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.doc ?? null) : null));
  const view = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.view ?? null) : null));
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const [dragging, setDragging] = useState(false);
  useViewportSizeTick();

  const availW = Math.max(0, stage.width - PAD * 2);
  const availH = Math.max(0, stage.height - PAD * 2 - PILLS_H);
  const scale = doc ? Math.max(0.0001, Math.min(availW / doc.width, availH / doc.height)) : 1;
  const dispW = doc ? doc.width * scale : 0;
  const dispH = doc ? doc.height * scale : 0;
  const left = (stage.width - dispW) / 2;
  const top = PAD + (availH - dispH) / 2;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const thumb = useDocumentThumbnail(doc, Math.max(dispW, dispH) * dpr, 200);

  const zoom = view && view.zoom ? view.zoom : viewport.zoom();

  // Visible document area.
  let rect: { x: number; y: number; w: number; h: number } | null = null;
  if (doc && view) {
    const vs = viewport.getSize();
    const tl = viewport.screenToDoc({ x: 0, y: 0 });
    const br = viewport.screenToDoc({ x: vs.width, y: vs.height });
    const x0 = Math.max(0, tl.x);
    const y0 = Math.max(0, tl.y);
    const x1 = Math.min(doc.width, br.x);
    const y1 = Math.min(doc.height, br.y);
    if (x1 > x0 && y1 > y0) rect = { x: left + x0 * scale, y: top + y0 * scale, w: (x1 - x0) * scale, h: (y1 - y0) * scale };
  }

  const centerOn = (x: number, y: number) => {
    if (!doc) return;
    // Keep the view centered somewhere on the document (never pan it completely away).
    const docX = Math.max(0, Math.min(doc.width, x));
    const docY = Math.max(0, Math.min(doc.height, y));
    const z = viewport.zoom();
    useEditor.getState().setView({ panX: z * (doc.width / 2 - docX), panY: z * (doc.height / 2 - docY) });
    viewport.requestRender();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!doc || e.button !== 0 || (e.target as HTMLElement).closest('.layers-nav-pills')) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const toDoc = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: (cx - r.left - left) / scale, y: (cy - r.top - top) / scale };
    };
    // Grab inside the view rectangle keeps the grab offset; outside jumps the center there.
    const p0 = toDoc(e.clientX, e.clientY);
    const vs = viewport.getSize();
    const c0 = viewport.screenToDoc({ x: vs.width / 2, y: vs.height / 2 });
    const r = el.getBoundingClientRect();
    const lx = e.clientX - r.left;
    const ly = e.clientY - r.top;
    const inside = rect && lx >= rect.x && lx <= rect.x + rect.w && ly >= rect.y && ly <= rect.y + rect.h;
    const off = inside ? { x: p0.x - c0.x, y: p0.y - c0.y } : { x: 0, y: 0 };
    if (!inside) centerOn(p0.x, p0.y);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const p = toDoc(ev.clientX, ev.clientY);
      centerOn(p.x - off.x, p.y - off.y);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragging(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const setZoom = (z: number) => {
    viewport.zoomTo(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)));
    viewport.requestRender();
  };

  return (
    <div className="layers-nav">
      <div
        ref={stageRef}
        className={`layers-nav-stage${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onWheel={(e) => {
          if (!doc) return;
          setZoom(viewport.zoom() * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        }}
      >
        {!doc ? (
          <div className="layers-empty" style={{ height: '100%', justifyContent: 'center' }}>
            <Compass size={22} strokeWidth={1.4} />
            <div>No document open</div>
          </div>
        ) : (
          <>
            <div className="layers-nav-doc" style={{ left, top, width: dispW, height: dispH }}>
              <CanvasView canvas={thumb} width={dispW} height={dispH} />
            </div>
            {rect && <div className="layers-nav-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
          </>
        )}
        <div className="layers-nav-pills" onPointerDown={(e) => e.stopPropagation()}>
          {PRESETS.map((p) => {
            const active = !!doc && p.zoom !== 'fit' && Math.abs(zoom - p.zoom) < 0.001;
            return (
              <button
                key={p.label}
                className={`layers-nav-pill${active ? ' active' : ''}`}
                disabled={!doc}
                title={p.zoom === 'fit' ? 'Fit on screen' : `Zoom to ${p.label}`}
                onClick={() => {
                  if (p.zoom === 'fit') viewport.fit();
                  else setZoom(p.zoom);
                  viewport.requestRender();
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="layers-nav-zoom" style={doc ? undefined : { opacity: 0.45, pointerEvents: 'none' }}>
        <div className="layers-nav-zoom-head">
          <span className="ui-label">Zoom</span>
          <NumberField
            value={doc ? zoom : 1}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.1}
            displayScale={100}
            unit="%"
            title="Zoom level"
            onChange={(v) => doc && setZoom(v)}
          />
        </div>
        <Slider
          value={Math.log(doc ? zoom : 1)}
          min={Math.log(MIN_ZOOM)}
          max={Math.log(MAX_ZOOM)}
          step={0.01}
          showNumber={false}
          onChange={(v) => doc && setZoom(Math.exp(v))}
        />
      </div>
    </div>
  );
}
