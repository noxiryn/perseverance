/**
 * Shape tool options (stored per tool in the editor store) and conversions between options and
 * ShapeProps. Fill/stroke settings are shared by all shape tools (written to each of them), the
 * geometry settings (radius, sides…) are per tool.
 */
import type { Gradient, Paint, ShapeKind, ShapeLayer, ShapeProps, StrokeStyle } from '../../core/types';
import { activeSession, useEditor } from '../../state/editor';
import { keepAnchor } from '../type/affine';

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

/**
 * Stroke for the options. With an `existing` stroke, its non-solid paint is kept, and so are its
 * dash/cap/join when the dash preset is unchanged (e.g. round joins set in Properties survive a
 * width change from the options bar).
 */
export function strokeFromOptions(o: ShapeToolOptions, existing?: StrokeStyle | null): StrokeStyle | null {
  if (!o.strokeOn || !(o.strokeWidth > 0)) return null;
  const keepPaint = existing && existing.paint.type !== 'solid' ? existing.paint : null;
  const keepStyle = existing && dashPresetOf(existing) === o.strokeDash;
  const style = keepStyle ? { dash: existing.dash ? [...existing.dash] : undefined, cap: existing.cap ?? 'butt', join: existing.join ?? 'miter' } : dashFor(o.strokeDash);
  return {
    paint: keepPaint ?? { type: 'solid', color: o.strokeColor },
    width: o.strokeWidth,
    align: o.strokeAlign,
    ...style,
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
  writeShapeOptions(toolId, { [key]: value } as Partial<ShapeToolOptions>);
}

/** Write several tool options in one store update (shared keys go to every shape tool). */
export function writeShapeOptions(toolId: ShapeToolId, patch: Partial<ShapeToolOptions>) {
  const keys = Object.keys(patch) as (keyof ShapeToolOptions)[];
  if (!keys.length) return;
  const shared: Record<string, unknown> = {};
  const own: Record<string, unknown> = {};
  for (const k of keys) (SHARED_KEYS.has(k) ? shared : own)[k] = patch[k];
  useEditor.setState((s) => {
    const next = { ...s.toolOptions };
    if (Object.keys(shared).length) for (const id of SHAPE_TOOL_IDS) next[id] = { ...next[id], ...shared };
    if (Object.keys(own).length) next[toolId] = { ...next[toolId], ...own };
    return { toolOptions: next };
  });
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
export type PresetLookup = (id: string) => { path: string; viewBox: [number, number, number, number]; name?: string } | undefined;

export function applyOptionToShape(l: ShapeLayer, key: keyof ShapeToolOptions, o: ShapeToolOptions, primary: string, secondary: string, presetLookup?: PresetLookup) {
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
        const prev = s.presetId ? presetLookup?.(s.presetId) : undefined;
        swapShapePath(l, p.path, p.viewBox, o.presetId);
        renameForPreset(l, prev?.name, p.name);
      }
      break;
    }
  }
}

/**
 * Box size for a new path aspect: the area is kept (so switching back and forth between presets
 * returns to the same size) and the proportions follow the viewBox. Unchanged when the aspect
 * already matches.
 */
export function boxForAspect(w: number, h: number, vbW: number, vbH: number): { w: number; h: number } {
  const a = vbW / vbH;
  if (!Number.isFinite(a) || a <= 0 || !(w > 0) || !(h > 0)) return { w, h };
  if (Math.abs(w / h - a) / a < 0.005) return { w, h };
  const area = w * h;
  return { w: Math.sqrt(area * a), h: Math.sqrt(area / a) };
}

/**
 * Replace a path shape's outline (custom shape preset) and give the box the new outline's
 * proportions around the same center (rotation/flip aware), so the new shape is not stretched.
 */
export function swapShapePath(l: ShapeLayer, path: string, viewBox: [number, number, number, number], presetId?: string) {
  const s = l.shape;
  s.path = path;
  s.viewBox = [...viewBox] as [number, number, number, number];
  if (presetId !== undefined) s.presetId = presetId;
  const w0 = Math.max(1, s.width);
  const h0 = Math.max(1, s.height);
  const { w, h } = boxForAspect(w0, h0, viewBox[2], viewBox[3]);
  if (w === w0 && h === h0) return;
  const pos = keepAnchor(l.transform, w0, h0, { x: w0 / 2, y: h0 / 2 }, w, h, { x: w / 2, y: h / 2 });
  s.width = w;
  s.height = h;
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    l.transform.x = pos.x;
    l.transform.y = pos.y;
  }
}

/**
 * A layer still named after its custom shape preset ("5-Point Star", "5-Point Star 2") follows a
 * preset swap ("Skull", "Skull 2"); names the user chose are left alone.
 */
export function renameForPreset(l: { name: string }, oldName: string | undefined, newName: string | undefined) {
  if (!oldName || !newName || oldName === newName) return;
  if (l.name === oldName) l.name = newName;
  else if (l.name.startsWith(`${oldName} `) && /^\d+$/.test(l.name.slice(oldName.length + 1))) l.name = newName + l.name.slice(oldName.length);
}
