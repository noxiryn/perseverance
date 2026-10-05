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
      width={460}
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
        {bake
          ? 'Drop shadows, strokes, glows and overlays are rendered into each layer so the PSD looks exactly like your document.'
          : 'Layer styles are written as editable Photoshop effects (drop/inner shadow, outer/inner glow, bevel, satin, stroke, color and gradient overlay). Layers using a style Photoshop does not have (long shadow, pattern overlay) are baked.'}
      </div>
      <div className="io-sep" />
      <div className="io-note">
        Layers, groups, names, opacity, fill, blend modes, visibility, clipping masks and layer masks are preserved. Solid and gradient fill
        layers stay editable fill layers (a gradient offset Photoshop can't store exactly is written as pixels); text and shape layers are exported as pixel layers (smart filters applied). Brightness/Contrast,
        Levels, Curves, Exposure, Vibrance, Hue/Saturation, Color Balance, Black &amp; White, Photo Filter, Channel Mixer, Gradient Map,
        Selective Color, Invert, Posterize and Threshold stay editable adjustment layers; other adjustments (Duotone, Split Toning, Color
        Lookup, Vignette…) are baked into pixel layers. The background colour becomes a bottom “Background Color” layer.
      </div>
      <div className="io-note" style={{ marginTop: 6 }}>
        Baked adjustments match exactly over opaque pixels and inside clipping masks. Over semi-transparent pixels — soft edges in a group
        or a transparent document — they look slightly denser in Photoshop; the export lists those layers.
      </div>
    </Dialog>
  );
}
