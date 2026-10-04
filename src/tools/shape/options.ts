/**
 * Shape tool options (stored per tool in the editor store) and conversions between options and
 * ShapeProps. Fill/stroke settings are shared by all shape tools (written to each of them), the
 * geometry settings (radius, sides…) are per tool.
 */
import type { Gradient, Paint, ShapeKind, ShapeLayer, ShapeProps, StrokeStyle } from '../../core/types';
import { activeSession, useEditor } from '../../state/editor';

export const SHAPE_TOOL_IDS = ['shape-rect', 'shape-ellipse', 'shape-polygon', 'shape-star', 'shape-line', 'shape-custom'] as const;
export type ShapeToolId = (typeof SHAPE_TOOL_IDS)[number];

export const TOOL_KIND: Record<ShapeToolId, ShapeKind> = {
  'shape-rect': 'rect',
  'shape-ellipse': 'ellipse',
  'shape-polygon': 'polygon',
  'shape-star': 'star',
  'shape-line': 'line',
  'shape-custom': 'path',
};

export const KIND_TOOL: Record<ShapeKind, ShapeToolId> = {
  rect: 'shape-rect',
  ellipse: 'shape-ellipse',
  polygon: 'shape-polygon',
  star: 'shape-star',
  line: 'shape-line',
  path: 'shape-custom',
};

export const KIND_LABEL: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  star: 'Star',
  line: 'Line',
  path: 'Custom Shape',
};

export type FillMode = 'none' | 'solid' | 'gradient';
export type DashPreset = 'solid' | 'dashed' | 'dotted';
export type StrokeAlign = StrokeStyle['align'];

export type ShapeToolOptions = {
  fillMode: FillMode;
  /** '' = use the primary color at creation time. */
  fillColor: string;
  /** null = primary → secondary linear gradient. */
  fillGradient: Gradient | null;
  strokeOn: boolean;
  strokeColor: string;
  strokeWidth: number;
  strokeAlign: StrokeAlign;
  strokeDash: DashPreset;
  cornerRadius: number;
  sides: number;
  innerRatio: number;
  lineWidth: number;
  presetId: string;
};

export const SHARED_KEYS = new Set<keyof ShapeToolOptions>([
  'fillMode',
  'fillColor',
  'fillGradient',
  'strokeOn',
  'strokeColor',
  'strokeWidth',
  'strokeAlign',
  'strokeDash',
]);

const BASE: ShapeToolOptions = {
  fillMode: 'solid',
  fillColor: '',
  fillGradient: null,
  strokeOn: false,
  strokeColor: '#000000',
  strokeWidth: 4,
  strokeAlign: 'outside',
  strokeDash: 'solid',
  cornerRadius: 0,
  sides: 6,
  innerRatio: 0.5,
  lineWidth: 6,
  presetId: 'star-5',
};

export function shapeDefaults(toolId: ShapeToolId): ShapeToolOptions {
  switch (toolId) {
    case 'shape-star':
      return { ...BASE, sides: 5, innerRatio: 0.45 };
    case 'shape-polygon':
      return { ...BASE, sides: 6 };
    case 'shape-line':
      return { ...BASE, strokeAlign: 'center' };
    default:
      return { ...BASE };
  }
}

export function isShapeToolId(id: string): id is ShapeToolId {
  return (SHAPE_TOOL_IDS as readonly string[]).includes(id);
}

/** Which option keys affect a layer of the given kind. */
export function keyAppliesToKind(key: keyof ShapeToolOptions, kind: ShapeKind): boolean {
  if (SHARED_KEYS.has(key)) return true;
  switch (key) {
    case 'cornerRadius':
      return kind === 'rect' || kind === 'polygon' || kind === 'star';
    case 'sides':
      return kind === 'polygon' || kind === 'star';
    case 'innerRatio':
      return kind === 'star';
    case 'lineWidth':
      return kind === 'line';
    case 'presetId':
      return kind === 'path';
    default:
      return false;
  }
}

/* ---------------- paints ---------------- */

export function defaultGradient(a: string, b: string): Gradient {
  return {
    kind: 'linear',
    angle: 90,
    scale: 1,
    stops: [
      { offset: 0, color: a },
      { offset: 1, color: b },
    ],
  };
}

export function fillFromOptions(o: ShapeToolOptions, primary: string, secondary: string): Paint | null {
  if (o.fillMode === 'none') return null;
  if (o.fillMode === 'gradient') return { type: 'gradient', gradient: structuredClone(o.fillGradient ?? defaultGradient(primary, secondary)) };
  return { type: 'solid', color: o.fillColor || primary };
}

export function dashFor(preset: DashPreset): Pick<StrokeStyle, 'dash' | 'cap' | 'join'> {
  if (preset === 'dashed') return { dash: [3, 2], cap: 'butt', join: 'miter' };
  if (preset === 'dotted') return { dash: [0, 2], cap: 'round', join: 'round' };
  return { dash: undefined, cap: 'butt', join: 'miter' };
}

export function dashPresetOf(stroke: StrokeStyle | null | undefined): DashPreset {
  const d = stroke?.dash;
  if (!d || !d.length || !d.some((v) => v > 0)) return 'solid';
  return d[0] === 0 ? 'dotted' : 'dashed';
}

export function strokeFromOptions(o: ShapeToolOptions, existing?: StrokeStyle | null): StrokeStyle | null {
  if (!o.strokeOn || !(o.strokeWidth > 0)) return null;
  const keepPaint = existing && existing.paint.type !== 'solid' ? existing.paint : null;
  return {
    paint: keepPaint ?? { type: 'solid', color: o.strokeColor },
    width: o.strokeWidth,
    align: o.strokeAlign,
    ...dashFor(o.strokeDash),
  };
}

export function paintColor(p: Paint | null | undefined, fallback: string): string {
  if (!p) return fallback;
  if (p.type === 'solid') return p.color;
  if (p.type === 'gradient') return p.gradient.stops[0]?.color ?? fallback;
  return fallback;
}

/** Options as seen from an existing shape (for the options bar when a shape layer is active). */
export function optionsFromShape(shape: ShapeProps): Partial<ShapeToolOptions> {
  const out: Partial<ShapeToolOptions> = {
    fillMode: !shape.fill ? 'none' : shape.fill.type === 'gradient' ? 'gradient' : 'solid',
    strokeOn: !!shape.stroke && shape.stroke.width > 0,
  };
  if (shape.fill?.type === 'solid') out.fillColor = shape.fill.color;
  if (shape.fill?.type === 'gradient') out.fillGradient = shape.fill.gradient;
  if (shape.stroke) {
    out.strokeColor = paintColor(shape.stroke.paint, '#000000');
    out.strokeWidth = shape.stroke.width;
    out.strokeAlign = shape.stroke.align;
    out.strokeDash = dashPresetOf(shape.stroke);
  }
  out.cornerRadius = shape.cornerRadius;
  out.sides = shape.sides;
  out.innerRatio = shape.innerRatio;
  out.lineWidth = shape.lineWidth;
  if (shape.presetId) out.presetId = shape.presetId;
  return out;
}

/* ---------------- store access ---------------- */

export function readShapeOptions(toolId: ShapeToolId): ShapeToolOptions {
  return { ...shapeDefaults(toolId), ...(useEditor.getState().toolOptions[toolId] as Partial<ShapeToolOptions> | undefined) };
}

/** Write a tool option (shared keys go to every shape tool so they stay in sync). */
export function writeShapeOption<K extends keyof ShapeToolOptions>(toolId: ShapeToolId, key: K, value: ShapeToolOptions[K]) {
  const st = useEditor.getState();
  if (SHARED_KEYS.has(key)) {
    useEditor.setState((s) => {
      const next = { ...s.toolOptions };
      for (const id of SHAPE_TOOL_IDS) next[id] = { ...next[id], [key]: value };
      return { toolOptions: next };
    });
  } else st.setToolOption(toolId, key, value);
}

/** The active layer if it is a shape layer. */
export function activeShapeLayer(): ShapeLayer | null {
  const s = activeSession();
  const l = s?.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  return l && l.type === 'shape' ? l : null;
}

export type EditPhase = 'live' | 'commit';

/** Live-preview or commit (coalesced) a change to a shape layer. */
export function editShapeLayer(layerId: string, mutate: (l: ShapeLayer) => void, phase: EditPhase, label = 'Edit Shape') {
  const st = useEditor.getState();
  const recipe = (d: Parameters<Parameters<typeof st.preview>[0]>[0]) => {
    const l = d.layers[layerId];
    if (l && l.type === 'shape') mutate(l);
  };
  if (phase === 'live') st.preview(recipe);
  else st.commit(label, recipe, { coalesce: true });
}

/** Apply one option change to a shape layer (only keys relevant to its kind). */
export function applyOptionToShape(l: ShapeLayer, key: keyof ShapeToolOptions, o: ShapeToolOptions, primary: string, secondary: string, presetLookup?: (id: string) => { path: string; viewBox: [number, number, number, number] } | undefined) {
  const s = l.shape;
  if (!keyAppliesToKind(key, s.kind)) return;
  switch (key) {
    case 'fillMode':
    case 'fillColor':
    case 'fillGradient':
      s.fill = fillFromOptions(o, primary, secondary);
      break;
    case 'strokeOn':
    case 'strokeColor':
    case 'strokeWidth':
    case 'strokeAlign':
    case 'strokeDash': {
      const prev = s.stroke;
      const next = strokeFromOptions(o, key === 'strokeColor' ? null : prev);
      s.stroke = next;
      break;
    }
    case 'cornerRadius':
      s.cornerRadius = Math.max(0, o.cornerRadius);
      break;
    case 'sides':
      s.sides = Math.max(s.kind === 'star' ? 2 : 3, Math.round(o.sides));
      break;
    case 'innerRatio':
      s.innerRatio = Math.min(1, Math.max(0.01, o.innerRatio));
      break;
    case 'lineWidth':
      s.lineWidth = Math.max(0.5, o.lineWidth);
      break;
    case 'presetId': {
      const p = presetLookup?.(o.presetId);
      if (p) {
        s.path = p.path;
        s.viewBox = [...p.viewBox] as [number, number, number, number];
        s.presetId = o.presetId;
      }
      break;
    }
  }
}
