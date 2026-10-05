import { useId } from 'react';
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
  const token = useId();
  // The shared Dialog handles Enter itself (capture phase, default prevented), so a button that
  // has keyboard focus never receives its click: answer with the FOCUSED button (Tab to “Don't
  // Save” + Enter must not save), falling back to the default choice.
  const onSubmit = () => {
    const el = document.activeElement as HTMLElement | null;
    const focused = el?.dataset.ioChoiceOwner === token ? el.dataset.ioChoice : undefined;
    const value = focused !== undefined && choices.some((c) => c.value === focused) ? focused : def;
    if (value !== undefined) close(value);
  };
  return (
    <Dialog
      title={title}
      width={440}
      onClose={() => close(undefined)}
      onSubmit={onSubmit}
      footer={choices.map((c, i) => (
        <Button
          key={c.value}
          data-io-choice={c.value}
          data-io-choice-owner={token}
          variant={c.variant}
          autoFocus={c.value === def || (!def && i === choices.length - 1)}
          onClick={() => close(c.value)}
        >
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
