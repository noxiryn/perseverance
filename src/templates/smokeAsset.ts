/**
 * "Billowing Smoke (soft)" — the templates' procedural smoke (paint.ts) exposed as a library
 * asset, so template/look smoke layers are regular asset layers that can be regenerated with new
 * params from the asset Properties section (color, placement, coverage, seed…).
 */
import type { ParamDef, ParamValues } from '../core/types';
import type { AssetDef } from '../registry';
import { createCanvas } from '../core/canvas';
import { smokeCanvas, type SmokeOptions, type SmokeSide } from './paint';

export const BILLOW_SMOKE_ID = 'billow-smoke';

const SIDES: { value: SmokeSide; label: string }[] = [
  { value: 'right', label: 'Right' },
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'full', label: 'Full' },
];

const pct = (key: string, label: string, d: number): ParamDef => ({ key, label, type: 'number', min: 0, max: 1, step: 0.01, default: d, displayScale: 100, unit: '%' });

export const BILLOW_SMOKE_PARAMS: ParamDef[] = [
  { key: 'color', label: 'Color', type: 'color', default: '#c4141c' },
  { key: 'highlight', label: 'Highlight', type: 'color', default: '#ff4a3a' },
  { key: 'shadow', label: 'Shadow', type: 'color', default: '#2a0204' },
  { key: 'side', label: 'Placement', type: 'select', options: SIDES, default: 'right' },
  pct('coverage', 'Coverage', 0.6),
  pct('density', 'Density', 0.9),
  { key: 'scale', label: 'Billow size', type: 'number', min: 0.5, max: 3, step: 0.05, default: 1.1, unit: '×' },
  pct('curl', 'Curl', 0.5),
  { key: 'seed', label: 'Seed', type: 'seed', default: 7 },
];

const str = (p: ParamValues, k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
const num = (p: ParamValues, k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);

/** Params → painter options (defensive: unknown/missing values fall back to defaults). */
export function smokeOptionsFromParams(p: ParamValues): SmokeOptions {
  const side = str(p, 'side', 'right');
  return {
    color: str(p, 'color', '#c4141c'),
    highlight: str(p, 'highlight', '#ff4a3a'),
    shadow: str(p, 'shadow', '#2a0204'),
    side: (SIDES.some((s) => s.value === side) ? side : 'right') as SmokeSide,
    coverage: num(p, 'coverage', 0.6),
    density: num(p, 'density', 0.9),
    scale: num(p, 'scale', 1.1),
    curl: num(p, 'curl', 0.5),
    seed: num(p, 'seed', 7),
  };
}

export const billowSmokeAsset: AssetDef = {
  id: BILLOW_SMOKE_ID,
  name: 'Billowing Smoke (soft)',
  category: 'Smoke & Atmosphere',
  tags: ['smoke', 'billowing', 'soft', 'crimson', 'red', 'clouds', 'atmosphere', 'volumetric'],
  sizing: 'document',
  defaultBlendMode: 'normal',
  params: BILLOW_SMOKE_PARAMS,
  generate(params, { width, height }) {
    return smokeCanvas(width, height, smokeOptionsFromParams(params));
  },
  thumbnail(size) {
    const w = Math.max(16, Math.round(size));
    const h = Math.max(9, Math.round(size * 0.5625));
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) return c;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(smokeCanvas(w, h, smokeOptionsFromParams({})), 0, 0);
    return c;
  },
};
