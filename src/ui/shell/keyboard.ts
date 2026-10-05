/**
 * Global keyboard handling:
 *  1. skip when typing in a text field (or a modal dialog / menu owns the keyboard);
 *  2. active tool's onKeyDown;
 *  3. commands registry shortcuts (matchShortcut, preventDefault);
 *  4. number keys → layer opacity (Shift: fill); tool single-key shortcuts (Shift+key cycles
 *     tools sharing the key);
 *  5. hold Space → temporary Hand tool; hold Alt with a paint tool → temporary Eyedropper;
 *     a lone Alt press focuses the menu bar; Alt+mnemonic opens a menu.
 * Also blocks browser defaults (Ctrl+S/O/N/P/W, page zoom, …) and Ctrl+wheel page zoom.
 */
import { commands, tools, type CommandDef } from '../../registry';
import { useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { eventKey, isTypingTarget, matchShortcut, parseShortcut } from '../shortcuts';
import { isMac } from '../../platform';
import { shortcutAlternatives } from './menuModel';
import { runCommandSafely, openMenuByMnemonic } from './MenuBar';
import { menuBarActive, useShell } from './shellStore';
import { ALT_EYEDROPPER_TOOLS, resolveToolShortcut } from './toolModel';
import { useToolMemory } from './toolMemory';
import { applyOpacityDigit, digitOf } from './opacityKeys';

/* ---------------- shortcut index ---------------- */

let index: Map<string, { cmd: CommandDef; shortcut: string }[]> | null = null;
commands.subscribe(() => {
  index = null;
});

function shortcutIndex() {
  if (index) return index;
  index = new Map();
  for (const c of commands.list()) {
    for (const s of shortcutAlternatives(c.shortcut)) {
      const key = parseShortcut(s).key;
      if (!key) continue;
      const list = index.get(key);
      const entry = { cmd: c, shortcut: s };
      if (list) list.push(entry);
      else index.set(key, [entry]);
    }
  }
  return index;
}

/** Find the command bound to this key event (first enabled match). */
export function commandForEvent(e: KeyboardEvent): CommandDef | null {
  const list = shortcutIndex().get(eventKey(e));
  if (!list) return null;
  let fallback: CommandDef | null = null;
  for (const { cmd, shortcut } of list) {
    if (!matchShortcut(e, shortcut)) continue;
    let enabled = true;
    try {
      enabled = cmd.enabled ? cmd.enabled() : true;
    } catch {
      enabled = true;
    }
    if (enabled) return cmd;
    fallback ??= cmd;
  }
  return fallback;
}

/** Ctrl+<key> combos whose browser default must never run (save page, print, close tab…). */
const BLOCK_CTRL = new Set(['s', 'o', 'n', 'p', 'w', 't', 'r', 'g', 'h', 'j', 'd', 'e', 'f', 'k', 'l', 'u', 'b', 'i', 'm', 'q', '=', '-', '0', '+', '[', ']', ';', "'", ',', '.', '/', '\\']);

function isDialogOpen() {
  return useUI.getState().dialogs.length > 0 || useUI.getState().commandPaletteOpen;
}

/* ---------------- temporary tools ---------------- */

type TempKind = 'space' | 'alt' | null;
let temp: TempKind = null;
let tempTool: string | null = null;

function startTemp(kind: Exclude<TempKind, null>, toolId: string) {
  if (temp || !tools.get(toolId)) return false;
  const ed = useEditor.getState();
  if (ed.activeTool === toolId) return false;
  ed.setTool(toolId, true);
  temp = kind;
  tempTool = toolId;
  return true;
}

function endTemp(kind?: Exclude<TempKind, null>) {
  if (!temp || (kind && temp !== kind)) return;
  const ed = useEditor.getState();
  if (ed.activeTool === tempTool) ed.restoreTool();
  temp = null;
  tempTool = null;
}

/* ---------------- focus classification ---------------- */

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'number', 'email', 'password', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week']);
/** Keys a focused non-text control (checkbox, slider, radio…) uses itself. */
const CONTROL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter']);

/**
 * 'text' — keyboard input belongs to a text field (no global shortcuts at all);
 * 'control' — a checkbox/slider/radio/select has focus: only the keys it uses (arrows, Home/End,
 *  PageUp/PageDown, Space, Enter) are left to it, so tool letters, Delete and Ctrl+Z keep working
 *  after picking a blend mode or clicking an options-bar checkbox. A handled shortcut calls
 *  preventDefault, which also stops a focused select's type-to-search from changing its value;
 * null — nothing special.
 */
export function focusKind(t: EventTarget | null): 'text' | 'control' | null {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return null;
  if (el.tagName === 'SELECT') return 'control';
  if (el.tagName === 'INPUT') {
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    return TEXT_INPUT_TYPES.has(type) ? 'text' : 'control';
  }
  return isTypingTarget(el) ? 'text' : null;
}

function keyBelongsToFocus(e: KeyboardEvent): boolean {
  const kinds = [focusKind(e.target), focusKind(document.activeElement)];
  if (kinds.includes('text')) return true;
  return kinds.includes('control') && CONTROL_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/* ---------------- handler ---------------- */

let altAlone = false;

export function handleKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  if (menuBarActive()) return; // menu bar / dropdown own the keyboard
  if (e.key !== 'Alt') altAlone = false;

  const typing = keyBelongsToFocus(e);
  const modal = isDialogOpen();
  const ctrl = isMac ? e.metaKey : e.ctrlKey;

  if (typing || modal) {
    // Still keep the browser from closing/printing/reloading the window.
    if (ctrl && !typing && BLOCK_CTRL.has(eventKey(e))) e.preventDefault();
    return;
  }

  // 1. Active tool.
  const ed = useEditor.getState();
  const tool = tools.get(ed.activeTool);
  if (tool?.onKeyDown) {
    try {
      if (tool.onKeyDown(e)) {
        e.preventDefault();
        return;
      }
    } catch (err) {
      console.error('[shell] tool onKeyDown failed', err);
    }
  }

  // Temporary tools.
  if (e.code === 'Space' && !ctrl && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (!e.repeat) startTemp('space', 'hand');
    return;
  }
  if (e.key === 'Alt') {
    if (!e.repeat) {
      if (ALT_EYEDROPPER_TOOLS.has(ed.activeTool) && startTemp('alt', 'eyedropper')) altAlone = false;
      else altAlone = true;
    }
    e.preventDefault();
    return;
  }

  // 2. Command shortcuts.
  const cmd = commandForEvent(e);
  if (cmd) {
    e.preventDefault();
    runCommandSafely(cmd, false);
    return;
  }

  // Alt+letter → open menu by mnemonic.
  if (e.altKey && !ctrl && !e.shiftKey && /^[a-z]$/.test(eventKey(e))) {
    if (openMenuByMnemonic(eventKey(e))) {
      e.preventDefault();
      return;
    }
  }

  if (ctrl) {
    if (BLOCK_CTRL.has(eventKey(e))) e.preventDefault();
    return;
  }
  if (e.altKey || e.metaKey) return;

  // Number keys → opacity (Shift: fill) of the selected layers, as in Photoshop. Paint tools took
  // their digits (brush opacity) in step 1 already.
  const digit = digitOf(e);
  if (digit !== null) {
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    if (applyOpacityDigit(digit, e.shiftKey)) {
      e.preventDefault();
      return;
    }
  }

  // 3. Tool single-key shortcuts.
  const k = eventKey(e);
  if (k.length === 1 && /[a-z]/.test(k)) {
    const id = resolveToolShortcut(k, e.shiftKey, tools.list(), ed.activeTool, useToolMemory.getState().lastUsed);
    if (id && e.repeat) {
      // Holding the key (e.g. Shift+U) must not spin through the group every ~30ms.
      e.preventDefault();
      return;
    }
    if (id) {
      e.preventDefault();
      if (temp) {
        // Switching tools while a temporary tool is held: drop the temp state.
        temp = null;
        tempTool = null;
      }
      ed.setTool(id);
      return;
    }
  }
  if (e.key === 'F1' || e.key === 'F5' || e.key === 'F3' || e.key === 'F7') e.preventDefault();
}

export function handleKeyUp(e: KeyboardEvent) {
  const typing = isTypingTarget(e.target);
  if (e.code === 'Space') {
    if (temp === 'space') {
      e.preventDefault();
      endTemp('space');
      return;
    }
  }
  if (e.key === 'Alt') {
    if (temp === 'alt') {
      e.preventDefault();
      endTemp('alt');
      altAlone = false;
      return;
    }
    if (altAlone && !typing && !isDialogOpen()) {
      e.preventDefault();
      altAlone = false;
      const sh = useShell.getState();
      if (sh.menuOpen === null) sh.setMenuFocus(sh.menuFocus === null ? 0 : null);
      return;
    }
    altAlone = false;
  }
  if (typing) return;
  const tool = tools.get(useEditor.getState().activeTool);
  if (tool?.onKeyUp) {
    try {
      if (tool.onKeyUp(e)) e.preventDefault();
    } catch (err) {
      console.error('[shell] tool onKeyUp failed', err);
    }
  }
}

function onBlur() {
  // Alt+Tab etc.: never leave a temporary tool stuck.
  endTemp();
  altAlone = false;
}

function onPointerDown() {
  altAlone = false;
}

function onWheel(e: WheelEvent) {
  // Block Chromium page zoom; the viewport handles Ctrl+wheel itself.
  if (e.ctrlKey) e.preventDefault();
  // Alt+wheel zooms the canvas: releasing Alt afterwards must not focus the menu bar.
  if (e.altKey) altAlone = false;
}

function onContextMenu(e: MouseEvent) {
  if (!isTypingTarget(e.target)) e.preventDefault();
}

/** Install global listeners; returns an uninstaller. */
export function installKeyboard(): () => void {
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('contextmenu', onContextMenu);
  return () => {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('contextmenu', onContextMenu);
  };
}
