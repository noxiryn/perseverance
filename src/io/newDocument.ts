/**
 * New Document: presets (docPresets registry with built-in fallbacks), recent sizes, creation.
 */
import { bitmaps } from '../core/bitmaps';
import { createDocument, insertLayerDraft, makeRasterLayer } from '../core/document';
import { docPresets, type DocPresetDef } from '../registry';
import { useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { pushRecentSize, type RecentSize } from './math';
import { readJSON, readPref, writeJSON } from './util';

export type BackgroundChoice = 'white' | 'black' | 'transparent' | 'custom';

export interface NewDocumentSpec {
  name: string;
  width: number;
  height: number;
  background: BackgroundChoice;
  customColor: string;
}

export const MAX_DOC_SIZE = 16384;
const RECENT_SIZES_KEY = 'perseverance.recentSizes';

export const PRESET_CATEGORIES: DocPresetDef['category'][] = ['Roblox', 'Social', 'Video', 'Print', 'Common'];

export const FALLBACK_PRESETS: DocPresetDef[] = [
  { id: 'io-roblox-icon', name: 'Roblox Icon', category: 'Roblox', width: 512, height: 512, description: 'Experience icon' },
  { id: 'io-roblox-thumb', name: 'Roblox Thumbnail', category: 'Roblox', width: 1920, height: 1080, description: '16:9 experience thumbnail' },
  { id: 'io-thumb-720', name: 'Thumbnail 720p', category: 'Video', width: 1280, height: 720, description: 'YouTube-style thumbnail' },
];

export function allPresets(): DocPresetDef[] {
  const list = docPresets.list();
  return list.length ? list : FALLBACK_PRESETS;
}

export function readRecentSizes(): RecentSize[] {
  const v = readJSON<unknown>(RECENT_SIZES_KEY, []);
  return Array.isArray(v)
    ? v.filter((s): s is RecentSize => !!s && Number.isFinite((s as RecentSize).width) && Number.isFinite((s as RecentSize).height)).slice(0, 6)
    : [];
}

/** Default background from prefs: 'white' | 'black' | 'transparent' | '#rrggbb'. */
export function defaultBackground(): { choice: BackgroundChoice; color: string } {
  const p = readPref<string>('defaultBackground', 'white');
  if (p === 'white' || p === 'black' || p === 'transparent') return { choice: p, color: '#808080' };
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(p)) return { choice: 'custom', color: p };
  return { choice: 'white', color: '#808080' };
}

export function backgroundColorOf(spec: Pick<NewDocumentSpec, 'background' | 'customColor'>): string | null {
  switch (spec.background) {
    case 'white':
      return '#ffffff';
    case 'black':
      return '#000000';
    case 'transparent':
      return null;
    default:
      return spec.customColor;
  }
}

/** Create and open a new document from a spec. Returns the doc id. */
export function createNewDocument(spec: NewDocumentSpec): string {
  const width = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(spec.width)));
  const height = Math.max(1, Math.min(MAX_DOC_SIZE, Math.round(spec.height)));
  const color = backgroundColorOf(spec);
  const doc = createDocument({ name: spec.name.trim() || 'Untitled', width, height, background: null });
  const layer = makeRasterLayer({
    name: color ? 'Background' : 'Layer 1',
    bitmapId: bitmaps.create(width, height, color ?? undefined),
    width,
    height,
  });
  insertLayerDraft(doc, layer, {});
  useEditor.getState().openDocument(doc, { label: 'New Document', activeLayerId: layer.id });
  writeJSON(RECENT_SIZES_KEY, pushRecentSize(readRecentSizes(), { width, height }));
  requestAnimationFrame(() => viewport.fit());
  return doc.id;
}

export async function showNewDocumentDialog(initial?: Partial<NewDocumentSpec>) {
  const { NewDocumentDialog } = await import('./dialogs/NewDocumentDialog');
  const spec = await openDialog<NewDocumentSpec, { initial?: Partial<NewDocumentSpec> }>(NewDocumentDialog, { initial });
  if (!spec) return;
  try {
    createNewDocument(spec);
  } catch (e) {
    console.error(e);
    toast(`Could not create the document: ${(e as Error).message}`, 'error');
  }
}
