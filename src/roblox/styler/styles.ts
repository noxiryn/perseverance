/**
 * Character Styler presets. Each style is a set of smart filters + layer effects added to the
 * character layer and tracked in `layer.meta.styler` so switching styles replaces only what the
 * styler added (the user's own filters/effects are kept). Filters list alternatives: the first
 * registered filter id wins (other modules' filters when present, the Roblox filters otherwise).
 */
import type { BlendMode, FilterInstance, Gradient, Layer, LayerEffect, ParamValue, ParamValues } from '../../core/types';

export interface FilterOption {
  filterId: string;
  params: ParamValues;
}

export interface StyleFilterSpec {
  /** Stable key inside the style (controls bind to it). */
  key: string;
  options: FilterOption[];
  opacity?: number;
  blendMode?: BlendMode;
}

export interface StyleEffectSpec {
  key: string;
  effectId: string;
  params: ParamValues;
}

export interface StyleControl {
  id: string;
  label: string;
  kind: 'filter' | 'effect';
  /** Spec key the control edits. */
  target: string;
  /** Param key, or a map filterId → param key when alternatives use different names. */
  param: string | Record<string, string>;
  type: 'number' | 'color';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  displayScale?: number;
}

export interface StyleDef {
  id: string;
  name: string;
  description: string;
  swatch: string[];
  filters: StyleFilterSpec[];
  effects: StyleEffectSpec[];
  controls: StyleControl[];
}

export interface StylerMeta {
  style: string;
  filters: Record<string, { id: string; filterId: string }>;
  effects: Record<string, { id: string; effectId: string }>;
}

/* ------------------------------------------------------------------ */
/* Reusable pieces                                                     */
/* ------------------------------------------------------------------ */

const celOrToon = (levels: number, outline: number, extra: { cel?: ParamValues; toon?: ParamValues } = {}): FilterOption[] => [
  { filterId: 'cel-shade', params: { levels, smoothness: 0.12, outline: outline > 0, outlineThickness: outline, outlineColor: '#000000', saturation: 0, ...extra.cel } },
  { filterId: 'toon-roblox', params: { levels, outlineWidth: outline, outlineColor: '#000000', ...extra.toon } },
];

/**
 * Hair shadow over the face. Styles put it BEFORE the posterize/cel stage so the gradient is
 * banded into a flat dark tone like hand-shaded GFX (ref. Birdcage poster), instead of a smooth
 * gradient band floating over flat tones.
 */
const topShade = (height: number, opacity: number, color = '#000000'): StyleFilterSpec => ({
  key: 'face',
  options: [{ filterId: 'top-shade', params: { height, opacity, color, softness: 0.65 } }],
});

/** Amber gradient map (sunburst halftone look). */
const AMBER_MAP: Gradient = {
  kind: 'linear',
  angle: 0,
  scale: 1,
  stops: [
    { offset: 0, color: '#1a0f06' },
    { offset: 0.38, color: '#8a3c12' },
    { offset: 0.7, color: '#e88a2a' },
    { offset: 1, color: '#fff1c9' },
  ],
};

const C = {
  tones: (target = 'base'): StyleControl => ({
    id: 'tones',
    label: 'Posterize',
    kind: 'filter',
    target,
    param: 'levels',
    type: 'number',
    min: 2,
    max: 8,
    step: 1,
  }),
  outline: (target = 'base'): StyleControl => ({
    id: 'outline',
    label: 'Outline',
    kind: 'filter',
    target,
    param: { 'cel-shade': 'outlineThickness', 'toon-roblox': 'outlineWidth' },
    type: 'number',
    min: 0,
    max: 10,
    step: 0.5,
    unit: 'px',
  }),
  outlineColor: (target = 'base'): StyleControl => ({
    id: 'outlineColor',
    label: 'Ink color',
    kind: 'filter',
    target,
    param: { 'cel-shade': 'outlineColor', 'toon-roblox': 'outlineColor' },
    type: 'color',
  }),
  faceHeight: (): StyleControl => ({ id: 'faceHeight', label: 'Face shadow', kind: 'filter', target: 'face', param: 'height', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' }),
  faceStrength: (): StyleControl => ({ id: 'faceStrength', label: 'Shadow', kind: 'filter', target: 'face', param: 'opacity', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' }),
  rimColor: (target = 'rim', label = 'Rim color'): StyleControl => ({ id: `${target}Color`, label, kind: 'filter', target, param: 'color', type: 'color' }),
  rimWidth: (target = 'rim', label = 'Rim width'): StyleControl => ({ id: `${target}Width`, label, kind: 'filter', target, param: 'width', type: 'number', min: 0, max: 60, step: 1, unit: 'px' }),
  rimAngle: (target = 'rim'): StyleControl => ({ id: `${target}Angle`, label: 'Rim angle', kind: 'filter', target, param: 'angle', type: 'number', min: -180, max: 180, step: 1, unit: '°' }),
};

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

export const STYLES: StyleDef[] = [
  {
    id: 'toon-ink',
    name: 'Toon Ink',
    description: 'Flat 3–4 tone cel shading, clean ink outline and a hair shadow over the face.',
    swatch: ['#f1e7d6', '#a07850', '#111111'],
    filters: [topShade(0.3, 0.55, '#120d1f'), { key: 'base', options: celOrToon(4, 2.5) }],
    effects: [],
    controls: [C.tones(), C.outline(), C.outlineColor(), C.faceHeight(), C.faceStrength()],
  },
  {
    id: 'comic-halftone',
    name: 'Comic Halftone',
    description: 'Posterized colors with a printed halftone dot screen and ink lines.',
    swatch: ['#ffb347', '#e0662a', '#1a1208'],
    filters: [
      topShade(0.28, 0.45),
      { key: 'base', options: celOrToon(4, 2) },
      // Amber gradient map over the character (skipped when the adjustments module is absent).
      { key: 'amber', options: [{ filterId: 'gradient-map', params: { gradient: AMBER_MAP, reverse: false, dither: false } }], opacity: 0.7 },
      {
        key: 'halftone',
        options: [
          { filterId: 'halftone', params: { mode: 'color', shape: 'dot', size: 6, angle: 45, contrast: 22, paper: '#f5f1e8', transparentPaper: false, mix: 0.42 } },
          { filterId: 'comic-dots', params: { size: 6, shadow: 0.5, saturation: 15 } },
        ],
      },
    ],
    effects: [],
    controls: [
      C.tones(),
      { id: 'dotSize', label: 'Dot size', kind: 'filter', target: 'halftone', param: 'size', type: 'number', min: 2, max: 40, step: 0.5, unit: 'px' },
      { id: 'dotMix', label: 'Halftone', kind: 'filter', target: 'halftone', param: 'mix', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' },
      C.outline(),
      C.faceStrength(),
    ],
  },
  {
    id: 'noir-shadow',
    name: 'Noir Shadow',
    description: 'Grayscale high-contrast toon with deep shadows and a heavy drop shadow.',
    swatch: ['#e8e8e8', '#6a6a6a', '#050505'],
    filters: [
      topShade(0.42, 0.7),
      {
        key: 'base',
        options: [{ filterId: 'toon-roblox', params: { levels: 3, saturation: -100, shadowColor: '#000000', shadowStrength: 0.7, shadowThreshold: 0.5, outlineWidth: 2, edges: 0.3 } }],
      },
    ],
    effects: [{ key: 'shadow', effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.85, angle: 135, distance: 26, spread: 0.1, size: 28, blendMode: 'multiply' } }],
    controls: [
      C.tones(),
      { id: 'shadowStrength', label: 'Shadow depth', kind: 'filter', target: 'base', param: 'shadowStrength', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' },
      C.faceHeight(),
      { id: 'dropDistance', label: 'Drop shadow', kind: 'effect', target: 'shadow', param: 'distance', type: 'number', min: 0, max: 120, step: 1, unit: 'px' },
      { id: 'dropOpacity', label: 'Drop opacity', kind: 'effect', target: 'shadow', param: 'opacity', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' },
    ],
  },
  {
    id: 'crimson-rim',
    name: 'Crimson Rim',
    description: 'Red back-light rim, warm red tint and a red glow — the crimson film look.',
    swatch: ['#ff3b3b', '#7a0a0a', '#0a0000'],
    filters: [
      topShade(0.3, 0.5, '#1a0003'),
      {
        key: 'base',
        options: [{ filterId: 'toon-roblox', params: { levels: 5, smooth: 0.3, outlineWidth: 0, edges: 0.15, tint: '#ff3030', tintStrength: 0.22, shadowColor: '#2a0004', shadowStrength: 0.5 } }],
      },
      { key: 'rim', options: [{ filterId: 'rim-light', params: { color: '#ff1a1a', width: 16, angle: 40, intensity: 0.95, softness: 0.55 } }] },
      // Light printed dot screen on the character (crimson film look; skipped when unavailable).
      { key: 'halftone', options: [{ filterId: 'halftone', params: { mode: 'color', shape: 'dot', size: 5, angle: 45, contrast: 12, paper: '#ffd9d4', transparentPaper: false, mix: 0.35 } }] },
    ],
    effects: [{ key: 'glow', effectId: 'outer-glow', params: { color: '#ff1a1a', opacity: 0.55, size: 34, spread: 0, blendMode: 'screen' } }],
    controls: [
      C.rimColor(),
      C.rimWidth(),
      C.rimAngle(),
      { id: 'tint', label: 'Tint', kind: 'filter', target: 'base', param: 'tint', type: 'color' },
      { id: 'tintStrength', label: 'Tint amount', kind: 'filter', target: 'base', param: 'tintStrength', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' },
      { id: 'glowSize', label: 'Glow', kind: 'effect', target: 'glow', param: 'size', type: 'number', min: 0, max: 120, step: 1, unit: 'px' },
    ],
  },
  {
    id: 'gothic-poster',
    name: 'Gothic Poster',
    description: 'Flat cut-paper tones, violet rim and a dark outline — the gothic paper poster look.',
    swatch: ['#efeae0', '#8b7cf6', '#0b0b0b'],
    filters: [
      topShade(0.34, 0.62, '#0d0a18'),
      {
        key: 'base',
        // 4 tones keep skin close to its own value (3 tones lifted it to a pale mask).
        options: [
          { filterId: 'toon-roblox', params: { levels: 4, smooth: 0.45, saturation: -25, shadowColor: '#1a1430', shadowStrength: 0.55, shadowThreshold: 0.4, outlineWidth: 2.5, edges: 0.35 } },
        ],
      },
      { key: 'rim', options: [{ filterId: 'rim-light', params: { color: '#8b7cf6', width: 7, angle: 120, intensity: 0.75, softness: 0.3 } }] },
    ],
    effects: [{ key: 'stroke', effectId: 'stroke', params: { color: '#0b0b0b', size: 4, position: 'outside', opacity: 1 } }],
    controls: [
      C.tones(),
      { id: 'shadowTint', label: 'Shadow tint', kind: 'filter', target: 'base', param: 'shadowColor', type: 'color' },
      C.rimColor(),
      C.faceStrength(),
      { id: 'strokeSize', label: 'Outline', kind: 'effect', target: 'stroke', param: 'size', type: 'number', min: 0, max: 30, step: 1, unit: 'px' },
    ],
  },
  {
    id: 'neon-edge',
    name: 'Neon Edge',
    description: 'Cyan and magenta rim lights with a neon glow.',
    swatch: ['#3cf2ff', '#ff2bd6', '#140a2a'],
    filters: [
      { key: 'base', options: [{ filterId: 'toon-roblox', params: { levels: 4, saturation: 25, outlineWidth: 1.5, shadowColor: '#140a3a', shadowStrength: 0.6 } }] },
      { key: 'rimA', options: [{ filterId: 'rim-light', params: { color: '#3cf2ff', width: 12, angle: 150, intensity: 0.9, softness: 0.4 } }] },
      { key: 'rimB', options: [{ filterId: 'rim-light', params: { color: '#ff2bd6', width: 12, angle: -30, intensity: 0.9, softness: 0.4 } }] },
    ],
    effects: [{ key: 'glow', effectId: 'outer-glow', params: { color: '#3cf2ff', opacity: 0.7, size: 26, spread: 0.05, blendMode: 'screen' } }],
    controls: [
      C.rimColor('rimA', 'Left rim'),
      C.rimColor('rimB', 'Right rim'),
      C.rimWidth('rimA', 'Rim width'),
      { id: 'glowColor', label: 'Glow color', kind: 'effect', target: 'glow', param: 'color', type: 'color' },
      { id: 'glowSize', label: 'Glow', kind: 'effect', target: 'glow', param: 'size', type: 'number', min: 0, max: 120, step: 1, unit: 'px' },
    ],
  },
  {
    id: 'silhouette',
    name: 'Silhouette',
    description: 'Solid silhouette with a soft drop shadow (noir thumbnails).',
    swatch: ['#0b0b0b', '#2a2a2a', '#d6d6d6'],
    filters: [{ key: 'base', options: [{ filterId: 'silhouette', params: { color: '#0b0b0b', keepEdges: 0.12 } }] }],
    effects: [{ key: 'shadow', effectId: 'drop-shadow', params: { color: '#000000', opacity: 0.6, angle: 120, distance: 18, spread: 0, size: 22, blendMode: 'multiply' } }],
    controls: [
      { id: 'silColor', label: 'Color', kind: 'filter', target: 'base', param: 'color', type: 'color' },
      { id: 'keepEdges', label: 'Inner lines', kind: 'filter', target: 'base', param: 'keepEdges', type: 'number', min: 0, max: 1, step: 0.01, displayScale: 100, unit: '%' },
      { id: 'dropDistance', label: 'Drop shadow', kind: 'effect', target: 'shadow', param: 'distance', type: 'number', min: 0, max: 120, step: 1, unit: 'px' },
    ],
  },
  {
    id: 'painterly',
    name: 'Painterly',
    description: 'Soft painted strokes with warm light and gentle shadows.',
    swatch: ['#f4d9a8', '#b5714a', '#3a2418'],
    filters: [
      topShade(0.3, 0.35, '#2a1408'),
      {
        key: 'paint',
        options: [
          { filterId: 'oil-paint', params: { radius: 4, detail: 0.4, shine: 0.12, angle: 135 } },
          { filterId: 'kuwahara', params: { radius: 5 } },
          { filterId: 'toon-roblox', params: { levels: 7, smooth: 0.9, outlineWidth: 0, edges: 0 } },
        ],
      },
      { key: 'rim', options: [{ filterId: 'rim-light', params: { color: '#ffd29a', width: 12, angle: 135, intensity: 0.5, softness: 0.9 } }] },
    ],
    effects: [],
    controls: [
      { id: 'brush', label: 'Brush size', kind: 'filter', target: 'paint', param: { 'oil-paint': 'radius', kuwahara: 'radius' }, type: 'number', min: 1, max: 12, step: 1, unit: 'px' },
      C.rimColor('rim', 'Light color'),
      C.rimWidth('rim', 'Light width'),
      C.faceStrength(),
    ],
  },
];

export function styleById(id: string | null | undefined): StyleDef | undefined {
  return STYLES.find((s) => s.id === id);
}

/* ------------------------------------------------------------------ */
/* Pure apply / read helpers                                           */
/* ------------------------------------------------------------------ */

export interface Availability {
  hasFilter(id: string): boolean;
  hasEffect(id: string): boolean;
}

export interface BuiltStyle {
  filters: FilterInstance[];
  effects: LayerEffect[];
  meta: StylerMeta;
}

/** Instantiate a style's filters/effects for whatever is registered. */
export function buildStyle(style: StyleDef, avail: Availability, makeId: (prefix: string) => string): BuiltStyle {
  const meta: StylerMeta = { style: style.id, filters: {}, effects: {} };
  const filters: FilterInstance[] = [];
  const effects: LayerEffect[] = [];
  for (const spec of style.filters) {
    const opt = spec.options.find((o) => avail.hasFilter(o.filterId));
    if (!opt) continue;
    const inst: FilterInstance = {
      id: makeId('fx_'),
      filterId: opt.filterId,
      enabled: true,
      params: structuredClone(opt.params),
      opacity: spec.opacity ?? 1,
      blendMode: spec.blendMode ?? 'normal',
    };
    filters.push(inst);
    meta.filters[spec.key] = { id: inst.id, filterId: inst.filterId };
  }
  for (const spec of style.effects) {
    if (!avail.hasEffect(spec.effectId)) continue;
    const e: LayerEffect = { id: makeId('ef_'), effectId: spec.effectId, enabled: true, params: structuredClone(spec.params) };
    effects.push(e);
    meta.effects[spec.key] = { id: e.id, effectId: e.effectId };
  }
  return { filters, effects, meta };
}

/** Read the styler metadata of a layer (defensive). */
export function readStylerMeta(layer: Pick<Layer, 'meta'> | null | undefined): StylerMeta | null {
  const m = (layer?.meta as { styler?: unknown } | undefined)?.styler as Partial<StylerMeta> | undefined;
  if (!m || typeof m !== 'object' || typeof m.style !== 'string') return null;
  return { style: m.style, filters: { ...(m.filters ?? {}) }, effects: { ...(m.effects ?? {}) } };
}

/**
 * Immer-draft mutation: remove the styler's previous filters/effects from the layer and (when
 * `built` is given) append the new ones. Returns the number of removed instances.
 */
export function applyBuiltStyleDraft(layer: Layer, built: BuiltStyle | null): number {
  const prev = readStylerMeta(layer);
  let removed = 0;
  if (prev) {
    const fIds = new Set(Object.values(prev.filters).map((f) => f.id));
    const eIds = new Set(Object.values(prev.effects).map((e) => e.id));
    const before = layer.filters.length + layer.effects.length;
    layer.filters = layer.filters.filter((f) => !fIds.has(f.id));
    layer.effects = layer.effects.filter((e) => !eIds.has(e.id));
    removed = before - layer.filters.length - layer.effects.length;
  }
  const meta = { ...(layer.meta ?? {}) } as Record<string, unknown>;
  if (built) {
    layer.filters.push(...built.filters);
    layer.effects.push(...built.effects);
    meta.styler = built.meta;
  } else delete meta.styler;
  layer.meta = meta;
  return removed;
}

export interface ResolvedControl {
  control: StyleControl;
  /** Index into layer.filters / layer.effects. */
  index: number;
  instanceId: string;
  /** Registered filter/effect id of the instance. */
  defId: string;
  param: string;
}

/** Map a style's controls onto the layer's tracked instances (controls without a target are dropped). */
export function resolveControls(style: StyleDef, layer: Pick<Layer, 'filters' | 'effects' | 'meta'>): ResolvedControl[] {
  const meta = readStylerMeta(layer);
  if (!meta || meta.style !== style.id) return [];
  const out: ResolvedControl[] = [];
  for (const c of style.controls) {
    const ref = c.kind === 'filter' ? meta.filters[c.target] : meta.effects[c.target];
    if (!ref) continue;
    const list = c.kind === 'filter' ? layer.filters : layer.effects;
    const index = list.findIndex((x) => x.id === ref.id);
    if (index < 0) continue;
    const defId = c.kind === 'filter' ? (list[index] as FilterInstance).filterId : (list[index] as LayerEffect).effectId;
    const param = typeof c.param === 'string' ? c.param : c.param[defId];
    if (!param) continue;
    out.push({ control: c, index, instanceId: ref.id, defId, param });
  }
  return out;
}

/** Immer-draft mutation: set one bound param. */
export function setControlDraft(layer: Layer, rc: ResolvedControl, value: ParamValue) {
  const list = rc.control.kind === 'filter' ? layer.filters : layer.effects;
  const inst = list.find((x) => x.id === rc.instanceId);
  if (inst) inst.params = { ...inst.params, [rc.param]: value };
}
