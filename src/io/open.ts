/**
 * CONTRACT (owned by the IO module): open any supported file.
 *  - .pgfx project → new document session
 *  - .psd → new document with layers
 *  - images (png/jpg/webp/gif/bmp) → new document (asNewDocument / no doc open) or placed as a
 *    new layer in the active document.
 */
import type { OpenedFile } from '../platform';
import { toast } from '../state/ui';

export async function openFile(file: OpenedFile, opts: { asNewDocument?: boolean } = {}): Promise<void> {
  void opts;
  toast(`Opening ${file.name} is not available yet`, 'info');
}

/** Place image data (clipboard / drag-drop blob) into the active document as a new layer. */
export async function placeImageBlob(blob: Blob, name = 'Pasted Image'): Promise<void> {
  void blob;
  toast(`Placing ${name} is not available yet`, 'info');
}
