/**
 * What a command shortcut does while text is being edited on the canvas (Photoshop-like). Keys the
 * textarea edits natively (Ctrl+A/C/V/X/Z/Y, arrows, Delete…) never get here.
 *
 * - 'text'     Type menu commands (size up / down…) apply to the edited text; editing continues.
 * - 'view'     Zoom in / out, fit, 100 %, rulers, guides, grid, extras, snap: editing continues, as
 *              with Ctrl+wheel and the scroll / hand pan (you zoom to check the text you type).
 * - 'undo'     Step Backward (Alt+Ctrl+Z) undoes typing, like Ctrl+Z; editing continues.
 * - 'deselect' Ctrl+D drops the text selection (Ctrl+A selected all text); editing continues.
 * - 'ignore'   Image adjustments (Ctrl+I Invert, Ctrl+U Hue/Saturation, Shift+Ctrl+L Auto Tone…),
 *              Image menu commands, filters and pixel-selection commands: Photoshop disables them
 *              while type is being edited. Nothing runs, editing continues (a hint says to commit
 *              first) — a key pressed by habit must not end editing and change the text layer, after
 *              which the next Backspace would delete the layer instead of a character.
 * - 'commit'   Layer structure (new / duplicate / group / merge / arrange / clip), Free Transform,
 *              save / export / close, the command palette: the typed text is committed first (nothing
 *              typed is lost, one history step), then the command runs on the committed layer.
 *              Editing has visibly ended, so later keys act on the document as usual.
 *
 * Text style keys (TEXT_STYLE_KEYS) are matched before any of this.
 */
export type TextEditShortcut = 'text' | 'view' | 'undo' | 'deselect' | 'ignore' | 'commit';

/** Command families that stay disabled while text is edited ('ignore'). */
const IGNORED_PREFIXES = ['adjustments.', 'image.', 'filter.', 'select.'];

export function shortcutDuringTextEdit(commandId: string): TextEditShortcut {
  if (commandId.startsWith('type.')) return 'text';
  if (commandId.startsWith('view.') && commandId !== 'view.fullscreen') return 'view';
  if (commandId === 'edit.stepBackward') return 'undo';
  if (commandId === 'select.deselect') return 'deselect';
  if (IGNORED_PREFIXES.some((p) => commandId.startsWith(p))) return 'ignore';
  return 'commit';
}

export interface TextStyleKey {
  /** Shortcuts (ui/shortcuts.ts syntax). */
  keys: string[];
  /** Type command they run on the edited text; null = swallowed (no such style here). */
  command: string | null;
  label: string;
}

/**
 * Style keys while editing text. They win over the document commands bound to the same keys
 * (Color Balance, Invert, Hue/Saturation, Auto Color, Inverse, Desaturate): Photoshop's type
 * shortcuts Shift+Ctrl+B / I / K (faux bold / italic / all caps) plus the word-processor habit
 * Ctrl+B / Ctrl+I. Underline (Ctrl+U / Shift+Ctrl+U) doesn't exist here, so those keys do nothing.
 */
export const TEXT_STYLE_KEYS: readonly TextStyleKey[] = [
  { keys: ['Ctrl+B', 'Shift+Ctrl+B'], command: 'type.fauxBold', label: 'Faux Bold' },
  { keys: ['Ctrl+I', 'Shift+Ctrl+I'], command: 'type.fauxItalic', label: 'Faux Italic' },
  { keys: ['Shift+Ctrl+K'], command: 'type.uppercase', label: 'All Caps' },
  { keys: ['Ctrl+U', 'Shift+Ctrl+U'], command: null, label: 'Underline (not available)' },
];

/** The text style key matching a keydown (`match` = ui/shortcuts matchShortcut), if any. */
export function textStyleKeyFor<E>(e: E, match: (e: E, shortcut: string) => boolean): TextStyleKey | null {
  return TEXT_STYLE_KEYS.find((k) => k.keys.some((s) => match(e, s))) ?? null;
}
