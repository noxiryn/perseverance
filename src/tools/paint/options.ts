/**
 * Tool option shapes + defaults for every paint tool. Options live in the editor store under
 * `toolOptions[toolId]` (read with toolOptions()/useToolOptions(), write with setToolOption()).
 */
import type { BlendMode, Gradient } from '../../core/types';
import { useEditor } from '../../state/editor';

/** Brush blend modes: layer blend modes plus Photoshop's paint-only Behind / Clear. */
export type BrushBlend = BlendMode | 'behind' | 'clear';

/** Settings that define a brush stroke (tip + dynamics). Shared by brush-like tools. */
export interface BrushSettings {
  /** Brush preset that supplies the tip (textured tip or round). */
  presetId: string;
  /** Diameter in document px. */
  size: number;
  /** 0..1 (round tips only) */
  hardness: number;
  /** Fraction of the diameter. */
  spacing: number;
  /** 0..1 */
  flow: number;
  /** 0..1 — cap for the whole stroke. */
  opacity: number;
  /** Degrees. */
  angle: number;
  /** 0..1 */
  roundness: number;
  sizeJitter: number;
  angleJitter: number;
  scatter: number;
  opacityJitter: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** Rotate the tip along the stroke direction (rake / bristle brushes). */
  followDirection: boolean;
  /** 0..100 */
  smoothing: number;
}

export interface BrushToolOptions extends BrushSettings, Record<string, unknown> {
  blendMode: BrushBlend;
  airbrush: boolean;
}

export const BRUSH_SETTINGS_DEFAULTS: BrushSettings = {
  presetId: 'round-hard',
  size: 30,
  hardness: 1,
  spacing: 0.1,
  flow: 1,
  opacity: 1,
  angle: 0,
  roundness: 1,
  sizeJitter: 0,
  angleJitter: 0,
  scatter: 0,
  opacityJitter: 0,
  pressureSize: false,
  pressureOpacity: false,
  followDirection: false,
  smoothing: 10,
};

export const BRUSH_DEFAULTS: BrushToolOptions = {
  ...BRUSH_SETTINGS_DEFAULTS,
  blendMode: 'normal',
  airbrush: false,
};

export interface PencilToolOptions extends Record<string, unknown> {
  size: number;
  opacity: number;
  blendMode: BrushBlend;
  shape: 'round' | 'square';
  smoothing: number;
  pressureSize: boolean;
}

export const PENCIL_DEFAULTS: PencilToolOptions = {
  size: 1,
  opacity: 1,
  blendMode: 'normal',
  shape: 'round',
  smoothing: 0,
  pressureSize: false,
};

export type EraserMode = 'brush' | 'pencil' | 'block';

export interface EraserToolOptions extends BrushSettings, Record<string, unknown> {
  mode: EraserMode;
}

export const ERASER_DEFAULTS: EraserToolOptions = {
  ...BRUSH_SETTINGS_DEFAULTS,
  presetId: 'round-soft',
  size: 60,
  hardness: 0.6,
  mode: 'brush',
};

export interface CloneToolOptions extends BrushSettings, Record<string, unknown> {
  blendMode: BrushBlend;
  aligned: boolean;
  sample: 'current' | 'all';
}

export const CLONE_DEFAULTS: CloneToolOptions = {
  ...BRUSH_SETTINGS_DEFAULTS,
  presetId: 'round-soft',
  size: 80,
  hardness: 0.5,
  smoothing: 0,
  blendMode: 'normal',
  aligned: true,
  sample: 'current',
};

export interface GradientToolOptions extends Record<string, unknown> {
  /** null = Foreground → Background (follows the current colors). */
  gradient: Gradient | null;
  kind: Gradient['kind'];
  blendMode: BrushBlend;
  opacity: number;
  reverse: boolean;
  dither: boolean;
  /** Honour the gradient's stop transparency. */
  transparency: boolean;
}

export const GRADIENT_DEFAULTS: GradientToolOptions = {
  gradient: null,
  kind: 'linear',
  blendMode: 'normal',
  opacity: 1,
  reverse: false,
  dither: true,
  transparency: true,
};

export interface BucketToolOptions extends Record<string, unknown> {
  source: 'foreground' | 'pattern';
  patternId: string;
  patternScale: number;
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  allLayers: boolean;
  opacity: number;
  blendMode: BrushBlend;
}

export const BUCKET_DEFAULTS: BucketToolOptions = {
  source: 'foreground',
  patternId: '',
  patternScale: 1,
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  allLayers: false,
  opacity: 1,
  blendMode: 'normal',
};

export type ToneRange = 'shadows' | 'midtones' | 'highlights';

export interface RetouchToolOptions extends Record<string, unknown> {
  size: number;
  hardness: number;
  spacing: number;
  /** blur / sharpen / smudge strength 0..1 */
  strength: number;
  /** smudge: start each dab with the foreground color */
  fingerPainting: boolean;
  /** dodge / burn */
  range: ToneRange;
  exposure: number;
  protectTones: boolean;
  /** sponge */
  spongeMode: 'saturate' | 'desaturate';
  flow: number;
  vibrance: boolean;
  smoothing: number;
  pressureSize: boolean;
  pressureStrength: boolean;
}

export const RETOUCH_DEFAULTS: RetouchToolOptions = {
  size: 60,
  hardness: 0.5,
  spacing: 0.15,
  strength: 0.5,
  fingerPainting: false,
  range: 'midtones',
  exposure: 0.5,
  protectTones: true,
  spongeMode: 'desaturate',
  flow: 0.5,
  vibrance: true,
  smoothing: 0,
  pressureSize: false,
  pressureStrength: false,
};

/** Per-tool defaults for retouch tools (different spacing/strength feel). */
export const RETOUCH_TOOL_DEFAULTS: Record<string, Partial<RetouchToolOptions>> = {
  'blur-brush': { strength: 0.5, spacing: 0.15 },
  'sharpen-brush': { strength: 0.35, spacing: 0.2 },
  smudge: { strength: 0.6, spacing: 0.05, hardness: 0.4 },
  dodge: { exposure: 0.4, range: 'midtones' },
  burn: { exposure: 0.4, range: 'midtones' },
  sponge: { flow: 0.5, spongeMode: 'desaturate' },
};

export function retouchDefaults(toolId: string): RetouchToolOptions {
  return { ...RETOUCH_DEFAULTS, ...RETOUCH_TOOL_DEFAULTS[toolId] };
}

/** Tools whose options carry BrushSettings (preset tip + dynamics). */
export const TIP_TOOLS = ['brush', 'eraser', 'clone-stamp'] as const;
export type TipToolId = (typeof TIP_TOOLS)[number];

export const PAINT_TOOL_IDS = [
  'brush',
  'pencil',
  'eraser',
  'clone-stamp',
  'gradient',
  'paint-bucket',
  'blur-brush',
  'sharpen-brush',
  'smudge',
  'dodge',
  'burn',
  'sponge',
] as const;

export const RETOUCH_TOOL_IDS = ['blur-brush', 'sharpen-brush', 'smudge', 'dodge', 'burn', 'sponge'] as const;

export function isTipTool(id: string): id is TipToolId {
  return (TIP_TOOLS as readonly string[]).includes(id);
}

export function isPaintTool(id: string): boolean {
  return (PAINT_TOOL_IDS as readonly string[]).includes(id);
}

export function isRetouchTool(id: string): boolean {
  return (RETOUCH_TOOL_IDS as readonly string[]).includes(id);
}

/** Defaults for any paint tool id. */
export function defaultsFor(toolId: string): Record<string, unknown> {
  switch (toolId) {
    case 'brush':
      return BRUSH_DEFAULTS;
    case 'pencil':
      return PENCIL_DEFAULTS;
    case 'eraser':
      return ERASER_DEFAULTS;
    case 'clone-stamp':
      return CLONE_DEFAULTS;
    case 'gradient':
      return GRADIENT_DEFAULTS;
    case 'paint-bucket':
      return BUCKET_DEFAULTS;
    default:
      return retouchDefaults(toolId);
  }
}

/** Write one option. */
export function setOpt(toolId: string, key: string, value: unknown) {
  useEditor.getState().setToolOption(toolId, key, value);
}

/** Write several options at once (single store update). */
export function setOpts(toolId: string, values: Record<string, unknown>) {
  useEditor.setState((st) => ({
    toolOptions: { ...st.toolOptions, [toolId]: { ...st.toolOptions[toolId], ...values } },
  }));
}

/** Blend select options for paint tools. */
export const BRUSH_BLEND_OPTIONS: { value: BrushBlend; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'behind', label: 'Behind' },
  { value: 'clear', label: 'Clear' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'linear-dodge', label: 'Linear Dodge (Add)' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

/** The gradient the Gradient tool draws (Foreground → Background when none is chosen). */
export function effectiveGradient(o: GradientToolOptions): Gradient {
  const st = useEditor.getState();
  const g: Gradient = o.gradient ?? {
    kind: o.kind,
    angle: 0,
    scale: 1,
    stops: [
      { offset: 0, color: st.primaryColor },
      { offset: 1, color: st.secondaryColor },
    ],
  };
  return { ...g, kind: o.kind };
}

/** Canvas composite op for a brush blend mode. */
export function brushCompositeOp(mode: BrushBlend | undefined): GlobalCompositeOperation {
  switch (mode) {
    case undefined:
    case 'normal':
      return 'source-over';
    case 'behind':
      return 'destination-over';
    case 'clear':
      return 'destination-out';
    case 'linear-dodge':
      return 'lighter';
    default:
      return mode;
  }
}

/** Effective pressure for a pointer: pens report real pressure, mice/touch are full pressure. */
export function effectivePressure(pointerType: string, pressure: number): number {
  if (pointerType === 'pen') return Math.max(0.02, Math.min(1, pressure || 0));
  return 1;
}
