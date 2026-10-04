/**
 * CONTRACT (owned by the looks/templates module): apply a registered Look (one-click style) to
 * the active document, targeting a layer (e.g. the Roblox character) or the whole document when
 * targetLayerId is null. Must be ONE history step.
 */
import type { ID } from '../core/types';
import { toast } from '../state/ui';

export async function applyLook(lookId: string, targetLayerId: ID | null): Promise<void> {
  void targetLayerId;
  toast(`Looks engine not available yet (${lookId})`, 'info');
}
