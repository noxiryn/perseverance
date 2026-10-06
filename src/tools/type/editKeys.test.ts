import { describe, expect, it } from 'vitest';
import { TEXT_STYLE_KEYS, shortcutDuringTextEdit, textStyleKeyFor } from './editKeys';
import { matchShortcut } from '../../ui/shortcuts';

describe('shortcuts while editing text on the canvas', () => {
  it('keeps editing for zoom / fit / 100% and the other view toggles', () => {
    for (const id of ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', 'view.rulers', 'view.guides', 'view.grid', 'view.extras', 'view.snap']) {
      expect(shortcutDuringTextEdit(id)).toBe('view');
    }
  });

  it('applies Type commands to the edited text', () => {
    expect(shortcutDuringTextEdit('type.sizeUp')).toBe('text');
    expect(shortcutDuringTextEdit('type.sizeDown')).toBe('text');
  });

  it('maps Step Backward to text undo and Deselect to dropping the text selection', () => {
    expect(shortcutDuringTextEdit('edit.stepBackward')).toBe('undo');
    expect(shortcutDuringTextEdit('select.deselect')).toBe('deselect');
  });

  it('commits the typed text first for layer-structure, transform, file and other commands', () => {
    for (const id of [
      'layer.duplicate',
      'layer.group',
      'layer.new',
      'layer.mergeDown',
      'layer.sendBackward',
      'layer.clip',
      'edit.freeTransform',
      'edit.transformAgain',
      'file.save',
      'file.export',
      'file.close',
      'window.commandPalette',
      'view.fullscreen',
    ]) {
      expect(shortcutDuringTextEdit(id)).toBe('commit');
    }
  });

  it('ignores image adjustments, Image menu commands, filters and selections (Photoshop disables them while typing)', () => {
    for (const id of [
      'adjustments.apply.invert',
      'adjustments.apply.hue-saturation',
      'adjustments.apply.color-balance',
      'adjustments.apply.levels',
      'adjustments.desaturate',
      'image.autoColor',
      'image.autoTone',
      'image.imageSize',
      'filter.last',
      'select.inverse',
      'select.reselect',
      'select.allLayers',
    ]) {
      expect(shortcutDuringTextEdit(id), id).toBe('ignore');
    }
  });
});

/** A keydown as the textarea sees it (Ctrl on Windows / Linux). */
const key = (code: string, mods: { shift?: boolean; alt?: boolean } = {}) =>
  ({ code: `Key${code.toUpperCase()}`, key: code, ctrlKey: true, metaKey: false, shiftKey: !!mods.shift, altKey: !!mods.alt }) as KeyboardEvent;

describe('text style keys while editing', () => {
  const styleFor = (e: KeyboardEvent) => textStyleKeyFor(e, matchShortcut)?.command;

  it('Ctrl+B / Ctrl+I and Photoshop\'s Shift+Ctrl+B / I / K style the text instead of running Color Balance, Invert, Auto Color…', () => {
    expect(styleFor(key('b'))).toBe('type.fauxBold');
    expect(styleFor(key('b', { shift: true }))).toBe('type.fauxBold');
    expect(styleFor(key('i'))).toBe('type.fauxItalic');
    expect(styleFor(key('i', { shift: true }))).toBe('type.fauxItalic');
    expect(styleFor(key('k', { shift: true }))).toBe('type.uppercase');
  });

  it('swallows Ctrl+U / Shift+Ctrl+U (no underline) and leaves other keys to the command table', () => {
    const u = textStyleKeyFor(key('u'), matchShortcut);
    expect(u).not.toBeNull();
    expect(u!.command).toBeNull();
    expect(textStyleKeyFor(key('u', { shift: true }), matchShortcut)?.command).toBeNull();
    // Alt+Shift+Ctrl+B (Black & White) is not a style key: it is an ignored adjustment.
    expect(textStyleKeyFor(key('b', { shift: true, alt: true }), matchShortcut)).toBeNull();
    expect(textStyleKeyFor(key('j'), matchShortcut)).toBeNull();
    expect(textStyleKeyFor(key('k'), matchShortcut)).toBeNull(); // Ctrl+K: command palette
  });

  it('every style key names a Type command (or nothing)', () => {
    for (const k of TEXT_STYLE_KEYS) {
      if (k.command) expect(k.command.startsWith('type.')).toBe(true);
      expect(k.keys.length).toBeGreaterThan(0);
    }
  });
});
