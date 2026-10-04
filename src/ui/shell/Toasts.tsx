/** Toast host: pills at the top-left of the canvas area ("✓ Delete Layer completed."). */
import { Check, CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import { dismissToast, useUI, type Toast } from '../../state/ui';

const ICONS: Record<Toast['kind'], typeof Check> = {
  success: Check,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
};

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="shell-toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind] ?? Info;
        return (
          <div key={t.id} className={`shell-toast ${t.kind}`} onClick={() => dismissToast(t.id)} title="Click to dismiss">
            <Icon size={13} strokeWidth={2.2} className="shell-toast-icon" />
            <span className="shell-toast-msg">{t.message}</span>
            {(t.kind === 'error' || t.kind === 'warning') && <X size={11} className="shell-toast-x" />}
          </div>
        );
      })}
    </div>
  );
}
