import { useState } from 'react';
import { Link, Unlink } from 'lucide-react';
import { Button, Checkbox, Dialog, IconButton, NumberField, Select } from '../../ui/controls';
import type { Document } from '../../core/types';
import { formatBytes } from '../math';
import { MAX_DOC_SIZE } from '../newDocument';
import type { ResampleMethod } from '../imageOps';
import '../io.css';

export type ImageSizeResult = { width: number; height: number; method: ResampleMethod; scaleStyles: boolean };

type Unit = 'px' | '%';

export function ImageSizeDialog({ close, doc }: { close: (r?: ImageSizeResult) => void; doc: Document }) {
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [unit, setUnit] = useState<Unit>('px');
  const [link, setLink] = useState(true);
  const [method, setMethod] = useState<ResampleMethod>('smooth');
  const [scaleStyles, setScaleStyles] = useState(true);
  const ratio = doc.width / doc.height;

  const setWidth = (px: number) => {
    const nw = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(px)));
    setW(nw);
    if (link) setH(Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(nw / ratio))));
  };
  const setHeight = (px: number) => {
    const nh = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(px)));
    setH(nh);
    if (link) setW(Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(nh * ratio))));
  };
  const shown = (px: number, base: number) => (unit === 'px' ? px : (px / base) * 100);
  const fromShown = (v: number, base: number) => (unit === 'px' ? v : (v / 100) * base);
  const changed = w !== doc.width || h !== doc.height;
  const submit = () => (changed ? close({ width: w, height: h, method, scaleStyles }) : close());

  return (
    <Dialog
      title="Image Size"
      width={420}
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
      <div className="io-note" style={{ marginBottom: 12 }}>
        Current: {doc.width} × {doc.height} px ({formatBytes(doc.width * doc.height * 4)}) → New: <b>{w} × {h} px</b> ({formatBytes(w * h * 4)})
      </div>
      <div className="io-form-grid" style={{ gridTemplateColumns: '96px 1fr auto' }}>
        <span className="ui-label">Width</span>
        <NumberField value={shown(w, doc.width)} min={unit === 'px' ? 1 : 0.1} step={unit === 'px' ? 1 : 0.1} unit={unit} onChange={(v) => setWidth(fromShown(v, doc.width))} />
        <div style={{ gridRow: 'span 2' }} className="io-link-btn">
          <IconButton icon={link ? Link : Unlink} active={link} title={link ? 'Constrain proportions (on)' : 'Constrain proportions (off)'} onClick={() => setLink(!link)} />
        </div>
        <span className="ui-label">Height</span>
        <NumberField value={shown(h, doc.height)} min={unit === 'px' ? 1 : 0.1} step={unit === 'px' ? 1 : 0.1} unit={unit} onChange={(v) => setHeight(fromShown(v, doc.height))} />
        <span className="ui-label">Units</span>
        <Select
          value={unit}
          options={[
            { value: 'px', label: 'Pixels' },
            { value: '%', label: 'Percent' },
          ]}
          onChange={setUnit}
          width={120}
        />
        <span />
        <span className="ui-label">Resample</span>
        <Select
          value={method}
          options={[
            { value: 'smooth', label: 'Bicubic (smooth)' },
            { value: 'nearest', label: 'Nearest Neighbor (hard edges)' },
          ]}
          onChange={setMethod}
          width={200}
        />
        <span />
        <span />
        <Checkbox checked={scaleStyles} onChange={setScaleStyles} label="Scale layer styles" />
        <span />
      </div>
      <div className="io-note" style={{ marginTop: 10 }}>
        All layers, masks, the selection and guides are scaled. Text and shapes stay editable.
      </div>
    </Dialog>
  );
}
