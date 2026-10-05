/**
 * Terse ParamDef builders + per-asset UI metadata (preview backdrop for thumbnails, font needs).
 */
import type { ParamDef, Point } from '../../core/types';
import type { AssetDef } from '../../registry';
import type { LightBackdropVariant } from './backdrop';

export type PreviewBg = 'paper' | 'dark' | 'checker' | 'mid' | 'none';

export interface AssetMeta {
  /** Backdrop drawn behind transparent assets in thumbnails/previews. */
  bg?: PreviewBg;
  /** The generator draws text: wait for fonts before rendering thumbnails. */
  fonts?: boolean;
  /**
   * Whether the asset can render at full quality right now (e.g. a user image whose full
   * resolution is decoded). Absent = always ready.
   */
  isReady?: () => boolean;
  /** Make the asset ready (decode its source…). Must never reject. */
  prepare?: () => Promise<void>;
  /**
   * Light-only overlay (Screen…) with a dark-on-light version: placed over a light backdrop it is
   * switched to Multiply with a dark shade of its color (see lib/backdrop.ts). Assets that depict
   * light itself (glows, flares) leave this unset and only get a hint.
   */
  onLight?: LightBackdropVariant;
}

export const assetMeta = new Map<string, AssetMeta>();

export function defineAsset(def: AssetDef, meta: AssetMeta = {}): AssetDef {
  assetMeta.set(def.id, meta);
  return def;
}

export const P = {
  seed: (d = 1): ParamDef => ({ key: 'seed', label: 'Seed', type: 'seed', default: d }),
  color: (key: string, label: string, d: string, group?: string): ParamDef => ({ key, label, type: 'color', default: d, group }),
  num: (
    key: string,
    label: string,
    min: number,
    max: number,
    d: number,
    o: { step?: number; unit?: string; group?: string; hint?: string } = {},
  ): ParamDef => ({ key, label, type: 'number', min, max, default: d, step: o.step ?? 1, unit: o.unit, group: o.group, hint: o.hint }),
  /** 0..1 value shown as a percentage. */
  pct: (key: string, label: string, d: number, o: { group?: string; hint?: string; max?: number } = {}): ParamDef => ({
    key,
    label,
    type: 'number',
    min: 0,
    max: o.max ?? 1,
    step: 0.01,
    default: d,
    displayScale: 100,
    unit: '%',
    group: o.group,
    hint: o.hint,
  }),
  select: (key: string, label: string, options: (string | [string, string])[], d: string, group?: string): ParamDef => ({
    key,
    label,
    type: 'select',
    default: d,
    group,
    options: options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o[0].toUpperCase() + o.slice(1) })),
  }),
  bool: (key: string, label: string, d: boolean, group?: string): ParamDef => ({ key, label, type: 'boolean', default: d, group }),
  angle: (key: string, label: string, d: number, group?: string): ParamDef => ({ key, label, type: 'angle', default: d, group }),
  point: (key: string, label: string, d: Point, group?: string): ParamDef => ({ key, label, type: 'point', default: d, group }),
  text: (key: string, label: string, d: string): ParamDef => ({ key, label, type: 'text', default: d }),
};
