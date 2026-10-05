import { useState } from 'react';
import { Button, Checkbox, Dialog } from '../../ui/controls';
import type { TrimBasis } from '../imageOps';
import '../io.css';

export type TrimResult = { basis: TrimBasis; sides: { top: boolean; bottom: boolean; left: boolean; right: boolean } };

const BASES: { value: TrimBasis; label: string }[] = [
  { value: 'transparent', label: 'Transparent Pixels' },
  { value: 'topLeft', label: 'Top Left Pixel Color' },
  { value: 'bottomRight', label: 'Bottom Right Pixel Color' },
];

export function TrimDialog({ close }: { close: (r?: TrimResult) => void }) {
  const [basis, setBasis] = useState<TrimBasis>('transparent');
  const [sides, setSides] = useState({ top: true, bottom: true, left: true, right: true });
  const any = sides.top || sides.bottom || sides.left || sides.right;
  const submit = () => any && close({ basis, sides });
  return (
    <Dialog
      title="Trim"
      width={360}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!any} onClick={submit}>
            Trim
          </Button>
        </>
      }
    >
      <div className="io-form-label">Based on</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {BASES.map((b) => (
          <label key={b.value} className="ui-check io-radio">
            <input type="radio" name="io-trim-basis" checked={basis === b.value} onChange={() => setBasis(b.value)} />
            {b.label}
          </label>
        ))}
      </div>
      <div className="io-form-label" style={{ marginTop: 14 }}>
        Trim away
      </div>
      <div className="io-form-row2">
        {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
          <Checkbox
            key={k}
            checked={sides[k]}
            onChange={(v) => setSides((s) => ({ ...s, [k]: v }))}
            label={k[0].toUpperCase() + k.slice(1)}
          />
        ))}
      </div>
    </Dialog>
  );
}
