/**
 * Left toolbar: one slot per tool group (last used tool shown, corner triangle when the group
 * has siblings), flyout on right-click / long-press, delayed tooltips, section separators,
 * foreground/background colors with swap (X) and reset (D).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight } from 'lucide-react';
import { tools, useRegistry, type ToolDef } from '../../registry';
import { useEditor } from '../../state/editor';
import { ColorPicker, Popover } from '../controls';
import { buildToolSlots, nextInSlot, type ToolSlot } from './toolModel';
import { useToolMemory } from './toolMemory';
import { shellPortalHost, toCss } from './uiScale';

/* ---------------- Tooltip ---------------- */

interface TipState {
  name: string;
  shortcut?: string;
  hint?: string;
  x: number;
  y: number;
}

function useDelayedTip(delay = 500) {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef(0);
  const show = useCallback(
    (el: HTMLElement, name: string, shortcut?: string, hint?: string) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        setTip({ name, shortcut, hint, x: r.right + 8, y: r.top + r.height / 2 });
      }, delay);
    },
    [delay],
  );
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setTip(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { tip, show, hide };
}

/** Delayed tooltip; x/y are visual px (from getBoundingClientRect). */
export function Tip({ tip, side = 'right' }: { tip: TipState | null; side?: 'right' | 'left' }) {
  if (!tip) return null;
  return createPortal(
    <div className={`ui-tooltip shell-tip${side === 'left' ? ' left' : ''}`} style={{ left: toCss(tip.x), top: toCss(tip.y) }}>
      <span className="shell-tip-name">{tip.name}</span>
      {tip.shortcut && <kbd>{tip.shortcut}</kbd>}
      {tip.hint && <div className="shell-tip-hint">{tip.hint}</div>}
    </div>,
    shellPortalHost(),
  );
}

/* ---------------- Flyout ---------------- */

function ToolFlyout({ slot, anchor, onClose }: { slot: ToolSlot; anchor: HTMLElement; onClose: () => void }) {
  const active = useEditor((s) => s.activeTool);
  return (
    <Popover anchor={anchor} onClose={onClose} placement="right-start" className="shell-tool-flyout">
      {slot.tools.map((t) => {
        const Icon = t.icon;
        return (
          <div
            key={t.id}
            className={`shell-tool-flyout-item${t.id === active ? ' active' : ''}`}
            onClick={() => {
              useEditor.getState().setTool(t.id);
              onClose();
            }}
          >
            <span className="shell-tool-flyout-mark">{t.id === slot.current.id ? '■' : ''}</span>
            <Icon size={15} strokeWidth={1.6} />
            <span className="shell-tool-flyout-name">{t.name}</span>
            {t.shortcut && <span className="shell-tool-flyout-key">{t.shortcut}</span>}
          </div>
        );
      })}
    </Popover>
  );
}

/* ---------------- Slot ---------------- */

function ToolSlotButton({
  slot,
  active,
  onFlyout,
  tipShow,
  tipHide,
}: {
  slot: ToolSlot;
  active: boolean;
  onFlyout: (slot: ToolSlot, el: HTMLElement) => void;
  tipShow: (el: HTMLElement, name: string, shortcut?: string, hint?: string) => void;
  tipHide: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const press = useRef<{ timer: number; fired: boolean }>({ timer: 0, fired: false });
  const t = slot.current;
  const Icon = t.icon;
  const multi = slot.tools.length > 1;

  const select = (tool: ToolDef) => useEditor.getState().setTool(tool.id);

  return (
    <button
      ref={ref}
      className={`shell-tool${active ? ' active' : ''}`}
      aria-label={t.name}
      aria-pressed={active}
      onPointerDown={(e) => {
        tipHide();
        if (e.button !== 0) return;
        press.current.fired = false;
        window.clearTimeout(press.current.timer);
        if (multi) {
          press.current.timer = window.setTimeout(() => {
            press.current.fired = true;
            if (ref.current) onFlyout(slot, ref.current);
          }, 380);
        }
      }}
      onPointerUp={() => window.clearTimeout(press.current.timer)}
      onPointerLeave={() => {
        window.clearTimeout(press.current.timer);
        tipHide();
      }}
      onPointerEnter={(e) =>
        tipShow(e.currentTarget, t.name, t.shortcut, multi ? `${slot.tools.length} tools · right-click for more` : undefined)
      }
      onClick={(e) => {
        if (press.current.fired) return;
        if (e.altKey && multi) select(nextInSlot(slot));
        else select(t);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        tipHide();
        if (multi && ref.current) onFlyout(slot, ref.current);
      }}
    >
      <Icon size={16} strokeWidth={1.6} />
      {multi && <span className="shell-tool-tri" />}
    </button>
  );
}

/* ---------------- Colors ---------------- */

function ColorChips() {
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const [edit, setEdit] = useState<{ which: 'primary' | 'secondary'; el: HTMLElement } | null>(null);
  const { tip, show, hide } = useDelayedTip();
  const close = useCallback(() => setEdit(null), []);
  const ed = useEditor.getState;

  return (
    <div className="shell-colors">
      <div
        className="shell-color-chip bg"
        style={{ background: secondary }}
        onClick={(e) => {
          hide();
          setEdit({ which: 'secondary', el: e.currentTarget });
        }}
        onPointerEnter={(e) => show(e.currentTarget, 'Background color', undefined, secondary)}
        onPointerLeave={hide}
      />
      <div
        className="shell-color-chip fg"
        style={{ background: primary }}
        onClick={(e) => {
          hide();
          setEdit({ which: 'primary', el: e.currentTarget });
        }}
        onPointerEnter={(e) => show(e.currentTarget, 'Foreground color', undefined, primary)}
        onPointerLeave={hide}
      />
      <button
        className="shell-color-swap"
        onClick={() => ed().swapColors()}
        onPointerEnter={(e) => show(e.currentTarget, 'Swap colors', 'X')}
        onPointerLeave={hide}
        aria-label="Swap colors"
      >
        <ArrowLeftRight size={9} strokeWidth={2} />
      </button>
      <button
        className="shell-color-reset"
        onClick={() => ed().resetColors()}
        onPointerEnter={(e) => show(e.currentTarget, 'Default colors', 'D')}
        onPointerLeave={hide}
        aria-label="Default colors"
      >
        <span className="a" />
        <span className="b" />
      </button>
      {edit && (
        <Popover anchor={edit.el} onClose={close} placement="right-start">
          <div className="shell-color-pop-title">{edit.which === 'primary' ? 'Foreground color' : 'Background color'}</div>
          <ColorPicker
            value={edit.which === 'primary' ? primary : secondary}
            onChange={(c) => (edit.which === 'primary' ? ed().setPrimaryColor(c) : ed().setSecondaryColor(c))}
          />
        </Popover>
      )}
      <Tip tip={tip} />
    </div>
  );
}

/* ---------------- Toolbar ---------------- */

export function Toolbar() {
  const list = useRegistry(tools);
  const active = useEditor((s) => s.activeTool);
  const lastUsed = useToolMemory((s) => s.lastUsed);
  const slots = useMemo(() => buildToolSlots(list, lastUsed, active), [list, lastUsed, active]);
  const [flyout, setFlyout] = useState<{ slot: string; el: HTMLElement } | null>(null);
  const { tip, show, hide } = useDelayedTip();
  const closeFlyout = useCallback(() => setFlyout(null), []);
  const flySlot = flyout ? slots.find((s) => s.group === flyout.slot) : null;

  return (
    <div className="shell-toolbar" onContextMenu={(e) => e.preventDefault()}>
      <div className="shell-toolbar-tools">
        {slots.map((slot, i) => (
          <Fragment key={slot.group}>
            {i > 0 && slots[i - 1].section !== slot.section && <div className="shell-toolbar-sep" />}
            <ToolSlotButton
              slot={slot}
              active={slot.tools.some((t) => t.id === active)}
              onFlyout={(s, el) => setFlyout({ slot: s.group, el })}
              tipShow={show}
              tipHide={hide}
            />
          </Fragment>
        ))}
        {!slots.length && <div className="shell-toolbar-empty" title="Tools are loading" />}
      </div>
      <div className="shell-toolbar-sep" />
      <ColorChips />
      {flyout && flySlot && <ToolFlyout slot={flySlot} anchor={flyout.el} onClose={closeFlyout} />}
      <Tip tip={tip} />
    </div>
  );
}
