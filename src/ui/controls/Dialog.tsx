import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { closeDialog, useUI } from '../../state/ui';

/**
 * Standard dialog frame. Use inside a component opened with `openDialog(Component, props)`:
 *
 *   function MyDialog({ close }: { close: (r?: string) => void }) {
 *     return <Dialog title="Hello" onClose={() => close()} footer={<Button onClick={() => close('ok')}>OK</Button>}>…</Dialog>;
 *   }
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
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && onSubmit && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        e.stopPropagation();
        onSubmit();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose, onSubmit]);

  return (
    <div className="ui-dialog" style={{ width }} onPointerDown={(e) => e.stopPropagation()}>
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
        return (
          <div key={d.id} className="ui-dialog-backdrop" onPointerDown={() => closeDialog(d.id)}>
            <div onPointerDown={(e) => e.stopPropagation()}>
              <C {...d.props} close={(r?: unknown) => closeDialog(d.id, r)} />
            </div>
          </div>
        );
      })}
    </>
  );
}
