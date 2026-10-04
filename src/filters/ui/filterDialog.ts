/**
 * CONTRACT (owned by the stylize-filters module): open the filter dialog with live preview for
 * a registered filter and apply it to the active layer.
 *  - mode 'auto' (default): smart filter for non-raster layers, destructive for raster layers
 *    unless the user ticks "Smart Filter";
 *  - 'smart': add to layer.filters; 'destructive': bake into the raster bitmap (respecting the
 *    selection).
 * Resolves when the dialog closes.
 */
import { toast } from '../../state/ui';

export async function openFilterDialog(filterId: string, opts: { mode?: 'auto' | 'smart' | 'destructive' } = {}): Promise<void> {
  void opts;
  toast(`Filter dialog not available yet (${filterId})`, 'info');
}
