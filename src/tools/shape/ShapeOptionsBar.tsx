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
  writeShapeOption,
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

export function setShapeOption<K extends keyof ShapeToolOptions>(
  toolId: ShapeToolId,
  view: ShapeToolOptions,
  layer: ShapeLayer | null,
  key: K,
  value: ShapeToolOptions[K],
  phase: EditPhase,
) {
  writeShapeOption(toolId, key, value);
  if (!layer) return;
  const kind = layer.shape.kind;
  if (!keyAppliesToKind(key, kind)) return;
  if (!SHARED_KEYS.has(key) && kind !== TOOL_KIND[toolId]) return;
  const { primaryColor, secondaryColor } = useEditor.getState();
  const next = { ...view, [key]: value } as ShapeToolOptions;
  editShapeLayer(layer.id, (l) => applyOptionToShape(l, key, next, primaryColor, secondaryColor, (id) => shapePresets.get(id)), phase, LABELS[key] ?? 'Edit Shape');
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
        onMode={(m) => {
          if (m === 'gradient' && !view.fillGradient) writeShapeOption(toolId, 'fillGradient', gradient);
          set('fillMode', m);
        }}
        onColor={(c, phase) => set('fillColor', c, phase)}
        onGradient={(g, phase) => set('fillGradient', g, phase)}
      />
      <span className="shape-opts-label">Stroke</span>
      <StrokeButton value={{ on: view.strokeOn, color: view.strokeColor, width: view.strokeWidth, align: view.strokeAlign, dash: view.strokeDash }} onOn={(on) => set('strokeOn', on)} onColor={(c, phase) => set('strokeColor', c, phase)} />
      <NumberField
        value={view.strokeWidth}
        min={0}
        max={500}
        step={1}
        unit="px"
        width={58}
        title="Stroke width"
        onChange={(v) => {
          if (!view.strokeOn && v > 0) writeShapeOption(toolId, 'strokeOn', true);
          set('strokeWidth', v, 'live');
        }}
        onCommit={(v) => {
          if (!view.strokeOn && v > 0) set('strokeOn', true);
          set('strokeWidth', v, 'commit');
        }}
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
