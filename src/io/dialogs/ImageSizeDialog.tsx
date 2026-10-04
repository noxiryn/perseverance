import { useState } from 'react';
import { Link, Unlink } from 'lucide-react';
import { Button, Checkbox, Dialog, IconButton, NumberField, Select } from '../../ui/controls';
import type { Document } from '../../core/types';
import { formatBytes } from '../math';
import { MAX_DOC_SIZE } from '../newDocument';
import type { ResampleMethod } from '../imageOps';
import { useDeferredSubmit } from './useDeferredSubmit';
import '../io.css';

export type ImageSizeResult = { width: number; height: number; method: ResampleMethod; scaleStyles: boolean };

type Unit = 'px' | '%';

/** Quick targets: relative factors or exact Roblox/video sizes. */
const QUICK: { id: string; label: string; factor?: number; size?: [number, number] }[] = [
  { id: 'p25', label: '25%', factor: 0.25 },
  { id: 'p50', label: '50%', factor: 0.5 },
  { id: 'p200', label: '200%', factor: 2 },
  { id: 'icon512', label: '512 × 512', size: [512, 512] },
  { id: 'icon1024', label: '1024 × 1024', size: [1024, 1024] },
  { id: 'hd1080', label: '1920 × 1080', size: [1920, 1080] },
  { id: 'hd720', label: '1280 × 720', size: [1280, 720] },
];

const clampPx = (v: number) => Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(v)));

export function ImageSizeDialog({ close, doc }: { close: (r?: ImageSizeResult) => void; doc: Document }) {
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [unit, setUnit] = useState<Unit>('px');
  const [link, setLink] = useState(true);
  const [method, setMethod] = useState<ResampleMethod>('smooth');
  const [scaleStyles, setScaleStyles] = useState(true);
  const ratio = doc.width / doc.height;

  const setWidth = (px: number) => {
    const nw = clampPx(px);
    setW(nw);
    if (link) setH(clampPx(nw / ratio));
  };
  const setHeight = (px: number) => {
    const nh = clampPx(px);
    setH(nh);
    if (link) setW(clampPx(nh * ratio));
  };
  const quick = (q: (typeof QUICK)[number]) => {
    if (q.factor) {
      setW(clampPx(doc.width * q.factor));
      setH(clampPx(doc.height * q.factor));
      return;
    }
    if (!q.size) return;
    const [qw, qh] = q.size;
    // A different aspect ratio can only be reached with unconstrained proportions.
    if (Math.abs(qw / qh - ratio) > 0.005) setLink(false);
    setW(qw);
    setH(qh);
  };
  const shown = (px: number, base: number) => (unit === 'px' ? px : (px / base) * 100);
  const fromShown = (v: number, base: number) => (unit === 'px' ? v : (v / 100) * base);
  const changed = w !== doc.width || h !== doc.height;
  const distorts = Math.abs(w / h - ratio) > 0.01;
  const submit = useDeferredSubmit(() => (changed ? close({ width: w, height: h, method, scaleStyles }) : close()));

  return (
    <Dialog
      title="Image Size"
      width={440}
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
        <span className="ui-label">Quick size</span>
        <div className="io-quick-sizes">
          {QUICK.map((q) => {
            const active = q.factor
              ? w === clampPx(doc.width * q.factor) && h === clampPx(doc.height * q.factor)
              : !!q.size && w === q.size[0] && h === q.size[1];
            return (
              <button key={q.id} className={`io-quick${active ? ' active' : ''}`} onClick={() => quick(q)}>
                {q.label}
              </button>
            );
          })}
        </div>
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
        {distorts ? (
          <span style={{ color: 'var(--warning)' }}>The aspect ratio changes — layers will be stretched. </span>
        ) : null}
        All layers, masks, the selection and guides are scaled. Text and shapes stay editable.
      </div>
    </Dialog>
  );
}
