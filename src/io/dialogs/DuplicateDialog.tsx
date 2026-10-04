import { useState } from 'react';
import { Button, Checkbox, Dialog, TextInput } from '../../ui/controls';
import '../io.css';

export type DuplicateResult = { name: string; merged: boolean };

export function DuplicateDialog({ close, name, layerCount }: { close: (r?: DuplicateResult) => void; name: string; layerCount: number }) {
  const [value, setValue] = useState(`${name} copy`);
  const [merged, setMerged] = useState(false);
  const submit = () => close({ name: value.trim() || `${name} copy`, merged });
  return (
    <Dialog
      title="Duplicate Image"
      width={400}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="io-form-grid">
        <span className="ui-label">Duplicate</span>
        <span className="io-dim" style={{ fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
        <span className="ui-label">As</span>
        <TextInput value={value} onChange={setValue} />
        <span />
        <Checkbox
          checked={merged}
          onChange={setMerged}
          disabled={layerCount < 2}
          label="Duplicate merged layers only"
          title="Create a flattened single-layer copy"
        />
      </div>
    </Dialog>
  );
}
