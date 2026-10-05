/** Options bar for the shape tools. Reflects (and edits) the active shape layer when there is one. */
import { useEditor } from '../../state/editor';
import { shapePresets } from '../../registry';
import { NumberField, Select } from '../../ui/controls';
import type { Gradient, ShapeLayer } from '../../core/types';
import {
  KIND_LABEL,
  SHARED_KEYS,
  TOOL_KIND,
  applyOptionToShape,
  defaultGradient,
  editShapeLayer,
  isShapeToolId,
  keyAppliesToKind,
  optionsFromShape,
  shapeDefaults,
  writeShapeOptions,
  type EditPhase,
  type ShapeToolId,
  type ShapeToolOptions,
} from './options';
import { ALIGN_OPTIONS, DashSelect, FillButton, StrokeButton } from './PaintControls';
import { PresetPicker } from './PresetPicker';
import './shape.css';

const LABELS: Partial<Record<keyof ShapeToolOptions, string>> = {
  fillMode: 'Shape Fill',
  fillColor: 'Shape Fill',
  fillGradient: 'Shape Fill',
  strokeOn: 'Shape Stroke',
  strokeColor: 'Shape Stroke',
  strokeWidth: 'Stroke Width',
  strokeAlign: 'Stroke Alignment',
  strokeDash: 'Stroke Style',
  cornerRadius: 'Corner Radius',
  sides: 'Polygon Sides',
  innerRatio: 'Star Inner Radius',
  lineWidth: 'Line Weight',
  presetId: 'Custom Shape',
};

/** Merge stored tool options with the active shape layer's values (what the bar displays). */
export function useShapeView(toolId: ShapeToolId) {
  const stored = useEditor((s) => s.toolOptions[toolId]) as Partial<ShapeToolOptions> | undefined;
  const layer = useEditor((s) => {
    const ses = s.activeDocId ? s.sessions[s.activeDocId] : null;
    const l = ses?.activeLayerId ? ses.doc.layers[ses.activeLayerId] : null;
    return l && l.type === 'shape' ? l : null;
  });
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  const base: ShapeToolOptions = { ...shapeDefaults(toolId), ...stored };
  let view = base;
  if (layer) {
    const fromLayer = optionsFromShape(layer.shape);
    const sameKind = layer.shape.kind === TOOL_KIND[toolId];
    const picked: Partial<ShapeToolOptions> = {};
    for (const k of Object.keys(fromLayer) as (keyof ShapeToolOptions)[]) {
      if (SHARED_KEYS.has(k) || sameKind) (picked as Record<string, unknown>)[k] = fromLayer[k];
    }
    view = { ...base, ...picked };
  }
  return { view, layer, primary, secondary };
}

/**
 * Change several options at once: they are written to the tool options and, when a shape layer is
 * active, applied to it in ONE edit (one history step on commit) computed from the same merged
 * view, so dependent keys (stroke on + width) never undo each other.
 */
export function setShapeOptions(toolId: ShapeToolId, view: ShapeToolOptions, layer: ShapeLayer | null, patch: Partial<ShapeToolOptions>, phase: EditPhase, label?: string) {
  const keys = Object.keys(patch) as (keyof ShapeToolOptions)[];
  if (!keys.length) return;
  writeShapeOptions(toolId, patch);
  if (!layer) return;
  const kind = layer.shape.kind;
  const applicable = keys.filter((k) => keyAppliesToKind(k, kind) && (SHARED_KEYS.has(k) || kind === TOOL_KIND[toolId]));
  if (!applicable.length) return;
  const { primaryColor, secondaryColor } = useEditor.getState();
  const next: ShapeToolOptions = { ...view, ...patch };
  editShapeLayer(
    layer.id,
    (l) => {
      for (const k of applicable) applyOptionToShape(l, k, next, primaryColor, secondaryColor, (id) => shapePresets.get(id));
    },
    phase,
    label ?? LABELS[applicable[applicable.length - 1]] ?? 'Edit Shape',
  );
}

export function setShapeOption<K extends keyof ShapeToolOptions>(
  toolId: ShapeToolId,
  view: ShapeToolOptions,
  layer: ShapeLayer | null,
  key: K,
  value: ShapeToolOptions[K],
  phase: EditPhase,
) {
  setShapeOptions(toolId, view, layer, { [key]: value } as Partial<ShapeToolOptions>, phase);
}

/**
 * Stroke width from the options bar. A positive width turns the stroke on (in the same edit).
 * While scrubbing, an existing stroke only changes width (0 included) so its colour, alignment,
 * dash and joins survive dragging through 0; a width of 0 removes the stroke on commit.
 */
export function setShapeStrokeWidth(toolId: ShapeToolId, view: ShapeToolOptions, layer: ShapeLayer | null, v: number, phase: EditPhase) {
  const width = Math.max(0, Number.isFinite(v) ? v : 0);
  const patch: Partial<ShapeToolOptions> = { strokeWidth: width };
  if (width > 0 && !view.strokeOn) patch.strokeOn = true;
  if (phase === 'live' && layer?.shape.stroke) {
    writeShapeOptions(toolId, patch);
    editShapeLayer(
      layer.id,
      (l) => {
        if (l.shape.stroke) l.shape.stroke.width = width;
      },
      'live',
      'Stroke Width',
    );
    return;
  }
  setShapeOptions(toolId, view, layer, patch, phase, 'Stroke Width');
}

export function ShapeOptionsBar() {
  const activeTool = useEditor((s) => s.activeTool);
  const toolId: ShapeToolId = isShapeToolId(activeTool) ? activeTool : 'shape-rect';
  const { view, layer, primary, secondary } = useShapeView(toolId);
  const kind = TOOL_KIND[toolId];
  const set = <K extends keyof ShapeToolOptions>(key: K, value: ShapeToolOptions[K], phase: EditPhase = 'commit') => setShapeOption(toolId, view, layer, key, value, phase);
  const gradient: Gradient = view.fillGradient ?? defaultGradient(primary, secondary);

  return (
    <div className="shape-opts">
      <span className="shape-opts-label">Fill</span>
      <FillButton
        value={{ mode: view.fillMode, color: view.fillColor || primary, gradient }}
        onMode={(m) => setShapeOptions(toolId, view, layer, m === 'gradient' && !view.fillGradient ? { fillMode: m, fillGradient: gradient } : { fillMode: m }, 'commit', 'Shape Fill')}
        onColor={(c, phase) => set('fillColor', c, phase)}
        onGradient={(g, phase) => set('fillGradient', g, phase)}
      />
      <span className="shape-opts-label">Stroke</span>
      <StrokeButton value={{ on: view.strokeOn, color: view.strokeColor, width: view.strokeWidth, align: view.strokeAlign, dash: view.strokeDash }} onOn={(on) => setShapeOptions(toolId, view, layer, on && !(view.strokeWidth > 0) ? { strokeOn: true, strokeWidth: 4 } : { strokeOn: on }, 'commit', 'Shape Stroke')}onColor={(c, phase) => set('strokeColor', c, phase)} />
      <NumberField
        value={view.strokeWidth}
        min={0}
        max={500}
        step={1}
        unit="px"
        width={58}
        title="Stroke width"
        onChange={(v) => setShapeStrokeWidth(toolId, view, layer, v, 'live')}
        onCommit={(v) => setShapeStrokeWidth(toolId, view, layer, v, 'commit')}
      />
      <Select value={view.strokeAlign} options={ALIGN_OPTIONS} onChange={(v) => set('strokeAlign', v)} width={78} title="Stroke alignment" />
      <DashSelect value={view.strokeDash} onChange={(v) => set('strokeDash', v)} />
      <span className="shape-opts-sep" />
      {(kind === 'polygon' || kind === 'star') && (
        <>
          <span className="shape-opts-label">{kind === 'star' ? 'Points' : 'Sides'}</span>
          <NumberField
            value={view.sides}
            min={kind === 'star' ? 2 : 3}
            max={64}
            step={1}
            width={46}
            onChange={(v) => set('sides', Math.round(v), 'live')}
            onCommit={(v) => set('sides', Math.round(v), 'commit')}
          />
        </>
      )}
      {kind === 'star' && (
        <>
          <span className="shape-opts-label">Inner</span>
          <NumberField
            value={view.innerRatio}
            min={0.01}
            max={1}
            step={1}
            displayScale={100}
            unit="%"
            width={54}
            title="Inner radius (% of outer)"
            onChange={(v) => set('innerRatio', v, 'live')}
            onCommit={(v) => set('innerRatio', v, 'commit')}
          />
        </>
      )}
      {(kind === 'rect' || kind === 'polygon' || kind === 'star') && (
        <>
          <span className="shape-opts-label">Radius</span>
          <NumberField
            value={view.cornerRadius}
            min={0}
            max={2000}
            step={1}
            unit="px"
            width={58}
            title="Corner radius"
            onChange={(v) => set('cornerRadius', v, 'live')}
            onCommit={(v) => set('cornerRadius', v, 'commit')}
          />
        </>
      )}
      {kind === 'line' && (
        <>
          <span className="shape-opts-label">Weight</span>
          <NumberField
            value={view.lineWidth}
            min={0.5}
            max={500}
            step={1}
            unit="px"
            width={58}
            title="Line weight"
            onChange={(v) => set('lineWidth', v, 'live')}
            onCommit={(v) => set('lineWidth', v, 'commit')}
          />
        </>
      )}
      {kind === 'path' && (
        <>
          <span className="shape-opts-label">Shape</span>
          <PresetPicker value={view.presetId} onChange={(id) => set('presetId', id)} compact />
        </>
      )}
      <span className="shape-opts-spacer" />
      <span className="shape-opts-hint">
        {layer ? `Editing “${layer.name}”` : `Drag to draw a ${KIND_LABEL[kind].toLowerCase()}`} · Shift {kind === 'line' ? 'snaps 45°' : 'constrains'} · Alt from center
      </span>
    </div>
  );
}
