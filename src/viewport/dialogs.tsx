/**
 * Dialogs for the Select and View menus: amount dialogs (Feather/Expand/Contract/Border/Smooth),
 * New Guide, and Color Range (live mask preview, sample from the preview with +/− eyedroppers).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pipette, Plus, Minus, X } from 'lucide-react';
import type { Guide } from '../core/types';
import { createCanvas, ctx2d } from '../core/canvas';
import type { SelectionMode } from '../editor/selection';
import { renderDocument } from '../render/compositor';
import { activeDoc, useEditor } from '../state/editor';
import { Button, Checkbox, Dialog, IconButton, NumberField, Select, Slider } from '../ui/controls';
import { colorRangeWeights, type ColorRangePreset } from './math/colorRange';
import { averageColor, hexToRgb, rgbToHex } from './math/color';
import { commitAlphaSelection, paintAlphaPreview, readComposite } from './selectOps';
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

/* ------------------------------------------------------------------ */
/* Color Range dialog                                                  */
/* ------------------------------------------------------------------ */

type Rgb = { r: number; g: number; b: number };

const RANGE_OPTIONS: { value: ColorRangePreset; label: string }[] = [
  { value: 'sampled', label: 'Sampled Colors' },
  { value: 'reds', label: 'Reds' },
  { value: 'yellows', label: 'Yellows' },
  { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' },
  { value: 'blues', label: 'Blues' },
  { value: 'magentas', label: 'Magentas' },
  { value: 'highlights', label: 'Highlights' },
  { value: 'midtones', label: 'Midtones' },
  { value: 'shadows', label: 'Shadows' },
  { value: 'skin', label: 'Skin Tones' },
];

const PREVIEW_W = 300;
const PREVIEW_H = 240;

export function ColorRangeDialog({ close }: { close: (r?: boolean) => void }) {
  const doc = activeDoc();
  const primary = useEditor((s) => s.primaryColor);
  const source = useMemo(() => {
    if (!doc) return null;
    let comp: HTMLCanvasElement;
    try {
      comp = renderDocument(doc);
    } catch (err) {
      console.error('[color range] render failed', err);
      return null;
    }
    const s = Math.min(PREVIEW_W / doc.width, PREVIEW_H / doc.height, 1);
    const pw = Math.max(1, Math.round(doc.width * s));
    const ph = Math.max(1, Math.round(doc.height * s));
    return {
      full: readComposite(comp, doc.width, doc.height),
      w: doc.width,
      h: doc.height,
      preview: readComposite(comp, pw, ph),
      pw,
      ph,
      image: (() => {
        const c = createCanvas(pw, ph);
        const ctx = ctx2d(c);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(comp, 0, 0, pw, ph);
        return c;
      })(),
    };
  }, [doc]);

  const [preset, setPreset] = useState<ColorRangePreset>('sampled');
  const [samples, setSamples] = useState<Rgb[]>(() => {
    const c = hexToRgb(primary);
    return c ? [c] : [];
  });
  const [negatives, setNegatives] = useState<Rgb[]>([]);
  const [fuzziness, setFuzziness] = useState(40);
  const [invert, setInvert] = useState(false);
  const [mode, setMode] = useState<SelectionMode>('new');
  const [view, setView] = useState<'selection' | 'image'>('selection');
  const [picker, setPicker] = useState<'pick' | 'add' | 'subtract'>('pick');
  const [hover, setHover] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const params = { preset, samples, negatives, fuzziness, invert };
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !source) return;
    if (view === 'image') {
      const ctx = ctx2d(c);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(source.image, 0, 0);
      return;
    }
    const alpha = colorRangeWeights(source.preview, source.pw * source.ph, { preset, samples, negatives, fuzziness, invert });
    paintAlphaPreview(c, alpha);
  }, [source, view, preset, samples, negatives, fuzziness, invert]);

  if (!doc || !source) {
    return (
      <Dialog title="Color Range" onClose={() => close()} footer={<Button onClick={() => close()}>Close</Button>}>
        <div className="viewport-dlg-note">Open a document to select a color range.</div>
      </Dialog>
    );
  }

  const sampleFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): Rgb | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * source.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * source.h);
    const c = averageColor(source.full, source.w, source.h, x, y, 3);
    return c ? { r: c.r, g: c.g, b: c.b } : null;
  };

  const onPick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = sampleFromEvent(e);
    if (!c) return;
    const kind = e.altKey ? 'subtract' : e.shiftKey ? 'add' : picker;
    setPreset('sampled');
    if (kind === 'add') setSamples((s) => [...s, c].slice(-16));
    else if (kind === 'subtract') setNegatives((s) => [...s, c].slice(-16));
    else {
      setSamples([c]);
      setNegatives([]);
    }
  };

  const submit = () => {
    flushFocusedField();
    const p = paramsRef.current;
    if (p.preset === 'sampled' && !p.samples.length) {
      close();
      return;
    }
    const alpha = colorRangeWeights(source.full, source.w * source.h, p);
    commitAlphaSelection(alpha, modeRef.current, 'Color Range');
    close(true);
  };

  return (
    <Dialog
      title="Color Range"
      width={600}
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
      <div className="viewport-cr">
        <div>
          <div className="viewport-cr-preview">
            <canvas
              ref={canvasRef}
              width={source.pw}
              height={source.ph}
              onPointerDown={onPick}
              onPointerMove={(e) => {
                const c = sampleFromEvent(e);
                setHover(c ? rgbToHex(c.r, c.g, c.b) : null);
              }}
              onPointerLeave={() => setHover(null)}
            />
          </div>
          <div className="viewport-dlg-row" style={{ marginTop: 8 }}>
            <div className="viewport-seg viewport-seg-text">
              <button className={`viewport-seg-btn${view === 'selection' ? ' active' : ''}`} onClick={() => setView('selection')}>
                Selection
              </button>
              <button className={`viewport-seg-btn${view === 'image' ? ' active' : ''}`} onClick={() => setView('image')}>
                Image
              </button>
            </div>
            <span className="viewport-dlg-note" style={{ marginLeft: 'auto' }}>
              {hover ? (
                <>
                  <span className="viewport-cr-chip" style={{ background: hover }} /> {hover}
                </>
              ) : (
                'Click the preview to sample'
              )}
            </span>
          </div>
        </div>
        <div className="viewport-cr-side">
          <div className="viewport-dlg-row">
            <span className="ui-label">Select</span>
            <Select value={preset} width={150} options={RANGE_OPTIONS} onChange={setPreset} />
          </div>
          {preset === 'sampled' && (
            <>
              <div className="viewport-dlg-row">
                <span className="ui-label">Eyedropper</span>
                <div className="viewport-seg">
                  <IconButton icon={Pipette} size="sm" active={picker === 'pick'} title="Sample a color" onClick={() => setPicker('pick')} />
                  <IconButton icon={Plus} size="sm" active={picker === 'add'} title="Add to sample (Shift)" onClick={() => setPicker('add')} />
                  <IconButton icon={Minus} size="sm" active={picker === 'subtract'} title="Subtract from sample (Alt)" onClick={() => setPicker('subtract')} />
                </div>
              </div>
              <div className="viewport-dlg-row">
                <span className="ui-label">Fuzziness</span>
                <Slider value={fuzziness} min={0} max={200} step={1} onChange={setFuzziness} width={170} />
              </div>
              <div className="viewport-cr-samples">
                {samples.map((c, i) => (
                  <button
                    key={`p${i}`}
                    className="viewport-cr-swatch"
                    style={{ background: rgbToHex(c.r, c.g, c.b) }}
                    title="Sampled color — click to remove"
                    onClick={() => setSamples((s) => s.filter((_, j) => j !== i))}
                  />
                ))}
                {negatives.map((c, i) => (
                  <button
                    key={`n${i}`}
                    className="viewport-cr-swatch neg"
                    style={{ background: rgbToHex(c.r, c.g, c.b) }}
                    title="Excluded color — click to remove"
                    onClick={() => setNegatives((s) => s.filter((_, j) => j !== i))}
                  >
                    <X size={9} />
                  </button>
                ))}
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    const c = hexToRgb(useEditor.getState().primaryColor);
                    if (c) setSamples((s) => [...s, c].slice(-16));
                  }}
                  title="Add the foreground color as a sample"
                >
                  + Foreground
                </Button>
              </div>
            </>
          )}
          <Checkbox checked={invert} onChange={setInvert} label="Invert" />
          <div className="viewport-dlg-row">
            <span className="ui-label">Mode</span>
            <Select
              value={mode}
              width={150}
              options={[
                { value: 'new', label: 'New Selection' },
                { value: 'add', label: 'Add to Selection' },
                { value: 'subtract', label: 'Subtract' },
                { value: 'intersect', label: 'Intersect' },
              ]}
              onChange={setMode}
            />
          </div>
          <div className="viewport-dlg-note">
            White areas in the preview will be selected. Shift-click adds colors, Alt-click removes them. Samples are taken from all visible layers.
          </div>
        </div>
      </div>
    </Dialog>
  );
}
