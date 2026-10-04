/**
 * Right dock: resizable column of three panel groups (tabs, ⋯ menu, collapse, splitters, tab
 * drag & drop between groups) plus the 34px icon strip with 320px flyout panels.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronsLeft, ChevronsRight, Ellipsis, Minus, PanelRightDashed, X } from 'lucide-react';
import { panels, useRegistry } from '../../registry';
import { useUI, type DockGroupState } from '../../state/ui';
import { showMenuAt, type MenuItem } from '../controls';
import { ErrorBoundary } from './ErrorBoundary';
import { PANEL_MIME, panelIcon, panelTitle } from './panelMeta';
import { useShell } from './shellStore';
import { Tip } from './Toolbar';
import { toCss } from './uiScale';
import { movePanel, removePanel, type DropTarget } from './workspaces';

type Slot = DockGroupState['slot'];

/* ------------------------------------------------------------------ */
/* Panel content                                                       */
/* ------------------------------------------------------------------ */

export function PanelContent({ id }: { id: string }) {
  useRegistry(panels); // re-render when panels register later
  const def = panels.get(id);
  if (!def) {
    const Icon = panelIcon(id);
    return (
      <div className="shell-panel-placeholder">
        <Icon size={22} strokeWidth={1.4} />
        <div className="shell-panel-placeholder-title">{panelTitle(id)}</div>
        <div className="shell-panel-placeholder-text">This panel isn’t available yet.</div>
      </div>
    );
  }
  const C = def.component;
  return (
    <ErrorBoundary name={`${def.title} panel`} resetKey={id}>
      <C />
    </ErrorBoundary>
  );
}

function panelMenuItems(id: string): MenuItem[] {
  const def = panels.get(id);
  if (!def?.menu) return [];
  try {
    return def.menu().map((m) => ({ label: m.label, checked: m.checked, disabled: m.disabled, run: m.run }));
  } catch (e) {
    console.warn('[dock] panel menu failed', e);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Drag & drop helpers                                                 */
/* ------------------------------------------------------------------ */

function dragPanelStart(e: React.DragEvent, id: string) {
  e.dataTransfer.setData(PANEL_MIME, id);
  e.dataTransfer.effectAllowed = 'move';
}

const hasPanel = (e: React.DragEvent) => e.dataTransfer.types.includes(PANEL_MIME);

function dropPanel(e: React.DragEvent, target: DropTarget) {
  const id = e.dataTransfer.getData(PANEL_MIME);
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  const ui = useUI.getState();
  ui.setWorkspace(movePanel(ui.workspace, id, target));
}

/**
 * Track a resize drag started on `e.currentTarget`: pointer capture keeps the moves coming when
 * the pointer leaves the handle, and the drag ends on pointerup, pointercancel (touch / pen) or
 * capture loss, so it can never stay stuck. Listeners sit on window because a captured element
 * that unmounts mid-drag reports the capture loss on the document.
 */
export function trackDrag(e: React.PointerEvent<HTMLElement>, cursorClass: string, onMove: (ev: PointerEvent) => void) {
  const el = e.currentTarget;
  const id = e.pointerId;
  try {
    el.setPointerCapture(id);
  } catch {
    /* pointer already released */
  }
  document.body.classList.add(cursorClass);
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === id) onMove(ev);
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    document.body.classList.remove(cursorClass);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('lostpointercapture', end);
    try {
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      /* element gone */
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('lostpointercapture', end);
}

/** Index to insert at, based on pointer x over the tab buttons. */
function insertIndex(container: HTMLElement, clientX: number): number {
  const tabs = [...container.querySelectorAll<HTMLElement>('[data-tab]')];
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

/* ------------------------------------------------------------------ */
/* Panel group                                                         */
/* ------------------------------------------------------------------ */

function PanelGroup({ g, groupRef }: { g: DockGroupState; groupRef: (el: HTMLDivElement | null) => void }) {
  useRegistry(panels);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const ui = useUI.getState;

  const openMenu = (el: HTMLElement) => {
    const id = g.active;
    const own = panelMenuItems(id);
    const items: MenuItem[] = [
      ...(own.length ? [...own, { separator: true }] : []),
      { label: g.collapsed ? 'Expand Panel Group' : 'Collapse Panel Group', run: () => ui().setGroupCollapsed(g.slot, !g.collapsed) },
      { label: `Move ${panelTitle(id)} to Icon Strip`, run: () => ui().setWorkspace(movePanel(ui().workspace, id, { kind: 'strip' })) },
      { label: `Close ${panelTitle(id)}`, run: () => ui().setWorkspace(removePanel(ui().workspace, id)) },
    ];
    showMenuAt(el, items, 200);
  };

  return (
    <div
      ref={groupRef}
      data-slot={g.slot}
      className={`shell-group${g.collapsed ? ' collapsed' : ''}`}
      style={g.collapsed ? { flex: '0 0 auto' } : { flex: `${g.size} 1 0px` }}
    >
      <div
        className="shell-group-head"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          ui().setGroupCollapsed(g.slot, !g.collapsed);
        }}
        onDragOver={(e) => {
          if (!hasPanel(e) || !tabsRef.current) return;
          e.preventDefault();
          setDropAt(insertIndex(tabsRef.current, e.clientX));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          const idx = tabsRef.current ? insertIndex(tabsRef.current, e.clientX) : undefined;
          setDropAt(null);
          dropPanel(e, { kind: 'group', slot: g.slot, index: idx });
        }}
      >
        <div className="shell-group-tabs" ref={tabsRef}>
          {g.tabs.map((id, i) => (
            <Fragment key={id}>
              {dropAt === i && <span className="shell-drop-caret" />}
              <button
                data-tab={id}
                className={`shell-group-tab${id === g.active && !g.collapsed ? ' active' : ''}${id === g.active ? ' current' : ''}`}
                draggable
                onDragStart={(e) => dragPanelStart(e, id)}
                onClick={() => ui().setGroupActive(g.slot, id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (id !== g.active) ui().setGroupActive(g.slot, id);
                  openMenu(e.currentTarget);
                }}
              >
                {panelTitle(id)}
              </button>
            </Fragment>
          ))}
          {dropAt === g.tabs.length && <span className="shell-drop-caret" />}
        </div>
        <div className="shell-group-actions">
          <button className="shell-group-btn" title="Panel menu" onClick={(e) => openMenu(e.currentTarget)}>
            <Ellipsis size={13} />
          </button>
          <button
            className="shell-group-btn round"
            title={g.collapsed ? 'Expand' : 'Collapse'}
            onClick={() => ui().setGroupCollapsed(g.slot, !g.collapsed)}
          >
            {g.collapsed ? <ChevronDown size={11} strokeWidth={2} /> : <Minus size={11} strokeWidth={2} />}
          </button>
        </div>
      </div>
      {!g.collapsed && (
        <div className="shell-group-body">
          <PanelContent key={g.active} id={g.active} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dock column                                                         */
/* ------------------------------------------------------------------ */

function Splitter({ above, below, getEl }: { above: DockGroupState; below: DockGroupState; getEl: (slot: Slot) => HTMLDivElement | null }) {
  const active = !above.collapsed && !below.collapsed;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0) return;
    const a = getEl(above.slot);
    const b = getEl(below.slot);
    if (!a || !b) return;
    e.preventDefault();
    // All measurements are visual px (rects and clientY), so the ratio is zoom-independent.
    const startY = e.clientY;
    const hA = a.getBoundingClientRect().height;
    const hB = b.getBoundingClientRect().height;
    const W = above.size + below.size;
    const H = hA + hB;
    const visualPerCss = H / Math.max(1, a.offsetHeight + b.offsetHeight);
    const MIN = Math.min(96 * visualPerCss, H / 2); // 96 CSS px minimum group height
    trackDrag(e, 'shell-resizing-row', (ev) => {
      const nA = Math.max(MIN, Math.min(H - MIN, hA + (ev.clientY - startY)));
      const wA = (W * nA) / H;
      const ui = useUI.getState();
      ui.setGroupSize(above.slot, wA);
      ui.setGroupSize(below.slot, W - wA);
    });
  };
  return <div className={`shell-splitter${active ? ' active' : ''}`} onPointerDown={onPointerDown} />;
}

function DockColumn() {
  const ws = useUI((s) => s.workspace);
  const width = useUI((s) => s.dockWidth);
  const els = useRef(new Map<Slot, HTMLDivElement>());
  const groups = ws.groups.filter((g) => g.tabs.length);
  const allCollapsed = groups.every((g) => g.collapsed);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = useUI.getState().dockWidth;
    // dockWidth is in CSS px of the (possibly CSS-zoomed) UI; pointer deltas are visual px.
    trackDrag(e, 'shell-resizing-col', (ev) => useUI.getState().setDockWidth(startW + toCss(startX - ev.clientX)));
  };

  return (
    <div className="shell-dock" style={{ width }}>
      <div className="shell-dock-resize" onPointerDown={startResize} onDoubleClick={() => useUI.getState().setDockWidth(268)} title="Drag to resize" />
      {groups.map((g, i) => (
        <Fragment key={g.slot}>
          {i > 0 && <Splitter above={groups[i - 1]} below={g} getEl={(s) => els.current.get(s) ?? null} />}
          <PanelGroup
            g={g}
            groupRef={(el) => {
              if (el) els.current.set(g.slot, el);
              else els.current.delete(g.slot);
            }}
          />
        </Fragment>
      ))}
      {(allCollapsed || !groups.length) && (
        <div
          className="shell-dock-filler"
          onDragOver={(e) => hasPanel(e) && e.preventDefault()}
          onDrop={(e) => dropPanel(e, { kind: 'group', slot: (groups[groups.length - 1]?.slot ?? 'bottom') as Slot })}
        >
          {!groups.length && <span>Drag panels here, or open them from the Window menu</span>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Strip + flyout                                                      */
/* ------------------------------------------------------------------ */

function Strip() {
  const ws = useUI((s) => s.workspace);
  const flyout = useUI((s) => s.flyoutPanel);
  const collapsed = useShell((s) => s.dockCollapsed);
  const setCollapsed = useShell((s) => s.setDockCollapsed);
  useRegistry(panels);
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null);
  const tipTimer = useRef(0);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sections: string[][] = [];
  if (collapsed) for (const g of ws.groups) if (g.tabs.length) sections.push(g.tabs);
  if (ws.strip.length) sections.push(ws.strip);

  const showTip = (el: HTMLElement, name: string) => {
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setTip({ name, x: r.left - 8, y: r.top + r.height / 2 });
    }, 450);
  };
  const hideTip = () => {
    window.clearTimeout(tipTimer.current);
    setTip(null);
  };
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);

  const stripIndex = (clientY: number) => {
    const icons = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-strip-own]') ?? [])];
    for (let i = 0; i < icons.length; i++) {
      const r = icons[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return icons.length;
  };

  return (
    <div className="shell-strip">
      <button
        className="shell-strip-toggle"
        title={collapsed ? 'Expand panels' : 'Collapse panels to icons'}
        onClick={() => {
          setCollapsed(!collapsed);
          useUI.getState().setFlyout(null);
        }}
      >
        {collapsed ? <ChevronsLeft size={13} /> : <ChevronsRight size={13} />}
      </button>
      <div
        className="shell-strip-list"
        ref={listRef}
        onDragOver={(e) => {
          if (!hasPanel(e)) return;
          e.preventDefault();
          setDropAt(stripIndex(e.clientY));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          const idx = stripIndex(e.clientY);
          setDropAt(null);
          dropPanel(e, { kind: 'strip', index: idx });
        }}
      >
        {sections.map((ids, si) => {
          const own = si === sections.length - 1 && ids === ws.strip;
          return (
            <div key={si} className="shell-strip-section">
              {ids.map((id, i) => {
                const Icon = panelIcon(id);
                return (
                  <Fragment key={id}>
                    {own && dropAt === i && <span className="shell-drop-caret h" />}
                    <button
                      data-strip-panel={id}
                      {...(own ? { 'data-strip-own': '' } : {})}
                      className={`shell-strip-btn${flyout === id ? ' active' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        hideTip();
                        dragPanelStart(e, id);
                      }}
                      onPointerEnter={(e) => showTip(e.currentTarget, panelTitle(id))}
                      onPointerLeave={hideTip}
                      onClick={() => {
                        hideTip();
                        useUI.getState().setFlyout(flyout === id ? null : id);
                      }}
                      aria-label={panelTitle(id)}
                    >
                      <Icon size={15} strokeWidth={1.6} />
                    </button>
                  </Fragment>
                );
              })}
              {own && dropAt === ids.length && <span className="shell-drop-caret h" />}
            </div>
          );
        })}
        {!ws.strip.length && !collapsed && <div className="shell-strip-drop-hint" title="Drag a panel tab here" />}
      </div>
      <Tip tip={tip} side="left" />
    </div>
  );
}

function Flyout({ sideRef }: { sideRef: React.RefObject<HTMLDivElement | null> }) {
  const id = useUI((s) => s.flyoutPanel);
  useRegistry(panels);
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(8);
  const [height, setHeight] = useState(560);

  useLayoutEffect(() => {
    if (!id || !sideRef.current) return;
    // Measured in visual px, applied as CSS px of the (possibly CSS-zoomed) UI.
    const side = sideRef.current.getBoundingClientRect();
    const sideH = toCss(side.height);
    const icon = sideRef.current.querySelector<HTMLElement>(`[data-strip-panel="${CSS.escape(id)}"]`);
    const avail = sideH - 16;
    const h = Math.min(avail, Math.max(380, Math.min(620, avail)));
    let t = icon ? toCss(icon.getBoundingClientRect().top - side.top) - 6 : 8;
    t = Math.max(8, Math.min(t, sideH - h - 8));
    setTop(t);
    setHeight(h);
  }, [id, sideRef]);

  // Close on outside click (ignoring portals opened from inside the panel).
  useEffect(() => {
    if (!id) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || ref.current?.contains(t)) return;
      if (t.closest('.shell-strip, .ui-popover, .ui-menu, .ui-dialog-backdrop, [data-shell-menu], .shell-pal-backdrop')) return;
      useUI.getState().setFlyout(null);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [id]);

  const onMenu = useCallback(
    (el: HTMLElement) => {
      if (!id) return;
      const own = panelMenuItems(id);
      const ui = useUI.getState;
      showMenuAt(
        el,
        [
          ...(own.length ? [...own, { separator: true }] : []),
          { label: 'Dock in Panel Group', run: () => ui().setWorkspace(movePanel(ui().workspace, id, { kind: 'group', slot: 'bottom' })) },
          { label: 'Close', run: () => ui().setFlyout(null) },
        ],
        180,
      );
    },
    [id],
  );

  if (!id) return null;
  const Icon = panelIcon(id);
  return (
    <div ref={ref} className="shell-flyout" style={{ top, height }}>
      <div className="shell-flyout-head">
        <Icon size={13} strokeWidth={1.7} />
        <span className="shell-flyout-title">{panelTitle(id)}</span>
        <button className="shell-group-btn" title="Panel menu" onClick={(e) => onMenu(e.currentTarget)}>
          <Ellipsis size={13} />
        </button>
        <button className="shell-group-btn" title="Close" onClick={() => useUI.getState().setFlyout(null)}>
          <X size={13} />
        </button>
      </div>
      <div className="shell-flyout-body">
        <PanelContent key={id} id={id} />
      </div>
    </div>
  );
}

/** Strip + dock + flyout (hidden entirely when panels are toggled off with Tab). */
export function DockArea() {
  const visible = useUI((s) => s.dockVisible);
  const collapsed = useShell((s) => s.dockCollapsed);
  const sideRef = useRef<HTMLDivElement>(null);
  if (!visible) {
    return (
      <div className="shell-side-hidden">
        <button className="shell-strip-toggle" title="Show panels (Tab)" onClick={() => useUI.setState({ dockVisible: true })}>
          <PanelRightDashed size={13} />
        </button>
      </div>
    );
  }
  return (
    <div className="shell-side" ref={sideRef}>
      <Strip />
      {!collapsed && <DockColumn />}
      <Flyout sideRef={sideRef} />
    </div>
  );
}

