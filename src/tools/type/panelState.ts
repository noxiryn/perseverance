/** Whether the Character panel is currently visible (docked & active, or open as a flyout). */
import type { UIState } from '../../state/ui';

export const CHARACTER_PANEL_ID = 'character';

export function isCharacterPanelOpen(s: Pick<UIState, 'workspace' | 'flyoutPanel'>): boolean {
  if (s.flyoutPanel === CHARACTER_PANEL_ID) return true;
  return s.workspace.groups.some((g) => g.tabs.includes(CHARACTER_PANEL_ID) && g.active === CHARACTER_PANEL_ID && !g.collapsed);
}
