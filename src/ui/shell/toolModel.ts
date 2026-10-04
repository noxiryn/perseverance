/**
 * Pure helpers for the left toolbar and tool keyboard shortcuts.
 */
import type { ToolDef } from '../../registry';

export interface ToolSlot {
  group: string;
  /** Group sort key (smallest tool order in the group). */
  order: number;
  /** Tools of the group in display order. */
  tools: ToolDef[];
  /** Tool shown in the slot (active tool of the group, else last used, else first). */
  current: ToolDef;
  /** Toolbar section: 0 selection/crop/sample, 1 paint/retouch, 2 type/shape, 3 navigation. */
  section: number;
}

export function sectionOf(order: number): number {
  if (order <= 60) return 0;
  if (order <= 120) return 1;
  if (order <= 140) return 2;
  return 3;
}

/** Group tools into toolbar slots sorted by group order. */
export function buildToolSlots(
  list: readonly ToolDef[],
  lastUsed: Readonly<Record<string, string>>,
  activeTool: string | null,
): ToolSlot[] {
  const groups = new Map<string, ToolDef[]>();
  list.forEach((t) => {
    const g = groups.get(t.group);
    if (g) g.push(t);
    else groups.set(t.group, [t]);
  });
  const slots: ToolSlot[] = [];
  for (const [group, tools] of groups) {
    // Stable sort by order (registration order breaks ties).
    const sorted = tools
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t.order - b.t.order || a.i - b.i)
      .map((x) => x.t);
    const order = sorted[0].order;
    const current =
      sorted.find((t) => t.id === activeTool) ?? sorted.find((t) => t.id === lastUsed[group]) ?? sorted[0];
    slots.push({ group, order, tools: sorted, current, section: sectionOf(order) });
  }
  slots.sort((a, b) => a.order - b.order || a.group.localeCompare(b.group));
  return slots;
}

/**
 * Resolve a single-key tool shortcut.
 *  - key: the pressed letter (any case)
 *  - shift: Shift held → cycle to the next tool sharing the shortcut
 * Returns the tool id to activate, or null when no tool uses this key.
 */
export function resolveToolShortcut(
  key: string,
  shift: boolean,
  list: readonly ToolDef[],
  activeTool: string | null,
  lastUsed: Readonly<Record<string, string>>,
): string | null {
  const k = key.toUpperCase();
  if (k.length !== 1) return null;
  const candidates = list
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (t.shortcut ?? '').toUpperCase() === k)
    .sort((a, b) => a.t.order - b.t.order || a.i - b.i)
    .map((x) => x.t);
  if (!candidates.length) return null;
  const activeIdx = candidates.findIndex((t) => t.id === activeTool);
  if (activeIdx >= 0) {
    return shift ? candidates[(activeIdx + 1) % candidates.length].id : candidates[activeIdx].id;
  }
  const group = candidates[0].group;
  const remembered = candidates.find((t) => t.id === lastUsed[group]);
  return (remembered ?? candidates[0]).id;
}

/** Next tool in a slot (Alt+click on a toolbar slot cycles like Photoshop). */
export function nextInSlot(slot: ToolSlot): ToolDef {
  const i = slot.tools.indexOf(slot.current);
  return slot.tools[(i + 1) % slot.tools.length];
}

/** Tools that temporarily switch to the eyedropper while Alt is held. */
export const ALT_EYEDROPPER_TOOLS = new Set(['brush', 'pencil', 'gradient', 'paint-bucket']);
