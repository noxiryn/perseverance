import { describe, expect, it } from 'vitest';
import { shortcutDuringTextEdit } from './editKeys';

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
      'select.inverse',
      'select.allLayers',
      'adjustments.apply.levels',
      'file.save',
      'file.export',
      'file.close',
      'window.commandPalette',
      'view.fullscreen',
    ]) {
      expect(shortcutDuringTextEdit(id)).toBe('commit');
    }
  });
});
