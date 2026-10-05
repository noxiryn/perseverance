/** Layer effects (layer styles) — registered in the `effects` registry. */
import { effects } from '../../registry';
import { dropShadow, innerShadow, longShadow } from './shadows';
import { innerGlow, outerGlow } from './glows';
import { stroke } from './stroke';
import { colorOverlay, gradientOverlay, patternOverlay } from './overlays';
import { bevel, satin } from './bevel';

export const EFFECT_DEFS = [dropShadow, outerGlow, stroke, longShadow, innerShadow, innerGlow, colorOverlay, gradientOverlay, patternOverlay, bevel, satin];

export function registerEffects() {
  effects.registerMany(EFFECT_DEFS);
}

export { effectCacheable, effectClips, effectExtent, effectMeta, effectReach, effectStage, effectTranslationSafe } from './common';
export type { DistanceMode, EffectArgsExt, EffectFields, EffectRegion, LocalRect } from './common';
