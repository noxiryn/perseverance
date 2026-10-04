/**
 * CONTRACT (owned by the fx-filters module): open the filter dialog with live preview for
 * a registered filter and apply it to the active layer.
 *  - mode 'auto' (default): smart filter for non-raster layers, destructive for raster layers
 *    unless the user ticks "Smart Filter";
 *  - 'smart': add to layer.filters; 'destructive': bake into the raster bitmap (respecting the
 *    selection).
 * Resolves when the dialog closes.
 */
import type { ParamValues } from '../../core/types';
import { filters } from '../../registry';
import { openDialog, toast } from '../../state/ui';
import { applyFilterNow, resolveTarget, type ApplyMode } from './apply';
import { FilterDialog, type FilterDialogProps } from './FilterDialog';
import { rememberedParams, setLastFilter } from './memory';

export async function openFilterDialog(filterId: string, opts: { mode?: 'auto' | 'smart' | 'destructive' } = {}): Promise<void> {
  return openFilterDialogWith(filterId, opts.mode ?? 'auto');
}

/** Same as openFilterDialog, optionally starting from given params (Filter Gallery). */
export async function openFilterDialogWith(filterId: string, mode: 'auto' | ApplyMode, params?: ParamValues): Promise<void> {
  const def = filters.get(filterId);
  if (!def) {
    toast(`Filter “${filterId}” is not available.`, 'error');
    return;
  }
  const r = resolveTarget();
  if ('error' in r) {
    toast(r.error, 'info', 3600);
    return;
  }
  // Parameterless filters (e.g. Invert) apply immediately, like Photoshop.
  if (!def.params.length) {
    const p = params ?? rememberedParams(def);
    const res = applyFilterNow(filterId, p, mode);
    if (!res.ok) toast(res.error ?? `${def.name} could not be applied.`, 'warning');
    else setLastFilter({ filterId, params: p, mode: res.mode ?? 'destructive' });
    return;
  }
  await openDialog<unknown, FilterDialogProps>(FilterDialog, { filterId, mode, target: r.target, initialParams: params });
}
