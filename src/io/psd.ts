/**
 * Photoshop (.psd) export and import via ag-psd.
 *  - Export: every leaf layer is rendered (optionally with baked layer styles), groups become PSD
 *    folders; names, opacity, blend modes, visibility, clipping, masks and a composite image are kept.
 *    Adjustment layers with a Photoshop equivalent are written as native adjustment layers (see
 *    psdAdjustments.ts); the others (duotone, split toning, color lookup, vignette…) are baked into
 *    a pixel layer showing their effect on what is below them, with the same mask, opacity and
 *    blending (exact over opaque pixels and inside clipping masks whose base has full fill; see
 *    psdBake.ts). The document background colour becomes a bottom "Background Color" fill layer.
 *  - Import: pixel layers → raster layers (left/top → transform), groups, masks, opacity, blending,
 *    visibility, clipping, supported adjustment layers; our "Background Color" layer becomes the
 *    document background again.
 */
import { readPsd, writePsd, type Layer as PsdLayer, type Psd, type LayerMaskData } from 'ag-psd';
import type { AdjustmentLayer, Document, FillLayer, ID, Layer, LayerMask, ParamValues } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, ctx2d, opaqueBounds } from '../core/canvas';
import { createDocument, insertLayerDraft, makeAdjustmentLayer, makeFillLayer, makeGroupLayer, makeRasterLayer, parentOf, siblingsOf } from '../core/document';
import { effectStage, renderDocument, renderLayerToDoc } from '../render/compositor';
import { effects as effectRegistry, filters } from '../registry';
import { makeFilterContext, resolveParams, runFilter } from '../filters/engine';
import { saveFile, type OpenedFile } from '../platform';
import { activeSession, useEditor } from '../state/editor';
import { openDialog, toast } from '../state/ui';
import { formatBytes, fromPsdBlend, safeFileName, toPsdBlend } from './math';
import { effectLabel, effectsFromPsd, effectsToPsd, fillFromPsd, fillToPsd, representableGradient, toPsdColor } from './psdEffects';
import { fromPsdAdjustment, toPsdAdjustment } from './psdAdjustments';
import { alphaChannel, finishBakedPixels } from './psdBake';
import { backgroundLayerOf, baseName, ensureFontsFor } from './util';

/** Name of the bottom fill layer that carries the document background colour in exported PSDs. */
export const PSD_BACKGROUND_LAYER = 'Background Color';

function paramsOf(filterId: string, params: ParamValues): ParamValues {
  const def = filters.get(filterId);
  return def ? resolveParams(def, params) : params;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
  /** Adjustment layers that could not be exported at all (unknown filter). */
  skipped: string[];
  /** Adjustment layers with no PSD equivalent, baked into pixel layers. */
  bakedAdjustments: string[];
  /**
   * Baked adjustments that are only approximate (see psdBake.ts): not clipped, over semi-transparent
   * pixels (soft edges inside an isolated group or a transparent document come out denser in
   * Photoshop); or clipped to a base whose clip stack doesn't match its shape (fill below 100%,
   * styles adding coverage such as a centre stroke).
   */
  approxAdjustments: string[];
  /** Gradient fill layers written as plain pixels (Photoshop's fill data can't hold their geometry closely enough). */
  rasterizedFills: string[];
  /** Layers whose styles had to be baked into pixels (no Photoshop equivalent). */
  baked: string[];
  /** Groups whose styles could not be exported (folders cannot hold baked pixels). */
  lostGroupStyles: string[];
}

/** Copy of a (cached, shared) render so later renders can't change it. */
function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

/** Render `rootIds` of `doc` on their own (doc space, transparent), optionally only below `below`. */
function renderIsolated(doc: Document, rootIds: ID[], overrides: Record<ID, Layer>, below?: ID): HTMLCanvasElement {
  const temp: Document = { ...doc, id: `${doc.id}~psd-bake`, background: null, layers: { ...doc.layers, ...overrides }, rootIds, selection: null };
  return copyCanvas(renderDocument(temp, { background: false, below }));
}

/**
 * What an adjustment layer applies to (doc space): everything below it — or, inside an isolated
 * (non pass-through) group, the group's content below it; for a clipped adjustment, its clip base
 * plus the layers clipped to it below the adjustment, with `clipShape` = the alpha channel of the
 * base's shape (the clip stack's coverage, see psdBake.ts; null when not clipped).
 */
function adjustmentBackdrop(doc: Document, l: AdjustmentLayer): { canvas: HTMLCanvasElement; clipShape: Uint8Array | null } {
  if (l.clipped) {
    const sibs = siblingsOf(doc, l.id);
    const i = sibs.indexOf(l.id);
    let baseIdx = i - 1;
    while (baseIdx >= 0 && doc.layers[sibs[baseIdx]]?.clipped) baseIdx--;
    const base = baseIdx >= 0 ? doc.layers[sibs[baseIdx]] : undefined;
    if (base && base.type !== 'adjustment') {
      // The clip stack composites the base's content at full opacity; its own opacity/blend apply
      // to the whole stack afterwards, and its behind-stage styles (shadows, outer glow) are drawn
      // under the stack, so clipped layers never see them.
      const solo = {
        ...base,
        opacity: 1,
        clipped: false,
        blendMode: base.type === 'group' && base.blendMode === 'pass-through' ? 'pass-through' : 'normal',
        effects: base.effects.filter((e) => {
          const def = effectRegistry.get(e.effectId);
          return !def || !e.enabled || effectStage(def, e.params) !== 'behind';
        }),
      } as Layer;
      const shape = { ...solo, fillOpacity: 1, effects: [] } as Layer;
      return {
        canvas: renderIsolated(doc, sibs.slice(baseIdx, i), { [base.id]: solo }),
        clipShape: alphaChannel(readPixels(renderIsolated(doc, [base.id], { [base.id]: shape }))),
      };
    }
  }
  for (let p = parentOf(doc, l.id); p; p = parentOf(doc, p)) {
    const g = doc.layers[p];
    if (g?.type === 'group' && g.blendMode !== 'pass-through') return { canvas: renderIsolated(doc, g.childIds, {}, l.id), clipShape: null };
  }
  return { canvas: copyCanvas(renderDocument(doc, { below: l.id, background: true })), clipShape: null };
}

/**
 * An adjustment Photoshop doesn't have, rendered into pixels (doc-sized), or null (unknown filter).
 * `opacity` is the layer's total strength (for the exactness check, see psdBake.ts).
 */
function bakeAdjustment(doc: Document, l: AdjustmentLayer, opacity: number): { canvas: HTMLCanvasElement; approx: boolean } | null {
  const def = filters.get(l.adjustment.filterId);
  if (!def) return null;
  const { canvas: c, clipShape } = adjustmentBackdrop(doc, l);
  const ctx = ctx2d(c, { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const alpha = alphaChannel(img.data);
  const out = runFilter(def, img, l.adjustment.params, makeFilterContext({ docWidth: doc.width, docHeight: doc.height }));
  const approx = finishBakedPixels(out.data, alpha, opacity, clipShape);
  ctx.putImageData(out, 0, 0);
  return { canvas: c, approx };
}

/** Largest per-channel difference allowed between a fill and its Photoshop-storable version. */
const FILL_ROUNDING_LEVELS = 2;

/**
 * Photoshop fill data for a fill layer, or null to keep it as plain pixels. ag-psd stores gradient
 * scale/offset as whole percents: a gradient that needs rounding is only written as an editable fill
 * when the rounded version renders within FILL_ROUNDING_LEVELS of the original (`full`); otherwise
 * Photoshop (and a re-import) would show a visibly shifted gradient, so the exact pixels are kept.
 */
function fillVectorData(doc: Document, l: FillLayer, full: HTMLCanvasElement | null): ReturnType<typeof fillToPsd> {
  const exact = fillToPsd(l.fill);
  if (exact || l.fill.type !== 'gradient' || !full) return exact;
  const fill = { ...l.fill, gradient: representableGradient(l.fill.gradient) };
  const vf = fillToPsd(fill);
  if (!vf) return null;
  const want = readPixels(full);
  const near = renderLayerToDoc(doc, { ...l, fill }, { effects: false, mask: false });
  if (!near || near.width !== full.width || near.height !== full.height) return null;
  const got = readPixels(near);
  for (let i = 0; i < want.length; i++) if (Math.abs(want[i] - got[i]) > FILL_ROUNDING_LEVELS) return null;
  return vf;
}

function readPixels(c: HTMLCanvasElement): Uint8ClampedArray {
  const s = createCanvas(c.width, c.height);
  const ctx = ctx2d(s, { willReadFrequently: true });
  ctx.drawImage(c, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

/** True when the bottom layer is an opaque, doc-covering "Background" that hides doc.background. */
function backgroundHidden(doc: Document): boolean {
  const bg = backgroundLayerOf(doc);
  if (!bg || !bg.visible || bg.opacity < 1 || bg.fillOpacity < 1 || bg.blendMode !== 'normal' || (bg.mask && bg.mask.enabled)) return false;
  const src = bitmaps.tryGet(bg.bitmapId);
  if (!src) return false;
  try {
    // Read a scratch copy: reading the live bitmap back would move it off the GPU for good.
    const c = createCanvas(src.width, src.height);
    const ctx = ctx2d(c, { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return false;
    return true;
  } catch {
    return false;
  }
}

/** Bottom fill layer carrying the document background colour (null when none or fully covered). */
function backgroundToPsd(doc: Document): PsdLayer | null {
  if (!doc.background || backgroundHidden(doc)) return null;
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  ctx.fillStyle = doc.background;
  ctx.fillRect(0, 0, c.width, c.height);
  return {
    name: PSD_BACKGROUND_LAYER,
    opacity: 1,
    blendMode: 'normal',
    top: 0,
    left: 0,
    bottom: doc.height,
    right: doc.width,
    canvas: c,
    vectorFill: { type: 'color', color: toPsdColor(doc.background, '#ffffff') },
  };
}

/** Build the ag-psd structure for a document. */
export function buildPsd(doc: Document, opts: PsdExportOptions): { psd: Psd } & PsdBuildReport {
  const report: PsdBuildReport = { skipped: [], bakedAdjustments: [], approxAdjustments: [], rasterizedFills: [], baked: [], lostGroupStyles: [] };
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
      if (fx.unsupported.length)
        report.lostGroupStyles.push(`${l.name} (${fx.unsupported.map((e) => effectLabel(e.effectId)).join(', ')})`);
      if (l.fillOpacity < 1) common.fillOpacity = l.fillOpacity;
      const children = l.childIds.map(convert).filter((c): c is PsdLayer => !!c);
      return { ...common, opened: !l.collapsed, children };
    }
    if (l.type === 'adjustment') {
      const inst = l.adjustment;
      // Our adjustment strength is opacity × fill × the instance's own opacity.
      common.opacity = clamp01(l.opacity * (Number.isFinite(l.fillOpacity) ? l.fillOpacity : 1) * (inst.opacity ?? 1));
      if (!inst.enabled) common.hidden = true;
      const a = toPsdAdjustment(inst.filterId, paramsOf(inst.filterId, inst.params));
      if (a) return { ...common, adjustment: a };
      const baked = bakeAdjustment(doc, l, common.opacity ?? 1);
      if (!baked) {
        report.skipped.push(l.name);
        return null;
      }
      report.bakedAdjustments.push(l.name);
      if (baked.approx) report.approxAdjustments.push(l.name);
      const bb = opaqueBounds(baked.canvas);
      if (!bb) return { ...common, top: 0, left: 0, bottom: 0, right: 0 };
      const c = createCanvas(bb.width, bb.height);
      ctx2d(c).drawImage(baked.canvas, bb.x, bb.y, bb.width, bb.height, 0, 0, bb.width, bb.height);
      return { ...common, top: bb.y, left: bb.x, bottom: bb.y + bb.height, right: bb.x + bb.width, canvas: c };
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
    if (!bake && l.fillOpacity < 1) {
      // The renderer applies Fill to the content: export it at full fill and let Photoshop apply it.
      common.fillOpacity = l.fillOpacity;
      source = { ...l, fillOpacity: 1 } as Layer;
    }
    const full = renderLayerToDoc(doc, source, { effects: bake, mask: false });
    if (source.type === 'fill' && !bake) {
      // Solid/gradient fills stay editable Photoshop fill layers (pixels are written too). Not when
      // styles are baked: Photoshop re-renders fill layers from this data and would drop them.
      const vf = fillVectorData(doc, source, full);
      if (vf) common.vectorFill = vf;
      else if (source.fill.type === 'gradient') report.rasterizedFills.push(l.name);
    }
    const b = full ? opaqueBounds(full) : null;
    if (!full || !b) return { ...common, top: 0, left: 0, bottom: 0, right: 0 };
    const c = createCanvas(b.width, b.height);
    ctx2d(c).drawImage(full, b.x, b.y, b.width, b.height, 0, 0, b.width, b.height);
    return { ...common, top: b.y, left: b.x, bottom: b.y + b.height, right: b.x + b.width, canvas: c };
  };
  const children = doc.rootIds.map(convert).filter((c): c is PsdLayer => !!c);
  const bg = backgroundToPsd(doc);
  if (bg) children.unshift(bg);
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
    const { psd, skipped, bakedAdjustments, approxAdjustments, rasterizedFills, baked, lostGroupStyles } = buildPsd(s.doc, opts);
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
    if (bakedAdjustments.length)
      notes.push(
        `${bakedAdjustments.length} adjustment layer${bakedAdjustments.length > 1 ? 's' : ''} without a Photoshop equivalent baked into pixels (${list(bakedAdjustments)})`,
      );
    if (approxAdjustments.length) notes.push(`baked approximately: ${list(approxAdjustments)}`);
    if (rasterizedFills.length) notes.push(`gradient fills exported as pixels: ${list(rasterizedFills)}`);
    if (skipped.length) notes.push(`${skipped.length} unknown adjustment layer${skipped.length > 1 ? 's' : ''} left out (${list(skipped)})`);
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
  return {
    bitmapId: bitmaps.add(c),
    enabled: !m.disabled,
    density: m.userMaskDensity ?? 1,
    feather: m.userMaskFeather ?? 0,
    inverted: false,
  };
}

/** The colour of an exported "Background Color" layer (plain solid fill at the bottom), or null. */
function backgroundFromPsd(l: PsdLayer): string | null {
  if (l.name !== PSD_BACKGROUND_LAYER || l.children || l.adjustment || l.hidden || l.clipping || l.vectorMask) return null;
  if ((l.opacity ?? 1) < 1 || (l.fillOpacity ?? 1) < 1 || (l.blendMode && l.blendMode !== 'normal') || l.mask?.canvas || l.effects) return null;
  const fill = fillFromPsd(l.vectorFill);
  return fill?.type === 'solid' ? fill.color : null;
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
        layer = makeRasterLayer({
          name: l.name || 'Layer',
          bitmapId: bitmaps.create(doc.width, doc.height),
          width: doc.width,
          height: doc.height,
        });
      }
      applyCommon(layer, l, false);
      insertLayerDraft(doc, layer, { parentId });
    }
  };
  let list = psd.children ?? [];
  // Our own "Background Color" layer (see backgroundToPsd) is the document background again.
  const bottom = list[0];
  const bgFill = bottom && list.length > 1 ? backgroundFromPsd(bottom) : null;
  if (bgFill) {
    doc.background = bgFill;
    list = list.slice(1);
  }
  if (list.length) add(list, null);
  else if (psd.canvas) {
    const layer = makeRasterLayer({
      name: 'Background',
      bitmapId: bitmaps.add(psd.canvas),
      width: psd.canvas.width,
      height: psd.canvas.height,
    });
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
  if (unsupported)
    toast(`${unsupported} PSD adjustment/special layer${unsupported > 1 ? 's were' : ' was'} not supported and skipped`, 'warning', 4500);
  return doc;
}
