/** Properties panel section for shape layers: kind, size, geometry, fill and stroke. */
import { useEditor } from '../../state/editor';
import { shapePresets } from '../../registry';
import { Field, NumberField, Select } from '../../ui/controls';
import type { Gradient, ShapeKind, ShapeLayer, StrokeStyle } from '../../core/types';
import { KIND_LABEL, dashFor, dashPresetOf, defaultGradient, editShapeLayer, paintColor, readShapeOptions, renameForPreset, swapShapePath, type DashPreset, type EditPhase, type FillMode } from './options';
import { ALIGN_OPTIONS, DashSelect, FillButton, StrokeButton } from './PaintControls';
import { PresetPicker } from './PresetPicker';
import { DEFAULT_SHAPE_PRESET } from './presets';
import { keepAnchor } from '../type/affine';
import './shape.css';

const KINDS: { value: ShapeKind; label: string }[] = (['rect', 'ellipse', 'polygon', 'star', 'line', 'path'] as ShapeKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }));

/** Resize the shape box keeping its top-left corner fixed in document space (rotation-aware). */
function resizeKeepingCorner(l: ShapeLayer, w: number, h: number) {
  // Pivot sizes as the renderer sees them (getLayerSize clamps to ≥ 1, e.g. for 0-height lines).
  const pos = keepAnchor(l.transform, Math.max(1, l.shape.width), Math.max(1, l.shape.height), { x: 0, y: 0 }, Math.max(1, w), Math.max(1, h), { x: 0, y: 0 });
  l.shape.width = w;
  l.shape.height = h;
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    l.transform.x = pos.x;
    l.transform.y = pos.y;
  }
}

/** A side length for the Size fields: lines allow 0 (axis-aligned) unless the other side is 0 too. */
function sideValue(l: ShapeLayer, v: number, other: number): number {
  const n = Number.isFinite(v) ? v : 1;
  if (l.shape.kind === 'line') return other > 0 ? Math.max(0, n) : Math.max(1, n);
  return Math.max(1, n);
}

/**
 * Last stroke removed from a layer here (width 0 / stroke toggled off): turning the stroke back on
 * restores its colour, alignment, dash and joins instead of a default black stroke.
 */
const removedStrokes = new Map<string, StrokeStyle>();

function rememberStroke(layerId: string, stroke: StrokeStyle | null) {
  if (!stroke) return;
  removedStrokes.delete(layerId);
  // JSON clone: `stroke` is usually an immer draft (structuredClone cannot clone proxies).
  removedStrokes.set(layerId, JSON.parse(JSON.stringify(stroke)) as StrokeStyle);
  if (removedStrokes.size > 64) removedStrokes.delete(removedStrokes.keys().next().value as string);
}

const JOINS: { value: CanvasLineJoin; label: string }[] = [
  { value: 'miter', label: 'Miter' },
  { value: 'round', label: 'Round' },
  { value: 'bevel', label: 'Bevel' },
];

export function ShapeProperties({ layerId }: { layerId: string }) {
  const layer = useEditor((s) => {
    const l = s.activeDocId ? s.sessions[s.activeDocId]?.doc.layers[layerId] : null;
    return l && l.type === 'shape' ? l : null;
  });
  const primary = useEditor((s) => s.primaryColor);
  const secondary = useEditor((s) => s.secondaryColor);
  if (!layer) return <div className="shape-props-empty">Select a shape layer.</div>;
  const s = layer.shape;
  const edit = (mutate: (l: ShapeLayer) => void, phase: EditPhase, label: string) => editShapeLayer(layerId, mutate, phase, label);
  const num = (label: string, apply: (l: ShapeLayer, v: number) => void) => ({
    onChange: (v: number) => edit((l) => apply(l, v), 'live', label),
    onCommit: (v: number) => edit((l) => apply(l, v), 'commit', label),
  });

  // Lines may be exactly horizontal/vertical (one side 0); other shapes need at least 1px.
  const minSide = s.kind === 'line' ? 0 : 1;

  const fillMode: FillMode = !s.fill ? 'none' : s.fill.type === 'gradient' ? 'gradient' : 'solid';
  const fillColor = s.fill?.type === 'solid' ? s.fill.color : paintColor(s.fill, primary);
  const fillGradient: Gradient = s.fill?.type === 'gradient' ? s.fill.gradient : defaultGradient(fillColor, secondary);
  const stroke = s.stroke;
  const strokeColor = paintColor(stroke?.paint, '#000000');
  const setStroke = (patch: Partial<StrokeStyle> | null, phase: EditPhase, label = 'Shape Stroke') =>
    edit(
      (l) => {
        if (patch === null) {
          if (phase === 'commit') rememberStroke(layerId, l.shape.stroke);
          l.shape.stroke = null;
          return;
        }
        const restored = removedStrokes.get(layerId);
        const base: StrokeStyle = l.shape.stroke ?? (restored ? { ...structuredClone(restored), width: restored.width > 0 ? restored.width : 4 } : { paint: { type: 'solid', color: strokeColor }, width: 4, align: 'outside', ...dashFor('solid') });
        l.shape.stroke = { ...base, ...patch };
      },
      phase,
      label,
    );

  /**
   * While scrubbing, keep the stroke object and only change its width (0 included: the renderer
   * skips it) so colour, alignment, dash and joins survive dragging through 0. A width of 0 removes
   * the stroke on commit; a positive width on a shape without stroke adds one.
   */
  const setStrokeWidth = (v: number, phase: EditPhase) => {
    const width = Math.max(0, Number.isFinite(v) ? v : 0);
    edit(
      (l) => {
        const cur = l.shape.stroke;
        if (cur) {
          if (phase === 'commit' && width === 0) {
            rememberStroke(layerId, cur);
            l.shape.stroke = null;
          } else cur.width = width;
        } else if (width > 0) {
          const restored = removedStrokes.get(layerId);
          l.shape.stroke = restored ? { ...structuredClone(restored), width } : { paint: { type: 'solid', color: strokeColor }, width, align: 'outside', ...dashFor('solid') };
        }
      },
      phase,
      'Stroke Width',
    );
  };

  const changeKind = (k: ShapeKind) => {
    if (k === s.kind) return;
    edit(
      (l) => {
        l.shape.kind = k;
        if (k === 'path' && !l.shape.path) {
          const p = shapePresets.get(readShapeOptions('shape-custom').presetId) ?? shapePresets.get(DEFAULT_SHAPE_PRESET);
          if (p) swapShapePath(l, p.path, p.viewBox, p.id);
        }
        if (k === 'star' && l.shape.sides < 2) l.shape.sides = 5;
        if (k === 'polygon' && l.shape.sides < 3) l.shape.sides = 3;
        if (k === 'line' && !(l.shape.lineWidth > 0)) l.shape.lineWidth = 6;
      },
      'commit',
      'Change Shape Type',
    );
  };

  return (
    <div className="shape-props">
      <Field label="Type">
        <Select value={s.kind} options={KINDS} onChange={changeKind} width="100%" />
      </Field>
      {s.kind === 'path' && (
        <Field label="Shape">
          <PresetPicker
            value={s.presetId ?? ''}
            onChange={(id) => {
              const p = shapePresets.get(id);
              if (!p) return;
              edit(
                (l) => {
                  const prev = l.shape.presetId ? shapePresets.get(l.shape.presetId) : undefined;
                  swapShapePath(l, p.path, p.viewBox, p.id);
                  renameForPreset(l, prev?.name, p.name);
                },
                'commit',
                'Custom Shape',
              );
            }}
          />
        </Field>
      )}
      <Field label="Size">
        <div className="shape-props-row">
          <NumberField value={s.width} min={minSide} max={30000} step={1} unit="W" width="100%" {...num('Shape Size', (l, v) => resizeKeepingCorner(l, sideValue(l, v, l.shape.height), l.shape.height))} />
          <NumberField value={s.height} min={minSide} max={30000} step={1} unit="H" width="100%" {...num('Shape Size', (l, v) => resizeKeepingCorner(l, l.shape.width, sideValue(l, v, l.shape.width)))} />
        </div>
      </Field>
      {(s.kind === 'rect' || s.kind === 'polygon' || s.kind === 'star') && (
        <Field label="Radius">
          <NumberField value={s.cornerRadius} min={0} max={5000} step={1} unit="px" width="100%" {...num('Corner Radius', (l, v) => (l.shape.cornerRadius = Math.max(0, v)))} />
        </Field>
      )}
      {(s.kind === 'polygon' || s.kind === 'star') && (
        <Field label={s.kind === 'star' ? 'Points' : 'Sides'}>
          <NumberField value={s.sides} min={s.kind === 'star' ? 2 : 3} max={64} step={1} width="100%" {...num('Polygon Sides', (l, v) => (l.shape.sides = Math.round(v)))} />
        </Field>
      )}
      {s.kind === 'star' && (
        <Field label="Inner">
          <NumberField value={s.innerRatio} min={0.01} max={1} step={1} displayScale={100} unit="%" width="100%" {...num('Star Inner Radius', (l, v) => (l.shape.innerRatio = v))} />
        </Field>
      )}
      {s.kind === 'line' && (
        <Field label="Weight">
          <NumberField value={s.lineWidth} min={0.5} max={1000} step={1} unit="px" width="100%" {...num('Line Weight', (l, v) => (l.shape.lineWidth = Math.max(0.5, v)))} />
        </Field>
      )}
      <Field label="Fill">
        <div className="shape-props-row">
          <FillButton
            value={{ mode: fillMode, color: fillColor, gradient: fillGradient }}
            onMode={(m) =>
              edit(
                (l) => {
                  l.shape.fill = m === 'none' ? null : m === 'gradient' ? { type: 'gradient', gradient: structuredClone(fillGradient) } : { type: 'solid', color: fillColor };
                },
                'commit',
                'Shape Fill',
              )
            }
            onColor={(c, phase) => edit((l) => (l.shape.fill = { type: 'solid', color: c }), phase, 'Shape Fill')}
            onGradient={(g, phase) => edit((l) => (l.shape.fill = { type: 'gradient', gradient: g }), phase, 'Shape Fill')}
          />
          <span className="shape-props-dim">{fillMode === 'none' ? 'None' : fillMode === 'gradient' ? 'Gradient' : fillColor}</span>
        </div>
      </Field>
      <Field label="Stroke">
        <div className="shape-props-row">
          <StrokeButton
            value={{ on: !!stroke, color: strokeColor, width: stroke?.width ?? 0, align: stroke?.align ?? 'outside', dash: dashPresetOf(stroke) }}
            onOn={(on) => setStroke(on ? {} : null, 'commit')}
            onColor={(c, phase) => setStroke({ paint: { type: 'solid', color: c } }, phase)}
          />
          <NumberField
            value={stroke?.width ?? 0}
            min={0}
            max={500}
            step={1}
            unit="px"
            width={64}
            onChange={(v) => setStrokeWidth(v, 'live')}
            onCommit={(v) => setStrokeWidth(v, 'commit')}
          />
        </div>
      </Field>
      {stroke && (
        <>
          <Field label="Align">
            <Select value={stroke.align} options={ALIGN_OPTIONS} onChange={(v) => setStroke({ align: v }, 'commit', 'Stroke Alignment')} width="100%" />
          </Field>
          <Field label="Style">
            <div className="shape-props-row">
              <DashSelect value={dashPresetOf(stroke)} onChange={(d: DashPreset) => setStroke(dashFor(d), 'commit', 'Stroke Style')} width={90} />
              <Select value={stroke.join ?? 'miter'} options={JOINS} onChange={(j) => setStroke({ join: j }, 'commit', 'Stroke Corners')} width={76} title="Corner joins" />
            </div>
          </Field>
        </>
      )}
    </div>
  );
}
