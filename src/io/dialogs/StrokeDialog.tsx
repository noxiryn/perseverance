import { useState } from 'react';
import { Button, Checkbox, ColorField, Dialog, NumberField, Select, Slider } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import { BLEND_OPTIONS, type StrokeSpec } from '../fillStroke';
import type { StrokeLocation } from '../math';
import { readJSON, writeJSON } from '../util';
import { useDeferredSubmit } from './useDeferredSubmit';
import '../io.css';

const KEY = 'perseverance.strokeDialog';

const LOCATIONS: { value: StrokeLocation; label: string }[] = [
  { value: 'inside', label: 'Inside' },
  { value: 'center', label: 'Center' },
  { value: 'outside', label: 'Outside' },
];

export function StrokeDialog({ close }: { close: (r?: StrokeSpec) => void }) {
  const primary = useEditor((st) => st.primaryColor);
  const [spec, setSpec] = useState<StrokeSpec>(() => ({
    width: 4,
    location: 'center',
    blendMode: 'normal',
    opacity: 1,
    preserveTransparency: false,
    ...readJSON<Partial<StrokeSpec>>(KEY, {}),
    color: primary,
  }));
  const set = <K extends keyof StrokeSpec>(k: K, v: StrokeSpec[K]) => setSpec((p) => ({ ...p, [k]: v }));
  const submit = useDeferredSubmit(() => {
    writeJSON(KEY, { ...spec, color: undefined });
    close(spec);
  });
  return (
    <Dialog
      title="Stroke"
      width={400}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Stroke
          </Button>
        </>
      }
    >
      <div className="io-form-grid">
        <span className="ui-label">Width</span>
        <NumberField value={spec.width} min={1} max={250} unit="px" width={90} onChange={(v) => set('width', Math.round(v))} />
        <span className="ui-label">Color</span>
        <ColorField value={spec.color} onChange={(c) => set('color', c)} alpha showHex />
        <span className="ui-label">Location</span>
        <div className="io-seg">
          {LOCATIONS.map((l) => (
            <button key={l.value} className={spec.location === l.value ? 'active' : ''} onClick={() => set('location', l.value)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <div className="io-sep" />
      <div className="io-form-grid">
        <span className="ui-label">Mode</span>
        <Select value={spec.blendMode} options={BLEND_OPTIONS} onChange={(v) => set('blendMode', v)} width={170} />
        <span className="ui-label">Opacity</span>
        <Slider value={Math.round(spec.opacity * 100)} min={1} max={100} unit="%" onChange={(v) => set('opacity', v / 100)} />
        <span />
        <Checkbox checked={spec.preserveTransparency} onChange={(v) => set('preserveTransparency', v)} label="Preserve Transparency" />
      </div>
    </Dialog>
  );
}
