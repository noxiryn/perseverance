/** Terse ParamDef builders for filter definitions. */
import type { ParamDef, ParamValues, Point } from '../../core/types';

type Extra = { step?: number; unit?: string; group?: string; hint?: string; showIf?: (v: ParamValues) => boolean; displayScale?: number };

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

/** Size in px. */
export const pxP = (key: string, label: string, min: number, max: number, def: number, extra: Extra = {}): ParamDef =>
  numP(key, label, min, max, def, { unit: 'px', step: max <= 20 ? 0.1 : max <= 100 ? 0.5 : 1, ...extra });

/** 0..1 stored, shown as %. */
export const pctP = (key: string, label: string, def: number, extra: Extra = {}, min = 0, max = 1): ParamDef =>
  numP(key, label, min, max, def, { step: 0.01, unit: '%', displayScale: 100, ...extra });

export const angleP = (key: string, label: string, def: number, extra: Omit<Extra, 'step' | 'unit' | 'displayScale'> = {}): ParamDef => ({
  type: 'angle',
  key,
  label,
  default: def,
  ...extra,
});

export const boolP = (key: string, label: string, def: boolean, extra: Omit<Extra, 'step' | 'unit' | 'displayScale'> = {}): ParamDef => ({
  type: 'boolean',
  key,
  label,
  default: def,
  ...extra,
});

export const colorP = (key: string, label: string, def: string, extra: Omit<Extra, 'step' | 'unit' | 'displayScale'> = {}): ParamDef => ({
  type: 'color',
  key,
  label,
  default: def,
  ...extra,
});

export const selectP = (
  key: string,
  label: string,
  options: { value: string; label: string }[] | [string, string][],
  def: string,
  extra: Omit<Extra, 'step' | 'unit' | 'displayScale'> = {},
): ParamDef => ({
  type: 'select',
  key,
  label,
  options: options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o)),
  default: def,
  ...extra,
});

export const seedP = (def = 1, key = 'seed', label = 'Seed'): ParamDef => ({ type: 'seed', key, label, default: def });

export const pointP = (key: string, label: string, def: Point, extra: Omit<Extra, 'step' | 'unit' | 'displayScale'> = {}): ParamDef => ({
  type: 'point',
  key,
  label,
  default: def,
  ...extra,
});
