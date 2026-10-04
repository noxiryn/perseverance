import { AlertTriangle } from 'lucide-react';
import { Button, Dialog } from '../../ui/controls';
import { openDialog } from '../../state/ui';
import '../io.css';

export interface Choice {
  value: string;
  label: string;
  variant?: 'primary' | 'ghost' | 'danger';
}

export type ChoiceOptions = {
  title: string;
  message: string;
  detail?: string;
  choices: Choice[];
  /** Value returned on Enter (defaults to the primary choice). */
  defaultValue?: string;
};

function ChoiceDialog({ close, title, message, detail, choices, defaultValue }: ChoiceOptions & { close: (r?: string) => void }) {
  const def = defaultValue ?? choices.find((c) => c.variant === 'primary')?.value;
  return (
    <Dialog
      title={title}
      width={440}
      onClose={() => close(undefined)}
      onSubmit={def ? () => close(def) : undefined}
      footer={choices.map((c, i) => (
        <Button key={c.value} variant={c.variant} autoFocus={c.value === def || (!def && i === choices.length - 1)} onClick={() => close(c.value)}>
          {c.label}
        </Button>
      ))}
    >
      <div className="io-choice">
        <AlertTriangle size={22} className="io-choice-icon" />
        <div>
          <div className="io-choice-msg">{message}</div>
          {detail && <div className="io-choice-detail">{detail}</div>}
        </div>
      </div>
    </Dialog>
  );
}

/** Ask the user to pick one of several buttons. Resolves with the value (undefined if dismissed). */
export function askChoice(opts: ChoiceOptions): Promise<string | undefined> {
  return openDialog<string, ChoiceOptions>(ChoiceDialog, opts);
}
