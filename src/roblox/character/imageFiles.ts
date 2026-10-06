/**
 * Which files Replace Character can take as a render (pure helpers, no editor state).
 */
import { extOf } from '../../platform';
import { isPgfx } from '../../io/container';

/** Extensions of the raster images the decoder reads (createImageBitmap). */
export const IMAGE_FILE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

/** Raster MIME types the decoder reads (used only for files without an extension). */
const RASTER_MIME = /^image\/(png|jpeg|pjpeg|webp|gif|bmp|x-ms-bmp)$/i;
/** Documents that open as projects (File ▸ Open), never as a character render. */
const PROJECT_FILE_EXTS = ['psd', 'psb', 'pgfx'];

/** What a file's first bytes say: a raster image the decoder reads, a project (PSD / .pgfx), or neither. */
export function sniffImageBytes(data: ArrayBuffer | Uint8Array): 'raster' | 'project' | null {
  const b = data instanceof Uint8Array ? data.subarray(0, 12) : new Uint8Array(data, 0, Math.min(12, data.byteLength));
  if (b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return 'project'; // 8BPS (PSD / PSB)
  if (isPgfx(data)) return 'project';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'raster'; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'raster'; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'raster'; // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return 'raster'; // BMP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'raster'; // RIFF WEBP
  return null;
}

/**
 * Whether a file can become a character render: a PNG / JPEG / WebP / GIF / BMP the decoder reads.
 * Decided by the file's bytes when they are known, else by its extension (a MIME type only counts
 * for a file without one). PSDs, projects, SVG, TIFF… are never claimed — they go to the normal
 * open path (a PSD opens as a document) instead of failing to decode as a render. Chromium reports
 * `image/vnd.adobe.photoshop` for .psd wherever the OS knows the type, so an `image/` MIME prefix
 * alone says nothing.
 */
export function isReplaceableImage(name: string, mime = '', data?: ArrayBuffer | Uint8Array | null): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  const ext = base.includes('.') ? extOf(base) : '';
  if (PROJECT_FILE_EXTS.includes(ext)) return false;
  if (data && data.byteLength) return sniffImageBytes(data) === 'raster';
  if (ext) return IMAGE_FILE_EXTS.includes(ext);
  return RASTER_MIME.test(mime);
}

/**
 * While a drag is over the window only the items' MIME types are known (no names, no bytes): could
 * it be a render Replace Character takes? False when every file item has a known type that isn't
 * one of the decoder's rasters (a PSD reported as image/vnd.adobe.photoshop, SVG, TIFF,
 * application/…); true when a type is empty (Windows without a registration for the extension) or
 * a raster, or when the types are unknown (`types` empty).
 */
export function mayBeReplaceableDrag(types: readonly string[]): boolean {
  return types.length === 0 || types.some((t) => t === '' || RASTER_MIME.test(t));
}
