/**
 * Remove Background dialog: live preview on a checkerboard (computed on a downscaled working copy),
 * Auto / Color key / Green screen modes, tolerance + softness, feather, shrink edge, spill
 * decontamination, and output as deleted pixels (default, trims the layer to the character) or a
 * layer mask. Warns when parts of the subject would end up semi-transparent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Pipette, Scissors } from 'lucide-react';
import { Button, Checkbox, Dialog, Field } from '../../ui/controls';
import { activeDoc } from '../../state/editor';
import { openDialog } from '../../state/ui';
import { bitmaps } from '../../core/bitmaps';
import { createCanvas, ctx2d, ctxRead } from '../../core/canvas';
import type { RasterLayer } from '../../core/types';
import '../roblox.css';
import { ColorRow, Group, Hint, Seg, SliderRow } from '../studio/ui';
import { DEFAULT_BG_PARAMS, GREEN_PRESET, PARTIAL_INTERIOR_WARN, applyMask, cutoutStats, paletteFor, removeBackground, type BgMode, type BgParams } from './core';
import { applyRemoveBackground, type BgOutput } from './apply';
import { rgbToHexString } from '../pixels';

const PREVIEW_MAX = 960;

type View = 'result' | 'overlay' | 'mask';

const MODE_OPTIONS: { value: BgMode; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Samples the border colors and flood-fills the background from every edge' },
  { value: 'color', label: 'Color key', title: 'Remove one color (click the preview to pick it)' },
  { value: 'green', label: 'Green screen', title: 'Chroma key for green backdrops' },
];

let lastParams: BgParams = { ...DEFAULT_BG_PARAMS };
// Delete is the default: character styles and looks need a real cut-out (smart filters run before
// a layer mask), and the layer gets trimmed to the character.
let lastOutput: BgOutput = 'delete';

interface Working {
  img: ImageData;
  scale: number;
}

function makeWorking(layer: RasterLayer): Working | null {
  const src = bitmaps.tryGet(layer.bitmapId);
  if (!src) return null;
  const scale = Math.min(1, PREVIEW_MAX / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const c = createCanvas(w, h);
  const ctx = ctxRead(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return { img: ctx.getImageData(0, 0, w, h), scale };
}

export interface RemoveBgProps extends Record<string, unknown> {
  layerId: string;
}

export function RemoveBgDialog({ close, layerId }: RemoveBgProps & { close: (r?: unknown) => void }) {
  const [layer] = useState(() => activeDoc()?.layers[layerId] as RasterLayer | undefined);
  const working = useMemo(() => (layer ? makeWorking(layer) : null), [layer]);
  const [params, setParams] = useState<BgParams>(() => ({ ...lastParams }));
  const [output, setOutput] = useState<BgOutput>(lastOutput);
  const [view, setView] = useState<View>('result');
  const [picking, setPicking] = useState(false);
  const [stats, setStats] = useState<{ removed: number; partialInterior: number; palette: string[] } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const set = (patch: Partial<BgParams>) => setParams((p) => ({ ...p, ...patch }));

  // Live preview (debounced so slider drags stay smooth).
  useEffect(() => {
    if (!working) return;
    const t = window.setTimeout(() => {
      const c = canvasRef.current;
      if (!c) return;
      const { img, scale } = working;
      const copy = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
      const scaled: BgParams = { ...params, feather: params.feather * scale, shrink: params.shrink * scale };
      const { mask, palette } = removeBackground(copy, scaled);
      const out = new ImageData(img.width, img.height);
      const o = out.data;
      const d = copy.data;
      const quality = cutoutStats(img, mask);
      for (let i = 0, q = 0; i < mask.length; i++, q += 4) {
        const m = mask[i];
        if (view === 'mask') {
          o[q] = o[q + 1] = o[q + 2] = (m * d[q + 3]) / 255;
          o[q + 3] = 255;
        } else if (view === 'overlay') {
          const k = (1 - m / 255) * 0.6;
          o[q] = img.data[q] * (1 - k) + 255 * k;
          o[q + 1] = img.data[q + 1] * (1 - k) + 40 * k;
          o[q + 2] = img.data[q + 2] * (1 - k) + 60 * k;
          o[q + 3] = img.data[q + 3];
        } else {
          o[q] = d[q];
          o[q + 1] = d[q + 1];
          o[q + 2] = d[q + 2];
          o[q + 3] = d[q + 3];
        }
      }
      if (view === 'result') applyMask(out, mask);
      c.width = img.width;
      c.height = img.height;
      ctx2d(c).putImageData(out, 0, 0);
      setStats({ removed: quality.removed, partialInterior: quality.partialInterior, palette: palette.map((p) => rgbToHexString(p[0], p[1], p[2])) });
    }, 40);
    return () => window.clearTimeout(t);
  }, [working, params, view]);

  const pickAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!working || (!picking && params.mode !== 'color')) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * working.img.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * working.img.height);
    if (x < 0 || y < 0 || x >= working.img.width || y >= working.img.height) return;
    const q = (y * working.img.width + x) * 4;
    const d = working.img.data;
    set({ mode: 'color', keyColor: rgbToHexString(d[q], d[q + 1], d[q + 2]) });
    setPicking(false);
  };

  const apply = () => {
    lastParams = params;
    lastOutput = output;
    if (applyRemoveBackground(layerId, params, output)) close(true);
  };
  // Enter: the Dialog first blurs a focused number field (committing its typed value) and submits
  // on the next tick — go through a ref so the freshly committed params are the ones applied.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const submit = useCallback(() => applyRef.current(), []);

  if (!layer || !working) {
    return (
      <Dialog title="Remove Background" onClose={() => close()} footer={<Button onClick={() => close()}>Close</Button>}>
        <div className="ui-empty">The selected layer has no pixels to process.</div>
      </Dialog>
    );
  }

  const autoPalette = params.mode === 'auto' && stats ? stats.palette : params.mode === 'auto' ? paletteFor(working.img, params).map((p) => rgbToHexString(p[0], p[1], p[2])) : [];

  return (
    <Dialog
      title={`Remove Background — “${layer.name}”`}
      width="min(1180px, 92vw)"
      onClose={() => close()}
      onSubmit={submit}
      footer={
        <div className="roblox-foot">
          <span className="info">
            {stats ? `${Math.round(stats.removed * 100)}% of the layer removed` : 'Computing…'} · {layer.width}×{layer.height}px
          </span>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" icon={output === 'mask' ? Scissors : Eraser} onClick={apply}>
            {output === 'mask' ? 'Apply as Mask' : 'Delete Background'}
          </Button>
        </div>
      }
    >
      <div className="roblox-bg">
        <div className="roblox-bg-preview">
          <div className="roblox-bg-toolbar">
            <Seg
              value={view}
              options={[
                { value: 'result', label: 'Result' },
                { value: 'overlay', label: 'Overlay' },
                { value: 'mask', label: 'Mask' },
              ]}
              onChange={setView}
            />
            <span style={{ flex: 1 }} />
            <Button size="small" variant={picking ? 'primary' : undefined} icon={Pipette} onClick={() => setPicking(!picking)} title="Click the background in the preview to key out that color">
              Pick color
            </Button>
          </div>
          <div className="roblox-bg-stage">
            <canvas
              ref={canvasRef}
              className={`roblox-bg-canvas${view === 'result' ? ' checker' : ''}`}
              style={{ cursor: picking || params.mode === 'color' ? 'crosshair' : 'default', aspectRatio: `${working.img.width} / ${working.img.height}` }}
              onPointerDown={pickAt}
            />
          </div>
        </div>
        <div className="roblox-bg-side">
          <Group title="Mode">
            <Seg
              value={params.mode}
              options={MODE_OPTIONS}
              onChange={(mode) => set(mode === 'green' ? { ...GREEN_PRESET } : mode === 'auto' ? { mode, tolerance: DEFAULT_BG_PARAMS.tolerance, softness: DEFAULT_BG_PARAMS.softness } : { mode })}
            />
            {params.mode === 'auto' && (
              <Hint>
                Border colors detected:{' '}
                <span style={{ display: 'inline-flex', gap: 3, verticalAlign: 'middle' }}>
                  {autoPalette.length ? autoPalette.map((c) => <span key={c} title={c} style={{ width: 12, height: 12, borderRadius: 2, background: c, boxShadow: 'inset 0 0 0 1px #fff3' }} />) : 'transparent border (uses existing alpha)'}
                </span>
              </Hint>
            )}
            {params.mode === 'color' && (
              <>
                <ColorRow label="Key color" value={params.keyColor} onChange={(keyColor) => set({ keyColor })} />
                <Hint>Click the background in the preview to pick its color.</Hint>
              </>
            )}
            <SliderRow label="Tolerance" value={params.tolerance} min={0} max={100} step={1} onChange={(tolerance) => set({ tolerance })} hint="How different a color may be and still count as background" />
            <SliderRow label="Softness" value={params.softness} min={0} max={60} step={1} onChange={(softness) => set({ softness })} hint="Partial transparency band along the cut" />
            {stats && stats.partialInterior > PARTIAL_INTERIOR_WARN && (
              <div className="roblox-bg-warn" role="status">
                ⚠ {Math.round(stats.partialInterior * 100)}% of the subject would be semi-transparent — lower Tolerance or Softness
                {params.mode === 'auto' ? ', or pick the background color with Color key' : ''}. Check the Mask view (white = kept).
              </div>
            )}
            {params.mode !== 'auto' && (
              <Field label="">
                <Checkbox checked={params.contiguous} onChange={(contiguous) => set({ contiguous })} label="Only connected to the edges" />
              </Field>
            )}
          </Group>
          <Group title="Edges">
            <SliderRow label="Feather" value={params.feather} min={0} max={20} step={0.1} unit="px" onChange={(feather) => set({ feather })} />
            <SliderRow label="Shrink edge" value={params.shrink} min={0} max={20} step={0.5} unit="px" onChange={(shrink) => set({ shrink })} hint="Erode the cut-out to drop background fringes" />
            <SliderRow
              label="Decontaminate"
              value={params.decontaminate}
              min={0}
              max={1}
              step={0.01}
              displayScale={100}
              unit="%"
              onChange={(decontaminate) => set({ decontaminate })}
              hint="Remove background color spill from the pixels along the cut. This recolors those edge pixels on the layer (interior colors are never changed), even with Layer mask output — set 0% to keep every pixel untouched."
            />
          </Group>
          <Group title="Output">
            <Seg
              value={output}
              options={[
                { value: 'delete', label: 'Delete background', title: 'Erase the background and trim the layer to the character (best for character styles and looks)' },
                { value: 'mask', label: 'Layer mask', title: 'Non-destructive: hide the background with a layer mask' },
              ]}
              onChange={setOutput}
            />
            <Hint>
              {output === 'mask'
                ? `Non-destructive — refine later by painting on the mask, or disable it with Shift-click on its thumbnail. Character Styler styles and looks apply this mask automatically before styling.${params.decontaminate > 0 ? ' Edge decontamination still recolors pixels along the cut.' : ''}`
                : 'Erases the background and trims the layer to your character, so styles, looks and the transform box follow the character (undo with Ctrl+Z).'}
            </Hint>
            {output === 'mask' && layer.mask && (
              <Hint>
                {layer.mask.enabled === false
                  ? '⚠ This layer has a disabled mask — applying replaces it (Undo restores it).'
                  : 'The layer already has a mask — the cut-out is combined with it.'}
              </Hint>
            )}
          </Group>
        </div>
      </div>
    </Dialog>
  );
}

export function openRemoveBackground(layerId: string) {
  return openDialog<unknown, RemoveBgProps>(RemoveBgDialog, { layerId });
}
