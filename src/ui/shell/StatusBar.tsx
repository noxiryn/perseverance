/**
 * 24px status bar: Shortcuts button, editable zoom, color mode, doc sizes, pixel size, cursor
 * position, statusItems registry, Units select and Fit.
 */
import { useEffect, useRef, useState } from 'react';
import { Crosshair, Keyboard } from 'lucide-react';
import { runCommand, statusItems, useRegistry } from '../../registry';
import { useActiveDoc, useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { releaseSelectFocus, selectFocusHandlers } from '../controls';
import { clientToViewport, docSizeLabel, formatZoom, zoomToApply } from './docInfo';
import { ErrorBoundary } from './ErrorBoundary';

function ZoomField({ disabled }: { disabled: boolean }) {
  const zoom = useEditor((s) => (s.activeDocId ? (s.sessions[s.activeDocId]?.view.zoom ?? 0) : 0));
  // zoom 0 = not fitted yet (the viewport fits on first render).
  const label = disabled || !zoom ? '—' : formatZoom(zoom);
  const [text, setText] = useState(label);
  const focused = useRef(false);
  /** Set by Esc: the blur that follows must not apply the typed text. */
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(label);
  }, [label]);
  const commit = (value: string) => {
    const z = zoomToApply(value, label, zoom);
    if (z !== null) viewport.zoomTo(z);
    setText(z !== null ? formatZoom(z) : label);
  };
  return (
    <input
      className="shell-status-zoom"
      value={text}
      disabled={disabled}
      title="Zoom — type a value and press Enter"
      onFocus={(e) => {
        focused.current = true;
        cancelled.current = false;
        e.target.select();
      }}
      onBlur={(e) => {
        focused.current = false;
        if (cancelled.current) {
          cancelled.current = false;
          setText(label);
          return;
        }
        commit(e.currentTarget.value);
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const f = e.key === 'ArrowUp' ? 1.25 : 0.8;
          viewport.zoomBy(f);
        }
      }}
    />
  );
}

/** Track the pointer over the viewport element and convert to document coordinates. */
function useCursorDocPos(): { x: number; y: number } | null {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    let last: PointerEvent | null = null;
    const update = () => {
      raf = 0;
      const e = last;
      const el = viewport.element();
      if (!e || !el) return setPos(null);
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom && el.contains(e.target as Node);
      if (!inside) return setPos(null);
      const p = viewport.screenToDoc(clientToViewport(e.clientX, e.clientY, r, el.clientWidth, el.clientHeight));
      setPos((prev) => {
        const nx = Math.floor(p.x);
        const ny = Math.floor(p.y);
        return prev && prev.x === nx && prev.y === ny ? prev : { x: nx, y: ny };
      });
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onLeave = () => {
      last = null;
      setPos(null);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return pos;
}

function fmtUnit(v: number, total: number, units: 'px' | '%') {
  return units === '%' ? `${((v / Math.max(1, total)) * 100).toFixed(1)}%` : `${v}`;
}

export function StatusBar() {
  const doc = useActiveDoc();
  const units = useUI((s) => s.units);
  const setUnits = useUI((s) => s.setUnits);
  const items = useRegistry(statusItems);
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const cursor = useCursorDocPos();

  return (
    <div className="shell-statusbar">
      <button className="shell-status-btn" onClick={() => runCommand('help.shortcuts')} title="Keyboard shortcuts (F1)">
        <Keyboard size={11} strokeWidth={1.8} />
        Shortcuts
      </button>
      <span className="shell-status-sep" />
      <ZoomField disabled={!doc} />
      <span className="shell-status-sep" />
      <span className="shell-status-item strong">RGB Color · 8 bit</span>
      {doc && (
        <>
          <span className="shell-status-sep" />
          <span className="shell-status-item">{docSizeLabel(doc)}</span>
          <span className="shell-status-sep" />
          <span className="shell-status-item" title="Document size">
            {doc.width} × {doc.height} px
          </span>
          <span className="shell-status-sep" />
          <span className="shell-status-item shell-status-cursor" title="Cursor position">
            <Crosshair size={10} strokeWidth={1.8} />
            {cursor ? (
              <>
                X <b>{fmtUnit(cursor.x, doc.width, units)}</b> Y <b>{fmtUnit(cursor.y, doc.height, units)}</b>
              </>
            ) : (
              <span className="dim">—</span>
            )}
          </span>
        </>
      )}
      {sorted.map((it) => {
        const C = it.component;
        return (
          <span key={it.id} className="shell-status-custom">
            <span className="shell-status-sep" />
            <ErrorBoundary inline name={it.id}>
              <C />
            </ErrorBoundary>
          </span>
        );
      })}
      <span className="shell-status-spacer" />
      <span className="shell-status-label">Units</span>
      <select
        className="shell-status-select"
        value={units}
        {...selectFocusHandlers}
        onChange={(e) => {
          setUnits(e.target.value as 'px' | '%');
          releaseSelectFocus(e.currentTarget);
        }}
      >
        <option value="px">Pixels</option>
        <option value="%">Percent</option>
      </select>
      <button className="shell-status-btn" disabled={!doc} onClick={() => viewport.fit()} title="Fit on screen (Ctrl+0)">
        Fit
      </button>
    </div>
  );
}
