/** Terse ParamDef builders + safe param readers for the adjustment filters. */
import type { Color, CurvesValue, Gradient, ParamDef, ParamValues } from '../../core/types';

type Extra = {
  step?: number;
  unit?: string;
  group?: string;
  hint?: string;
  showIf?: (v: ParamValues) => boolean;
  displayScale?: number;
};
type PlainExtra = Omit<Extra, 'step' | 'unit' | 'displayScale'>;

export const numP = (key: string, label: string, min: number, max: number, def: number, extra: Extra = {}): ParamDef => ({
  type: 'number',
  key,
  label,
  min,
  max,
  default: def,
  step: extra.step ?? (max - min <= 2 ? 0.01 : max - min <= 20 ? 0.1 : 1),
  ...extra,
});

/** 0..1 stored, shown as %. */
export const pctP = (key: string, label: string, def: number, extra: Extra = {}, min = 0, max = 1): ParamDef =>
  numP(key, label, min, max, def, { step: 0.01, unit: '%', displayScale: 100, ...extra });

export const boolP = (key: string, label: string, def: boolean, extra: PlainExtra = {}): ParamDef => ({
  type: 'boolean',
  key,
  label,
  default: def,
  ...extra,
});

export const colorP = (key: string, label: string, def: Color, extra: PlainExtra = {}): ParamDef => ({
  type: 'color',
  key,
  label,
  default: def,
  ...extra,
});

export const selectP = (
  key: string,
  label: string,
  options: [string, string][],
  def: string,
  extra: PlainExtra = {},
): ParamDef => ({
  type: 'select',
  key,
  label,
  options: options.map(([value, l]) => ({ value, label: l })),
  default: def,
  ...extra,
});

export const gradientP = (key: string, label: string, def: Gradient, extra: PlainExtra = {}): ParamDef => ({
  type: 'gradient',
  key,
  label,
  default: def,
  ...extra,
});

export const curvesP = (key: string, label: string, def: CurvesValue, extra: PlainExtra = {}): ParamDef => ({
  type: 'curves',
  key,
  label,
  default: def,
  ...extra,
});

/* ---------------- readers (never trust that a key is present / well-typed) ---------------- */

export function num(p: ParamValues, key: string, def: number, min = -Infinity, max = Infinity): number {
  const v = p[key];
  const n = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : def;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

export function bool(p: ParamValues, key: string, def: boolean): boolean {
  const v = p[key];
  return typeof v === 'boolean' ? v : v === undefined || v === null ? def : !!v;
}

export function str(p: ParamValues, key: string, def: string): string {
  const v = p[key];
  return typeof v === 'string' && v ? v : def;
}

export function isGradient(v: unknown): v is Gradient {
  return !!v && typeof v === 'object' && Array.isArray((v as Gradient).stops) && (v as Gradient).stops.length > 0;
}

export function isCurves(v: unknown): v is CurvesValue {
  if (!v || typeof v !== 'object') return false;
  const c = v as CurvesValue;
  return ['rgb', 'r', 'g', 'b'].every((k) => Array.isArray(c[k as keyof CurvesValue]));
}
