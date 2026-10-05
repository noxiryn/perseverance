/**
 * Small "save as…" prompt shared by the user libraries (My Styles, My Looks, My Templates):
 * a name field, optional checkboxes and a short description of what gets saved.
 */
import { useState, type ReactNode } from 'react';
import { Button, Checkbox, Dialog, Field, TextInput } from '../ui/controls';
import { openDialog } from '../state/ui';

export interface SaveOption {
  key: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
}

export interface SavePromptProps extends Record<string, unknown> {
  title: string;
  /** Label of the confirm button (default "Save"). */
  confirm?: string;
  defaultName: string;
  description?: ReactNode;
  options?: SaveOption[];
}

export interface SavePromptResult {
  name: string;
  options: Record<string, boolean>;
}

export function SavePresetDialog({ close, title, confirm, defaultName, description, options = [] }: SavePromptProps & { close: (r?: SavePromptResult) => void }) {
  const [name, setName] = useState(defaultName);
  const [opts, setOpts] = useState<Record<string, boolean>>(() => Object.fromEntries(options.map((o) => [o.key, o.checked && !o.disabled])));
  const ok = name.trim().length > 0;
  const submit = () => {
    if (ok) close({ name: name.trim(), options: opts });
  };
  return (
    <Dialog
      title={title}
      width={420}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={submit}>
            {confirm ?? 'Save'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="Name" width="100%" />
        </Field>
        {options.map((o) => (
          <div key={o.key} title={o.hint}>
            <Checkbox checked={!!opts[o.key]} disabled={o.disabled} onChange={(v) => setOpts((p) => ({ ...p, [o.key]: v }))} label={o.label} />
          </div>
        ))}
        {description && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.45 }}>{description}</div>}
      </div>
    </Dialog>
  );
}

/** Ask for a name (and options). Resolves undefined when cancelled. */
export function promptSave(props: SavePromptProps) {
  return openDialog<SavePromptResult, SavePromptProps>(SavePresetDialog, props);
}
