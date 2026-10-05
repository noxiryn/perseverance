import { useState } from 'react';
import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight, Dot } from 'lucide-react';
import { Button, Checkbox, ColorField, Dialog, NumberField, Select } from '../../ui/controls';
import type { Document } from '../../core/types';
import { useEditor } from '../../state/editor';
import { MAX_DOC_SIZE } from '../newDocument';
import { backgroundLayerOf } from '../util';
import { useDeferredSubmit } from './useDeferredSubmit';
import '../io.css';

export type CanvasSizeResult = { width: number; height: number; anchor: number; extension: string | null };

type ExtChoice = 'background' | 'foreground' | 'white' | 'black' | 'gray' | 'transparent' | 'other';
type Unit = 'px' | '%';

const EXT_OPTIONS: { value: ExtChoice; label: string }[] = [
  { value: 'background', label: 'Background color' },
  { value: 'foreground', label: 'Foreground color' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'gray', label: 'Gray' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'other', label: 'Other…' },
];

/** Arrow icons pointing away from the anchor (like Photoshop's anchor grid). */
const ARROWS = [ArrowUpLeft, ArrowUp, ArrowUpRight, ArrowLeft, Dot, ArrowRight, ArrowDownLeft, ArrowDown, ArrowDownRight];

function arrowFor(cell: number, anchor: number) {
  const cx = cell % 3,
    cy = Math.floor(cell / 3),
    ax = anchor % 3,
    ay = Math.floor(anchor / 3);
  const dx = cx - ax,
    dy = cy - ay;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  return ARROWS[(dy + 1) * 3 + (dx + 1)];
}

/** What the new canvas area will show. */
function extensionNote(doc: Document, hasBackground: boolean): string {
  if (hasBackground) return 'The extension color fills new area on the Background layer; other layers keep their pixels.';
  const bottom = doc.layers[doc.rootIds[0]];
  if (bottom?.type === 'fill' && bottom.visible) return `The “${bottom.name}” fill layer covers the new area.`;
  if (doc.background) return 'There is no Background layer: new area shows the document background color.';
  return 'There is no Background layer, so new areas stay transparent.';
}

export function CanvasSizeDialog({ close, doc }: { close: (r?: CanvasSizeResult) => void; doc: Document }) {
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const [unit, setUnit] = useState<Unit>('px');
  const [relative, setRelative] = useState(false);
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [anchor, setAnchor] = useState(4);
  const hasBackground = !!backgroundLayerOf(doc);
  // Like Photoshop: new canvas area takes the background color — when there is a Background layer.
  const [ext, setExt] = useState<ExtChoice>(hasBackground ? 'background' : 'transparent');
  const [other, setOther] = useState('#808080');

  // Values shown in the fields (relative = delta).
  const toShown = (px: number, base: number) => {
    const v = relative ? px - base : px;
    return unit === 'px' ? v : (v / base) * 100;
  };
  const fromShown = (v: number, base: number) => {
    const px = unit === 'px' ? v : (v / 100) * base;
    return Math.round(relative ? base + px : px);
  };
  const clampPx = (v: number) => Math.max(1, Math.min(MAX_DOC_SIZE, v));

  const extColor = (): string | null => {
    switch (ext) {
      case 'background':
        return secondary;
      case 'foreground':
        return primary;
      case 'white':
        return '#ffffff';
      case 'black':
        return '#000000';
      case 'gray':
        return '#808080';
      case 'transparent':
        return null;
      default:
        return other;
    }
  };
  const changed = w !== doc.width || h !== doc.height;
  const submit = useDeferredSubmit(() =>
    changed ? close({ width: w, height: h, anchor, extension: hasBackground ? extColor() : null }) : close(),
  );

  return (
    <Dialog
      title="Canvas Size"
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
        Current size: {doc.width} × {doc.height} px
      </div>
      <div className="io-form-grid">
        <span className="ui-label">{relative ? 'Width (+/−)' : 'Width'}</span>
        <NumberField
          autoFocus
          value={toShown(w, doc.width)}
          unit={unit}
          step={unit === 'px' ? 1 : 0.1}
          onChange={(v) => setW(clampPx(fromShown(v, doc.width)))}
          width={140}
        />
        <span className="ui-label">{relative ? 'Height (+/−)' : 'Height'}</span>
        <NumberField
          value={toShown(h, doc.height)}
          unit={unit}
          step={unit === 'px' ? 1 : 0.1}
          onChange={(v) => setH(clampPx(fromShown(v, doc.height)))}
          width={140}
        />
        <span className="ui-label">Units</span>
        <div className="ui-row">
          <Select
            value={unit}
            options={[
              { value: 'px', label: 'Pixels' },
              { value: '%', label: 'Percent' },
            ]}
            onChange={setUnit}
            width={100}
          />
          <Checkbox checked={relative} onChange={setRelative} label="Relative" />
        </div>
        <span className="ui-label">Anchor</span>
        <div className="io-anchor">
          {Array.from({ length: 9 }, (_, i) => {
            const Icon = arrowFor(i, anchor);
            return (
              <button key={i} className={i === anchor ? 'active' : ''} onClick={() => setAnchor(i)} title="Anchor">
                {Icon && <Icon size={12} strokeWidth={2} />}
              </button>
            );
          })}
        </div>
        <span className="ui-label">Extension</span>
        <div className="ui-row">
          <Select
            value={hasBackground ? ext : 'transparent'}
            options={EXT_OPTIONS}
            onChange={setExt}
            width={150}
            disabled={!hasBackground}
            title={hasBackground ? 'Color of the new area on the Background layer' : 'Only a Background layer is extended with a color'}
          />
          {hasBackground && ext === 'other' && <ColorField value={other} onChange={setOther} />}
          {hasBackground && ext !== 'transparent' && ext !== 'other' && (
            <span className="ui-swatch" style={{ width: 20, height: 20 }}>
              <span style={{ background: extColor() ?? 'transparent' }} />
            </span>
          )}
        </div>
      </div>
      <div className="io-note" style={{ marginTop: 10 }}>
        New size:{' '}
        <b>
          {w} × {h} px
        </b>
        . {extensionNote(doc, hasBackground)}
      </div>
    </Dialog>
  );
}
