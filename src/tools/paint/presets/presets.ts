/**
 * Built-in brush presets (registered into `brushPresets`). Presets may carry paint-specific
 * extras (opacity, pressure toggles, follow-direction, smoothing, airbrush) beyond the shared
 * BrushPresetDef contract; other modules can ignore them.
 */
import type { BrushPresetDef } from '../../../registry';
import type { BrushSettings } from '../options';
import { BRUSH_SETTINGS_DEFAULTS } from '../options';
import {
  chalkTip,
  charcoalTip,
  crossHatchTip,
  dryBrushTip,
  glowDotTip,
  grungeTip1,
  grungeTip2,
  hairStrandsTip,
  halftoneTip,
  markerTip,
  roughInkTip,
  scratchesTip,
  smokeTip,
  sparkleTip,
  splatterTip,
  sprayTip,
  squareTip,
  watercolorTip,
} from './tips';

export interface PaintBrushPreset extends BrushPresetDef {
  description?: string;
  opacity?: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  followDirection?: boolean;
  smoothing?: number;
  airbrush?: boolean;
  /** User-saved preset (deletable). */
  user?: boolean;
  /** For user presets: the preset whose tip is reused. */
  tipFrom?: string;
}

export const BUILTIN_PRESETS: PaintBrushPreset[] = [
  // ---- Basic ----
  { id: 'round-hard', name: 'Round Hard', category: 'Basic', size: 30, hardness: 1, spacing: 0.1, flow: 1, description: 'Crisp round brush for clean shapes' },
  { id: 'round-soft', name: 'Round Soft', category: 'Basic', size: 60, hardness: 0, spacing: 0.1, flow: 1, description: 'Soft-edged round brush for shading' },
  { id: 'airbrush-soft', name: 'Airbrush Soft', category: 'Basic', size: 140, hardness: 0, spacing: 0.08, flow: 0.08, airbrush: true, description: 'Builds up gently — glows and soft shadows' },
  { id: 'hard-pencil', name: 'Hard Pencil', category: 'Basic', size: 4, hardness: 0.95, spacing: 0.08, flow: 1, pressureOpacity: true, description: 'Thin sketching line' },
  { id: 'ink-pen', name: 'Ink Pen', category: 'Basic', size: 10, hardness: 0.97, spacing: 0.06, flow: 1, pressureSize: true, smoothing: 45, description: 'Smooth inking with pressure taper' },
  { id: 'calligraphy', name: 'Calligraphy', category: 'Basic', size: 30, hardness: 0.92, spacing: 0.04, flow: 1, angle: 45, roundness: 0.18, smoothing: 30, description: 'Flat angled nib' },
  { id: 'marker', name: 'Marker', category: 'Basic', size: 40, hardness: 0.8, spacing: 0.06, flow: 0.55, angle: 20, tip: markerTip, description: 'Semi-transparent chisel marker' },
  { id: 'square', name: 'Square', category: 'Basic', size: 30, hardness: 1, spacing: 0.08, flow: 1, tip: squareTip, description: 'Hard square tip for blocky pixel-ish strokes' },

  // ---- Dry media ----
  { id: 'chalk', name: 'Chalk', category: 'Dry Media', size: 60, hardness: 1, spacing: 0.16, flow: 0.9, angleJitter: 0.4, tip: chalkTip, description: 'Grainy chalk' },
  { id: 'charcoal', name: 'Charcoal', category: 'Dry Media', size: 50, hardness: 1, spacing: 0.1, flow: 0.8, angle: 30, roundness: 0.6, angleJitter: 0.06, pressureOpacity: true, tip: charcoalTip, description: 'Streaky charcoal smear' },
  { id: 'dry-brush', name: 'Dry Brush', category: 'Dry Media', size: 70, hardness: 1, spacing: 0.035, flow: 0.7, followDirection: true, tip: dryBrushTip, description: 'Bristle streaks that follow the stroke' },
  { id: 'cross-hatch', name: 'Cross-Hatch', category: 'Dry Media', size: 90, hardness: 1, spacing: 0.5, flow: 0.9, angleJitter: 0.04, tip: crossHatchTip, description: 'Comic-style hatching texture' },
  { id: 'rough-ink', name: 'Rough Ink', category: 'Dry Media', size: 24, hardness: 1, spacing: 0.08, flow: 1, angleJitter: 1, pressureSize: true, smoothing: 25, tip: roughInkTip, description: 'Jagged ink edges for gothic linework' },

  // ---- Grunge & texture ----
  { id: 'grunge-1', name: 'Grunge Blotch 1', category: 'Grunge & Texture', size: 220, hardness: 1, spacing: 0.6, flow: 1, angleJitter: 1, sizeJitter: 0.3, tip: grungeTip1, description: 'Distressed blotches and specks' },
  { id: 'grunge-2', name: 'Grunge Blotch 2', category: 'Grunge & Texture', size: 260, hardness: 1, spacing: 0.7, flow: 1, angleJitter: 1, scatter: 0.2, tip: grungeTip2, description: 'Worn, pitted texture stamp' },
  { id: 'splatter', name: 'Splatter', category: 'Grunge & Texture', size: 260, hardness: 1, spacing: 0.9, flow: 1, angleJitter: 1, sizeJitter: 0.4, scatter: 0.3, tip: splatterTip, description: 'Ink/blood splatter' },
  { id: 'spray-paint', name: 'Spray Paint', category: 'Grunge & Texture', size: 140, hardness: 1, spacing: 0.12, flow: 0.35, angleJitter: 1, airbrush: true, tip: sprayTip, description: 'Speckled spray can' },
  { id: 'scratches', name: 'Scratches', category: 'Grunge & Texture', size: 220, hardness: 1, spacing: 1.2, flow: 1, angleJitter: 1, sizeJitter: 0.5, scatter: 0.5, opacityJitter: 0.4, tip: scratchesTip, description: 'Film scratches for crimson/noir looks' },
  { id: 'watercolor-edge', name: 'Watercolor Edge', category: 'Grunge & Texture', size: 150, hardness: 1, spacing: 0.25, flow: 0.3, angleJitter: 1, sizeJitter: 0.2, tip: watercolorTip, description: 'Pigment pooling at the edges' },
  { id: 'halftone-dot', name: 'Halftone Dot', category: 'Grunge & Texture', size: 120, hardness: 1, spacing: 1.1, flow: 1, tip: halftoneTip, description: 'Soft halftone dot falloff' },

  // ---- FX & particles ----
  { id: 'smoke', name: 'Smoke', category: 'FX & Particles', size: 220, hardness: 1, spacing: 0.18, flow: 0.18, angleJitter: 1, sizeJitter: 0.3, scatter: 0.15, tip: smokeTip, description: 'Billowing smoke wisps' },
  { id: 'sparkle-stars', name: 'Sparkle Stars', category: 'FX & Particles', size: 50, hardness: 1, spacing: 1.6, flow: 1, sizeJitter: 0.7, scatter: 1, angleJitter: 0.08, opacityJitter: 0.3, tip: sparkleTip, description: 'Twinkling 4-point stars' },
  { id: 'glow-dot', name: 'Glow Dot', category: 'FX & Particles', size: 60, hardness: 1, spacing: 0.05, flow: 0.22, tip: glowDotTip, description: 'Bright core with a soft halo' },
  { id: 'embers', name: 'Embers', category: 'FX & Particles', size: 30, hardness: 1, spacing: 1.4, flow: 1, scatter: 1, sizeJitter: 0.85, opacityJitter: 0.5, tip: glowDotTip, description: 'Scattered glowing sparks' },
  { id: 'scatter-dots', name: 'Scatter Dots', category: 'FX & Particles', size: 16, hardness: 0.9, spacing: 1.2, flow: 1, scatter: 1, sizeJitter: 0.7, description: 'Random dots / dust' },

  // ---- Hair ----
  { id: 'hair-strands', name: 'Hair Strands', category: 'Hair', size: 60, hardness: 1, spacing: 0.03, flow: 0.85, followDirection: true, pressureSize: true, smoothing: 50, tip: hairStrandsTip, description: 'Rake of strands for hair highlights' },
];

/** Brush settings a preset applies (missing fields fall back to neutral values). */
export function presetSettings(p: BrushPresetDef): BrushSettings {
  const x = p as PaintBrushPreset;
  return {
    ...BRUSH_SETTINGS_DEFAULTS,
    presetId: p.id,
    size: p.size,
    hardness: p.hardness,
    spacing: p.spacing,
    flow: p.flow,
    opacity: x.opacity ?? 1,
    angle: p.angle ?? 0,
    roundness: p.roundness ?? 1,
    sizeJitter: p.sizeJitter ?? 0,
    angleJitter: p.angleJitter ?? 0,
    scatter: p.scatter ?? 0,
    opacityJitter: p.opacityJitter ?? 0,
    pressureSize: x.pressureSize ?? false,
    pressureOpacity: x.pressureOpacity ?? false,
    followDirection: x.followDirection ?? false,
    smoothing: x.smoothing ?? BRUSH_SETTINGS_DEFAULTS.smoothing,
  };
}
