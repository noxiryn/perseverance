/** Stroke configs from tool settings (pure; shared by tools and previews). */
import type { BrushSettings } from '../options';
import type { StrokeConfig } from './stroke';

/** Stroke config for brush-like settings. `stabilizer` is the pulled-string radius in doc px. */
export function strokeConfig(o: BrushSettings, stabilizer = 0): StrokeConfig {
  return {
    size: Math.max(1, o.size),
    flow: o.flow,
    angle: o.angle,
    roundness: o.roundness,
    sizeJitter: o.sizeJitter,
    angleJitter: o.angleJitter,
    scatter: o.scatter,
    opacityJitter: o.opacityJitter,
    pressureSize: o.pressureSize,
    pressureOpacity: o.pressureOpacity,
    followDirection: o.followDirection,
    spacing: Math.max(0.01, o.spacing),
    stabilizer,
  };
}

/** Plain (no dynamics) config for aliased tips (pencil, eraser pencil/block). */
export function hardConfig(size: number, stabilizer: number, pressureSize: boolean): StrokeConfig {
  return {
    size: Math.max(1, size),
    flow: 1,
    angle: 0,
    roundness: 1,
    sizeJitter: 0,
    angleJitter: 0,
    scatter: 0,
    opacityJitter: 0,
    pressureSize,
    pressureOpacity: false,
    followDirection: false,
    spacing: 0.1,
    stabilizer,
  };
}
