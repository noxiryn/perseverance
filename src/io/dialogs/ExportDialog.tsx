import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Checkbox, ColorField, Dialog, NumberField, Slider, TextInput } from '../../ui/controls';
import type { Document } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { toast } from '../../state/ui';
import {
  afterPaint,
  encodeExport,
  EXT,
  exportSize,
  loadExportOptions,
  renderExportPreview,
  renderForExport,
  saveExport,
  saveExportOptions,
  SIZE_PRESETS,
  type ExportFormat,
  type ExportOptions,
} from '../exportRender';
import { formatBytes, safeFileName, withExtension } from '../math';
import { useDeferredSubmit } from './useDeferredSubmit';
import '../io.css';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];
const SCALES = [0.25, 0.5, 1, 2, 3, 4];

interface Rendered {
  key: string;
  /** Full-size export, or a reduced render of a huge one (`reduced`). */
  canvas: HTMLCanvasElement;
  /** Encoded `canvas` (exact file for full renders; basis of the estimate for reduced ones). */
  blob: Blob | null;
  width: number;
  height: number;
  reduced: boolean;
  ratio: number;
}

export function ExportDialog({ close, doc }: { close: (r?: string) => void; doc: Document }) {
  const [o, setO] = useState<ExportOptions>(() => loadExportOptions());
  const [fileName, setFileName] = useState(() => `${safeFileName(doc.name)}.${EXT[loadExportOptions().format]}`);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const job = useRef(0);

  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => setO((p) => ({ ...p, [k]: v }));
  const key = JSON.stringify(o);
  const lossy = o.format !== 'png';
  const size = useMemo(() => exportSize(doc, o), [doc, o]);

  // Re-render (debounced) and estimate the encoded size whenever options change.
  useEffect(() => {
    const id = ++job.current;
    setBusy(true);
    const t = window.setTimeout(async () => {
      try {
        const p = await renderExportPreview(doc, o);
        if (id !== job.current) return;
        const base = { key, canvas: p.canvas, width: p.width, height: p.height, reduced: p.reduced, ratio: p.ratio };
        setRendered({ ...base, blob: null });
        setError(null);
        const blob = await encodeExport(p.canvas, o);
        if (id !== job.current) return;
        setRendered({ ...base, blob });
      } catch (e) {
        if (id === job.current) setError((e as Error).message ?? String(e));
      } finally {
        if (id === job.current) setBusy(false);
      }
    }, 280);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, doc]);

  // Draw a downscaled preview (the full export may be huge).
  useEffect(() => {
    const pc = previewRef.current;
    if (!pc || !rendered) return;
    const src = rendered.canvas;
    const k = Math.min(1, 1100 / Math.max(src.width, src.height));
    pc.width = Math.max(1, Math.round(src.width * k));
    pc.height = Math.max(1, Math.round(src.height * k));
    const ctx = ctx2d(pc);
    ctx.clearRect(0, 0, pc.width, pc.height);
    // Checkerboard behind transparent exports.
    const cell = 8;
    const tile = createCanvas(cell * 2, cell * 2);
    const tctx = ctx2d(tile);
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, cell * 2, cell * 2);
    tctx.fillStyle = '#d9d9d9';
    tctx.fillRect(0, 0, cell, cell);
    tctx.fillRect(cell, cell, cell, cell);
    ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
    ctx.fillRect(0, 0, pc.width, pc.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, pc.width, pc.height);
  }, [rendered]);

  const setFormat = (f: ExportFormat) => {
    set('format', f);
    setFileName((n) => withExtension(n || safeFileName(doc.name), EXT[f]));
  };

  const doExport = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Reuse the preview when it IS the export; huge exports are only rendered now.
      const exact = rendered?.key === key && !rendered.reduced ? rendered : null;
      let canvas = exact?.canvas ?? null;
      let blob = exact?.blob ?? null;
      if (!canvas) {
        const full = exportSize(doc, o);
        if (full.width * full.height > 4_000_000) {
          toast(`Rendering ${full.width}×${full.height} px…`, 'info', 3000);
          await afterPaint();
        }
        canvas = await renderForExport(doc, o);
      }
      if (!blob) blob = await encodeExport(canvas, o);
      const name = withExtension(safeFileName(fileName.trim() || doc.name), EXT[o.format]);
      saveExportOptions(o);
      const res = await saveExport(blob, name, o.format);
      if (res) {
        toast(`Exported ${canvas.width}×${canvas.height} ${o.format.toUpperCase()} (${formatBytes(blob.size)})`, 'success');
        close('ok');
      }
    } catch (e) {
      toast(`Export failed: ${(e as Error).message ?? e}`, 'error', 5000);
    } finally {
      setSaving(false);
    }
  };

  const submitOnEnter = useDeferredSubmit(() => void doExport());
  const out = rendered?.key === key ? rendered : null;
  const estimate = out?.blob ? out.blob.size * (out.reduced ? out.ratio : 1) : null;
  const preset = SIZE_PRESETS.find((p) => p.id === o.presetId);
  // What Cover / Fit does when the aspect ratios differ.
  let fitNote: string | null = null;
  if (preset) {
    const srcAspect = doc.width / doc.height;
    const dstAspect = preset.width / preset.height;
    if (Math.abs(srcAspect - dstAspect) > 0.01) {
      const wider = srcAspect > dstAspect;
      fitNote =
        o.fit === 'cover'
          ? `The ${wider ? 'left and right' : 'top and bottom'} edges of the document are cropped.`
          : `${wider ? 'Top and bottom' : 'Left and right'} bars are added (${o.format === 'jpeg' || o.fillBackground ? 'background color' : 'transparent'}).`;
    }
  }

  return (
    <Dialog
      title="Export As"
      width={920}
      onClose={() => close()}
      onSubmit={submitOnEnter}
      footer={
        <>
          <span className="io-faint" style={{ marginRight: 'auto', fontSize: 'var(--fs-sm)' }}>
            Tip: Alt+Shift+Ctrl+S exports a full-size PNG instantly
          </span>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" icon={Download} disabled={saving || !!error} onClick={doExport}>
            {saving ? 'Exporting…' : 'Export'}
          </Button>
        </>
      }
    >
      <div className="io-export">
        <div className="io-export-preview">
          {error ? (
            <div className="io-error" style={{ padding: 24, textAlign: 'center' }}>
              Cannot export: {error}
            </div>
          ) : (
            <canvas ref={previewRef} />
          )}
          {out && !error && (
            <span className="io-export-badge">
              {out.width} × {out.height} px{out.reduced ? ' · reduced preview' : ''}
            </span>
          )}
          {busy && <span className="io-export-busy">Rendering…</span>}
        </div>
        <div className="io-export-side">
          <div className="io-export-controls">
            <div className="io-form-label">File name</div>
            <TextInput value={fileName} onChange={setFileName} />

            <div className="io-form-label">Format</div>
            <div className="io-seg">
              {FORMATS.map((f) => (
                <button key={f.value} className={o.format === f.value ? 'active' : ''} onClick={() => setFormat(f.value)}>
                  {f.label}
                </button>
              ))}
            </div>

            {lossy && (
              <>
                <div className="io-form-label">Quality</div>
                <Slider value={Math.round(o.quality * 100)} min={1} max={100} unit="%" onChange={(v) => set('quality', v / 100)} />
              </>
            )}

            <div className="io-form-label">Size</div>
            <div className="io-size-chips">
              <button className={`io-chip${!preset ? ' active' : ''}`} onClick={() => set('presetId', null)}>
                Document
                <small>
                  {Math.round(doc.width * o.scale)} × {Math.round(doc.height * o.scale)}
                </small>
              </button>
              {SIZE_PRESETS.map((p) => (
                <button key={p.id} className={`io-chip${preset?.id === p.id ? ' active' : ''}`} onClick={() => set('presetId', p.id)}>
                  {p.label}
                  <small>
                    {p.width} × {p.height}
                  </small>
                </button>
              ))}
            </div>

            {preset ? (
              <>
                <div className="io-form-label">Fit</div>
                <div className="io-seg">
                  <button
                    className={o.fit === 'cover' ? 'active' : ''}
                    onClick={() => set('fit', 'cover')}
                    title="Fill the frame, cropping the edges"
                  >
                    Cover (crop)
                  </button>
                  <button
                    className={o.fit === 'fit' ? 'active' : ''}
                    onClick={() => set('fit', 'fit')}
                    title="Fit inside the frame with borders"
                  >
                    Fit (letterbox)
                  </button>
                </div>
                {fitNote && (
                  <div className="io-note" style={{ marginTop: 4 }}>
                    {fitNote}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="io-form-label">Scale</div>
                <div className="ui-row">
                  <div className="io-seg" style={{ flex: 1 }}>
                    {SCALES.map((s) => (
                      <button key={s} className={o.scale === s ? 'active' : ''} onClick={() => set('scale', s)}>
                        {s}×
                      </button>
                    ))}
                  </div>
                  <NumberField
                    value={o.scale * 100}
                    min={25}
                    max={400}
                    step={1}
                    unit="%"
                    width={64}
                    onChange={(v) => set('scale', Math.round(v) / 100)}
                  />
                </div>
              </>
            )}

            <div className="io-form-label">Options</div>
            <div className="ui-row">
              <Checkbox
                checked={o.format === 'jpeg' || o.fillBackground}
                disabled={o.format === 'jpeg'}
                onChange={(v) => set('fillBackground', v)}
                label={o.format === 'jpeg' ? 'Background (JPEG has no transparency)' : 'Fill background'}
              />
            </div>
            {(o.format === 'jpeg' || o.fillBackground) && (
              <div className="ui-row" style={{ paddingLeft: 19 }}>
                <ColorField value={o.background} onChange={(c) => set('background', c)} showHex />
              </div>
            )}
            <div className="ui-row">
              <Checkbox checked={o.trim} onChange={(v) => set('trim', v)} label="Trim transparent pixels" />
            </div>
          </div>

          <div className="io-export-stats">
            <span>Dimensions</span>
            <span>{out ? `${out.width} × ${out.height}` : `${size.width} × ${size.height}`}</span>
            <span>Format</span>
            <span>
              {o.format.toUpperCase()}
              {lossy ? ` · ${Math.round(o.quality * 100)}%` : ''}
            </span>
            <span>File size</span>
            <span title={out?.reduced ? 'Estimated from a reduced preview — the image is rendered at full size on export' : undefined}>
              {error ? '—' : estimate !== null ? `≈ ${formatBytes(Math.round(estimate))}${out?.reduced ? ' (est.)' : ''}` : 'Estimating…'}
            </span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
