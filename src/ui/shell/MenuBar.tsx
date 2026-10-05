/**
 * Application menu bar built from the commands registry.
 *  - Click opens a menu; while one is open, hovering another top-level item switches to it.
 *  - Keyboard: Alt focuses the bar (mnemonics underlined), ←/→ move, ↓/Enter open, ↑/↓ move in
 *    menus, → opens submenus / next menu, ← closes submenus / previous menu, Enter runs, Esc closes.
 *  - enabled()/checked() are evaluated when a menu opens.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { commands, useRegistry, type CommandDef } from '../../registry';
import { formatShortcut } from '../shortcuts';
import { toast } from '../../state/ui';
import { buildMenuTree, MENU_MNEMONICS, shortcutAlternatives, type MenuTreeNode, type TopMenu } from './menuModel';
import { useShell } from './shellStore';
import { shellPortalHost, toCss } from './uiScale';

/* ------------------------------------------------------------------ */
/* Evaluated rows                                                   */
/* ------------------------------------------------------------------ */

type Row =
  | { kind: 'sep' }
  | {
      kind: 'item';
      label: string;
      shortcut?: string;
      enabled: boolean;
      checked: boolean;
      icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
      command?: CommandDef;
      children?: Row[];
    };

function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  if (!fn) return fallback;
  try {
    return fn();
  } catch (e) {
    console.warn('[menu] command state check failed', e);
    return fallback;
  }
}

function evaluate(nodes: MenuTreeNode[]): Row[] {
  const rows: Row[] = [];
  for (const n of nodes) {
    if (n.kind === 'separator') {
      if (rows.length && rows[rows.length - 1].kind !== 'sep') rows.push({ kind: 'sep' });
    } else if (n.kind === 'command') {
      const c = n.command;
      rows.push({
        kind: 'item',
        label: c.label,
        shortcut: shortcutAlternatives(c.shortcut)[0],
        enabled: safe(c.enabled?.bind(c), true),
        checked: safe(c.checked?.bind(c), false),
        icon: c.icon,
        command: c,
      });
    } else {
      const children = evaluate(n.children);
      rows.push({ kind: 'item', label: n.label, enabled: children.some((r) => r.kind === 'item' && r.enabled), checked: false, children });
    }
  }
  while (rows.length && rows[rows.length - 1].kind === 'sep') rows.pop();
  return rows;
}

/**
 * Run a command, reporting failures (sync or async) as toasts. Menus and the palette defer the run
 * (`defer`) so they can unmount before a dialog opens; keyboard shortcuts run immediately.
 */
export function runCommandSafely(c: CommandDef, defer = true) {
  const exec = () => {
    try {
      if (c.enabled && !c.enabled()) return;
      const r = c.run();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((e: unknown) => {
          console.error(e);
          toast(`${c.label}: ${(e as Error)?.message ?? e}`, 'error', 4000);
        });
      }
    } catch (e) {
      console.error(e);
      toast(`${c.label}: ${(e as Error)?.message ?? e}`, 'error', 4000);
    }
  };
  if (defer) window.setTimeout(exec, 0);
  else exec();
}

const selectable = (r: Row | undefined) => !!r && r.kind === 'item';

function nextSelectable(rows: Row[], from: number, dir: 1 | -1): number {
  const n = rows.length;
  if (!n) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (selectable(rows[i])) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Dropdown (multi-level)                                              */
/* ------------------------------------------------------------------ */

interface LevelProps {
  rows: Row[];
  x: number;
  y: number;
  /** Right edge alternative when flipping a submenu to the left. */
  flipX?: number;
  hl: number;
  openChild: number;
  level: number;
  onHover(level: number, index: number): void;
  onActivate(level: number, index: number): void;
  itemRef(level: number, index: number, el: HTMLDivElement | null): void;
  guard: PointerGuard;
}

/**
 * Guards pointerup activation: the release that ends the click which opened a menu must never run
 * an item that happens to sit under the cursor. An item runs on pointerup only after the pointer
 * went down on it or moved over it, and not within the first moments after the menu opened.
 */
interface PointerGuard {
  openedAt: number;
  armed: string | null;
}

const ACTIVATE_DELAY_MS = 150;

/** Gap kept between a menu and the bottom of the window (visual px). */
const MENU_MARGIN = 8;

/**
 * Where a menu level goes (visual px). Top-level menus never move above their anchor (they would
 * cover the menu bar and put an item under the opening click): they keep `top = y` and get a max
 * height instead, so a tall menu scrolls. Submenus may shift up to fit, but never above the window
 * and never taller than it.
 */
export function placeMenu(
  o: { x: number; y: number; flipX?: number; width: number; height: number; level: number },
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  let left = o.x;
  if (left + o.width > viewport.width - 4) left = o.flipX !== undefined ? Math.max(4, o.flipX - o.width) : Math.max(4, viewport.width - o.width - 4);
  let top = o.y;
  if (o.level > 0 && top + o.height > viewport.height - MENU_MARGIN) top = Math.max(4, viewport.height - o.height - MENU_MARGIN);
  top = Math.max(0, Math.min(top, viewport.height - 48));
  return { left, top, maxHeight: Math.max(40, viewport.height - top - MENU_MARGIN) };
}

/**
 * Scroll a menu item into its (scrollable) menu, keeping the menu padding visible around it. Used for
 * keyboard navigation of tall menus that scroll; hover never scrolls (the pointer is already on it).
 */
export function revealMenuItem(el: HTMLElement) {
  const menu = el.offsetParent instanceof HTMLElement ? el.offsetParent : el.parentElement;
  if (!menu || menu.scrollHeight <= menu.clientHeight + 1) return;
  const next = menuScrollFor(menu.scrollTop, menu.clientHeight, el.offsetTop, el.offsetHeight);
  if (next !== menu.scrollTop) menu.scrollTop = next;
}

/** scrollTop that brings [itemTop, itemTop+itemHeight] fully into view with the least movement. */
export function menuScrollFor(scrollTop: number, viewH: number, itemTop: number, itemH: number, pad = 4): number {
  const top = itemTop - pad;
  const bottom = itemTop + itemH + pad;
  if (top < scrollTop) return Math.max(0, top);
  if (bottom > scrollTop + viewH) return Math.max(0, bottom - viewH);
  return scrollTop;
}

function MenuLevel({ rows, x, y, flipX, hl, openChild, level, onHover, onActivate, itemRef, guard }: LevelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number; ready: boolean }>({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Natural (unclipped) height in visual px: the rect may already be capped by max-height.
    const toVisual = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
    const naturalH = r.height + Math.max(0, el.scrollHeight - el.clientHeight) * toVisual;
    const p = placeMenu({ x, y, flipX, width: r.width, height: naturalH, level }, { width: window.innerWidth, height: window.innerHeight });
    setPos({ ...p, ready: true });
  }, [x, y, flipX, rows, level]);

  return (
    <div
      ref={ref}
      className="shell-menu"
      data-shell-menu=""
      role="menu"
      // Positions are measured in visual px; the portal host may carry the UI-scale CSS zoom.
      style={{
        left: toCss(pos.left),
        top: toCss(pos.top),
        maxHeight: pos.maxHeight !== undefined ? toCss(pos.maxHeight) : undefined,
        visibility: pos.ready ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((r, i) => {
        if (r.kind === 'sep') return <div key={i} className="shell-menu-sep" />;
        const Icon = r.icon;
        const cls = ['shell-menu-item', !r.enabled && 'disabled', (hl === i || openChild === i) && 'hl'].filter(Boolean).join(' ');
        return (
          <div
            key={i}
            ref={(el) => itemRef(level, i, el)}
            className={cls}
            role="menuitem"
            aria-disabled={!r.enabled}
            onPointerEnter={() => onHover(level, i)}
            onPointerDown={() => {
              guard.armed = `${level}:${i}`;
            }}
            onPointerMove={() => {
              guard.armed = `${level}:${i}`;
            }}
            onPointerUp={(e) => {
              if (e.button !== 0) return;
              if (guard.armed !== `${level}:${i}` || performance.now() - guard.openedAt < ACTIVATE_DELAY_MS) return;
              onActivate(level, i);
            }}
          >
            <span className="shell-menu-check">
              {r.checked ? <Check size={12} strokeWidth={2.2} /> : Icon ? <Icon size={13} strokeWidth={1.6} /> : null}
            </span>
            <span className="shell-menu-label">{r.label}</span>
            {r.shortcut && !r.children && <span className="shell-menu-shortcut">{formatShortcut(r.shortcut)}</span>}
            {r.children && <ChevronRight size={12} className="shell-menu-sub" />}
          </div>
        );
      })}
      {!rows.length && <div className="shell-menu-empty">No items yet</div>}
    </div>
  );
}

interface DropdownProps {
  rows: Row[];
  anchor: DOMRect;
  keyboard: boolean;
  onClose(): void;
  onNavigate(dir: 1 | -1): void;
}

function MenuDropdown({ rows, anchor, keyboard, onClose, onNavigate }: DropdownProps) {
  /** Highlighted index per open level. */
  const [path, setPath] = useState<number[]>(() => [keyboard ? nextSelectable(rows, -1, 1) : -1]);
  const items = useRef(new Map<string, HTMLDivElement>());
  const hoverTimer = useRef(0);
  const [, force] = useState(0);
  const forced = useRef('');
  const guard = useRef<PointerGuard>({ openedAt: performance.now(), armed: null }).current;
  /** Set by keyboard navigation: reveal the new highlight once it has rendered. */
  const revealHl = useRef(false);

  const levelRows = useCallback(
    (level: number): Row[] | null => {
      let cur: Row[] = rows;
      for (let l = 0; l < level; l++) {
        const r = cur[path[l]];
        if (!r || r.kind !== 'item' || !r.children) return null;
        cur = r.children;
      }
      return cur;
    },
    [rows, path],
  );

  const activate = useCallback(
    (level: number, index: number) => {
      const lr = levelRows(level);
      const r = lr?.[index];
      if (!r || r.kind !== 'item' || !r.enabled) return;
      if (r.children) {
        window.clearTimeout(hoverTimer.current);
        setPath((p) => [...p.slice(0, level), index, nextSelectable(r.children!, -1, 1)]);
        return;
      }
      onClose();
      if (r.command) runCommandSafely(r.command);
    },
    [levelRows, onClose],
  );

  const hover = useCallback(
    (level: number, index: number) => {
      window.clearTimeout(hoverTimer.current);
      setPath((p) => {
        const base = [...p.slice(0, level), index];
        return base;
      });
      const lr = levelRows(level);
      const r = lr?.[index];
      if (r && r.kind === 'item' && r.children && r.enabled) {
        hoverTimer.current = window.setTimeout(() => {
          setPath((p) => (p[level] === index ? [...p.slice(0, level + 1), -1] : p));
        }, 140);
      }
    },
    [levelRows],
  );

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Keyboard navigation (capture: the menu owns the keyboard while open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const depth = path.length - 1;
      const lr = levelRows(depth) ?? [];
      const cur = path[depth];
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
        // Tab is swallowed without moving the highlight; everything else may move it.
        if (e.key !== 'Tab') revealHl.current = true;
      };
      switch (e.key) {
        case 'ArrowDown':
          handled();
          setPath((p) => [...p.slice(0, depth), nextSelectable(lr, cur, 1)]);
          return;
        case 'ArrowUp':
          handled();
          setPath((p) => [...p.slice(0, depth), nextSelectable(lr, cur < 0 ? 0 : cur, -1)]);
          return;
        case 'ArrowRight': {
          handled();
          const r = lr[cur];
          if (r && r.kind === 'item' && r.children && r.enabled) activate(depth, cur);
          else onNavigate(1);
          return;
        }
        case 'ArrowLeft':
          handled();
          if (depth > 0) setPath((p) => p.slice(0, depth));
          else onNavigate(-1);
          return;
        case 'Enter':
        case ' ':
          handled();
          if (cur >= 0) activate(depth, cur);
          return;
        case 'Escape':
          handled();
          if (depth > 0) setPath((p) => p.slice(0, depth));
          else onClose();
          return;
        case 'Tab':
          handled();
          return;
        case 'Alt':
          handled();
          onClose();
          return;
        default:
          if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
            handled();
            const ch = e.key.toLowerCase();
            const n = lr.length;
            for (let k = 1; k <= n; k++) {
              const i = (cur + k + n) % n;
              const r = lr[i];
              if (r && r.kind === 'item' && r.label.toLowerCase().startsWith(ch)) {
                setPath((p) => [...p.slice(0, depth), i]);
                break;
              }
            }
          } else if (!['Shift', 'Control', 'Meta'].includes(e.key)) {
            // Any other shortcut closes the menu and lets the key through.
            onClose();
          }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [path, levelRows, activate, onClose, onNavigate]);

  // Build levels with positions.
  const levels: { rows: Row[]; x: number; y: number; flipX?: number }[] = [];
  levels.push({ rows, x: anchor.left, y: anchor.bottom + 2 });
  for (let l = 0; l < path.length - 1; l++) {
    const lr = levelRows(l + 1);
    const el = items.current.get(`${l}:${path[l]}`);
    if (!lr || !el) break;
    const r = el.getBoundingClientRect();
    levels.push({ rows: lr, x: r.right + 1, y: r.top - 5, flipX: r.left - 1 });
  }

  const itemRef = useCallback((level: number, index: number, el: HTMLDivElement | null) => {
    const k = `${level}:${index}`;
    if (el) {
      if (items.current.get(k) !== el) {
        items.current.set(k, el);
      }
    } else items.current.delete(k);
  }, []);

  // Keyboard moves in a tall (scrolling) menu: keep the highlighted item visible.
  useLayoutEffect(() => {
    if (!revealHl.current) return;
    revealHl.current = false;
    const depth = path.length - 1;
    const el = items.current.get(`${depth}:${path[depth]}`);
    if (el) revealMenuItem(el);
  });

  // Submenu positions depend on item elements; re-render once after they mount.
  const pathKey = path.join(',');
  useLayoutEffect(() => {
    if (levels.length < path.length && forced.current !== pathKey) {
      forced.current = pathKey;
      force((n) => n + 1);
    }
  });

  return createPortal(
    <>
      {levels.map((lv, l) => (
        <MenuLevel
          key={l}
          level={l}
          rows={lv.rows}
          x={lv.x}
          y={lv.y}
          flipX={lv.flipX}
          hl={l === path.length - 1 ? path[l] : -1}
          openChild={l < path.length - 1 ? path[l] : -1}
          onHover={hover}
          onActivate={activate}
          itemRef={itemRef}
          guard={guard}
        />
      ))}
    </>,
    shellPortalHost(),
  );
}

/* ------------------------------------------------------------------ */
/* Menu bar                                                            */
/* ------------------------------------------------------------------ */

function MenuLabel({ name, underline }: { name: string; underline: boolean }) {
  const m = MENU_MNEMONICS[name as TopMenu];
  if (!underline || !m) return <>{name}</>;
  const i = name.toUpperCase().indexOf(m);
  if (i < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, i)}
      <u>{name[i]}</u>
      {name.slice(i + 1)}
    </>
  );
}

export function MenuBar() {
  const cmds = useRegistry(commands);
  const tree = useMemo(() => buildMenuTree(cmds), [cmds]);
  const menuOpen = useShell((s) => s.menuOpen);
  const menuFocus = useShell((s) => s.menuFocus);
  const mnemonics = useShell((s) => s.mnemonics);
  const setMenuOpen = useShell((s) => s.setMenuOpen);
  const setMenuFocus = useShell((s) => s.setMenuFocus);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const [openInfo, setOpenInfo] = useState<{ rows: Row[]; rect: DOMRect; keyboard: boolean; stamp: number } | null>(null);

  const open = useCallback(
    (i: number, keyboard: boolean) => {
      const m = tree[i];
      const el = btns.current[i];
      if (!m || !el) return;
      setOpenInfo({ rows: evaluate(m.items), rect: el.getBoundingClientRect(), keyboard, stamp: Date.now() });
      setMenuOpen(i);
    },
    [tree, setMenuOpen],
  );

  const close = useCallback(() => {
    setOpenInfo(null);
    setMenuOpen(null);
  }, [setMenuOpen]);

  // Keep store + local state in sync if something else closes the menu.
  useEffect(() => {
    if (menuOpen === null && openInfo) setOpenInfo(null);
    else if (menuOpen !== null && !openInfo) open(menuOpen, true);
  }, [menuOpen, openInfo, open]);

  // Outside click closes.
  useEffect(() => {
    if (menuOpen === null && menuFocus === null) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-shell-menu]') || barRef.current?.contains(t)) return;
      close();
      setMenuFocus(null);
    };
    const blur = () => {
      close();
      setMenuFocus(null);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [menuOpen, menuFocus, close, setMenuFocus]);

  // Keyboard while the bar is focused (Alt mode) but no menu is open.
  useEffect(() => {
    if (menuFocus === null || menuOpen !== null) return;
    const n = tree.length;
    const onKey = (e: KeyboardEvent) => {
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowRight') {
        handled();
        setMenuFocus((menuFocus + 1) % n);
      } else if (e.key === 'ArrowLeft') {
        handled();
        setMenuFocus((menuFocus - 1 + n) % n);
      } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        handled();
        open(menuFocus, true);
      } else if (e.key === 'Escape' || e.key === 'Alt' || e.key === 'Tab') {
        handled();
        setMenuFocus(null);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        handled();
        const idx = tree.findIndex((m) => MENU_MNEMONICS[m.name as TopMenu]?.toLowerCase() === e.key.toLowerCase());
        if (idx >= 0) open(idx, true);
      } else if (!['Shift', 'Control', 'Meta'].includes(e.key)) {
        setMenuFocus(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menuFocus, menuOpen, tree, open, setMenuFocus]);

  const navigate = useCallback(
    (dir: 1 | -1) => {
      if (menuOpen === null) return;
      const n = tree.length;
      open((menuOpen + dir + n) % n, true);
    },
    [menuOpen, tree.length, open],
  );

  return (
    <div className="shell-menubar app-no-drag" role="menubar" ref={barRef}>
      {tree.map((m, i) => (
        <button
          key={m.name}
          ref={(el) => {
            btns.current[i] = el;
          }}
          className={['shell-menubar-item', menuOpen === i && 'open', menuFocus === i && menuOpen === null && 'focus'].filter(Boolean).join(' ')}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuOpen === i}
          tabIndex={-1}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (menuOpen === i) close();
            else open(i, false);
          }}
          onPointerEnter={() => {
            if (menuOpen !== null && menuOpen !== i) open(i, false);
          }}
        >
          <MenuLabel name={m.name} underline={mnemonics} />
        </button>
      ))}
      {openInfo && menuOpen !== null && (
        <MenuDropdown key={openInfo.stamp} rows={openInfo.rows} anchor={openInfo.rect} keyboard={openInfo.keyboard} onClose={close} onNavigate={navigate} />
      )}
    </div>
  );
}

/** Open a top-level menu by its mnemonic letter (used by the global Alt+letter handler). */
export function openMenuByMnemonic(letter: string): boolean {
  const tree = buildMenuTree(commands.list());
  const idx = tree.findIndex((m) => MENU_MNEMONICS[m.name as TopMenu]?.toLowerCase() === letter.toLowerCase());
  if (idx < 0) return false;
  useShell.setState({ mnemonics: true });
  useShell.getState().setMenuOpen(idx);
  return true;
}
