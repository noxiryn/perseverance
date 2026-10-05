/**
 * Type tool options (stored in the editor store under toolOptions['type']) and conversions between
 * options and TextProps. New text uses the primary color unless a gradient fill is chosen.
 */
import type { Gradient, Paint, TextProps, TextWarpStyle } from '../../core/types';
import { DEFAULT_TEXT } from '../../core/document';
import { useEditor } from '../../state/editor';

export const TYPE_TOOL_ID = 'type';

export interface TextWarp {
  style: TextWarpStyle;
  bend: number;
  horizontal: number;
  vertical: number;
}

export type TypeToolOptions = {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSize: number;
  align: TextProps['align'];
  lineHeight: number;
  letterSpacing: number;
  scaleX: number;
  scaleY: number;
  uppercase: boolean;
  fauxBold: boolean;
  fauxItalic: boolean;
  antiAlias: boolean;
  fillType: 'solid' | 'gradient';
  /** Gradient used when fillType = 'gradient' (null = primary → secondary). */
  gradient: Gradient | null;
  strokeOn: boolean;
  strokeColor: string;
  strokeWidth: number;
  warp: TextWarp;
  /** Text style preset whose layer effects are added to new text layers (null = none). */
  stylePreset: string | null;
};

export const NO_WARP: TextWarp = { style: 'none', bend: 0, horizontal: 0, vertical: 0 };

export const TYPE_DEFAULTS: TypeToolOptions = {
  fontFamily: DEFAULT_TEXT.fontFamily,
  fontWeight: DEFAULT_TEXT.fontWeight,
  fontStyle: 'normal',
  fontSize: 96,
  align: 'left',
  lineHeight: DEFAULT_TEXT.lineHeight,
  letterSpacing: 0,
  scaleX: 1,
  scaleY: 1,
  uppercase: false,
  fauxBold: false,
  fauxItalic: false,
  antiAlias: true,
  fillType: 'solid',
  gradient: null,
  strokeOn: false,
  strokeColor: '#000000',
  strokeWidth: 4,
  warp: NO_WARP,
  stylePreset: null,
};

/** Font size presets (px) offered by the size dropdowns. */
export const SIZE_PRESETS = [8, 10, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96, 120, 150, 200, 250, 300, 400];

export function defaultTextGradient(a: string, b: string): Gradient {
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

function finite(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Sanitize stored options (old/foreign values never break the tool). */
export function normalizeOptions(raw: Partial<TypeToolOptions> | undefined): TypeToolOptions {
  const o = { ...TYPE_DEFAULTS, ...raw };
  return {
    ...o,
    fontFamily: typeof o.fontFamily === 'string' && o.fontFamily.trim() ? o.fontFamily : TYPE_DEFAULTS.fontFamily,
    fontWeight: Math.round(finite(o.fontWeight, 400)),
    fontStyle: o.fontStyle === 'italic' ? 'italic' : 'normal',
    fontSize: Math.max(1, finite(o.fontSize, TYPE_DEFAULTS.fontSize)),
    align: o.align === 'center' || o.align === 'right' ? o.align : 'left',
    lineHeight: Math.max(0.1, finite(o.lineHeight, TYPE_DEFAULTS.lineHeight)),
    letterSpacing: finite(o.letterSpacing, 0),
    scaleX: finite(o.scaleX, 1) || 1,
    scaleY: finite(o.scaleY, 1) || 1,
    strokeWidth: Math.max(0, finite(o.strokeWidth, 4)),
    warp: o.warp && typeof o.warp === 'object' ? { ...NO_WARP, ...o.warp } : NO_WARP,
  };
}

/** TextProps for a new text layer from the tool options. */
export function textPropsFromOptions(o: TypeToolOptions, primary: string, secondary: string, content = ''): TextProps {
  const fill: Paint =
    o.fillType === 'gradient' ? { type: 'gradient', gradient: structuredClone(o.gradient ?? defaultTextGradient(primary, secondary)) } : { type: 'solid', color: primary };
  return {
    ...DEFAULT_TEXT,
    content,
    fontFamily: o.fontFamily,
    fontWeight: o.fontWeight,
    fontStyle: o.fontStyle,
    fontSize: o.fontSize,
    fill,
    align: o.align,
    lineHeight: o.lineHeight,
    letterSpacing: o.letterSpacing,
    scaleX: o.scaleX,
    scaleY: o.scaleY,
    uppercase: o.uppercase,
    boxWidth: null,
    stroke: o.strokeOn && o.strokeWidth > 0 ? { color: o.strokeColor, width: o.strokeWidth } : null,
    warp: { ...o.warp },
    fauxBold: o.fauxBold,
    fauxItalic: o.fauxItalic,
    antiAlias: o.antiAlias,
  };
}

/** Tool options mirroring a text layer's style (so the next text uses the last used settings). */
export function optionsFromText(t: TextProps): Partial<TypeToolOptions> {
  const out: Partial<TypeToolOptions> = {
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    fontSize: t.fontSize,
    align: t.align,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    scaleX: t.scaleX,
    scaleY: t.scaleY,
    uppercase: t.uppercase,
    fauxBold: t.fauxBold,
    fauxItalic: t.fauxItalic,
    antiAlias: t.antiAlias,
    strokeOn: !!t.stroke && t.stroke.width > 0,
    warp: { ...NO_WARP, ...t.warp },
  };
  if (t.stroke) {
    out.strokeColor = t.stroke.color;
    out.strokeWidth = t.stroke.width;
  }
  if (t.fill?.type === 'gradient') {
    out.fillType = 'gradient';
    out.gradient = t.fill.gradient;
  } else out.fillType = 'solid';
  return out;
}

/** The subset of TextProps keys that map 1:1 to tool options. */
const DIRECT_KEYS = [
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'fontSize',
  'align',
  'lineHeight',
  'letterSpacing',
  'scaleX',
  'scaleY',
  'uppercase',
  'fauxBold',
  'fauxItalic',
  'antiAlias',
] as const;

/** Options patch for a partial TextProps change (fill color is NOT mirrored: new text uses the primary color). */
export function optionsPatchFromTextPatch(p: Partial<TextProps>): Partial<TypeToolOptions> {
  const out: Partial<TypeToolOptions> = {};
  for (const k of DIRECT_KEYS) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  if (p.stroke !== undefined) {
    out.strokeOn = !!p.stroke && p.stroke.width > 0;
    if (p.stroke) {
      out.strokeColor = p.stroke.color;
      out.strokeWidth = p.stroke.width;
    }
  }
  if (p.warp) out.warp = { ...NO_WARP, ...p.warp };
  if (p.fill) {
    out.fillType = p.fill.type === 'gradient' ? 'gradient' : 'solid';
    if (p.fill.type === 'gradient') out.gradient = p.fill.gradient;
  }
  return out;
}

/**
 * Tool option keys that describe one layer's look (fill, outline, warp, style preset). Changing
 * them on a selected layer never changes what the next new text looks like.
 */
const PER_LAYER_KEYS = new Set<keyof TypeToolOptions>(['warp', 'strokeOn', 'strokeColor', 'strokeWidth', 'fillType', 'gradient', 'stylePreset']);

/** The part of a tool patch that carries over to new text after styling a layer (typography only). */
export function typographicPatch(patch: Partial<TypeToolOptions>): Partial<TypeToolOptions> {
  const out: Partial<TypeToolOptions> = {};
  for (const k of Object.keys(patch) as (keyof TypeToolOptions)[]) {
    if (!PER_LAYER_KEYS.has(k)) (out as Record<string, unknown>)[k] = patch[k];
  }
  return out;
}

/* ---------------- store access ---------------- */

export function readTypeOptions(): TypeToolOptions {
  return normalizeOptions(useEditor.getState().toolOptions[TYPE_TOOL_ID] as Partial<TypeToolOptions> | undefined);
}

export function writeTypeOptions(patch: Partial<TypeToolOptions>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  useEditor.setState((s) => ({ toolOptions: { ...s.toolOptions, [TYPE_TOOL_ID]: { ...s.toolOptions[TYPE_TOOL_ID], ...patch } } }));
}

/** React: current type tool options (normalized). */
export function useTypeOptions(): TypeToolOptions {
  const raw = useEditor((s) => s.toolOptions[TYPE_TOOL_ID]) as Partial<TypeToolOptions> | undefined;
  return normalizeOptions(raw);
}

/* ---------------- labels ---------------- */

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

export function weightLabel(w: number, italic = false): string {
  const name = WEIGHT_NAMES[Math.round(w / 100) * 100] ?? String(w);
  if (!italic) return name;
  return name === 'Regular' ? 'Italic' : `${name} Italic`;
}

/** Weight/style choices for a family: `weights` from its FontDef (default 400/700), italics when available. */
export function weightChoices(weights: number[] | undefined, italic: boolean | undefined): { value: string; label: string }[] {
  const ws = weights?.length ? [...new Set(weights)].sort((a, b) => a - b) : [400, 700];
  const out: { value: string; label: string }[] = [];
  for (const w of ws) {
    out.push({ value: `${w}`, label: weightLabel(w) });
    if (italic) out.push({ value: `${w}i`, label: weightLabel(w, true) });
  }
  return out;
}

export function weightValue(weight: number, style: 'normal' | 'italic'): string {
  return `${Math.round(weight)}${style === 'italic' ? 'i' : ''}`;
}

export function parseWeightValue(v: string): { fontWeight: number; fontStyle: 'normal' | 'italic' } {
  const italic = v.endsWith('i');
  const w = parseInt(italic ? v.slice(0, -1) : v, 10);
  return { fontWeight: Number.isFinite(w) ? w : 400, fontStyle: italic ? 'italic' : 'normal' };
}

/** Default layer name for a text layer (same rule as makeTextLayer). */
export function autoLayerName(content: string): string {
  return content.split('\n')[0].trim().slice(0, 32) || 'Text';
}
