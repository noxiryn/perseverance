/**
 * Extension point for images about to be placed as a new layer by File ▸ Place Image… or
 * Edit ▸ Paste (an image from another app or another document). A feature module may claim the
 * image instead — e.g. Roblox ▸ Replace Character offers to swap a template's placeholder
 * character for it, like it does for a dropped file. Handlers run in registration order; the
 * first that returns true wins and the image is not placed.
 */

export interface PlacedImageContext {
  canvas: HTMLCanvasElement;
  /** Layer name the image would get (file base name, or "Pasted Image"). */
  name: string;
  /** Which command brings the image in. */
  source: 'place' | 'paste';
}

export interface PlacedImageHandler {
  id: string;
  /** Return true when the image was handled (it is then not placed as a new layer). */
  claim(ctx: PlacedImageContext): boolean | Promise<boolean>;
}

const handlers = new Map<string, PlacedImageHandler>();

export function registerPlacedImageHandler(h: PlacedImageHandler): () => void {
  handlers.set(h.id, h);
  return () => {
    if (handlers.get(h.id) === h) handlers.delete(h.id);
  };
}

/** Ask the registered handlers to claim an image before it is placed (first claim wins). */
export async function claimPlacedImage(ctx: PlacedImageContext): Promise<boolean> {
  for (const h of handlers.values()) {
    try {
      if (await h.claim(ctx)) return true;
    } catch (e) {
      console.error(`[place] handler ${h.id} failed`, e);
    }
  }
  return false;
}
