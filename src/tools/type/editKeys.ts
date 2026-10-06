/**
 * What a command shortcut does while text is being edited on the canvas (Photoshop-like). Keys the
 * textarea edits natively (Ctrl+A/C/V/X/Z/Y, arrows, Delete…) never get here.
 *
 * - 'text'     Type menu commands (size up / down…) apply to the edited text; editing continues.
 * - 'view'     Zoom in / out, fit, 100 %, rulers, guides, grid, extras, snap: editing continues, as
 *              with Ctrl+wheel and the scroll / hand pan (you zoom to check the text you type).
 * - 'undo'     Step Backward (Alt+Ctrl+Z) undoes typing, like Ctrl+Z; editing continues.
 * - 'deselect' Ctrl+D drops the text selection (Ctrl+A selected all text); editing continues.
 * - 'commit'   Everything else — layer structure (new / duplicate / group / merge / arrange / clip),
 *              Free Transform, pixel selections, adjustments, save / export / close, the command
 *              palette: the typed text is committed first (nothing typed is lost, one history step),
 *              then the command runs on the committed layer. Editing has visibly ended, so later
 *              keys act on the document as usual.
 */
export type TextEditShortcut = 'text' | 'view' | 'undo' | 'deselect' | 'commit';

export function shortcutDuringTextEdit(commandId: string): TextEditShortcut {
  if (commandId.startsWith('type.')) return 'text';
  if (commandId.startsWith('view.') && commandId !== 'view.fullscreen') return 'view';
  if (commandId === 'edit.stepBackward') return 'undo';
  if (commandId === 'select.deselect') return 'deselect';
  return 'commit';
}
