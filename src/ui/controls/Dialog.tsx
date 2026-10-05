import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { closeDialog, useUI } from '../../state/ui';

/** Entry id of the dialog being rendered (provided by DialogHost). */
const DialogIdContext = createContext<string | null>(null);

/** onClose handlers of mounted <Dialog> frames, keyed by dialog entry id (used by backdrop clicks). */
const closeHandlers = new Map<string, () => void>();

/** Text-entry inputs commit their typed value on blur (see NumberField / TextInput). */
function commitFocusedField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  const isText =
    tag === 'TEXTAREA' ||
    (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file'].includes((el as HTMLInputElement).type));
  if (!isText) return false;
  el.blur();
  return true;
}

/**
 * Enter on these elements does their own thing (activate a button/link, open a select, run a
 * search, newline in a textarea) and must not submit the dialog. Mark any element (or ancestor)
 * with data-enter-local to opt out as well.
 */
function enterBelongsToTarget(el: HTMLElement | null): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT') return true;
  if (tag === 'INPUT' && ['search', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes((el as HTMLInputElement).type)) return true;
  const role = el.getAttribute('role');
  if (role && ['button', 'link', 'option', 'menuitem', 'tab', 'combobox', 'listbox'].includes(role)) return true;
  return !!el.closest('[data-enter-local]');
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Inputs that take typed text (initial-focus candidates). */
const TEXT_ENTRY =
  'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([readonly]), textarea:not([disabled]):not([readonly])';

function isShown(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** Keyboard-focusable elements inside `root`, in tab order (document order; positive tabIndex is not used in the app). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.closest('[inert]') && isShown(el));
}

/**
 * Where focus goes when a dialog opens: an element that already took focus itself (autoFocus),
 * then an explicit [data-autofocus], the first text field, the primary footer button, any
 * focusable element, and finally the dialog frame itself.
 */
function initialFocusTarget(root: HTMLElement): HTMLElement {
  const pick = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].find((el) => el.tabIndex >= 0 && isShown(el));
  return (
    pick('[data-autofocus], [autofocus]') ??
    pick(TEXT_ENTRY) ??
    pick('.ui-dialog-foot .ui-btn.primary:not([disabled])') ??
    focusableIn(root).find((el) => !el.closest('.ui-dialog-head')) ??
    root
  );
}

/** Popovers / menus opened from inside a dialog live in portals outside it: leave Tab to them. */
const inFloatingUi = (el: Element | null) => !!el?.closest('.ui-popover, .ui-menu, [data-shell-menu]');

/**
 * Standard dialog frame. Use inside a component opened with `openDialog(Component, props)`:
 *
 *   function MyDialog({ close }: { close: (r?: string) => void }) {
 *     return <Dialog title="Hello" onClose={() => close()} footer={<Button onClick={() => close('ok')}>OK</Button>}>…</Dialog>;
 *   }
 *
 * Keyboard: Escape → onClose, Enter → onSubmit (not from textareas). Only the topmost dialog reacts.
 * Enter first blurs a focused text field so its typed value is committed before onSubmit runs.
 * A click on the backdrop calls onClose too (unless the dialog was opened with closeOnBackdrop:false).
 *
 * Focus: on open, focus moves into the dialog (an autoFocus element, else the first text field,
 * else the primary button, else the frame); Tab / Shift+Tab wrap inside the topmost dialog so
 * nothing behind the backdrop can be reached; on close, focus returns to where it was.
 */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  width,
  onSubmit,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number | string;
  /** Called on Enter (when focus is not in a textarea). */
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const entryId = useContext(DialogIdContext);
  const titleId = useId();
  // Latest onSubmit: after an Enter blur-commit the parent re-renders with fresh state before we submit.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  // Focus to restore on close: captured during the first render, before autoFocus children run.
  const restoreRef = useRef<Element | null | undefined>(undefined);
  if (restoreRef.current === undefined) restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const active = document.activeElement;
    if (!active || !root.contains(active)) {
      const target = initialFocusTarget(root);
      target.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement && target.matches(TEXT_ENTRY)) target.select();
    }
    const restore = restoreRef.current;
    return () => {
      // Runs after the dialog left the DOM. Give focus back unless something else took it meanwhile
      // (e.g. the next dialog in a chain focused its own field).
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      if (restore instanceof HTMLElement && restore !== document.body && restore.isConnected && !restore.closest('[inert]')) {
        restore.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (!entryId) return;
    closeHandlers.set(entryId, onClose);
    return () => {
      if (closeHandlers.get(entryId) === onClose) closeHandlers.delete(entryId);
    };
  }, [entryId, onClose]);

  useEffect(() => {
    const isTopmost = () => {
      const all = document.querySelectorAll('.ui-dialog');
      return all.length > 0 && all[all.length - 1] === ref.current;
    };
    const key = (e: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const root = ref.current;
        if (!root) return;
        const active = document.activeElement;
        if (inFloatingUi(active)) return;
        const items = focusableIn(root);
        if (!items.length) {
          e.preventDefault();
          root.focus({ preventScroll: true });
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const inside = !!active && root.contains(active);
        let next: HTMLElement | null = null;
        if (!inside) next = e.shiftKey ? last : first;
        else if (e.shiftKey && (active === first || active === root)) next = last;
        else if (!e.shiftKey && active === last) next = first;
        if (next) {
          e.preventDefault();
          next.focus({ preventScroll: true });
        }
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && onSubmit && !enterBelongsToTarget(e.target as HTMLElement | null)) {
        e.stopPropagation();
        e.preventDefault();
        // Let a focused NumberField/TextInput commit its typed text first (it commits on blur),
        // then submit with the re-rendered (latest) handler.
        if (commitFocusedField()) requestAnimationFrame(() => window.setTimeout(() => submitRef.current?.(), 0));
        else onSubmit();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, onSubmit]);

  return (
    <div
      ref={ref}
      className="ui-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{ width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ui-dialog-head">
        <span id={titleId} style={{ flex: 1 }}>
          {title}
        </span>
        <button className="ui-icon-btn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </div>
      <div className="ui-dialog-body">{children}</div>
      {footer && <div className="ui-dialog-foot">{footer}</div>}
    </div>
  );
}

/** Mount once at the app root: renders the stack of open dialogs. */
export function DialogHost() {
  const dialogs = useUI((s) => s.dialogs);
  return (
    <>
      {dialogs.map((d) => {
        const C = d.component;
        const onBackdrop = () => {
          if (d.options?.closeOnBackdrop === false) return;
          // Route through the dialog's own onClose so it can cancel live previews / save state.
          const handler = closeHandlers.get(d.id);
          if (handler) handler();
          else closeDialog(d.id);
        };
        return (
          <DialogIdContext.Provider key={d.id} value={d.id}>
            <div className="ui-dialog-backdrop" onPointerDown={onBackdrop}>
              <div onPointerDown={(e) => e.stopPropagation()}>
                <C {...d.props} close={(r?: unknown) => closeDialog(d.id, r)} />
              </div>
            </div>
          </DialogIdContext.Provider>
        );
      })}
    </>
  );
}
