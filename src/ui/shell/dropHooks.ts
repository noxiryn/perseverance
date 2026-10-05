/**
 * Extension point for files dropped onto the window. Feature modules register a handler that may
 * claim a dropped file before the shell opens/places it (e.g. Roblox ▸ Replace Character offers
 * to swap a template's placeholder for the dropped render), plus an optional hint line for the
 * "Drop to open" overlay.
 */

export interface FileDropContext {
  file: File;
  data: ArrayBuffer;
  /** Number of files in this drop. */
  count: number;
  hasDoc: boolean;
  shift: boolean;
  /** Drop position (client px). */
  clientX: number;
  clientY: number;
}

export interface FileDropHandler {
  id: string;
  /** Return true when the drop was handled (the shell then skips this file). */
  claim(ctx: FileDropContext): boolean | Promise<boolean>;
  /** Extra line for the drop overlay while dragging (null = nothing to add). */
  hint?(): string | null;
}

const handlers = new Map<string, FileDropHandler>();

export function registerFileDropHandler(h: FileDropHandler): () => void {
  handlers.set(h.id, h);
  return () => {
    if (handlers.get(h.id) === h) handlers.delete(h.id);
  };
}

/** Ask the registered handlers to claim a dropped file (first claim wins). */
export async function claimFileDrop(ctx: FileDropContext): Promise<boolean> {
  for (const h of handlers.values()) {
    try {
      if (await h.claim(ctx)) return true;
    } catch (e) {
      console.error(`[drop] handler ${h.id} failed`, e);
    }
  }
  return false;
}

/** Hint lines from the handlers for the overlay. */
export function fileDropHints(): string[] {
  const out: string[] = [];
  for (const h of handlers.values()) {
    const t = h.hint?.();
    if (t) out.push(t);
  }
  return out;
}
