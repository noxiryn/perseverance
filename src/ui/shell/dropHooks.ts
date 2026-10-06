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
  hint?(drag: FileDragInfo): string | null;
}

/** What is known about the files being dragged over the window (before the drop). */
export interface FileDragInfo {
  /** MIME types of the dragged file items ('' where the OS doesn't know it; [] = not known). */
  types: string[];
}

let dragInfo: FileDragInfo = { types: [] };

/** The dragged files' item types (DataTransferItem.type is readable during dragenter / dragover). */
export function fileDragInfoOf(dt: DataTransfer | null | undefined): FileDragInfo {
  const items = dt?.items ? Array.from(dt.items) : [];
  return { types: items.filter((i) => i.kind === 'file').map((i) => i.type) };
}

/** Called by the shell while files are dragged over the window (read by the hints). */
export function setFileDragInfo(info: FileDragInfo) {
  dragInfo = info;
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
    const t = h.hint?.(dragInfo);
    if (t) out.push(t);
  }
  return out;
}
