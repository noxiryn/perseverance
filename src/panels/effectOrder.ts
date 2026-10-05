/**
 * The real drawing order of a layer's effects, as the renderer composites them:
 *  1. 'behind' effects (drop/long shadow, outer glow, outside stroke) under the content,
 *  2. the layer content,
 *  3. 'above' effects (overlays, inner shadow/glow, bevel, inside/center stroke) over it.
 * Within a stage, effects are sorted by their type's `order`, and only instances of the same
 * type (same stage + order — a "bucket") are ordered by their position in `layer.effects`.
 * So the only reordering that changes the image is within a bucket (e.g. two strokes).
 */
import type { LayerEffect } from '../core/types';
import { effects } from '../registry';

export interface EffectPlacement {
  stage: 'behind' | 'above';
  /** Order within the stage (lower is drawn first). */
  order: number;
}

/** Bucket key: effects with the same key are ordered by array index; others by type. */
export const bucketKey = (p: EffectPlacement) => `${p.stage}:${p.order}`;

export interface OrderedEffect {
  fx: LayerEffect;
  /** Index in layer.effects. */
  index: number;
  place: EffectPlacement;
  bucket: string;
}

/** Effects in the order they are drawn (first = bottom-most). Pure given `placeOf`. */
export function drawOrder(list: readonly LayerEffect[], placeOf: (e: LayerEffect) => EffectPlacement): OrderedEffect[] {
  return list
    .map((fx, index) => {
      const place = placeOf(fx);
      return { fx, index, place, bucket: bucketKey(place) };
    })
    .sort((a, b) => (a.place.stage === b.place.stage ? 0 : a.place.stage === 'behind' ? -1 : 1) || a.place.order - b.place.order || a.index - b.index);
}

/**
 * Target index for moveEffect(from → to) that places effect `from` directly above (drawn after)
 * or below (drawn before) effect `ref` of the same bucket. Null when the move would not change
 * the drawing order (different buckets, same effect, or already there).
 */
export function reorderTarget(
  list: readonly LayerEffect[],
  placeOf: (e: LayerEffect) => EffectPlacement,
  from: number,
  ref: number,
  where: 'above' | 'below',
): number | null {
  if (from === ref || !list[from] || !list[ref]) return null;
  if (bucketKey(placeOf(list[from])) !== bucketKey(placeOf(list[ref]))) return null;
  // Index of `ref` after removing `from`, then insert after (above) or before (below) it.
  const refAfter = ref > from ? ref - 1 : ref;
  const to = where === 'above' ? refAfter + 1 : refAfter;
  if (to === from) return null;
  // Already in place: `from` directly after/before `ref` among the same bucket's members.
  const bucket = bucketKey(placeOf(list[from]));
  const members = list.map((e, i) => ({ e, i })).filter(({ e }) => bucketKey(placeOf(e)) === bucket);
  const pos = members.findIndex((m) => m.i === from);
  const refPos = members.findIndex((m) => m.i === ref);
  if (where === 'above' && pos === refPos + 1) return null;
  if (where === 'below' && pos === refPos - 1) return null;
  return to;
}

/** Stage + order of an effect instance, from the effects registry (unknown effects go on top). */
export function effectPlacement(e: LayerEffect): EffectPlacement {
  const def = effects.get(e.effectId);
  if (!def) return { stage: 'above', order: 1e6 };
  // A stroke drawn outside the shape goes behind the content (the renderer's only
  // param-dependent stage; see ARCHITECTURE.md §5.5).
  if (def.id === 'stroke') {
    const pos = e.params.position;
    return { stage: pos === 'inside' || pos === 'center' ? 'above' : 'behind', order: def.order };
  }
  return { stage: def.stage, order: def.order };
}

/** A layer's effects top → bottom as drawn (the first row is drawn last, i.e. on top). */
export function effectsTopDown(list: readonly LayerEffect[]): OrderedEffect[] {
  return drawOrder(list, effectPlacement).reverse();
}
