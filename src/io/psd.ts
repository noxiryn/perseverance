/**
 * Photoshop (.psd) export and import via ag-psd.
 *  - Export: every leaf layer is rendered (optionally with baked layer styles), groups become PSD
 *    folders; names, opacity, blend modes, visibility, clipping, masks and a composite image are kept.
 *    Simple adjustment layers are written as native PSD adjustment layers.
 *  - Import: pixel layers → raster layers (left/top → transform), groups, masks, opacity, blending,
 *    visibility, clipping, and supported adjustment layers.
 */
import { readPsd, writePsd, type Layer as PsdLayer, type Psd, type AdjustmentLayer as PsdAdjustment, type LayerMaskData } from 'ag-psd';
import type { CurvePoints, CurvesValue, Document, ID, Layer, LayerMask, ParamValues } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, opaqueBounds } from '../core/canvas';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeFillLayer, makeGroupLayer, makeRasterLayer } from '../core/document';
import { renderDocument, renderLayerToDoc } from '../render/compositor';
import { effects as effectRegistry, filters } from '../registry';
import { resolveParams } from '../filters/engine';
import { saveFile, type OpenedFile } from '../platform';
import { activeSession, useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { formatBytes, fromPsdBlend, safeFileName, toPsdBlend } from './math';
import { effectLabel, effectsFromPsd, effectsToPsd, fillFromPsd, fillToPsd } from './psdEffects';
import { baseName, ensureFontsFor } from './util';

/* ------------------------------------------------------------------ */
/* Adjustment mapping                                                  */
/* ------------------------------------------------------------------ */

function paramsOf(filterId: string, params: ParamValues): ParamValues {
  const def = filters.get(filterId);
  return def ? resolveParams(def, params) : params;
}

const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const IDENTITY: CurvePoints = [
  [0, 0],
  [255, 255],
];

function toPsdAdjustment(filterId: string, raw: ParamValues): PsdAdjustment | null {
  const p = paramsOf(filterId, raw);
  switch (filterId) {
    case 'brightness-contrast':
      return { type: 'brightness/contrast', brightness: Math.round(n(p.brightness, 0)), contrast: Math.round(n(p.contrast, 0)), useLegacy: false };
    case 'levels':
      return {
        type: 'levels',
        rgb: {
          shadowInput: Math.round(n(p.inBlack, 0)),
          highlightInput: Math.round(n(p.inWhite, 255)),
          shadowOutput: Math.round(n(p.outBlack, 0)),
          highlightOutput: Math.round(n(p.outWhite, 255)),
          midtoneInput: n(p.gamma, 1),
        },
      };
    case 'curves': {
      const c = (p.curves as CurvesValue | undefined) ?? { rgb: IDENTITY, r: IDENTITY, g: IDENTITY, b: IDENTITY };
      const ch = (pts: CurvePoints | undefined) => (pts?.length ? pts : IDENTITY).map(([x, y]) => ({ input: Math.round(x), output: Math.round(y) }));
      return { type: 'curves', rgb: ch(c.rgb), red: ch(c.r), green: ch(c.g), blue: ch(c.b) };
    }
    case 'exposure':
      return { type: 'exposure', exposure: n(p.exposure, 0), offset: n(p.offset, 0), gamma: n(p.gamma, 1) };
    case 'vibrance':
      return { type: 'vibrance', vibrance: Math.round(n(p.vibrance, 0)), saturation: Math.round(n(p.saturation, 0)) };
    case 'hue-saturation':
      if (p.colorize) return null;
      return {
        type: 'hue/saturation',
        master: { a: 0, b: 0, c: 0, d: 0, hue: Math.round(n(p.hue, 0)), saturation: Math.round(n(p.saturation, 0)), lightness: Math.round(n(p.lightness, 0)) },
      };
    case 'invert':
      return { type: 'invert' };
    case 'posterize':
      return { type: 'posterize', levels: Math.round(n(p.levels, 4)) };
    case 'threshold':
      return { type: 'threshold', level: Math.round(n(p.level, 128)) };
    default:
      return null;
  }
}

function fromPsdAdjustment(a: PsdAdjustment): { filterId: string; params: ParamValues; name: string } | null {
  switch (a.type) {
    case 'brightness/contrast':
      return { filterId: 'brightness-contrast', name: 'Brightness/Contrast', params: { brightness: a.brightness ?? 0, contrast: a.contrast ?? 0 } };
    case 'levels': {
      const c = a.rgb;
      return {
        filterId: 'levels',
        name: 'Levels',
        params: c
          ? { inBlack: c.shadowInput, inWhite: c.highlightInput, outBlack: c.shadowOutput, outWhite: c.highlightOutput, gamma: c.midtoneInput || 1 }
          : {},
      };
    }
    case 'curves': {
      const ch = (c?: { input: number; output: number }[]): CurvePoints =>
        c && c.length >= 2 ? c.map((pt) => [pt.input, pt.output] as [number, number]).sort((x, y) => x[0] - y[0]) : IDENTITY;
      return { filterId: 'curves', name: 'Curves', params: { curves: { rgb: ch(a.rgb), r: ch(a.red), g: ch(a.green), b: ch(a.blue) } } };
    }
    case 'exposure':
      return { filterId: 'exposure', name: 'Exposure', params: { exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance':
      return { filterId: 'vibrance', name: 'Vibrance', params: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation':
      return {
        filterId: 'hue-saturation',
        name: 'Hue/Saturation',
        params: { hue: a.master?.hue ?? 0, saturation: a.master?.saturation ?? 0, lightness: a.master?.lightness ?? 0, colorize: false },
      };
    case 'invert':
      return { filterId: 'invert', name: 'Invert', params: {} };
    case 'posterize':
      return { filterId: 'posterize', name: 'Posterize', params: { levels: a.levels ?? 4 } };
    case 'threshold':
      return { filterId: 'threshold', name: 'Threshold', params: { level: a.level ?? 128 } };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface PsdExportOptions {
  bakeStyles: boolean;
}

function maskToPsd(doc: Document, mask: LayerMask): LayerMaskData | undefined {
  const src = bitmaps.tryGet(mask.bitmapId);
  if (!src) return undefined;
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (mask.inverted) {
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return {
    top: 0,
    left: 0,
    bottom: doc.height,
    right: doc.width,
    canvas: c,
    defaultColor: 0,
    disabled: !mask.enabled,
    ...(mask.density < 1 ? { userMaskDensity: mask.density } : {}),
    ...(mask.feather > 0 ? { userMaskFeather: mask.feather } : {}),
  };
}

export interface PsdBuildReport {
  /** Adjustment layers with no PSD equivalent (left out). */
  skipped: string[];
  /** Layers whose styles had to be baked into pixels (no Photoshop equivalent). */
  baked: string[];
  /** Groups whose styles could not be exported (folders cannot hold baked pixels). */
  lostGroupStyles: string[];
}

/** Build the ag-psd structure for a document. */
export function buildPsd(doc: Document, opts: PsdExportOptions): { psd: Psd } & PsdBuildReport {
  const report: PsdBuildReport = { skipped: [], baked: [], lostGroupStyles: [] };
  const convert = (id: ID): PsdLayer | null => {
    const l = doc.layers[id];
    if (!l) return null;
    const common: PsdLayer = {
      name: l.name,
      opacity: l.opacity,
      blendMode: toPsdBlend(l.blendMode) as PsdLayer['blendMode'],
      hidden: !l.visible,
      clipping: l.clipped,
    };
    if (l.mask) {
      const m = maskToPsd(doc, l.mask);
      if (m) common.mask = m;
    }
    if (l.type === 'group') {
      // Folders carry no pixels: their styles can only travel as native Photoshop effects.
      const fx = effectsToPsd(l.effects);
      if (fx.info) common.effects = fx.info;
      if (fx.unsupported.length) report.lostGroupStyles.push(`${l.name} (${fx.unsupported.map((e) => effectLabel(e.effectId)).join(', ')})`);
      if (l.fillOpacity < 1) common.fillOpacity = l.fillOpacity;
      const children = l.childIds.map(convert).filter((c): c is PsdLayer => !!c);
      return { ...common, opened: !l.collapsed, children };
    }
    if (l.type === 'adjustment') {
      const a = toPsdAdjustment(l.adjustment.filterId, l.adjustment.params);
      if (!a) {
        report.skipped.push(l.name);
        return null;
      }
      return { ...common, adjustment: a };
    }
    const enabledFx = l.effects.filter((e) => e.enabled);
    let bake = opts.bakeStyles && enabledFx.length > 0;
    let source: Layer = l;
    if (!opts.bakeStyles && l.effects.length) {
      const fx = effectsToPsd(l.effects);
      if (fx.unsupported.length) {
        bake = true;
        report.baked.push(`${l.name} (${fx.unsupported.map((e) => effectLabel(e.effectId)).join(', ')})`);
      } else if (fx.info) common.effects = fx.info;
    }
    if (l.type === 'fill' && !bake) {
      // Solid/gradient fills stay editable Photoshop fill layers (pixels are written too). Not when
      // styles are baked: Photoshop re-renders fill layers from this data and would drop them.
      const vf = fillToPsd(l.fill);
      if (vf) common.vectorFill = vf;
    }
    if (!bake && l.fillOpacity < 1) {
      // The renderer applies Fill to the content: export it at full fill and let Photoshop apply it.
      common.fillOpacity = l.fillOpacity;
      source = { ...l, fillOpacity: 1 } as Layer;
    }
    const full = renderLayerToDoc(doc, source, { effects: bake, mask: false });
    const b = full ? opaqueBounds(full) : null;
    if (!full || !b) return { ...common, top: 0, left: 0, bottom: 0, right: 0 };
    const c = createCanvas(b.width, b.height);
    ctx2d(c).drawImage(full, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
    return { ...common, top: b.y, left: b.x, bottom: b.y + b.height, right: b.x + b.width, canvas: c };
  };
  const children = doc.rootIds.map(convert).filter((c): c is PsdLayer => !!c);
  const comp = renderDocument(doc, { background: true });
  const composite = createCanvas(comp.width, comp.height);
  ctx2d(composite).drawImage(comp, 0, 0);
  const psd: Psd = { width: doc.width, height: doc.height, channels: 4, bitsPerChannel: 8, colorMode: 3, children, canvas: composite };
  return { psd, ...report };
}

export async function exportPsd(opts: PsdExportOptions): Promise<void> {
  const s = activeSession();
  if (!s) {
    toast('Open or create a document to export a PSD (File ▸ New / Open).', 'info');
    return;
  }
  try {
    toast('Preparing PSD…', 'info', 1600);
    await ensureFontsFor(s.doc);
    // Let the toast paint before the (synchronous) layer rendering and encoding.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const { psd, skipped, baked, lostGroupStyles } = buildPsd(s.doc, opts);
    const data = writePsd(psd, { generateThumbnail: true, noBackground: true });
    const res = await saveFile({
      title: 'Export PSD',
      defaultPath: `${safeFileName(s.doc.name)}.psd`,
      filters: [{ name: 'Photoshop Document', extensions: ['psd'] }],
      data,
    });
    if (!res) return;
    const list = (a: string[]) => `${a.slice(0, 3).join(', ')}${a.length > 3 ? '…' : ''}`;
    const notes: string[] = [];
    if (skipped.length) notes.push(`${skipped.length} adjustment layer${skipped.length > 1 ? 's' : ''} without a PSD equivalent skipped (${list(skipped)})`);
    if (baked.length) notes.push(`styles baked into pixels on ${list(baked)}`);
    if (lostGroupStyles.length) notes.push(`group styles not exported: ${list(lostGroupStyles)}`);
    const size = formatBytes(data.byteLength);
    if (notes.length) toast(`Exported PSD (${size}) · ${notes.join(' · ')}`, 'warning', 7000);
    else toast(`Exported PSD (${size})`, 'success');
  } catch (e) {
    console.error('[io] PSD export failed', e);
    toast(`PSD export failed: ${(e as Error).message ?? e}`, 'error', 5000);
  }
}

export async function showExportPsdDialog() {
  if (!activeSession()) {
    toast('Open or create a document to export a PSD (File ▸ New / Open).', 'info');
    return;
  }
  const { PsdExportDialog } = await import('./dialogs/PsdExportDialog');
  const opts = await openDialog<PsdExportOptions>(PsdExportDialog, {});
  if (opts) await exportPsd(opts);
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function maskFromPsd(doc: Document, m: LayerMaskData | undefined): LayerMask | null {
  if (!m || !m.canvas || m.fromVectorData) return null;
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  const d = Math.max(0, Math.min(255, m.defaultColor ?? 255));
  ctx.fillStyle = `rgb(${d},${d},${d})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(m.canvas, m.left ?? 0, m.top ?? 0);
  return { bitmapId: bitmaps.add(c), enabled: !m.disabled, density: m.userMaskDensity ?? 1, feather: m.userMaskFeather ?? 0, inverted: false };
}

/** Convert an ag-psd structure to a Document (bitmaps are registered in the store). */
export function psdToDocument(psd: Psd, name: string): { doc: Document; unsupported: number; styled: number } {
  const doc = createDocument({ name, width: psd.width, height: psd.height, background: null });
  let unsupported = 0;
  let styled = 0;
  const applyCommon = (target: Layer, l: PsdLayer, isGroup: boolean) => {
    target.opacity = Math.max(0, Math.min(1, l.opacity ?? 1));
    target.visible = !l.hidden;
    target.clipped = !!l.clipping;
    if (!isGroup) target.fillOpacity = Math.max(0, Math.min(1, l.fillOpacity ?? 1));
    (target as { blendMode: string }).blendMode = fromPsdBlend(l.blendMode, isGroup);
    if (l.transparencyProtected || l.protected?.transparency) target.locks = { ...target.locks, transparency: true };
    target.mask = maskFromPsd(doc, l.mask);
    // Layer pixels from a PSD exclude layer effects: bring them back as live layer styles.
    target.effects = effectsFromPsd(l.effects, (id) => !effectRegistry.list().length || effectRegistry.has(id));
    if (target.effects.length) styled++;
  };
  const add = (list: PsdLayer[] | undefined, parentId: ID | null) => {
    for (const l of list ?? []) {
      if (l.children) {
        const g = makeGroupLayer({ name: l.name || 'Group' });
        g.collapsed = !l.opened;
        applyCommon(g, l, true);
        insertLayerDraft(doc, g, { parentId });
        add(l.children, g.id);
        continue;
      }
      if (l.adjustment && !l.canvas) {
        const m = fromPsdAdjustment(l.adjustment);
        if (!m || !filters.get(m.filterId)) {
          unsupported++;
          continue;
        }
        const a = makeAdjustmentLayer({ name: l.name || m.name, filterId: m.filterId, params: m.params });
        applyCommon(a, l, false);
        insertLayerDraft(doc, a, { parentId });
        continue;
      }
      // Photoshop Solid Color / Gradient fill layers (without a vector mask = not a shape layer).
      const fill = !l.vectorMask ? fillFromPsd(l.vectorFill) : null;
      if (fill) {
        const f = makeFillLayer({ name: l.name || undefined, fill });
        applyCommon(f, l, false);
        insertLayerDraft(doc, f, { parentId });
        continue;
      }
      let layer;
      if (l.canvas && l.canvas.width > 0 && l.canvas.height > 0) {
        layer = makeRasterLayer({
          name: l.name || 'Layer',
          bitmapId: bitmaps.add(l.canvas),
          width: l.canvas.width,
          height: l.canvas.height,
          transform: { x: l.left ?? 0, y: l.top ?? 0 },
        });
      } else {
        // Empty pixel layer: keep it as a paintable doc-sized layer.
        layer = makeRasterLayer({ name: l.name || 'Layer', bitmapId: bitmaps.create(doc.width, doc.height), width: doc.width, height: doc.height });
      }
      applyCommon(layer, l, false);
      insertLayerDraft(doc, layer, { parentId });
    }
  };
  if (psd.children?.length) add(psd.children, null);
  else if (psd.canvas) {
    const layer = makeRasterLayer({ name: 'Background', bitmapId: bitmaps.add(psd.canvas), width: psd.canvas.width, height: psd.canvas.height });
    insertLayerDraft(doc, layer, {});
  } else throw new Error('the PSD contains no readable layers');
  return { doc, unsupported, styled };
}

export async function importPsd(file: OpenedFile): Promise<Document> {
  let psd: Psd;
  try {
    psd = readPsd(file.data, { skipThumbnail: true, skipLinkedFilesData: true });
  } catch (e) {
    throw new Error(`not a readable Photoshop file (${(e as Error).message})`);
  }
  if (psd.colorMode !== undefined && psd.colorMode !== 3 && psd.colorMode !== 1)
    toast('This PSD is not in RGB mode — colors may look different.', 'warning', 4000);
  const { doc, unsupported } = psdToDocument(psd, baseName(file.name));
  useEditor.getState().openDocument(doc, { label: 'Open PSD' });
  if (unsupported) toast(`${unsupported} PSD adjustment/special layer${unsupported > 1 ? 's were' : ' was'} not supported and skipped`, 'warning', 4500);
  return doc;
}
