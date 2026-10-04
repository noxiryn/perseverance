/**
 * Dialogs for the Select and View menus: amount dialogs (Feather/Expand/Contract/Border/Smooth)
 * and New Guide. (Color Range lives in ./colorRange.tsx.)
 */
import { useRef, useState } from 'react';
import type { Guide } from '../core/types';
import { activeDoc } from '../state/editor';
import { Button, Dialog, NumberField, Select, Slider } from '../ui/controls';
import './viewport.css';

/** Blur the focused field so a typed value is committed before reading it on Enter. */
function flushFocusedField() {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) el.blur();
}

/* ------------------------------------------------------------------ */
/* Amount dialog                                                       */
/* ------------------------------------------------------------------ */

export interface AmountDialogProps extends Record<string, unknown> {
  title: string;
  label: string;
  initial: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  note?: string;
}

export function AmountDialog({ close, title, label, initial, min, max, step = 1, unit = 'px', note }: AmountDialogProps & { close: (r?: number) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = (v: number) => {
    ref.current = v;
    setValue(v);
  };
  const submit = () => {
    flushFocusedField();
    close(Math.max(min, Math.min(max, ref.current)));
  };
  return (
    <Dialog
      title={title}
      width={360}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            OK
          </Button>
        </>
      }
    >
      <div className="viewport-dlg">
        <div className="viewport-dlg-row">
          <span className="ui-label">{label}</span>
          <Slider value={value} min={min} max={Math.min(max, 250)} step={step} unit={unit} onChange={set} width={220} />
        </div>
        {note && <div className="viewport-dlg-note">{note}</div>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* New Guide dialog                                                    */
/* ------------------------------------------------------------------ */

export interface NewGuideResult {
  orientation: Guide['orientation'];
  position: number;
}

export function NewGuideDialog({ close }: { close: (r?: NewGuideResult) => void }) {
  const doc = activeDoc();
  const [orientation, setOrientation] = useState<Guide['orientation']>('vertical');
  const [unit, setUnit] = useState<'px' | '%'>('px');
  const [value, setValue] = useState(0);
  const ref = useRef({ orientation, unit, value });
  ref.current = { orientation, unit, value };
  const valueRef = useRef(0);
  const submit = () => {
    flushFocusedField();
    const { orientation: o, unit: u } = ref.current;
    const v = valueRef.current;
    const dim = o === 'vertical' ? (doc?.width ?? 0) : (doc?.height ?? 0);
    close({ orientation: o, position: u === '%' ? (v / 100) * dim : v });
  };
  return (
    <Dialog
      title="New Guide"
      width={340}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            OK
          </Button>
        </>
      }
    >
      <div className="viewport-dlg">
        <div className="viewport-dlg-row">
          <span className="ui-label">Orientation</span>
          <div className="viewport-seg viewport-seg-text">
            <button className={`viewport-seg-btn${orientation === 'horizontal' ? ' active' : ''}`} onClick={() => setOrientation('horizontal')}>
              Horizontal
            </button>
            <button className={`viewport-seg-btn${orientation === 'vertical' ? ' active' : ''}`} onClick={() => setOrientation('vertical')}>
              Vertical
            </button>
          </div>
        </div>
        <div className="viewport-dlg-row">
          <span className="ui-label">Position</span>
          <NumberField
            value={value}
            min={-100000}
            max={100000}
            step={unit === '%' ? 0.1 : 1}
            width={90}
            onChange={(v) => {
              valueRef.current = v;
              setValue(v);
            }}
          />
          <Select
            value={unit}
            width={70}
            options={[
              { value: 'px', label: 'px' },
              { value: '%', label: '%' },
            ]}
            onChange={setUnit}
          />
        </div>
        {doc && (
          <div className="viewport-dlg-note">
            Canvas: {doc.width} × {doc.height} px. Tip: drag from the rulers (Ctrl+R) to place guides by hand.
          </div>
        )}
      </div>
    </Dialog>
  );
}
