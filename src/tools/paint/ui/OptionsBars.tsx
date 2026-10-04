/** Options bars for every paint tool (rendered by the shell's options bar host). */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Gauge, LocateOff, PenTool, RotateCcw, SlidersHorizontal, Wind } from 'lucide-react';
import type { GradientKind } from '../../../core/types';
import { assets, useRegistry } from '../../../registry';
import { useEditor, useToolOptions } from '../../../state/editor';
import { useUI } from '../../../state/ui';
import { Checkbox, GradientField, IconButton, Popover, Select, Slider } from '../../../ui/controls';
import { buildLUT, renderGradientPixels } from '../engine/gradient';
import { createCanvas, ctx2d } from '../../../core/canvas';
import {
  BRUSH_DEFAULTS,
  BUCKET_DEFAULTS,
  CLONE_DEFAULTS,
  ERASER_DEFAULTS,
  GRADIENT_DEFAULTS,
  PENCIL_DEFAULTS,
  effectiveGradient,
  retouchDefaults,
  setOpt,
  type EraserMode,
  type RetouchToolOptions,
  type ToneRange,
} from '../options';
import { PresetPicker, TipThumb } from './PresetList';
import { BlendSelect, CanvasView, OptLabel, OptSep, ScrubNumber, ToggleIcon } from './widgets';
import { cloneSource, clearCloneSource, subscribeCloneSource } from '../tools/cloneState';
import { ChevronDown } from 'lucide-react';
import '../paint.css';

const pct = { min: 0, max: 1, step: 1, displayScale: 100, unit: '%' } as const;

/** Toggle the Brushes panel (tip, dynamics and smoothing settings) — like Photoshop's brush settings button. */
function BrushesPanelToggle() {
  const open = useUI((s) => s.flyoutPanel === 'brushes' || s.workspace.groups.some((g) => g.active === 'brushes' && !g.collapsed));
  return (
    <ToggleIcon
      icon={SlidersHorizontal}
      active={open}
      title="Toggle the Brushes panel (tip shape, dynamics, presets)"
      onClick={() => useUI.getState().togglePanel('brushes')}
    />
  );
}

function PressureToggles({ toolId, size, opacity }: { toolId: string; size: boolean; opacity?: boolean }) {
  return (
    <>
      {opacity !== undefined && (
        <ToggleIcon icon={Gauge} active={opacity} title="Pen pressure controls opacity" onClick={() => setOpt(toolId, 'pressureOpacity', !opacity)} />
      )}
      <ToggleIcon icon={PenTool} active={size} title="Pen pressure controls size" onClick={() => setOpt(toolId, 'pressureSize', !size)} />
    </>
  );
}

/* ---------------- Brush ---------------- */

export function BrushOptionsBar() {
  const o = useToolOptions('brush', BRUSH_DEFAULTS);
  return (
    <div className="paint-opts">
      <PresetPicker toolId="brush" />
      <BrushesPanelToggle />
      <OptSep />
      <BlendSelect value={o.blendMode} onChange={(v) => setOpt('brush', 'blendMode', v)} />
      <ScrubNumber label="Opacity" value={o.opacity} onChange={(v) => setOpt('brush', 'opacity', v)} {...pct} />
      <ToggleIcon icon={Gauge} active={o.pressureOpacity} title="Pen pressure controls opacity" onClick={() => setOpt('brush', 'pressureOpacity', !o.pressureOpacity)} />
      <ScrubNumber label="Flow" value={o.flow} onChange={(v) => setOpt('brush', 'flow', v)} {...pct} />
      <ToggleIcon icon={Wind} active={o.airbrush} title="Airbrush-style build-up" onClick={() => setOpt('brush', 'airbrush', !o.airbrush)} />
      <OptSep />
      <ScrubNumber label="Smoothing" value={o.smoothing} onChange={(v) => setOpt('brush', 'smoothing', v)} min={0} max={100} unit="%" />
      <ScrubNumber label="Angle" value={o.angle} onChange={(v) => setOpt('brush', 'angle', v)} min={-180} max={180} unit="°" width={44} />
      <ToggleIcon icon={PenTool} active={o.pressureSize} title="Pen pressure controls size" onClick={() => setOpt('brush', 'pressureSize', !o.pressureSize)} />
    </div>
  );
}

/* ---------------- Pencil ---------------- */

export function PencilOptionsBar() {
  const o = useToolOptions('pencil', PENCIL_DEFAULTS);
  return (
    <div className="paint-opts">
      <div className="paint-opt-group">
        <TipThumb presetId="" hardness={1} size={20} pencil square={o.shape === 'square'} />
        <ScrubNumber label="Size" value={o.size} onChange={(v) => setOpt('pencil', 'size', Math.max(1, Math.round(v)))} min={1} max={500} unit="px" sliderMax={100} />
      </div>
      <Select
        value={o.shape}
        options={[
          { value: 'round', label: 'Round' },
          { value: 'square', label: 'Square' },
        ]}
        onChange={(v) => setOpt('pencil', 'shape', v)}
        width={80}
        title="Pencil tip shape"
      />
      <OptSep />
      <BlendSelect value={o.blendMode} onChange={(v) => setOpt('pencil', 'blendMode', v)} />
      <ScrubNumber label="Opacity" value={o.opacity} onChange={(v) => setOpt('pencil', 'opacity', v)} {...pct} />
      <OptSep />
      <ScrubNumber label="Smoothing" value={o.smoothing} onChange={(v) => setOpt('pencil', 'smoothing', v)} min={0} max={100} unit="%" />
      <PressureToggles toolId="pencil" size={o.pressureSize} />
    </div>
  );
}

/* ---------------- Eraser ---------------- */

export function EraserOptionsBar() {
  const o = useToolOptions('eraser', ERASER_DEFAULTS);
  return (
    <div className="paint-opts">
      {o.mode === 'brush' ? (
        <>
          <PresetPicker toolId="eraser" />
          <BrushesPanelToggle />
        </>
      ) : (
        <ScrubNumber label="Size" value={o.size} onChange={(v) => setOpt('eraser', 'size', Math.max(1, Math.round(v)))} min={1} max={1000} unit="px" sliderMax={300} />
      )}
      <OptSep />
      <div className="paint-opt-group">
        <OptLabel>Mode</OptLabel>
        <Select<EraserMode>
          value={o.mode}
          options={[
            { value: 'brush', label: 'Brush' },
            { value: 'pencil', label: 'Pencil' },
            { value: 'block', label: 'Block' },
          ]}
          onChange={(v) => setOpt('eraser', 'mode', v)}
          width={80}
        />
      </div>
      {o.mode !== 'block' && <ScrubNumber label="Opacity" value={o.opacity} onChange={(v) => setOpt('eraser', 'opacity', v)} {...pct} />}
      {o.mode === 'brush' && (
        <>
          <ToggleIcon icon={Gauge} active={o.pressureOpacity} title="Pen pressure controls opacity" onClick={() => setOpt('eraser', 'pressureOpacity', !o.pressureOpacity)} />
          <ScrubNumber label="Flow" value={o.flow} onChange={(v) => setOpt('eraser', 'flow', v)} {...pct} />
        </>
      )}
      <OptSep />
      <ScrubNumber label="Smoothing" value={o.smoothing} onChange={(v) => setOpt('eraser', 'smoothing', v)} min={0} max={100} unit="%" />
      {o.mode === 'brush' && (
        <ToggleIcon icon={PenTool} active={o.pressureSize} title="Pen pressure controls size" onClick={() => setOpt('eraser', 'pressureSize', !o.pressureSize)} />
      )}
      <span className="paint-opt-hint">Erases to transparency · paints the background color on masks and locked layers</span>
    </div>
  );
}

/* ---------------- Clone stamp ---------------- */

export function CloneOptionsBar() {
  const o = useToolOptions('clone-stamp', CLONE_DEFAULTS);
  // Re-render when the document or the clone source changes.
  useEditor((s) => s.activeDocId);
  useSyncExternalStore(subscribeCloneSource, () => cloneSource());
  const src = cloneSource();
  return (
    <div className="paint-opts">
      <PresetPicker toolId="clone-stamp" />
      <BrushesPanelToggle />
      <OptSep />
      <BlendSelect value={o.blendMode} onChange={(v) => setOpt('clone-stamp', 'blendMode', v)} exclude={['behind', 'clear']} />
      <ScrubNumber label="Opacity" value={o.opacity} onChange={(v) => setOpt('clone-stamp', 'opacity', v)} {...pct} />
      <ScrubNumber label="Flow" value={o.flow} onChange={(v) => setOpt('clone-stamp', 'flow', v)} {...pct} />
      <OptSep />
      <Checkbox checked={o.aligned} onChange={(v) => setOpt('clone-stamp', 'aligned', v)} label="Aligned" title="Keep the same offset between strokes" />
      <div className="paint-opt-group">
        <OptLabel>Sample</OptLabel>
        <Select
          value={o.sample}
          options={[
            { value: 'current', label: 'Current Layer' },
            { value: 'all', label: 'All Layers' },
          ]}
          onChange={(v) => setOpt('clone-stamp', 'sample', v)}
          width={112}
        />
      </div>
      <OptSep />
      {src ? (
        <>
          <span className="paint-opt-hint">
            Source {Math.round(src.source.x)}, {Math.round(src.source.y)}
          </span>
          <IconButton icon={LocateOff} size="sm" title="Clear clone source" onClick={() => clearCloneSource()} />
        </>
      ) : (
        <span className="paint-opt-hint">Alt-click to set the clone source</span>
      )}
    </div>
  );
}

/* ---------------- Gradient ---------------- */

const KINDS: { value: GradientKind; title: string }[] = [
  { value: 'linear', title: 'Linear gradient' },
  { value: 'radial', title: 'Radial gradient' },
  { value: 'angle', title: 'Angle gradient' },
  { value: 'reflected', title: 'Reflected gradient' },
  { value: 'diamond', title: 'Diamond gradient' },
];

const kindIconCache = new Map<string, HTMLCanvasElement>();
function kindIcon(kind: GradientKind): HTMLCanvasElement {
  const hit = kindIconCache.get(kind);
  if (hit) return hit;
  const n = 32;
  const c = createCanvas(n, n);
  const img = new ImageData(n, n);
  const lut = buildLUT([
    { offset: 0, color: '#f2f2f2' },
    { offset: 1, color: '#2a2a2a' },
  ]);
  const center = kind === 'linear' ? { s: { x: 3, y: 16 }, e: { x: 29, y: 16 } } : { s: { x: 16, y: 16 }, e: { x: kind === 'reflected' ? 29 : 30, y: 16 } };
  renderGradientPixels(img.data, n, n, 0, 0, 1, null, { kind, start: center.s, end: center.e, lut, dither: false });
  ctx2d(c).putImageData(img, 0, 0);
  kindIconCache.set(kind, c);
  return c;
}

export function GradientOptionsBar() {
  const o = useToolOptions('gradient', GRADIENT_DEFAULTS);
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const g = useMemo(() => effectiveGradient(o), [o.gradient, o.kind, primary, secondary]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="paint-opts">
      <div className="paint-gradient-field" title={o.gradient ? 'Edit gradient' : 'Foreground → Background (click to edit)'}>
        <GradientField value={g} onChange={(v) => setOpt('gradient', 'gradient', { ...v, kind: o.kind })} showGeometry={false} />
      </div>
      <IconButton
        icon={RotateCcw}
        size="sm"
        title="Reset to Foreground → Background"
        active={!o.gradient}
        onClick={() => setOpt('gradient', 'gradient', null)}
      />
      <OptSep />
      <div className="paint-seg" role="radiogroup" aria-label="Gradient type">
        {KINDS.map((k) => (
          <button key={k.value} className={`paint-seg-btn${o.kind === k.value ? ' active' : ''}`} title={k.title} onClick={() => setOpt('gradient', 'kind', k.value)}>
            <CanvasView source={kindIcon(k.value)} width={16} height={16} className="paint-kind-icon" />
          </button>
        ))}
      </div>
      <OptSep />
      <BlendSelect value={o.blendMode} onChange={(v) => setOpt('gradient', 'blendMode', v)} />
      <ScrubNumber label="Opacity" value={o.opacity} onChange={(v) => setOpt('gradient', 'opacity', v)} {...pct} />
      <OptSep />
      <Checkbox checked={o.reverse} onChange={(v) => setOpt('gradient', 'reverse', v)} label="Reverse" />
      <Checkbox checked={o.dither} onChange={(v) => setOpt('gradient', 'dither', v)} label="Dither" />
      <Checkbox checked={o.transparency} onChange={(v) => setOpt('gradient', 'transparency', v)} label="Transparency" />
      <span className="paint-opt-hint">Drag to draw · Shift snaps to 45°</span>
    </div>
  );
}

/* ---------------- Paint bucket ---------------- */

export function BucketOptionsBar() {
  const o = useToolOptions('paint-bucket', BUCKET_DEFAULTS);
  const list = useRegistry(assets);
  const patterns = useMemo(
    () =>
      list
        .filter((a) => a.category !== 'My Assets')
        .map((a) => ({ value: a.id, label: `${a.category} · ${a.name}` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [list],
  );
  return (
    <div className="paint-opts">
      <div className="paint-opt-group">
        <OptLabel>Fill</OptLabel>
        <Select
          value={o.source}
          options={[
            { value: 'foreground', label: 'Foreground' },
            { value: 'pattern', label: 'Pattern' },
          ]}
          onChange={(v) => {
            setOpt('paint-bucket', 'source', v);
            if (v === 'pattern' && !o.patternId && patterns[0]) setOpt('paint-bucket', 'patternId', patterns[0].value);
          }}
          width={100}
        />
      </div>
      {o.source === 'pattern' && (
        <>
          <Select
            value={o.patternId || (patterns[0]?.value ?? '')}
            options={patterns.length ? patterns : [{ value: '', label: 'No patterns available' }]}
            onChange={(v) => setOpt('paint-bucket', 'patternId', v)}
            width={170}
            title="Pattern asset"
          />
          <ScrubNumber label="Scale" value={o.patternScale} onChange={(v) => setOpt('paint-bucket', 'patternScale', v)} min={0.1} max={4} step={1} displayScale={100} unit="%" />
        </>
      )}
      <OptSep />
      <BlendSelect value={o.blendMode} onChange={(v) => setOpt('paint-bucket', 'blendMode', v)} />
      <ScrubNumber label="Opacity" value={o.opacity} onChange={(v) => setOpt('paint-bucket', 'opacity', v)} {...pct} />
      <ScrubNumber label="Tolerance" value={o.tolerance} onChange={(v) => setOpt('paint-bucket', 'tolerance', Math.round(v))} min={0} max={255} />
      <OptSep />
      <Checkbox checked={o.antiAlias} onChange={(v) => setOpt('paint-bucket', 'antiAlias', v)} label="Anti-alias" />
      <Checkbox checked={o.contiguous} onChange={(v) => setOpt('paint-bucket', 'contiguous', v)} label="Contiguous" />
      <Checkbox checked={o.allLayers} onChange={(v) => setOpt('paint-bucket', 'allLayers', v)} label="All Layers" />
    </div>
  );
}

/* ---------------- Retouch ---------------- */

function SizeHardness({ toolId, o }: { toolId: string; o: RetouchToolOptions }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button className="paint-picker-btn" title="Brush size & hardness" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        <TipThumb presetId="" hardness={o.hardness} size={20} />
        <span className="paint-picker-size">{Math.round(o.size)}</span>
        <ChevronDown size={10} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" width={260}>
          <div className="paint-picker">
            <div className="paint-picker-row">
              <span className="paint-opt-label">Size</span>
              <Slider value={o.size} onChange={(v) => setOpt(toolId, 'size', v)} min={1} max={800} unit="px" />
            </div>
            <div className="paint-picker-row">
              <span className="paint-opt-label">Hardness</span>
              <Slider value={o.hardness} onChange={(v) => setOpt(toolId, 'hardness', v)} min={0} max={1} step={1} displayScale={100} unit="%" />
            </div>
            <div className="paint-picker-row">
              <span className="paint-opt-label">Spacing</span>
              <Slider value={o.spacing} onChange={(v) => setOpt(toolId, 'spacing', v)} min={0.02} max={1} step={1} displayScale={100} unit="%" />
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

export function RetouchOptionsBar() {
  const toolId = useEditor((s) => s.activeTool);
  const o = useToolOptions(toolId, retouchDefaults(toolId));
  const isTone = toolId === 'dodge' || toolId === 'burn';
  return (
    <div className="paint-opts">
      <SizeHardness toolId={toolId} o={o} />
      <OptSep />
      {(toolId === 'blur-brush' || toolId === 'sharpen-brush' || toolId === 'smudge') && (
        <ScrubNumber label="Strength" value={o.strength} onChange={(v) => setOpt(toolId, 'strength', v)} {...pct} />
      )}
      {toolId === 'smudge' && (
        <Checkbox checked={o.fingerPainting} onChange={(v) => setOpt(toolId, 'fingerPainting', v)} label="Finger Painting" title="Start each stroke with the foreground color" />
      )}
      {isTone && (
        <>
          <div className="paint-opt-group">
            <OptLabel>Range</OptLabel>
            <Select<ToneRange>
              value={o.range}
              options={[
                { value: 'shadows', label: 'Shadows' },
                { value: 'midtones', label: 'Midtones' },
                { value: 'highlights', label: 'Highlights' },
              ]}
              onChange={(v) => setOpt(toolId, 'range', v)}
              width={96}
            />
          </div>
          <ScrubNumber label="Exposure" value={o.exposure} onChange={(v) => setOpt(toolId, 'exposure', v)} {...pct} />
          <Checkbox checked={o.protectTones} onChange={(v) => setOpt(toolId, 'protectTones', v)} label="Protect Tones" />
        </>
      )}
      {toolId === 'sponge' && (
        <>
          <div className="paint-opt-group">
            <OptLabel>Mode</OptLabel>
            <Select
              value={o.spongeMode}
              options={[
                { value: 'desaturate', label: 'Desaturate' },
                { value: 'saturate', label: 'Saturate' },
              ]}
              onChange={(v) => setOpt(toolId, 'spongeMode', v)}
              width={100}
            />
          </div>
          <ScrubNumber label="Flow" value={o.flow} onChange={(v) => setOpt(toolId, 'flow', v)} {...pct} />
          <Checkbox checked={o.vibrance} onChange={(v) => setOpt(toolId, 'vibrance', v)} label="Vibrance" title="Protect already-saturated colors from clipping" />
        </>
      )}
      <OptSep />
      <ScrubNumber label="Smoothing" value={o.smoothing} onChange={(v) => setOpt(toolId, 'smoothing', v)} min={0} max={100} unit="%" />
      <ToggleIcon
        icon={Gauge}
        active={o.pressureStrength}
        title={`Pen pressure controls ${isTone ? 'exposure' : toolId === 'sponge' ? 'flow' : 'strength'}`}
        onClick={() => setOpt(toolId, 'pressureStrength', !o.pressureStrength)}
      />
      <ToggleIcon icon={PenTool} active={o.pressureSize} title="Pen pressure controls size" onClick={() => setOpt(toolId, 'pressureSize', !o.pressureSize)} />
    </div>
  );
}
