import { useState } from 'react';
import { Button, Checkbox, Dialog } from '../../ui/controls';
import type { PsdExportOptions } from '../psd';
import { readJSON, writeJSON } from '../util';
import '../io.css';

const KEY = 'perseverance.psdExport';

export function PsdExportDialog({ close }: { close: (r?: PsdExportOptions) => void }) {
  const [bake, setBake] = useState(() => readJSON<{ bakeStyles?: boolean }>(KEY, {}).bakeStyles ?? true);
  const submit = () => {
    writeJSON(KEY, { bakeStyles: bake });
    close({ bakeStyles: bake });
  };
  return (
    <Dialog
      title="Export as Photoshop (PSD)"
      width={440}
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Export PSD…
          </Button>
        </>
      }
    >
      <Checkbox checked={bake} onChange={setBake} label="Bake layer styles into pixels" />
      <div className="io-note" style={{ marginTop: 6, paddingLeft: 19 }}>
        Drop shadows, strokes, glows and smart filters are rendered into each layer so the PSD looks identical in Photoshop.
      </div>
      <div className="io-sep" />
      <div className="io-note">
        Layers, groups, names, opacity, blend modes, visibility, clipping masks and layer masks are preserved. Text and shape layers
        are exported as pixel layers. Brightness/Contrast, Levels, Curves, Exposure, Vibrance, Hue/Saturation, Invert, Posterize and
        Threshold stay editable adjustment layers.
      </div>
    </Dialog>
  );
}
