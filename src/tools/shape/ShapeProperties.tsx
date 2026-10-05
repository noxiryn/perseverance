/** Properties panel section for shape layers: kind, size, geometry, fill and stroke. */
import { useEditor } from '../../state/editor';
import { shapePresets } from '../../registry';
import { Field, NumberField, Select } from '../../ui/controls';
import type { Gradient, ShapeKind, ShapeLayer, StrokeStyle } from '../../core/types';
import { KIND_LABEL, dashFor, dashPresetOf, defaultGradient, editShapeLayer, paintColor, readShapeOptions, type DashPreset, type EditPhase, type FillMode } from './options';
import { ALIGN_OPTIONS, DashSelect, FillButton, StrokeButton } from './PaintControls';
import { PresetPicker } from './PresetPicker';
import { DEFAULT_SHAPE_PRESET } from './presets';
import { keepAnchor } from '../type/affine';
import './shape.css';

const KINDS: { value: ShapeKind; label: string }[] = (['rect', 'ellipse', 'polygon', 'star', 'line', 'path'] as ShapeKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }));

/** Resize the shape box keeping its top-left corner fixed in document space (rotation-aware). */
function resizeKeepingCorner(l: ShapeLayer, w: number, h: number) {
  const pos = keepAnchor(l.transform, l.shape.width, l.shape.height, { x: 0, y: 0 }, w, h, { x: 0, y: 0 });
  l.shape.width = w;
  l.shape.height = h;
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    l.transform.x = pos.x;
    l.transform.y = pos.y;
  }
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

  const fillMode: FillMode = !s.fill ? 'none' : s.fill.type === 'gradient' ? 'gradient' : 'solid';
  const fillColor = s.fill?.type === 'solid' ? s.fill.color : paintColor(s.fill, primary);
  const fillGradient: Gradient = s.fill?.type === 'gradient' ? s.fill.gradient : defaultGradient(fillColor, secondary);
  const stroke = s.stroke;
  const strokeColor = paintColor(stroke?.paint, '#000000');
  const setStroke = (patch: Partial<StrokeStyle> | null, phase: EditPhase, label = 'Shape Stroke') =>
    edit(
      (l) => {
        if (patch === null) {
          l.shape.stroke = null;
          return;
        }
        const base: StrokeStyle = l.shape.stroke ?? { paint: { type: 'solid', color: strokeColor }, width: 4, align: 'outside', ...dashFor('solid') };
        l.shape.stroke = { ...base, ...patch };
      },
      phase,
      label,
    );

  const changeKind = (k: ShapeKind) => {
    if (k === s.kind) return;
    edit(
      (l) => {
        l.shape.kind = k;
        if (k === 'path' && !l.shape.path) {
          const p = shapePresets.get(readShapeOptions('shape-custom').presetId) ?? shapePresets.get(DEFAULT_SHAPE_PRESET);
          if (p) {
            l.shape.path = p.path;
            l.shape.viewBox = [...p.viewBox] as [number, number, number, number];
            l.shape.presetId = p.id;
          }
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
                  l.shape.path = p.path;
                  l.shape.viewBox = [...p.viewBox] as [number, number, number, number];
                  l.shape.presetId = p.id;
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
          <NumberField value={s.width} min={1} max={30000} step={1} unit="W" width="100%" {...num('Shape Size', (l, v) => resizeKeepingCorner(l, Math.max(1, v), l.shape.height))} />
          <NumberField value={s.height} min={1} max={30000} step={1} unit="H" width="100%" {...num('Shape Size', (l, v) => resizeKeepingCorner(l, l.shape.width, Math.max(1, v)))} />
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
          <NumberField value={stroke?.width ?? 0} min={0} max={500} step={1} unit="px" width={64} {...{
            onChange: (v: number) => setStroke(v > 0 ? { width: v } : null, 'live', 'Stroke Width'),
            onCommit: (v: number) => setStroke(v > 0 ? { width: v } : null, 'commit', 'Stroke Width'),
          }} />
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
