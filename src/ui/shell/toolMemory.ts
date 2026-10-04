/**
 * Remembers the last used tool of each toolbar group (shown in the slot, used by single-key
 * shortcuts). Persisted in localStorage 'perseverance.toolSlots'.
 */
import { create } from 'zustand';
import { tools } from '../../registry';
import { useEditor } from '../../state/editor';

const KEY = 'perseverance.toolSlots';

function read(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

interface ToolMemoryState {
  lastUsed: Record<string, string>;
  remember(toolId: string): void;
}

export const useToolMemory = create<ToolMemoryState>()((set, get) => ({
  lastUsed: read(),
  remember(toolId) {
    const t = tools.get(toolId);
    if (!t || get().lastUsed[t.group] === toolId) return;
    const lastUsed = { ...get().lastUsed, [t.group]: toolId };
    set({ lastUsed });
    try {
      localStorage.setItem(KEY, JSON.stringify(lastUsed));
    } catch {
      /* ignore */
    }
  },
}));

let installed = false;
export function installToolMemory() {
  if (installed) return;
  installed = true;
  useToolMemory.getState().remember(useEditor.getState().activeTool);
  useEditor.subscribe((s, p) => {
    if (s.activeTool !== p.activeTool) useToolMemory.getState().remember(s.activeTool);
  });
}
