/**
 * Export rendering: composite the document at the requested scale / preset size, optionally trim
 * transparent pixels and fill a background (JPEG), then encode.
 */
import type { Document } from '../core/types';
import { canvasToBlob, createCanvas, ctx2d, opaqueBounds } from '../core/canvas';
import { renderDocument } from '../render/compositor';
import { saveFile } from '../platform';
import { activeSession } from '../state/editor';
import { toast } from '../state/ui';
import { fitRect, formatBytes, safeFileName, sizeEstimateFactor, type FitMode } from './math';
import { ensureFontsFor, readJSON, writeJSON } from './util';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface SizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: 'icon512', label: 'Roblox Icon', width: 512, height: 512 },
  { id: 'icon1024', label: 'Icon 1024', width: 1024, height: 1024 },
  { id: 'thumb1080', label: 'Thumbnail', width: 1920, height: 1080 },
  { id: 'thumb720', label: 'Thumbnail 720', width: 1280, height: 720 },
];

export interface ExportOptions {
  format: ExportFormat;
  /** 0..1 (JPEG/WebP) */
  quality: number;
  /** 0.25..4 (ignored when a size preset is active) */
  scale: number;
  presetId: string | null;
  fit: FitMode;
  /** Fill color under the image (always used for JPEG). */
  fillBackground: boolean;
  background: string;
  trim: boolean;
}

export const DEFAULT_EXPORT: ExportOptions = {
  format: 'png',
  quality: 0.92,
  scale: 1,
  presetId: null,
  fit: 'cover',
  fillBackground: false,
  background: '#ffffff',
  trim: false,
};

const OPTS_KEY = 'perseverance.exportOptions';

export function loadExportOptions(): ExportOptions {
  const v = readJSON<Partial<ExportOptions>>(OPTS_KEY, {});
  return { ...DEFAULT_EXPORT, ...(v && typeof v === 'object' ? v : {}) };
}

export function saveExportOptions(o: ExportOptions) {
  writeJSON(OPTS_KEY, o);
}

export const MIME: Record<ExportFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export const EXT: Record<ExportFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
export const FILTER_NAMES: Record<ExportFormat, string> = { png: 'PNG Image', jpeg: 'JPEG Image', webp: 'WebP Image' };

/** Output pixel size for options (before trimming). */
export function exportSize(doc: Document, o: ExportOptions, trimmed?: { width: number; height: number } | null) {
  const preset = SIZE_PRESETS.find((p) => p.id === o.presetId);
  if (preset) return { width: preset.width, height: preset.height };
  const src = trimmed ?? doc;
  return { width: Math.max(1, Math.round(src.width * o.scale)), height: Math.max(1, Math.round(src.height * o.scale)) };
}

/** Doc-space bounds of non-transparent pixels (for trimming), or null when fully transparent. */
export function documentOpaqueBounds(doc: Document) {
  const probe = renderDocument(doc, { scale: Math.min(1, 2048 / Math.max(doc.width, doc.height)), background: true });
  const b = opaqueBounds(probe);
  if (!b) return null;
  const k = doc.width / probe.width;
  const x = Math.max(0, Math.floor(b.x * k));
  const y = Math.max(0, Math.floor(b.y * k));
  return {
    x,
    y,
    width: Math.min(doc.width - x, Math.ceil((b.x + b.width) * k) - x),
    height: Math.min(doc.height - y, Math.ceil((b.y + b.height) * k) - y),
  };
}

/** Where the document lands in the export: source region, output size, scale and offset. */
export interface ExportPlan {
  /** Doc-space source region (the whole document, or the trimmed bounds). */
  region: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
  /** Doc → output scale. */
  scale: number;
  /** Top-left of the scaled region in the output (letterbox / cover offset). */
  dx: number;
  dy: number;
  fill: boolean;
}

/** Plan an export (throws when trimming leaves nothing). */
export function planExport(doc: Document, o: ExportOptions): ExportPlan {
  const fill = o.format === 'jpeg' || o.fillBackground;
  const trimmed = o.trim ? documentOpaqueBounds(doc) : null;
  if (o.trim && !trimmed) throw new Error('the image is completely transparent — nothing to export after trimming');
  const region = trimmed ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  const preset = SIZE_PRESETS.find((p) => p.id === o.presetId);
  if (preset) {
    const f = fitRect(region.width, region.height, preset.width, preset.height, o.fit);
    return { region, width: preset.width, height: preset.height, scale: f.scale, dx: f.x, dy: f.y, fill };
  }
  const scale = Math.max(0.01, Math.min(8, o.scale));
  return {
    region,
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
    scale,
    dx: 0,
    dy: 0,
    fill,
  };
}

/** Render a plan, uniformly reduced by `k` (≤ 1) for previews. */
function drawPlan(doc: Document, o: ExportOptions, plan: ExportPlan, k = 1): HTMLCanvasElement {
  const out = createCanvas(Math.max(1, Math.round(plan.width * k)), Math.max(1, Math.round(plan.height * k)));
  const scale = plan.scale * k;
  const src = plan.region;
  const full = renderDocument(doc, { scale, background: true });
  const ctx = ctx2d(out);
  if (plan.fill) {
    ctx.fillStyle = o.background || '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.imageSmoothingQuality = 'high';
  // Draw the (scaled) source region at its placement.
  ctx.drawImage(
    full,
    src.x * scale,
    src.y * scale,
    src.width * scale,
    src.height * scale,
    Math.round(plan.dx * k),
    Math.round(plan.dy * k),
    Math.round(src.width * scale),
    Math.round(src.height * scale),
  );
  return out;
}

/** Render the export image at full size. */
export async function renderForExport(doc: Document, o: ExportOptions): Promise<HTMLCanvasElement> {
  await ensureFontsFor(doc);
  return drawPlan(doc, o, planExport(doc, o));
}

/** Outputs above this many pixels are previewed (and their file size estimated) from a reduced render. */
export const LARGE_EXPORT_PIXELS = 8_000_000;
/** Pixel budget of a reduced preview render. */
const PREVIEW_PIXELS = 2_000_000;

export interface ExportPreview {
  canvas: HTMLCanvasElement;
  /** Full export size. */
  width: number;
  height: number;
  /** True when `canvas` is a reduced render (the full image is rendered on export). */
  reduced: boolean;
  /** Multiplies the encoded preview's byte count into a full-size estimate (1 when not reduced). */
  estimateFactor: number;
}

/**
 * Render for the Export dialog: full size for ordinary outputs, a reduced render for huge ones
 * (e.g. a 4× thumbnail at 7680×4320) so changing options never freezes the dialog.
 */
export async function renderExportPreview(doc: Document, o: ExportOptions): Promise<ExportPreview> {
  await ensureFontsFor(doc);
  const plan = planExport(doc, o);
  const px = plan.width * plan.height;
  const k = px > LARGE_EXPORT_PIXELS ? Math.sqrt(PREVIEW_PIXELS / px) : 1;
  const canvas = drawPlan(doc, o, plan, k);
  // Effective preview scale from the actual (rounded) canvas size.
  const previewScale = plan.scale * Math.sqrt((canvas.width * canvas.height) / px);
  return { canvas, width: plan.width, height: plan.height, reduced: k < 1, estimateFactor: k < 1 ? sizeEstimateFactor(previewScale, plan.scale) : 1 };
}

/** Wait until the browser has painted (so a toast / busy state shows before a long synchronous render). */
export function afterPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

export function encodeExport(canvas: HTMLCanvasElement, o: ExportOptions): Promise<Blob> {
  return canvasToBlob(canvas, MIME[o.format], o.format === 'png' ? undefined : Math.max(0.01, Math.min(1, o.quality)));
}

/** Write an export blob via the native dialog (desktop) or a download (browser). */
export async function saveExport(blob: Blob, fileName: string, format: ExportFormat): Promise<string | null> {
  return saveFile({
    title: 'Export As',
    defaultPath: fileName,
    filters: [{ name: FILTER_NAMES[format], extensions: format === 'jpeg' ? ['jpg', 'jpeg'] : [EXT[format]] }],
    data: blob,
  });
}

/** File ▸ Quick Export as PNG: full-size PNG of the active document. */
export async function quickExportPng() {
  const s = activeSession();
  if (!s) {
    toast('Open or create a document to export (File ▸ New / Open).', 'info');
    return;
  }
  try {
    if (s.doc.width * s.doc.height > LARGE_EXPORT_PIXELS) {
      toast(`Rendering ${s.doc.width}×${s.doc.height} px…`, 'info', 2500);
      await afterPaint();
    }
    const canvas = await renderForExport(s.doc, { ...DEFAULT_EXPORT, format: 'png' });
    const blob = await encodeExport(canvas, { ...DEFAULT_EXPORT, format: 'png' });
    const res = await saveExport(blob, `${safeFileName(s.doc.name)}.png`, 'png');
    if (res) toast(`Exported ${canvas.width}×${canvas.height} PNG (${formatBytes(blob.size)})`, 'success');
  } catch (e) {
    console.error('[io] quick export failed', e);
    toast(`Export failed: ${(e as Error).message ?? e}`, 'error', 5000);
  }
}
