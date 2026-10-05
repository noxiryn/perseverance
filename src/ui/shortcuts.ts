/** Keyboard shortcut helpers. Shortcut strings look like 'Ctrl+Shift+N', 'Alt+Delete', 'F7', '['. */
import { isMac } from '../platform';

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  plus: '=',
  space: ' ',
  return: 'enter',
};

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseShortcut(s: string): ParsedShortcut {
  const parts = s.split('+').map((p) => p.trim());
  // Handle "Ctrl++" style (plus key)
  if (s.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  const res: ParsedShortcut = { ctrl: false, shift: false, alt: false, key: '' };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'mod') res.ctrl = true;
    else if (l === 'shift') res.shift = true;
    else if (l === 'alt' || l === 'option') res.alt = true;
    else res.key = KEY_ALIASES[l] ?? l;
  }
  return res;
}

/** Normalized key of a KeyboardEvent (lowercase, layout-independent for letters/digits). */
export function eventKey(e: KeyboardEvent): string {
  if (e.code?.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code?.startsWith('Digit')) return e.code.slice(5);
  if (e.code === 'BracketLeft') return '[';
  if (e.code === 'BracketRight') return ']';
  if (e.code === 'Equal') return '=';
  if (e.code === 'Minus') return '-';
  if (e.code === 'Backslash') return '\\';
  if (e.code === 'Semicolon') return ';';
  if (e.code === 'Quote') return "'";
  if (e.code === 'Comma') return ',';
  if (e.code === 'Period') return '.';
  if (e.code === 'Slash') return '/';
  if (e.code === 'Backquote') return '`';
  return e.key.toLowerCase();
}

export function matchShortcut(e: KeyboardEvent, s: string): boolean {
  const p = parseShortcut(s);
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  return ctrl === p.ctrl && e.shiftKey === p.shift && e.altKey === p.alt && eventKey(e) === p.key;
}

/** Human-friendly label: 'Ctrl+Shift+N' → '⌘⇧N' on mac, 'Ctrl+Shift+N' elsewhere. */
export function formatShortcut(s: string): string {
  if (!isMac) return s.replace(/\bMod\b|\bCmd\b/g, 'Ctrl');
  const p = parseShortcut(s);
  return `${p.ctrl ? '⌘' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.key.length === 1 ? p.key.toUpperCase() : p.key[0].toUpperCase() + p.key.slice(1)}`;
}

/** Input types that don't take text: global single-key shortcuts must keep working on them. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image']);

/** True when keyboard focus is in a text field (global shortcuts should be ignored). */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase());
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
