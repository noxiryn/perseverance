import { useState } from 'react';
import { Button, Dialog, TextInput } from '../../../ui/controls';
import '../paint.css';

/** Ask for a brush preset name (also used for renaming). */
export function SavePresetDialog({ close, initial, title }: { close: (name?: string) => void; initial: string; title: string }) {
  const [name, setName] = useState(initial);
  const ok = () => {
    if (name.trim()) close(name.trim());
  };
  return (
    <Dialog
      title={title}
      width={340}
      onClose={() => close()}
      onSubmit={ok}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={ok} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <label className="paint-dialog-field">
        <span className="paint-opt-label">Name</span>
        <AutoFocusInput value={name} onChange={setName} />
      </label>
    </Dialog>
  );
}

function AutoFocusInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div
      ref={(el) => {
        const input = el?.querySelector('input');
        if (input && document.activeElement !== input && !input.dataset.focused) {
          input.dataset.focused = '1';
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      }}
      style={{ flex: 1 }}
    >
      <TextInput value={value} onChange={onChange} placeholder="Brush name" />
    </div>
  );
}
