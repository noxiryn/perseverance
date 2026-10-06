/**
 * Pure layout helpers added for laptop-sized windows: dock presets fitted to the window height,
 * migration of saved layouts, flyout placement, tab-strip reveal, menu placement and the guide's
 * resume step.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE } from '../../state/ui';
import { placeFlyout, scrollDeltaToReveal } from './Dock';
import { menuScrollFor, placeMenu } from './MenuBar';
import { initialStep, resumeStep, stepAfterAction, TIPS_STEPS } from './dialogs/TipsDialog';
import {
  collapseForExpanded,
  fitLayoutToHeight,
  isUncustomized,
  LAYERS_MIN_BODY,
  LAYOUT_VERSION,
  layoutFits,
  LEGACY_PRESETS,
  migrateLayouts,
  parsePersisted,
  refitLayout,
  workspacePreset,
} from './workspaces';

const group = (l: ReturnType<typeof fitLayoutToHeight>, slot: string) => l.groups.find((g) => g.slot === slot)!;

/** Group heights (CSS px) as the dock's flex column lays them out: collapsed = 30px head, 5px splitters. */
function heights(l: ReturnType<typeof fitLayoutToHeight>, dock: number): Record<string, number> {
  const shown = l.groups.filter((g) => g.tabs.length);
  const open = shown.filter((g) => !g.collapsed);
  const avail = dock - (shown.length - 1) * 5 - (shown.length - open.length) * 30;
  const sum = open.reduce((a, g) => a + g.size, 0);
  return Object.fromEntries(shown.map((g) => [g.slot, g.collapsed ? 30 : (avail * g.size) / sum]));
}
const expand = (l: ReturnType<typeof fitLayoutToHeight>, slot: string) => ({ ...l, groups: l.groups.map((g) => (g.slot === slot ? { ...g, collapsed: false } : g)) });
const DOCK_1366 = 768 - 66;
const DOCK_1600 = 960 - 66;

describe('default workspace', () => {
  it('puts Libraries and Looks together in the largest group', () => {
    const top = group(DEFAULT_WORKSPACE, 'top');
    expect(top.tabs).toEqual(['libraries', 'looks']);
    const sizes = DEFAULT_WORKSPACE.groups.map((g) => g.size);
    expect(top.size).toBe(Math.max(...sizes));
    expect(group(DEFAULT_WORKSPACE, 'middle').tabs).toContain('navigator');
  });
});

describe('fitLayoutToHeight', () => {
  it('collapses the middle group on short docks (1366×768) and keeps three groups on tall ones', () => {
    const small = fitLayoutToHeight(DEFAULT_WORKSPACE, 768 - 66);
    expect(group(small, 'middle').collapsed).toBe(true);
    expect(group(small, 'top').collapsed).toBe(false);
    expect(group(small, 'bottom').collapsed).toBe(false);
    const tall = fitLayoutToHeight(DEFAULT_WORKSPACE, 960 - 66);
    expect(tall.groups.every((g) => !g.collapsed)).toBe(true);
    // Never mutates the preset.
    expect(group(DEFAULT_WORKSPACE, 'middle').collapsed).toBe(false);
  });

  it('never collapses below two expanded groups', () => {
    const tiny = fitLayoutToHeight(DEFAULT_WORKSPACE, 300);
    expect(tiny.groups.filter((g) => !g.collapsed).length).toBe(2);
  });

  it('gives Libraries at least ~520px in GFX Artist at 1600×960', () => {
    const gfx = fitLayoutToHeight(workspacePreset('gfx')!, DOCK_1600);
    expect(group(gfx, 'top').tabs[0]).toBe('libraries');
    expect(heights(gfx, DOCK_1600).top - 30).toBeGreaterThanOrEqual(520);
  });

  it('keeps about four layer rows in GFX Artist on laptop screens', () => {
    for (const dock of [DOCK_1366, DOCK_1600]) {
      const gfx = fitLayoutToHeight(workspacePreset('gfx')!, dock);
      const h = heights(gfx, dock);
      expect(h.bottom - 30).toBeGreaterThanOrEqual(LAYERS_MIN_BODY - 0.5);
      // Libraries / Looks stay the tall group.
      expect(h.top).toBeGreaterThan(h.bottom);
    }
    // At 1366×768 the old preset sizes left Layers a ~190px body (under two rows of layers).
    const raw = heights({ ...workspacePreset('gfx')! }, DOCK_1366);
    expect(raw.bottom - 30).toBeLessThan(200);
    // Never mutates the preset; total size is kept.
    const fitted = fitLayoutToHeight(workspacePreset('gfx')!, DOCK_1366);
    expect(group(workspacePreset('gfx')!, 'bottom').size).toBe(1.1);
    expect(group(fitted, 'top').size + group(fitted, 'bottom').size).toBeCloseTo(3.3, 2);
  });

  it('leaves presets that already give Layers room unchanged', () => {
    const ess = fitLayoutToHeight(DEFAULT_WORKSPACE, DOCK_1366);
    expect(ess.groups.map((g) => g.size)).toEqual(DEFAULT_WORKSPACE.groups.map((g) => g.size));
    const rbx = fitLayoutToHeight(workspacePreset('roblox')!, DOCK_1366);
    expect(rbx.groups.map((g) => g.size)).toEqual(workspacePreset('roblox')!.groups.map((g) => g.size));
  });

  it('does not squeeze the other groups below a usable height on tiny docks', () => {
    const gfx = fitLayoutToHeight(workspacePreset('gfx')!, 640 - 66);
    const h = heights(gfx, 640 - 66);
    expect(h.top - 30).toBeGreaterThanOrEqual(220 - 0.5);
    expect(h.bottom).toBeGreaterThan(heights(workspacePreset('gfx')!, 640 - 66).bottom);
  });
});

describe('collapseForExpanded (short-dock accordion)', () => {
  it('collapses another group when a third one is expanded on a short dock', () => {
    // Roblox at 1366×768 opens with Looks/Effects/Adjustments collapsed; clicking Looks expands it.
    const rbx = fitLayoutToHeight(workspacePreset('roblox')!, DOCK_1366);
    expect(group(rbx, 'middle').collapsed).toBe(true);
    const clicked = expand(rbx, 'middle');
    expect(layoutFits(clicked, DOCK_1366)).toBe(false);
    const next = collapseForExpanded(rbx, clicked, DOCK_1366)!;
    expect(next).not.toBeNull();
    expect(group(next, 'middle').collapsed).toBe(false); // the panel the user asked for
    expect(group(next, 'top').collapsed).toBe(true);
    expect(group(next, 'bottom').collapsed).toBe(false); // Layers stays
    expect(heights(next, DOCK_1366).middle - 30).toBeGreaterThanOrEqual(220);
  });

  it('collapses the middle group when the top one is expanded again', () => {
    const rbx = fitLayoutToHeight(workspacePreset('roblox')!, DOCK_1366);
    const looksOpen = collapseForExpanded(rbx, expand(rbx, 'middle'), DOCK_1366)!;
    const back = collapseForExpanded(looksOpen, expand(looksOpen, 'top'), DOCK_1366)!;
    expect(group(back, 'top').collapsed).toBe(false);
    expect(group(back, 'middle').collapsed).toBe(true);
  });

  it('does nothing when the groups fit, nothing was expanded, or the workspace changed', () => {
    const ess = fitLayoutToHeight(DEFAULT_WORKSPACE, DOCK_1600);
    const collapsed = { ...ess, groups: ess.groups.map((g) => (g.slot === 'middle' ? { ...g, collapsed: true } : g)) };
    expect(collapseForExpanded(collapsed, ess, DOCK_1600)).toBeNull(); // tall dock: three groups fit
    const small = fitLayoutToHeight(DEFAULT_WORKSPACE, DOCK_1366);
    expect(collapseForExpanded(small, { ...small }, DOCK_1366)).toBeNull();
    const gfx = fitLayoutToHeight(workspacePreset('gfx')!, DOCK_1366);
    expect(collapseForExpanded(gfx, expand(small, 'middle'), DOCK_1366)).toBeNull();
  });

  it('treats a panel dropped into an empty group as opening it', () => {
    const ess = fitLayoutToHeight(DEFAULT_WORKSPACE, DOCK_1366);
    const empty = { ...ess, groups: ess.groups.map((g) => (g.slot === 'middle' ? { ...g, tabs: [], collapsed: false } : g)) };
    const dropped = { ...ess, groups: ess.groups.map((g) => (g.slot === 'middle' ? { ...g, tabs: ['color'], active: 'color', collapsed: false } : g)) };
    const next = collapseForExpanded(empty, dropped, DOCK_1366)!;
    expect(group(next, 'middle').collapsed).toBe(false);
    expect(group(next, 'top').collapsed).toBe(true);
  });
});

describe('saved layout migration', () => {
  const legacyEssentials = LEGACY_PRESETS[1].find((p) => p.id === 'essentials')!;

  it('drops untouched copies of a changed preset and keeps customized ones', () => {
    const untouched = { ...legacyEssentials, groups: legacyEssentials.groups.map((g) => ({ ...g, active: g.tabs[g.tabs.length - 1], collapsed: true })) };
    expect(isUncustomized(untouched, legacyEssentials)).toBe(true);
    const resized = { ...legacyEssentials, groups: legacyEssentials.groups.map((g, i) => (i === 0 ? { ...g, size: 1.7 } : g)) };
    expect(isUncustomized(resized, legacyEssentials)).toBe(false);
    const out = migrateLayouts({ essentials: untouched, gfx: resized as typeof untouched }, 1);
    expect(out.essentials).toBeUndefined();
    expect(out.gfx).toBeDefined();
  });

  it('drops untouched v2 layouts so they are fitted again, also when they were fitted to the window', () => {
    const v2gfx = LEGACY_PRESETS[2].find((p) => p.id === 'gfx')!;
    expect(migrateLayouts({ gfx: v2gfx }, 2).gfx).toBeUndefined();
    // A copy fitted to this window (sizes adjusted) still counts as untouched when the height is known.
    const fitted = fitLayoutToHeight(v2gfx, DOCK_1366);
    expect(isUncustomized(fitted, v2gfx)).toBe(false);
    expect(migrateLayouts({ gfx: fitted }, 2, DOCK_1366).gfx).toBeUndefined();
    // A real customization (tab moved) is kept.
    const moved = { ...v2gfx, groups: v2gfx.groups.map((g) => (g.slot === 'bottom' ? { ...g, tabs: ['layers', 'history'] } : g)) };
    expect(migrateLayouts({ gfx: moved }, 2, DOCK_1366).gfx).toBeDefined();
    // Every current preset id has a v2 record.
    expect(LEGACY_PRESETS[LAYOUT_VERSION - 1].map((p) => p.id).sort()).toEqual(['essentials', 'gfx', 'painting', 'roblox', 'typography']);
  });

  it('parses, sanitizes and migrates the stored state', () => {
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted('{oops')).toBeNull();
    const customized = { ...legacyEssentials, groups: legacyEssentials.groups.map((g, i) => (i === 2 ? { ...g, tabs: ['layers', 'history'] } : g)) };
    const typo = workspacePreset('typography')!;
    const typoCustom = { ...typo, groups: typo.groups.map((g, i) => (i === 0 ? { ...g, size: 2 } : g)) };
    const v1 = JSON.stringify({ activeId: 'essentials', layouts: { essentials: legacyEssentials, typography: typo, painting: { ...workspacePreset('painting')!, strip: ['libraries'] } }, dockWidth: 300 });
    const p = parsePersisted(v1)!;
    expect(p.version).toBe(LAYOUT_VERSION);
    expect(p.layouts.essentials).toBeUndefined(); // untouched old default → the new preset applies
    expect(p.layouts.typography).toBeUndefined(); // untouched copy → fitted afresh to the window
    expect(p.layouts.painting).toBeDefined(); // customized: kept as is
    expect(parsePersisted(JSON.stringify({ version: 2, activeId: 'typography', layouts: { typography: typoCustom } }))!.layouts.typography).toBeDefined();
    expect(p.dockWidth).toBe(300);
    const kept = parsePersisted(JSON.stringify({ activeId: 'essentials', layouts: { essentials: customized } }))!;
    expect(kept.layouts.essentials.groups[2].tabs).toEqual(['layers', 'history']);
    // Current-version state is not migrated again.
    const current = parsePersisted(JSON.stringify({ version: LAYOUT_VERSION, activeId: 'essentials', layouts: { essentials: legacyEssentials } }))!;
    expect(current.layouts.essentials).toBeDefined();
  });
});

describe('placeFlyout', () => {
  it('stays inside the area above the status bar and shrinks to short content', () => {
    // 1366×768: side column 702px tall, status bar top at 678 relative to it.
    const p = placeFlyout(74, 678, 0);
    expect(p.top + Math.min(620, 678 - 16)).toBeLessThanOrEqual(678 - 8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(678 - 8);
    // A short panel (300px) stays next to its icon.
    const short = placeFlyout(140, 678, 300);
    expect(short.top).toBe(140);
    expect(short.top + 300).toBeLessThanOrEqual(678 - 8);
    // A tall panel near the bottom is moved up to fit.
    const tall = placeFlyout(400, 678, 600);
    expect(tall.top + 600).toBeLessThanOrEqual(678 - 8);
    expect(tall.top).toBeGreaterThanOrEqual(8);
  });
});

describe('scrollDeltaToReveal', () => {
  it('scrolls just enough to show a clipped tab', () => {
    expect(scrollDeltaToReveal(10, 60, 200)).toBe(0);
    expect(scrollDeltaToReveal(180, 240, 200)).toBe(48);
    expect(scrollDeltaToReveal(-30, 20, 200)).toBe(-38);
  });
});

describe('placeMenu', () => {
  const vp = { width: 1366, height: 768 };
  it('keeps a tall top-level menu below its anchor and caps its height', () => {
    const p = placeMenu({ x: 160, y: 30, width: 240, height: 800, level: 0 }, vp);
    expect(p.top).toBe(30);
    expect(p.maxHeight).toBe(768 - 30 - 8);
  });
  it('shifts submenus up to fit, never above the window', () => {
    const p = placeMenu({ x: 400, y: 600, width: 200, height: 300, level: 1 }, vp);
    expect(p.top + 300).toBeLessThanOrEqual(768 - 8);
    const huge = placeMenu({ x: 400, y: 600, width: 200, height: 2000, level: 1 }, vp);
    expect(huge.top).toBe(4);
    expect(huge.maxHeight).toBe(768 - 4 - 8);
  });
  it('flips submenus left at the right edge', () => {
    const p = placeMenu({ x: 1300, y: 100, width: 200, height: 100, flipX: 1290, level: 1 }, vp);
    expect(p.left).toBe(1090);
  });
});

describe('menuScrollFor', () => {
  it('scrolls a scrolling menu just enough to show the highlighted item', () => {
    // Visible item: no change.
    expect(menuScrollFor(0, 300, 100, 24)).toBe(0);
    // Below the fold (ArrowUp wrapped to the last item): bottom edge + padding at the bottom.
    expect(menuScrollFor(0, 300, 600, 24)).toBe(600 + 24 + 4 - 300);
    // Above (ArrowDown wrapped to the first item): back to the top.
    expect(menuScrollFor(328, 300, 4, 24)).toBe(0);
    expect(menuScrollFor(328, 300, 200, 24)).toBe(196);
  });
});

describe('tips guide', () => {
  it('resumes at a valid step and advances after an action', () => {
    expect(resumeStep('3', 8)).toBe(3);
    expect(resumeStep('9', 8)).toBe(0);
    expect(resumeStep(null, 8)).toBe(0);
    expect(resumeStep('x', 8)).toBe(0);
    expect(stepAfterAction(2, 8)).toBe(3);
    expect(stepAfterAction(7, 8)).toBe(7);
  });

  it('starts over without a document when the remembered step needs a canvas', () => {
    const steps = [{}, {}, { needsDoc: true }, { needsDoc: true }];
    expect(initialStep('3', steps, true)).toBe(3);
    expect(initialStep('3', steps, false)).toBe(0);
    // "Add your character" works without a canvas (Pose Studio creates one).
    expect(initialStep('1', steps, false)).toBe(1);
    expect(initialStep('7', steps, true)).toBe(0);
  });

  it('always starts at step 1 when restarted from the start screen', () => {
    const steps = [{}, {}, { needsDoc: true }];
    expect(initialStep('2', steps, true, true)).toBe(0);
    expect(initialStep('1', steps, false, true)).toBe(0);
  });

  it('marks every step after "Add your character" as needing a canvas', () => {
    expect(TIPS_STEPS[0].needsDoc).toBeFalsy();
    expect(TIPS_STEPS[1].needsDoc).toBeFalsy();
    expect(TIPS_STEPS.slice(2).every((s) => s.needsDoc)).toBe(true);
    // The verifier's case: remembered "Give it a look" (index 4) with no document open.
    expect(initialStep('4', TIPS_STEPS, false)).toBe(0);
  });
});

/**
 * gate-first-user-5: a UI scale change resizes the dock under a layout fitted for the old height (all
 * three groups expanded at 100 % on 1366×768 → Layers pushed out of a 446 px dock at 150 %). The
 * layout is refitted then: secondary groups collapse (never the Layers group) and Layers keeps ~4 rows.
 */
describe('refitLayout (the dock height changed under the layout)', () => {
  it('a 1600×960 layout in the 125 % dock of the same window: middle collapses, Layers keeps its rows', () => {
    const ess = fitLayoutToHeight(DEFAULT_WORKSPACE, DOCK_1600);
    expect(ess.groups.every((g) => !g.collapsed)).toBe(true);
    const dock = Math.round(960 / 1.25) - 66;
    const next = refitLayout(ess, dock)!;
    expect(next).not.toBeNull();
    expect(group(next, 'middle').collapsed).toBe(true);
    const layers = next.groups.find((g) => g.tabs.includes('layers'))!;
    expect(layers.collapsed).toBe(false);
    expect(heights(next, dock)[layers.slot] - 30).toBeGreaterThanOrEqual(LAYERS_MIN_BODY - 0.5);
  });

  it('never collapses the group holding Layers, wherever it is', () => {
    const custom = { ...DEFAULT_WORKSPACE, groups: DEFAULT_WORKSPACE.groups.map((g) => ({ ...g, tabs: g.slot === 'middle' ? ['layers', 'swatches'] : g.tabs.filter((t) => t !== 'layers') })) };
    const next = refitLayout(custom, 500)!;
    expect(group(next, 'middle').collapsed).toBe(false);
    expect(next.groups.filter((g) => g.tabs.length && !g.collapsed).length).toBe(2);
  });

  it('nothing to do when the layout already fits', () => {
    expect(refitLayout(fitLayoutToHeight(DEFAULT_WORKSPACE, DOCK_1366), DOCK_1366)).toBeNull();
    expect(refitLayout(DEFAULT_WORKSPACE, 0)).toBeNull();
  });
});
