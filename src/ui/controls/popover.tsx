import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, ChevronRight } from 'lucide-react';
import { formatShortcut } from '../shortcuts';
import { insideLaterLayer, pushEscapeLayer, type EscapeLayer } from './escapeLayers';

/* ---------------- Popover ---------------- */

/**
 * A floating panel anchored to an element (or a point). Closes on outside click / Escape (only
 * the innermost open popover / menu / dialog reacts to Escape — escapeLayers.ts).
 * Renders into document.body.
 */
export function Popover({
  anchor,
  onClose,
  children,
  placement = 'bottom-start',
  width,
  className,
}: {
  anchor: HTMLElement | { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
  placement?: 'bottom-start' | 'bottom-end' | 'right-start' | 'left-start' | 'top-start';
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const el = ref.current;
    const pr = el.getBoundingClientRect();
    let left: number, top: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      if (placement === 'right-start') {
        left = r.right + 6;
        top = r.top;
      } else if (placement === 'left-start') {
        left = r.left - pr.width - 6;
        top = r.top;
      } else if (placement === 'top-start') {
        left = r.left;
        top = r.top - pr.height - 6;
      } else if (placement === 'bottom-end') {
        left = r.right - pr.width;
        top = r.bottom + 4;
      } else {
        left = r.left;
        top = r.bottom + 4;
      }
    } else {
      left = anchor.x;
      top = anchor.y;
    }
    left = Math.max(6, Math.min(left, window.innerWidth - pr.width - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - pr.height - 6));
    setPos({ left, top });
  }, [anchor, placement]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const layerRef = useRef<EscapeLayer | null>(null);
  const open = !!anchor;

  // Escape: registered once per opening (a re-render must not move this popover above one opened
  // from inside it). Only the innermost surface closes; see escapeLayers.ts.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    const openedFrom = anchorRef.current;
    let byEscape = false;
    const layer: EscapeLayer = {
      kind: 'floating',
      close: () => {
        byEscape = true;
        closeRef.current();
      },
      contains: (node) => !!ref.current?.contains(node),
    };
    layerRef.current = layer;
    const pop = pushEscapeLayer(layer);
    return () => {
      pop();
      if (layerRef.current === layer) layerRef.current = null;
      // Closed with Escape inside a dialog — or inside a popover opened from one (a gradient stop's
      // colour picker) — while focus was in it or nowhere: give focus back to the control that opened
      // it, not <body>, so keyboard users go on from there. (Outside dialogs and popovers focus stays
      // put: Space must still pan.)
      const anchorEl = anchorRef.current ?? openedFrom;
      const opener = anchorEl instanceof HTMLElement ? anchorEl : null;
      const active = document.activeElement;
      const lost = !active || active === document.body || !!el?.contains(active);
      const home = opener?.closest<HTMLElement>('.ui-dialog, .ui-popover') ?? null;
      if (byEscape && lost && opener && home) {
        requestAnimationFrame(() => {
          const now = document.activeElement;
          if ((now && now !== document.body) || !opener.isConnected || opener.closest('[inert]')) return;
          opener.focus({ preventScroll: true });
          // An opener that can't take focus: keep focus in its dialog (keyboard users stay there).
          if (document.activeElement !== opener && home.isConnected) home.closest<HTMLElement>('.ui-dialog')?.focus({ preventScroll: true });
        });
      }
    };
  }, [open]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
        // A click in a popover / menu opened from this one (a colour picker inside the gradient
        // editor) is not outside.
        if (layerRef.current && insideLaterLayer(layerRef.current, e.target)) return;
        onClose();
      }
    };
    // Defer so the opening click does not immediately close.
    const t = window.setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
    };
  }, [onClose, anchor]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={['ui-popover', className].filter(Boolean).join(' ')}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ---------------- Menus (dropdown + context menu) ---------------- */

export interface MenuItem {
  label?: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Section heading (non-interactive). */
  heading?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  run?: () => void;
}

interface MenuState {
  menu: { items: MenuItem[]; x: number; y: number; minWidth?: number } | null;
  open(items: MenuItem[], x: number, y: number, minWidth?: number): void;
  close(): void;
}

export const useMenuStore = create<MenuState>()((set) => ({
  menu: null,
  open: (items, x, y, minWidth) => set({ menu: { items, x, y, minWidth } }),
  close: () => set({ menu: null }),
}));

/** Show a context menu at a screen point (e.g. from onContextMenu). */
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  useMenuStore.getState().open(items, e.clientX, e.clientY);
}

/** Show a dropdown menu below an element. */
export function showMenuAt(el: HTMLElement, items: MenuItem[], minWidth?: number) {
  const r = el.getBoundingClientRect();
  useMenuStore.getState().open(items, r.left, r.bottom + 2, minWidth);
}

export function MenuList({
  items,
  x,
  y,
  onClose,
  minWidth,
  depth = 0,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  minWidth?: number;
  depth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const subTimer = useRef<number>(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x,
      top = y;
    if (left + r.width > window.innerWidth - 4) left = depth > 0 ? x - r.width - 200 : window.innerWidth - r.width - 4;
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ left: Math.max(4, left), top });
  }, [x, y, depth]);

  return (
    <>
      <div
        ref={ref}
        className="ui-menu"
        style={{ left: pos.left, top: pos.top, minWidth }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it.separator) return <div key={i} className="ui-menu-sep" />;
          if (it.heading) return <div key={i} className="ui-menu-heading">{it.label}</div>;
          const Icon = it.icon;
          return (
            <div
              key={i}
              className={`ui-menu-item${it.disabled ? ' disabled' : ''}${sub?.index === i ? ' hl' : ''}`}
              onPointerEnter={(e) => {
                window.clearTimeout(subTimer.current);
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                if (it.submenu) subTimer.current = window.setTimeout(() => setSub({ index: i, x: r.right - 2, y: r.top - 4 }), 120);
                else subTimer.current = window.setTimeout(() => setSub(null), 150);
              }}
              onClick={() => {
                if (it.submenu) {
                  const r = (ref.current!.children[i] as HTMLElement).getBoundingClientRect();
                  setSub({ index: i, x: r.right - 2, y: r.top - 4 });
                  return;
                }
                onClose();
                it.run?.();
              }}
            >
              <span className="check">{it.checked ? <Check size={12} /> : Icon ? <Icon size={13} strokeWidth={1.6} /> : null}</span>
              <span>{it.label}</span>
              {it.shortcut && <span className="shortcut">{formatShortcut(it.shortcut)}</span>}
              {it.submenu && <ChevronRight size={12} style={{ marginLeft: 'auto' }} />}
            </div>
          );
        })}
      </div>
      {sub && items[sub.index]?.submenu && (
        <MenuList items={items[sub.index].submenu!} x={sub.x} y={sub.y} onClose={onClose} depth={depth + 1} />
      )}
    </>
  );
}

/** Mount once at the app root: renders the global context/dropdown menu. */
export function MenuHost() {
  const menu = useMenuStore((s) => s.menu);
  const close = useMenuStore((s) => s.close);
  useEffect(() => {
    if (!menu) return;
    const down = () => close();
    // Escape closes the menu only (not the dialog / popover it was opened from): escapeLayers.ts.
    const pop = pushEscapeLayer({
      kind: 'floating',
      close,
      contains: (node) => !!(node instanceof Element ? node : node.parentElement)?.closest('.ui-menu'),
    });
    const t = window.setTimeout(() => {
      window.addEventListener('pointerdown', down);
      window.addEventListener('blur', down);
    }, 0);
    return () => {
      pop();
      window.clearTimeout(t);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('blur', down);
    };
  }, [menu, close]);
  if (!menu) return null;
  return createPortal(<MenuList items={menu.items} x={menu.x} y={menu.y} minWidth={menu.minWidth} onClose={close} />, document.body);
}
