import { beforeEach, describe, expect, it } from 'vitest';
import type { CommandDef, ToolDef } from '../../registry';
import { fuzzyMatch, wordsMatch } from './fuzzy';
import { bareLabel, filterNamesCoveredByCommands, rankItems, type RankableItem } from './paletteRank';
import { buildMenuTree, menuPathLabel, shortcutAlternatives, type MenuTreeNode } from './menuModel';
import { buildToolSlots, nextInSlot, resolveToolShortcut, sectionOf } from './toolModel';
import {
  clientToViewport,
  docByteSizes,
  dropMode,
  formatBytes,
  formatZoom,
  isSupportedDrop,
  parseZoom,
  tabLabel,
  windowTitle,
  zoomToApply,
} from './docInfo';
import { completedMessage, decideHistoryToast, type HistorySnapshot, type ToastDecisionState } from './historyToasts';
import { cloneLayout, isPanelVisible, movePanel, removePanel, revealPanel, sanitizeLayout, WORKSPACE_PRESETS } from './workspaces';
import { useShell } from './shellStore';
import { submitTarget } from './dialogs/ChoiceDialog';
import { applyUiScale, clampScale, cssZoom, nativeZoomSetter, shellPortalHost, toCss } from './uiScale';
import { _resetPrefsCache, defaultBackgroundColor, getPref, PREFS_KEY, resetPrefs, setPref } from './prefs';
import { shortcutKeys } from './Keys';
import { fitScale } from './ViewportHost';
import { DEFAULT_WORKSPACE, useUI } from '../../state/ui';

const noop = () => {};
const Icon = () => null;

/* ------------------------------------------------------------------ */

describe('fuzzyMatch', () => {
  it('matches contiguous substrings at word starts best', () => {
    const a = fuzzyMatch('lev', 'Levels…')!;
    const b = fuzzyMatch('lev', 'Brightness Level')!;
    expect(a.indices).toEqual([0, 1, 2]);
    expect(b).not.toBeNull();
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('matches word-start abbreviations', () => {
    const r = fuzzyMatch('ns', 'New Smart Object');
    expect(r).not.toBeNull();
    expect(r!.indices).toEqual([0, 4]);
  });

  it('supports multiple terms in any order', () => {
    expect(fuzzyMatch('blur gaus', 'Gaussian Blur…')).not.toBeNull();
    expect(fuzzyMatch('blur xyz', 'Gaussian Blur…')).toBeNull();
  });

  it('rejects scattered noise matches', () => {
    expect(fuzzyMatch('lev', 'Save As…')).toBeNull();
    expect(fuzzyMatch('zzz', 'Zoom In')).toBeNull();
  });

  it('empty query matches everything with score 0', () => {
    expect(fuzzyMatch('  ', 'Anything')).toEqual({ score: 0, indices: [] });
  });
});

describe('wordsMatch', () => {
  it('requires every term verbatim', () => {
    expect(wordsMatch('save', 'file.save File')).not.toBeNull();
    expect(wordsMatch('lev', 'file.save tpl-versus')).toBeNull();
  });
  it('prefers word-start occurrences', () => {
    expect(wordsMatch('ram', 'frame')!).toBeLessThan(wordsMatch('ram', 'ram frame')!);
  });
});

describe('rankItems', () => {
  const items: RankableItem[] = [
    { key: 'c1', kind: 'command', title: 'Levels…', subtitle: 'Image › Adjustments', keywords: 'image.levels' },
    { key: 'c2', kind: 'command', title: 'Save', subtitle: 'File', keywords: 'file.save' },
    { key: 't1', kind: 'tool', title: 'Brush', keywords: 'brush paint' },
    { key: 'f1', kind: 'filter', title: 'Gaussian Blur…', subtitle: 'Filter › Blur', keywords: 'soften' },
  ];
  const opts = { kindOrder: ['command', 'tool', 'filter'] };

  it('filters out non-matching items and groups by kind', () => {
    const g = rankItems(items, 'lev', opts);
    expect(g).toHaveLength(1);
    expect(g[0].kind).toBe('command');
    expect(g[0].items.map((i) => i.item.key)).toEqual(['c1']);
  });

  it('matches keywords as a fallback', () => {
    const g = rankItems(items, 'soften', opts);
    expect(g.map((x) => x.kind)).toEqual(['filter']);
  });

  it('orders groups by kind order for an empty query and caps items', () => {
    const g = rankItems(items, '', { ...opts, caps: { command: 1 } });
    expect(g.map((x) => x.kind)).toEqual(['command', 'tool', 'filter']);
    expect(g[0].items).toHaveLength(1);
  });

  it('onlyKind restricts results', () => {
    const g = rankItems(items, 'b', { ...opts, onlyKind: 'tool' });
    expect(g.map((x) => x.kind)).toEqual(['tool']);
  });

  it('penalizes disabled items', () => {
    const list: RankableItem[] = [
      { key: 'a', kind: 'command', title: 'Paste', disabled: true },
      { key: 'b', kind: 'command', title: 'Paste In Place' },
    ];
    const g = rankItems(list, 'paste', opts);
    expect(g[0].items[0].item.key).toBe('b');
  });

  it('hides duplicate filter items in the All scope but keeps them under their chip', () => {
    const list: RankableItem[] = [
      { key: 'command:filter.apply.gaussian', kind: 'command', title: 'Gaussian Blur…', subtitle: 'Filter › Blur' },
      { key: 'filter:gaussian', kind: 'filter', title: 'Gaussian Blur…', subtitle: 'Filter › Blur', onlyInKind: true },
      { key: 'filter:hidden-gem', kind: 'filter', title: 'Gaussian Glow…', subtitle: 'Filter › Glow' },
    ];
    const all = rankItems(list, 'gauss', { kindOrder: ['command', 'filter'] }).flatMap((g) => g.items.map((i) => i.item.key));
    expect(all).toEqual(['command:filter.apply.gaussian', 'filter:hidden-gem']);
    const only = rankItems(list, 'gauss', { kindOrder: ['command', 'filter'], onlyKind: 'filter' }).flatMap((g) => g.items.map((i) => i.item.key));
    expect(only.sort()).toEqual(['filter:gaussian', 'filter:hidden-gem']);
  });

  it('finds filters already exposed by Filter / Image ▸ Adjustments commands', () => {
    const covered = filterNamesCoveredByCommands([
      { label: 'Gaussian Blur…', menu: 'Filter/Blur' },
      { label: 'Levels...', menu: 'Image/Adjustments' },
      { label: 'Invert', menu: 'Image/Adjustments' },
      { label: 'Curves', menu: 'Layer/New Adjustment Layer' },
      { label: 'Filter Gallery…', menu: 'Filter' },
      { label: 'Duotone', menu: undefined },
    ]);
    expect([...covered].sort()).toEqual(['filter gallery', 'gaussian blur', 'invert', 'levels']);
    expect(covered.has(bareLabel('Curves'))).toBe(false);
    expect(bareLabel('Gaussian Blur…')).toBe('gaussian blur');
  });
});

/* ------------------------------------------------------------------ */

function cmd(id: string, menu: string | undefined, group?: string, order?: number, extra: Partial<CommandDef> = {}): CommandDef {
  return { id, label: id, menu, group, order, run: noop, ...extra };
}

function labels(nodes: MenuTreeNode[]): string[] {
  return nodes.map((n) => (n.kind === 'separator' ? '---' : n.kind === 'command' ? n.command.id : `[${n.label}]`));
}

describe('buildMenuTree', () => {
  const tree = buildMenuTree([
    cmd('file.save', 'File', '20-save', 0),
    cmd('file.new', 'File', '10-new', 0),
    cmd('file.open', 'File', '10-new', 2),
    cmd('file.recent.a', 'File/Open Recent', '10-new', 3),
    cmd('file.exit', 'File', '90-close', 2),
    cmd('image.levels', 'Image/Adjustments', '10-adjustments', 1),
    cmd('image.curves', 'Image/Adjustments', '10-adjustments', 2),
    cmd('image.size', 'Image', '30-size', 0),
    cmd('palette.only', undefined),
    cmd('plugin.x', 'Plugins', '10', 0),
  ]);

  it('always lists the standard menus in order, then extra menus', () => {
    expect(tree.map((m) => m.name)).toEqual(['File', 'Edit', 'Image', 'Layer', 'Type', 'Select', 'Filter', 'Roblox', 'View', 'Window', 'Help', 'Plugins']);
  });

  it('sorts by group then order with separators between groups', () => {
    const file = tree.find((m) => m.name === 'File')!;
    expect(labels(file.items)).toEqual(['file.new', 'file.open', '[Open Recent]', '---', 'file.save', '---', 'file.exit']);
  });

  it('positions submenus at their first descendant', () => {
    const image = tree.find((m) => m.name === 'Image')!;
    expect(labels(image.items)).toEqual(['[Adjustments]', '---', 'image.size']);
    const sub = image.items[0];
    expect(sub.kind === 'submenu' && labels(sub.children)).toEqual(['image.levels', 'image.curves']);
  });

  it('ignores commands without a menu', () => {
    const all = JSON.stringify(tree.map((m) => labels(m.items)));
    expect(all).not.toContain('palette.only');
  });
});

describe('menu helpers', () => {
  it('splits alternative shortcuts', () => {
    expect(shortcutAlternatives('Shift+Ctrl+Z / Ctrl+Y')).toEqual(['Shift+Ctrl+Z', 'Ctrl+Y']);
    expect(shortcutAlternatives('Ctrl+K')).toEqual(['Ctrl+K']);
    expect(shortcutAlternatives(undefined)).toEqual([]);
  });
  it('formats menu paths', () => {
    expect(menuPathLabel(cmd('a', 'Image/Adjustments'))).toBe('Image › Adjustments');
    expect(menuPathLabel(cmd('a', undefined))).toBe('');
  });
});

/* ------------------------------------------------------------------ */

function tool(id: string, group: string, order: number, shortcut?: string): ToolDef {
  return { id, name: id, group, order, shortcut, icon: Icon };
}

describe('tool slots & shortcuts', () => {
  const list = [
    tool('move', 'move', 10, 'V'),
    tool('marquee-ellipse', 'marquee', 21, 'M'),
    tool('marquee-rect', 'marquee', 20, 'M'),
    tool('brush', 'brush', 70, 'B'),
    tool('pencil', 'brush', 71, 'B'),
    tool('type', 'type', 130, 'T'),
    tool('hand', 'hand', 150, 'H'),
  ];

  it('groups tools into ordered slots with sections', () => {
    const slots = buildToolSlots(list, {}, 'move');
    expect(slots.map((s) => s.group)).toEqual(['move', 'marquee', 'brush', 'type', 'hand']);
    expect(slots[1].tools.map((t) => t.id)).toEqual(['marquee-rect', 'marquee-ellipse']);
    expect(slots.map((s) => s.section)).toEqual([0, 0, 1, 2, 3]);
  });

  it('shows the active tool, else the last used, else the first', () => {
    expect(buildToolSlots(list, {}, 'pencil').find((s) => s.group === 'brush')!.current.id).toBe('pencil');
    expect(buildToolSlots(list, { brush: 'pencil' }, 'move').find((s) => s.group === 'brush')!.current.id).toBe('pencil');
    expect(buildToolSlots(list, {}, 'move').find((s) => s.group === 'brush')!.current.id).toBe('brush');
  });

  it('cycles in a slot', () => {
    const slot = buildToolSlots(list, {}, 'marquee-ellipse').find((s) => s.group === 'marquee')!;
    expect(nextInSlot(slot).id).toBe('marquee-rect');
  });

  it('resolves single-key shortcuts (Shift cycles)', () => {
    expect(resolveToolShortcut('b', false, list, 'move', {})).toBe('brush');
    expect(resolveToolShortcut('b', false, list, 'move', { brush: 'pencil' })).toBe('pencil');
    expect(resolveToolShortcut('b', false, list, 'brush', {})).toBe('brush');
    expect(resolveToolShortcut('B', true, list, 'brush', {})).toBe('pencil');
    expect(resolveToolShortcut('b', true, list, 'pencil', {})).toBe('brush');
    expect(resolveToolShortcut('q', false, list, 'move', {})).toBeNull();
    expect(resolveToolShortcut('Enter', false, list, 'move', {})).toBeNull();
  });

  it('assigns toolbar sections by order', () => {
    expect([10, 60, 61, 120, 130, 140, 150].map(sectionOf)).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
});

/* ------------------------------------------------------------------ */

describe('doc info', () => {
  it('computes flattened and layered sizes', () => {
    const doc = {
      width: 100,
      height: 50,
      layers: {
        a: { type: 'raster', width: 100, height: 50, mask: null },
        b: { type: 'text', mask: { bitmapId: 'm' } },
      },
    } as never;
    const s = docByteSizes(doc);
    expect(s.flat).toBe(100 * 50 * 3);
    expect(s.layered).toBe(100 * 50 * 4 + 100 * 50);
  });

  it('formats bytes like Photoshop', () => {
    expect(formatBytes(1920 * 1080 * 3)).toBe('5.9M');
    expect(formatBytes(512 * 1024)).toBe('0.5M');
    expect(formatBytes(20 * 1024)).toBe('20K');
    expect(formatBytes(300 * 1024 * 1024)).toBe('300M');
  });

  it('formats and parses zoom', () => {
    expect(formatZoom(0.4612)).toBe('46.1%');
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(16)).toBe('1600%');
    expect(parseZoom('50')).toBe(0.5);
    expect(parseZoom('33.3 %')).toBeCloseTo(0.333);
    expect(parseZoom('2x')).toBe(2);
    expect(parseZoom('1:4')).toBe(0.25);
    expect(parseZoom('100000')).toBe(64);
    expect(parseZoom('abc')).toBeNull();
    expect(parseZoom('0')).toBeNull();
  });

  it('labels tabs and window titles', () => {
    expect(tabLabel('Icon', true)).toBe('Icon *');
    expect(tabLabel('Icon', false)).toBe('Icon');
    expect(windowTitle('Icon', true)).toBe('Icon * — Perseverance');
    expect(windowTitle(null, false)).toBe('Perseverance');
  });

  it('decides how dropped files open', () => {
    expect(dropMode('a.pgfx', true, false)).toBe('new');
    expect(dropMode('a.PSD', true, false)).toBe('new');
    expect(dropMode('a.png', false, false)).toBe('new');
    expect(dropMode('a.png', true, true)).toBe('new');
    expect(dropMode('a.png', true, false)).toBe('place');
    expect(isSupportedDrop('a.webp')).toBe(true);
    expect(isSupportedDrop('clip', 'image/png')).toBe(true);
    expect(isSupportedDrop('notes.txt', 'text/plain')).toBe(false);
  });

  it('only re-applies the zoom field when the value really changed', () => {
    const z = 0.6046875;
    const label = formatZoom(z); // '60.5%'
    expect(zoomToApply(label, label, z)).toBeNull(); // focus + blur without editing
    expect(zoomToApply(' 60.5% ', label, z)).toBeNull();
    expect(zoomToApply('60.5', label, z)).toBeNull(); // same as shown
    expect(zoomToApply('abc', label, z)).toBeNull();
    expect(zoomToApply('300', label, z)).toBe(3);
    expect(zoomToApply('50%', '—', 0)).toBe(0.5);
  });

  it('maps client coordinates to the element’s CSS px under a CSS zoom', () => {
    // 125% zoom: rect is visual (1171.25 wide), the element is 937 CSS px wide.
    const r = { left: 100, top: 50, width: 1171.25, height: 750 };
    const p = clientToViewport(100 + 585.625, 50 + 375, r, 937, 600);
    expect(p.x).toBeCloseTo(468.5);
    expect(p.y).toBeCloseTo(300);
    // No zoom: plain offsets; zero-sized elements fall back to 1:1.
    expect(clientToViewport(30, 40, { left: 10, top: 10, width: 200, height: 100 }, 200, 100)).toEqual({ x: 20, y: 30 });
    expect(clientToViewport(30, 40, { left: 10, top: 10, width: 0, height: 0 }, 0, 0)).toEqual({ x: 20, y: 30 });
  });

  it('fits a document without upscaling', () => {
    expect(fitScale(1920, 1080, 1056, 636)).toBeCloseTo(0.5);
    expect(fitScale(100, 100, 1000, 1000)).toBe(1);
    expect(fitScale(100, 100, 0, 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('history toasts', () => {
  const snap = (p: Partial<HistorySnapshot>): HistorySnapshot => ({ docId: 'd', entryId: 'e1', label: 'Open', index: 0, length: 1, ...p });
  const fresh = (): ToastDecisionState => ({ seen: new Set(['e1']), lastToastAt: 0, lastLabel: '', lastLabelAt: 0 });

  it('announces a new commit', () => {
    const st = fresh();
    expect(decideHistoryToast(snap({}), snap({ entryId: 'e2', label: 'Delete Layer', index: 1, length: 2 }), st, 10_000)).toBe('Delete Layer');
  });

  it('ignores coalesced updates, undo/redo and document switches', () => {
    const st = fresh();
    const a = snap({ entryId: 'e2', label: 'Opacity', index: 1, length: 2 });
    expect(decideHistoryToast(snap({}), a, st, 10_000)).toBe('Opacity');
    expect(decideHistoryToast(a, a, st, 10_100)).toBeNull();
    // undo back to e1, then redo to e2 (already seen)
    expect(decideHistoryToast(a, snap({ length: 2 }), st, 11_000)).toBeNull();
    expect(decideHistoryToast(snap({ length: 2 }), a, st, 12_000)).toBeNull();
    // other document
    expect(decideHistoryToast(a, snap({ docId: 'x', entryId: 'x2', index: 1, length: 2, label: 'Fill' }), st, 13_000)).toBeNull();
  });

  it('throttles continuous painting labels', () => {
    const st = fresh();
    let prev = snap({});
    const step = (i: number, t: number) => {
      const next = snap({ entryId: `b${i}`, label: 'Brush Stroke', index: i, length: i + 1 });
      const r = decideHistoryToast(prev, next, st, t);
      prev = next;
      return r;
    };
    expect(step(1, 10_000)).toBe('Brush Stroke');
    expect(step(2, 11_000)).toBeNull();
    expect(step(3, 15_000)).toBeNull();
    expect(step(4, 17_000)).toBe('Brush Stroke');
  });

  it('formats messages', () => {
    expect(completedMessage('Delete Layer')).toBe('Delete Layer completed.');
    expect(completedMessage('Gaussian Blur…')).toBe('Gaussian Blur completed.');
  });
});

/* ------------------------------------------------------------------ */

describe('workspaces', () => {
  it('has the five presets with unique panels', () => {
    expect(WORKSPACE_PRESETS.map((w) => w.name)).toEqual(['Essentials', 'GFX Artist', 'Roblox', 'Typography', 'Painting']);
    expect(WORKSPACE_PRESETS[0]).toBe(DEFAULT_WORKSPACE);
    for (const w of WORKSPACE_PRESETS) {
      const all = [...w.groups.flatMap((g) => g.tabs), ...w.strip];
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBe(14);
    }
  });

  it('sanitizes persisted layouts', () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout({ id: 3 })).toBeNull();
    const s = sanitizeLayout({
      id: 'essentials',
      groups: [
        { slot: 'top', tabs: ['navigator', 'navigator', 5], active: 'nope', size: -1 },
        { slot: 'bottom', tabs: ['layers'], active: 'layers', size: 99, collapsed: 1 },
      ],
      strip: ['layers', 'fonts', 'fonts'],
    })!;
    expect(s.name).toBe('Essentials');
    expect(s.groups.map((g) => g.slot)).toEqual(['top', 'middle', 'bottom']);
    expect(s.groups[0]).toMatchObject({ tabs: ['navigator'], active: 'navigator', size: 1, collapsed: false });
    expect(s.groups[1].tabs).toEqual([]);
    expect(s.groups[2]).toMatchObject({ size: 10, collapsed: true });
    expect(s.strip).toEqual(['fonts']);
  });

  it('moves and removes panels', () => {
    const w = DEFAULT_WORKSPACE;
    const a = movePanel(w, 'layers', { kind: 'group', slot: 'top', index: 0 });
    expect(a.groups[0].tabs).toEqual(['layers', 'libraries', 'looks']);
    expect(a.groups[0].active).toBe('layers');
    expect(a.groups[2].tabs).toEqual(['properties', 'history']);
    expect(a.groups[2].active).toBe('properties');
    const b = movePanel(a, 'navigator', { kind: 'strip', index: 0 });
    expect(b.strip[0]).toBe('navigator');
    expect(b.groups[1].tabs).toEqual(['swatches', 'color']);
    const c = removePanel(b, 'fonts');
    expect(c.strip).not.toContain('fonts');
    // original untouched
    expect(w.groups[2].tabs).toEqual(['layers', 'properties', 'history']);
  });

  describe('panel visibility', () => {
    beforeEach(() => {
      useUI.setState({ workspace: cloneLayout(DEFAULT_WORKSPACE), flyoutPanel: null, dockVisible: true });
      useShell.setState({ dockCollapsed: false });
    });

    it('toggles a docked panel', () => {
      expect(isPanelVisible('layers')).toBe(true);
      revealPanel('layers', true);
      expect(isPanelVisible('layers')).toBe(false);
      revealPanel('layers', true);
      expect(isPanelVisible('layers')).toBe(true);
      revealPanel('properties');
      expect(isPanelVisible('properties')).toBe(true);
      expect(isPanelVisible('layers')).toBe(false);
    });

    it('uses flyouts while the dock is collapsed to the strip', () => {
      useShell.setState({ dockCollapsed: true });
      // Groups are not rendered: nothing docked counts as visible.
      expect(isPanelVisible('layers')).toBe(false);
      revealPanel('layers', true);
      expect(useUI.getState().flyoutPanel).toBe('layers');
      expect(isPanelVisible('layers')).toBe(true);
      // The hidden group was not collapsed behind the user's back.
      expect(useUI.getState().workspace.groups.find((g) => g.slot === 'bottom')!.collapsed).toBe(false);
      revealPanel('layers', true);
      expect(useUI.getState().flyoutPanel).toBeNull();
      revealPanel('looks');
      revealPanel('looks');
      expect(useUI.getState().flyoutPanel).toBe('looks');
    });

    it('brings hidden panels back instead of toggling them off', () => {
      useUI.setState({ dockVisible: false });
      expect(isPanelVisible('layers')).toBe(false);
      revealPanel('layers', true);
      expect(useUI.getState().dockVisible).toBe(true);
      expect(isPanelVisible('layers')).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */

describe('choice dialog Enter', () => {
  it('lets a focused button handle Enter itself, otherwise picks the primary', () => {
    const btn = document.createElement('button');
    expect(submitTarget(btn, 'save')).toBeUndefined();
    expect(submitTarget(document.body, 'save')).toBe('save');
    expect(submitTarget(null, 'save')).toBe('save');
    expect(submitTarget(document.body, undefined)).toBeUndefined();
  });
});

describe('ui scale', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('detects a native zoom bridge', () => {
    expect(nativeZoomSetter(null)).toBeNull();
    expect(nativeZoomSetter({})).toBeNull();
    const calls: number[] = [];
    const bridge = { setZoomFactor(f: number) { calls.push(f); } };
    nativeZoomSetter(bridge)!(1.25);
    expect(calls).toEqual([1.25]);
  });

  it('clamps stored scales', () => {
    expect(clampScale(1.25)).toBe(1.25);
    expect(clampScale(9)).toBe(2);
    expect(clampScale(0.1)).toBe(0.5);
    expect(clampScale('x')).toBe(1);
    expect(clampScale(-1)).toBe(1);
  });

  it('applies a CSS zoom fallback and converts visual px', () => {
    applyUiScale(1.25);
    expect(cssZoom()).toBe(1.25);
    expect(toCss(250)).toBe(200);
    const de = document.documentElement;
    expect(de.style.getPropertyValue('--shell-css-zoom')).toBe('1.25');
    expect(de.style.getPropertyValue('--shell-ui-scale')).toBe('1.25');
    expect(de.hasAttribute('data-shell-css-zoom')).toBe(true);
    expect(shellPortalHost().parentElement).toBe(document.body);
    applyUiScale(1);
    expect(cssZoom()).toBe(1);
    expect(toCss(250)).toBe(250);
    expect(de.hasAttribute('data-shell-css-zoom')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('prefs', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrefsCache();
  });

  it('reads defaults and persists values', () => {
    expect(getPref('autosaveMinutes', 5)).toBe(5);
    setPref('autosaveMinutes', 10);
    expect(getPref('autosaveMinutes', 5)).toBe(10);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ autosaveMinutes: 10 });
    _resetPrefsCache();
    expect(getPref('autosaveMinutes', 5)).toBe(10);
  });

  it('falls back on wrong types and corrupt storage', () => {
    localStorage.setItem(PREFS_KEY, '{"toasts":"yes"}');
    _resetPrefsCache();
    expect(getPref('toasts', true)).toBe(true);
    localStorage.setItem(PREFS_KEY, 'not json');
    _resetPrefsCache();
    expect(getPref('toasts', false)).toBe(false);
  });

  it('resolves default background colors', () => {
    expect(defaultBackgroundColor()).toBe('#ffffff');
    setPref('defaultBackground', 'transparent');
    expect(defaultBackgroundColor()).toBeNull();
    setPref('defaultBackground', '#123456');
    expect(defaultBackgroundColor()).toBe('#123456');
    setPref('defaultBackground', 'garbage');
    expect(defaultBackgroundColor()).toBe('#ffffff');
    resetPrefs();
    expect(defaultBackgroundColor()).toBe('#ffffff');
  });
});

describe('shortcut keycaps', () => {
  it('splits shortcuts into keys', () => {
    expect(shortcutKeys('Ctrl+Shift+N')).toEqual(['Ctrl', 'Shift', 'N']);
    expect(shortcutKeys('F1')).toEqual(['F1']);
    expect(shortcutKeys('Ctrl++')).toEqual(['Ctrl', '+']);
  });
});
