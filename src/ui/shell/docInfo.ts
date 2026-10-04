/** Pure helpers for document info shown in the status bar and tabs. */
import type { Document } from '../../core/types';

/** Flattened size (8-bit RGB, like Photoshop's first number) and total layer data size in bytes. */
export function docByteSizes(doc: Pick<Document, 'width' | 'height' | 'layers'>): { flat: number; layered: number } {
  const flat = doc.width * doc.height * 3;
  let layered = 0;
  for (const l of Object.values(doc.layers)) {
    if (l.type === 'raster') layered += Math.max(0, l.width) * Math.max(0, l.height) * 4;
    if (l.mask) layered += doc.width * doc.height;
  }
  return { flat, layered: Math.max(flat, layered) };
}

/** '8.7M', '512K', '123M'. */
export function formatBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)}M`;
  if (mb >= 0.1) return `${mb.toFixed(1)}M`;
  return `${Math.max(1, Math.round(n / 1024))}K`;
}

export function docSizeLabel(doc: Pick<Document, 'width' | 'height' | 'layers'>): string {
  const { flat, layered } = docByteSizes(doc);
  return `Doc: ${formatBytes(flat)}/${formatBytes(layered)}`;
}

/** Zoom factor → '46.1%' / '100%' / '1600%'. */
export function formatZoom(z: number): string {
  const pct = z * 100;
  if (!Number.isFinite(pct) || pct <= 0) return '100%';
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) || rounded >= 1000 ? Math.round(rounded) : rounded.toFixed(1)}%`;
}

/** Parse user zoom input ('50', '50%', '33.3 %', '2x', '1:2') → zoom factor or null. */
export function parseZoom(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const ratio = s.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    return b > 0 && a > 0 ? clampZoom(a / b) : null;
  }
  const times = s.match(/^(\d+(?:\.\d+)?)\s*x$/);
  if (times) return clampZoom(Number(times[1]));
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (pct) {
    const v = Number(pct[1]);
    return v > 0 ? clampZoom(v / 100) : null;
  }
  return null;
}

function clampZoom(z: number) {
  return Math.max(0.02, Math.min(64, z));
}

/** Label for document tabs: 'Name *' when dirty. */
export function tabLabel(name: string, dirty: boolean): string {
  return dirty ? `${name} *` : name;
}

/** Window title: '<doc name>[ *] — Perseverance'. */
export function windowTitle(name: string | null, dirty: boolean): string {
  return name ? `${name}${dirty ? ' *' : ''} — Perseverance` : 'Perseverance';
}

/* ------------------------------------------------------------------ */
/* File drops                                                          */
/* ------------------------------------------------------------------ */

const PROJECT_EXTS = new Set(['pgfx', 'psd']);
const SUPPORTED_EXTS = new Set(['pgfx', 'psd', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico']);

function extension(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Decide how a dropped file opens: projects, no open document or Shift → new document. */
export function dropMode(name: string, hasDoc: boolean, shift: boolean): 'new' | 'place' {
  if (PROJECT_EXTS.has(extension(name)) || !hasDoc || shift) return 'new';
  return 'place';
}

/** Whether a dropped file can be opened (known extension or an image MIME type). */
export function isSupportedDrop(name: string, mime = ''): boolean {
  const ext = extension(name);
  if (SUPPORTED_EXTS.has(ext)) return true;
  return mime.startsWith('image/');
}
