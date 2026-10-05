/**
 * Pure layout helpers added for laptop-sized windows: dock presets fitted to the window height,
 * migration of saved layouts, flyout placement, tab-strip reveal, menu placement and the guide's
 * resume step.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE } from '../../state/ui';
import { placeFlyout, scrollDeltaToReveal } from './Dock';
import { placeMenu } from './MenuBar';
import { resumeStep, stepAfterAction } from './dialogs/TipsDialog';
import { fitLayoutToHeight, isUncustomized, LAYOUT_VERSION, LEGACY_PRESETS, migrateLayouts, parsePersisted, workspacePreset } from './workspaces';

const group = (l: ReturnType<typeof fitLayoutToHeight>, slot: string) => l.groups.find((g) => g.slot === slot)!;

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
    const gfx = fitLayoutToHeight(workspacePreset('gfx')!, 960 - 66);
    const open = gfx.groups.filter((g) => !g.collapsed && g.tabs.length);
    const body = 960 - 66 - 2 * 5 - gfx.groups.length * 30;
    const top = group(gfx, 'top');
    expect(top.tabs[0]).toBe('libraries');
    const sum = open.reduce((a, g) => a + g.size, 0);
    expect((body * top.size) / sum).toBeGreaterThanOrEqual(520);
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

  it('parses, sanitizes and migrates the stored state', () => {
    expect(parsePersisted(null)).toBeNull();
    expect(parsePersisted('{oops')).toBeNull();
    const customized = { ...legacyEssentials, groups: legacyEssentials.groups.map((g, i) => (i === 2 ? { ...g, tabs: ['layers', 'history'] } : g)) };
    const v1 = JSON.stringify({ activeId: 'essentials', layouts: { essentials: legacyEssentials, typography: workspacePreset('typography') }, dockWidth: 300 });
    const p = parsePersisted(v1)!;
    expect(p.version).toBe(LAYOUT_VERSION);
    expect(p.layouts.essentials).toBeUndefined(); // untouched old default → the new preset applies
    expect(p.layouts.typography).toBeDefined(); // unchanged preset: kept as is
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

describe('tips guide', () => {
  it('resumes at a valid step and advances after an action', () => {
    expect(resumeStep('3', 8)).toBe(3);
    expect(resumeStep('9', 8)).toBe(0);
    expect(resumeStep(null, 8)).toBe(0);
    expect(resumeStep('x', 8)).toBe(0);
    expect(stepAfterAction(2, 8)).toBe(3);
    expect(stepAfterAction(7, 8)).toBe(7);
  });
});
