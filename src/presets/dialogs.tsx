/**
 * Dialogs of the Swatches panel: "Extract palette from image" (k-means / median cut on the active
 * layer or the composite), a small text prompt (rename swatch / palette) and a confirmation
 * (deleting palettes / clearing swatches — these are not part of the document's undo history).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Dialog, Field, Select, Slider, Tabs, TextInput } from '../ui/controls';
import { openDialog, toast } from '../state/ui';
import { activeDoc, activeLayer } from '../state/editor';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, getImageData } from '../core/canvas';
import { renderDocument, renderLayerToDoc } from '../render/compositor';
import { extractPalette, type ExtractMethod, type PixelSource } from './extract';
import { describeColor } from './colorMath';
import { useUserPalettes } from './userPalettes';
import './presets.css';

/* ------------------------------ prompt ------------------------------ */

function PromptDialog({
  close,
  title,
  label,
  initial,
  confirm,
}: {
  close: (v?: string) => void;
  title: string;
  label: string;
  initial: string;
  confirm: string;
}) {
  const [v, setV] = useState(initial);
  return (
    <Dialog
      title={title}
      width={360}
      onClose={() => close()}
      onSubmit={() => close(v)}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={() => close(v)}>
            {confirm}
          </Button>
        </>
      }
    >
      <Field label={label}>
        <AutoFocusInput value={v} onChange={setV} />
      </Field>
    </Dialog>
  );
}

function AutoFocusInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      className="ui-input"
      style={{ width: '100%' }}
      autoFocus
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/** Ask for a line of text. Resolves with the trimmed value or null when cancelled/empty. */
export async function promptText(title: string, label: string, initial = '', confirm = 'OK'): Promise<string | null> {
  const r = await openDialog<string, { title: string; label: string; initial: string; confirm: string }>(PromptDialog, {
    title,
    label,
    initial,
    confirm,
  });
  const t = r?.trim();
  return t ? t : null;
}

/* ------------------------------ confirm ------------------------------ */

type ConfirmProps = {
  title: string;
  message: ReactNode;
  detail?: ReactNode;
  confirm: string;
};

function ConfirmDialog({ close, title, message, detail, confirm }: ConfirmProps & { close: (ok?: boolean) => void }) {
  return (
    <Dialog
      title={title}
      width={380}
      onClose={() => close()}
      onSubmit={() => close(true)}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="danger" onClick={() => close(true)}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="fc-pal-confirm">
        <p>{message}</p>
        {detail && <p className="fc-note">{detail}</p>}
      </div>
    </Dialog>
  );
}

/** Ask before a destructive, non-undoable action. Resolves true when confirmed. */
export async function confirmAction(opts: ConfirmProps): Promise<boolean> {
  return !!(await openDialog<boolean, ConfirmProps>(ConfirmDialog, opts));
}

/* ------------------------------ extract ------------------------------ */

type Source = 'layer' | 'composite';
const MAX_SIDE = 160;

function toPixels(c: HTMLCanvasElement): PixelSource {
  const s = Math.min(1, MAX_SIDE / Math.max(c.width, c.height, 1));
  const w = Math.max(1, Math.round(c.width * s));
  const h = Math.max(1, Math.round(c.height * s));
  const small = createCanvas(w, h);
  const ctx = ctx2d(small, { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(c, 0, 0, w, h);
  return getImageData(small);
}

/** Pixels of the active layer or of the visible composite (downscaled). Null when unavailable. */
export function readSourcePixels(source: Source): PixelSource | null {
  const doc = activeDoc();
  if (!doc) return null;
  const scale = Math.min(1, (MAX_SIDE * 2) / Math.max(doc.width, doc.height));
  try {
    if (source === 'composite') return toPixels(renderDocument(doc, { scale, background: true }));
    const layer = activeLayer();
    if (!layer) return null;
    if (layer.type === 'raster') {
      const bmp = bitmaps.tryGet(layer.bitmapId);
      return bmp ? toPixels(bmp) : null;
    }
    if (layer.type === 'adjustment') return null;
    const c = renderLayerToDoc(doc, layer, { scale });
    return c ? toPixels(c) : null;
  } catch (err) {
    console.warn('[swatches] could not read pixels', err);
    return null;
  }
}

function ExtractPaletteDialog({ close }: { close: (id?: string) => void }) {
  const doc = activeDoc();
  const layer = activeLayer();
  const layerOk = !!layer && layer.type !== 'adjustment';
  const [source, setSource] = useState<Source>(layerOk ? 'layer' : 'composite');
  const [count, setCount] = useState(8);
  const [method, setMethod] = useState<ExtractMethod>('kmeans');
  const [name, setName] = useState(`${(layerOk && source === 'layer' ? layer!.name : doc?.name) ?? 'Image'} Palette`);
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    if (!nameTouched) setName(`${(source === 'layer' && layer ? layer.name : doc?.name) ?? 'Image'} Palette`);
  }, [source, nameTouched, layer, doc]);

  const pixels = useMemo(() => readSourcePixels(source), [source]);
  const colors = useMemo(() => (pixels ? extractPalette(pixels, count, method) : []), [pixels, count, method]);
  /** A palette needs at least two colors to be useful. */
  const canCreate = colors.length >= 2;
  // Near-duplicate colors are merged, so flat artwork can yield fewer colors than requested.
  const shortfall =
    colors.length > 0 && colors.length < count
      ? `Only ${colors.length} distinct color${colors.length === 1 ? '' : 's'} found${
          source === 'layer' || method === 'kmeans'
            ? ` — try ${[source === 'layer' ? 'Whole Image' : '', method === 'kmeans' ? 'Median Cut' : ''].filter(Boolean).join(' or ')} for more`
            : ''
        }.${canCreate ? '' : ' A palette needs at least 2 colors.'}`
      : null;

  const create = () => {
    if (!canCreate) return;
    const id = useUserPalettes.getState().createPalette(name, colors.map((c) => c.color));
    toast(`Palette “${name.trim() || 'Palette'}” created (${colors.length} colors)`, 'success');
    close(id);
  };

  return (
    <Dialog
      title="Extract Palette from Image"
      width={460}
      onClose={() => close()}
      onSubmit={create}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!canCreate} onClick={create}>
            Create Palette
          </Button>
        </>
      }
    >
      <div className="fc-extract">
        <Field label="Source">
          <Tabs
            value={source}
            onChange={setSource}
            tabs={[
              { value: 'layer', label: layerOk ? `Layer: ${layer!.name}` : 'Active Layer' },
              { value: 'composite', label: 'Whole Image' },
            ]}
          />
        </Field>
        <Field label="Colors">
          <Slider value={count} min={5} max={12} step={1} onChange={(v) => setCount(Math.round(v))} />
        </Field>
        <Field label="Method">
          <Select
            value={method}
            onChange={setMethod}
            options={[
              { value: 'kmeans', label: 'K-Means (balanced)' },
              { value: 'median-cut', label: 'Median Cut (fast, keeps accents)' },
            ]}
          />
        </Field>
        <div className="fc-extract-preview" style={colors.length ? { gridTemplateColumns: `repeat(${Math.max(colors.length, 6)}, 1fr)` } : undefined}>
          {colors.length ? (
            colors.map((c) => (
              <div key={c.color} className="fc-extract-chip" title={`${describeColor(c.color)} ${c.color} · ${(c.weight * 100).toFixed(1)}% of pixels`}>
                <span style={{ background: c.color }} />
                {colors.length <= 9 && <code>{c.color}</code>}
              </div>
            ))
          ) : (
            <div className="ui-empty" style={{ width: '100%' }}>
              {source !== 'layer'
                ? 'Nothing to sample — the image is empty.'
                : !layer
                  ? 'No layer is selected — pick a layer or use Whole Image.'
                  : !layerOk
                    ? `“${layer.name}” is an adjustment layer and has no pixels of its own — select a pixel, text or shape layer, or use Whole Image.`
                    : 'The active layer has no visible pixels to sample.'}
            </div>
          )}
        </div>
        {shortfall && <div className={`fc-note fc-extract-note${canCreate ? '' : ' warn'}`}>{shortfall}</div>}
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(v) => {
              setNameTouched(true);
              setName(v);
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Open the extractor. Resolves with the new palette id (or undefined). */
export async function openExtractPalette(): Promise<string | undefined> {
  if (!activeDoc()) {
    toast('Open an image first — the palette is extracted from the active layer or the whole image', 'info');
    return undefined;
  }
  return openDialog<string>(ExtractPaletteDialog);
}
