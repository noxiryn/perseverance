import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commands, tools, type ToolDef } from '../../registry';
import { useEditor } from '../../state/editor';
import { useUI } from '../../state/ui';
import { commandForEvent, focusKind, handleKeyDown, handleKeyUp, installKeyboard } from './keyboard';
import { useShell } from './shellStore';

const Icon = () => null;
const tool = (id: string, group: string, order: number, shortcut?: string, extra: Partial<ToolDef> = {}): ToolDef => ({
  id,
  name: id,
  group,
  order,
  shortcut,
  icon: Icon,
  ...extra,
});

let ran: string[] = [];
let toolKeys: string[] = [];

function key(k: string, init: KeyboardEventInit = {}, type: 'keydown' | 'keyup' = 'keydown') {
  const code = k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : k === ' ' ? 'Space' : k;
  const e = new KeyboardEvent(type, { key: k, code, cancelable: true, bubbles: true, ...init });
  if (type === 'keydown') handleKeyDown(e);
  else handleKeyUp(e);
  return e;
}

beforeAll(() => {
  tools.registerMany([
    tool('move', 'move', 10, 'V'),
    tool('brush', 'brush', 70, 'B'),
    tool('pencil', 'brush', 71, 'B'),
    tool('eyedropper', 'eyedropper', 60, 'I'),
    tool('hand', 'hand', 150, 'H'),
    tool('type', 'type', 130, 'T', {
      onKeyDown: (e) => {
        toolKeys.push(e.key);
        return e.key === 'Enter';
      },
    }),
  ]);
  commands.registerMany([
    { id: 't.save', label: 'Save', shortcut: 'Ctrl+S', run: () => void ran.push('save') },
    { id: 't.redo', label: 'Redo', shortcut: 'Shift+Ctrl+Z / Ctrl+Y', run: () => void ran.push('redo') },
    { id: 't.off', label: 'Off', shortcut: 'Ctrl+J', enabled: () => false, run: () => void ran.push('off') },
    { id: 't.on', label: 'On', shortcut: 'Ctrl+J', run: () => void ran.push('on') },
  ]);
});

beforeEach(() => {
  ran = [];
  toolKeys = [];
  useEditor.setState({ activeTool: 'move', previousTool: null });
  useUI.setState({ dialogs: [], commandPaletteOpen: false });
  useShell.setState({ menuOpen: null, menuFocus: null, mnemonics: false });
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('focusKind', () => {
  it('classifies focus targets', () => {
    const text = document.createElement('input');
    const num = document.createElement('input');
    num.type = 'number';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const range = document.createElement('input');
    range.type = 'range';
    expect(focusKind(text)).toBe('text');
    expect(focusKind(num)).toBe('text');
    expect(focusKind(document.createElement('textarea'))).toBe('text');
    expect(focusKind(box)).toBe('control');
    expect(focusKind(range)).toBe('control');
    expect(focusKind(document.createElement('div'))).toBeNull();
    expect(focusKind(null)).toBeNull();
  });
});

describe('command shortcuts', () => {
  it('finds commands by shortcut, including alternatives, preferring enabled ones', () => {
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true }))?.id).toBe('t.save');
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', ctrlKey: true }))?.id).toBe('t.redo');
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }))?.id).toBe('t.redo');
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true }))?.id).toBe('t.on');
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS' }))).toBeNull();
  });

  it('runs commands synchronously and prevents the browser default', () => {
    const e = key('s', { ctrlKey: true });
    expect(ran).toEqual(['save']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('blocks browser defaults for unbound Ctrl combos', () => {
    expect(key('p', { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it('ignores shortcuts while typing or while a modal is open', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    key('s', { ctrlKey: true });
    expect(ran).toEqual([]);
    input.remove();
    useUI.setState({ commandPaletteOpen: true });
    key('b');
    expect(useEditor.getState().activeTool).toBe('move');
  });
});

describe('tool shortcuts', () => {
  it('activates and cycles tools', () => {
    key('b');
    expect(useEditor.getState().activeTool).toBe('brush');
    key('B', { shiftKey: true });
    expect(useEditor.getState().activeTool).toBe('pencil');
    key('v');
    expect(useEditor.getState().activeTool).toBe('move');
  });

  it('ignores auto-repeat so holding Shift+key does not spin through the group', () => {
    key('b');
    expect(useEditor.getState().activeTool).toBe('brush');
    key('B', { shiftKey: true });
    expect(useEditor.getState().activeTool).toBe('pencil');
    for (let i = 0; i < 5; i++) {
      const e = key('B', { shiftKey: true, repeat: true });
      expect(e.defaultPrevented).toBe(true);
    }
    expect(useEditor.getState().activeTool).toBe('pencil');
  });

  it('keeps working while a checkbox has focus, but leaves Space to it', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.appendChild(box);
    box.focus();
    key('b');
    expect(useEditor.getState().activeTool).toBe('brush');
    key(' ');
    expect(useEditor.getState().activeTool).toBe('brush');
    box.remove();
  });

  it('gives the active tool the first chance', () => {
    useEditor.setState({ activeTool: 'type' });
    const e = key('Enter');
    expect(toolKeys).toEqual(['Enter']);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('temporary tools', () => {
  it('holds Space for the hand tool', () => {
    useEditor.setState({ activeTool: 'brush' });
    key(' ');
    expect(useEditor.getState().activeTool).toBe('hand');
    key(' ', { repeat: true });
    expect(useEditor.getState().activeTool).toBe('hand');
    key(' ', {}, 'keyup');
    expect(useEditor.getState().activeTool).toBe('brush');
  });

  it('holds Alt for the eyedropper with paint tools only', () => {
    useEditor.setState({ activeTool: 'brush' });
    key('Alt', { altKey: true });
    expect(useEditor.getState().activeTool).toBe('eyedropper');
    key('Alt', {}, 'keyup');
    expect(useEditor.getState().activeTool).toBe('brush');

    useEditor.setState({ activeTool: 'move' });
    key('Alt', { altKey: true });
    expect(useEditor.getState().activeTool).toBe('move');
    key('Alt', {}, 'keyup');
  });

  it('drops the temporary state when switching tools while holding Space', () => {
    useEditor.setState({ activeTool: 'pencil' });
    key(' ');
    expect(useEditor.getState().activeTool).toBe('hand');
    key('v');
    expect(useEditor.getState().activeTool).toBe('move');
    key(' ', {}, 'keyup');
    expect(useEditor.getState().activeTool).toBe('move');
  });

  it('restores the tool when the window loses focus', () => {
    useEditor.setState({ activeTool: 'brush' });
    key(' ');
    expect(useEditor.getState().activeTool).toBe('hand');
    const uninstall = installKeyboard();
    window.dispatchEvent(new Event('blur'));
    uninstall();
    expect(useEditor.getState().activeTool).toBe('brush');
  });

  it('focuses the menu bar on a lone Alt press', () => {
    key('Alt', { altKey: true });
    key('Alt', {}, 'keyup');
    expect(useShell.getState().menuFocus).toBe(0);
    // While the menu bar owns the keyboard, tool keys are not handled globally.
    key('b');
    expect(useEditor.getState().activeTool).toBe('move');
  });
});
