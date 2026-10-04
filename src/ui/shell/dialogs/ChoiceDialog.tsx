/** Small modal asking the user to pick one of a few choices (e.g. Save / Don't Save / Cancel). */
import type { ComponentType } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Dialog } from '../../controls';
import { openDialog } from '../../../state/ui';

export interface Choice {
  value: string;
  label: string;
  variant?: 'primary' | 'danger' | 'ghost';
}

interface Props extends Record<string, unknown> {
  close: (r?: string) => void;
  title: string;
  message: string;
  detail?: string;
  choices: Choice[];
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
}

export function ChoiceDialog({ close, title, message, detail, choices, icon: Icon = TriangleAlert }: Props) {
  const primary = choices.find((c) => c.variant === 'primary');
  return (
    <Dialog title={title} onClose={() => close()} width={440} onSubmit={primary ? () => close(primary.value) : undefined}>
      <div className="shell-choice">
        <div className="shell-choice-icon">
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div className="shell-choice-text">
          <div className="shell-choice-msg">{message}</div>
          {detail && <div className="shell-choice-detail">{detail}</div>}
        </div>
      </div>
      <div className="shell-choice-actions">
        {choices.map((c, i) => (
          <Button key={c.value} variant={c.variant} autoFocus={c.variant === 'primary' || (!primary && i === 0)} onClick={() => close(c.value)}>
            {c.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}

/** Ask the user; resolves with the chosen value or undefined when dismissed. */
export function askChoice(opts: Omit<Props, 'close'>): Promise<string | undefined> {
  return openDialog<string, Omit<Props, 'close'>>(ChoiceDialog as never, opts);
}
