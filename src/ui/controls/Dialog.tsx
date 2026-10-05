import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
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
 * Standard dialog frame. Use inside a component opened with `openDialog(Component, props)`:
 *
 *   function MyDialog({ close }: { close: (r?: string) => void }) {
 *     return <Dialog title="Hello" onClose={() => close()} footer={<Button onClick={() => close('ok')}>OK</Button>}>…</Dialog>;
 *   }
 *
 * Keyboard: Escape → onClose, Enter → onSubmit (not from textareas). Only the topmost dialog reacts.
 * Enter first blurs a focused text field so its typed value is committed before onSubmit runs.
 * A click on the backdrop calls onClose too (unless the dialog was opened with closeOnBackdrop:false).
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
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && onSubmit && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        e.stopPropagation();
        e.preventDefault();
        // Let a focused NumberField/TextInput commit its typed text first (it commits on blur).
        if (commitFocusedField()) window.setTimeout(onSubmit, 0);
        else onSubmit();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, onSubmit]);

  return (
    <div ref={ref} className="ui-dialog" style={{ width }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="ui-dialog-head">
        <span style={{ flex: 1 }}>{title}</span>
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
