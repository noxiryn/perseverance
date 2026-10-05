/**
 * Menus: Image ▸ Adjustments (destructive), Layer ▸ New Adjustment Layer,
 * Image ▸ Auto Tone / Auto Contrast / Auto Color, Image ▸ Adjustments ▸ Desaturate.
 * Destructive adjustments open fx-filters' openFilterDialog(id, { mode: 'destructive' }), except
 * the ones with a dedicated editor (Levels, Curves, Color Balance, Selective Color, Exposure) and
 * edits of a non-pixel layer's mask, which open this module's AdjustmentDialog.
 * Adjustment commands are kept in sync with the filters registry, so adjustments registered by
 * other modules (e.g. Vignette) show up automatically.
 */
import { CircleSlash, Contrast, Palette, WandSparkles } from 'lucide-react';
import type { CurvesValue, ParamValues } from '../../core/types';
import { commands, filters, type CommandDef, type FilterDef } from '../../registry';
import { activeDoc, activeSession } from '../../state/editor';
import { toast } from '../../state/ui';
import { renderDocument } from '../../render/compositor';
import { analysisMask, autoColorCurves, autoContrastParams, autoToneCurves } from './auto';
import { activeRasterTarget, editRasterPixels, readTargetPixels, runAdjustment, targetFilterContext } from './apply';
import { CUSTOM_EDITOR_IDS } from './AdjustmentParams';
import { openAdjustmentDialog } from './AdjustmentDialog';
import { computeHistogram, readDownscaled } from './histogram';
import { createAdjustmentLayer, layersAbove, NO_DOC_MESSAGE } from './layers';
import { applyLuts } from './math';
import { orderAdjustments } from './presets';
import { curvesLuts, levelsLutFromParams } from './defs/tonal';
import { hueSaturationPixels } from './defs/color';

/** Photoshop shortcuts for the destructive adjustment commands. */
const SHORTCUTS: Record<string, string> = {
  levels: 'Ctrl+L',
  curves: 'Ctrl+M',
  'hue-saturation': 'Ctrl+U',
  'color-balance': 'Ctrl+B',
  'black-white': 'Alt+Shift+Ctrl+B',
  invert: 'Ctrl+I',
};

const DESTRUCTIVE_CATEGORIES = new Set(['Adjustments', 'Color']);
const SUBGROUP = ['', '-b', '-c', '-d', '-e'];

const hasDoc = () => !!activeDoc();

function applyDestructive(def: FilterDef) {
  const s = activeSession();
  if (!s) return toast(NO_DOC_MESSAGE, 'info');
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!layer) return toast(`Select a layer to apply ${def.name}.`, 'info');
  const onMask = s.editTarget === 'mask' && !!layer.mask;
  const nonPixel = layer.type === 'adjustment' || layer.type === 'group' || layer.type === 'fill';
  // The layer mask is the edit target: adjust the mask, whatever the layer type (e.g. Ctrl+I
  // inverts an adjustment layer's mask). Checked before rejecting non-pixel layers.
  if (onMask && !def.params.length) {
    const target = activeRasterTarget(`apply ${def.name}`);
    if (target) editRasterPixels(target, def.name, (img) => runAdjustment(def, img, {}, targetFilterContext(target)));
    return;
  }
  if (CUSTOM_EDITOR_IDS.has(def.id) || (onMask && nonPixel)) {
    void openAdjustmentDialog(def).catch((err) => {
      console.error(err);
      toast(`Couldn't open the ${def.name} dialog.`, 'error');
    });
    return;
  }
  if (nonPixel) {
    const what = layer.type === 'group' ? 'a group' : layer.type === 'adjustment' ? 'an adjustment layer' : 'a fill layer';
    return toast(`${def.name} can't be applied to ${what}. Use Layer ▸ New Adjustment Layer ▸ ${def.name} instead.`, 'warning');
  }
  // Loaded lazily: the dialog (fx-filters module) is heavy and not needed at startup.
  void import('../ui/filterDialog')
    .then((m) => m.openFilterDialog(def.id, { mode: 'destructive' }))
    .catch((err) => {
      console.error(err);
      toast(`Couldn't open the ${def.name} dialog.`, 'error');
    });
}

let registered = new Set<string>();
let signature = '';

/** (Re)register one command per adjustment filter for both menus. */
export function syncAdjustmentCommands() {
  const defs = filters.list().filter((f) => f.adjustment && !f.hidden);
  const sig = defs.map((d) => `${d.id}:${d.name}:${d.category}`).join('|');
  if (sig === signature) return;
  signature = sig;
  const rows = orderAdjustments(defs);
  const next: CommandDef[] = [];
  rows.forEach((row, ri) => {
    row.forEach((def, i) => {
      const order = ri * 100 + i * 10;
      next.push({
        id: `adjustments.newLayer.${def.id}`,
        // No ellipsis: the layer is created immediately (its settings open in Properties).
        label: def.name,
        menu: 'Layer/New Adjustment Layer',
        group: `20-fill${SUBGROUP[Math.min(ri, SUBGROUP.length - 1)]}`,
        order: 500 + order,
        icon: def.icon,
        keywords: ['adjustment layer', 'new', ...(def.keywords ?? [])],
        enabled: hasDoc,
        run: () => {
          createAdjustmentLayer(def.id, { reveal: true });
        },
      });
      if (DESTRUCTIVE_CATEGORIES.has(def.category)) {
        next.push({
          id: `adjustments.apply.${def.id}`,
          label: def.params.length ? `${def.name}…` : def.name,
          menu: 'Image/Adjustments',
          group: `10-adjustments${SUBGROUP[Math.min(ri, SUBGROUP.length - 1)]}`,
          order,
          shortcut: SHORTCUTS[def.id],
          icon: def.icon,
          keywords: ['adjust', 'destructive', ...(def.keywords ?? [])],
          enabled: hasDoc,
          run: () => applyDestructive(def),
        });
      }
    });
  });
  const ids = new Set(next.map((c) => c.id));
  for (const id of registered) if (!ids.has(id)) commands.unregister(id);
  commands.registerMany(next);
  registered = ids;
}

/* ================================================================== */
/* Auto Tone / Contrast / Color                                        */
/* ================================================================== */

type AutoKind = 'tone' | 'contrast' | 'color';
const AUTO_LABEL: Record<AutoKind, string> = { tone: 'Auto Tone', contrast: 'Auto Contrast', color: 'Auto Color' };

function autoParams(
  kind: AutoKind,
  img: ImageData,
  selection: ArrayLike<number> | null,
): { filterId: 'levels' | 'curves'; params: ParamValues } | null {
  const mask = analysisMask(img, selection);
  if (kind === 'contrast') {
    const p = autoContrastParams(computeHistogram(img, { mask }));
    return p ? { filterId: 'levels', params: { ...p } } : null;
  }
  const c: CurvesValue | null = kind === 'tone' ? autoToneCurves(computeHistogram(img, { mask })) : autoColorCurves(img, mask);
  return c ? { filterId: 'curves', params: { curves: c } } : null;
}

export function runAuto(kind: AutoKind) {
  const s = activeSession();
  if (!s) return toast(NO_DOC_MESSAGE, 'info');
  const label = AUTO_LABEL[kind];
  const layer = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;

  // Pixel layer (or its mask when the mask is the edit target): destructive, one bitmap patch.
  if (layer?.type === 'raster' || (layer?.mask && s.editTarget === 'mask')) {
    const target = activeRasterTarget(label.toLowerCase());
    if (!target) return;
    const px = readTargetPixels(target);
    const res = autoParams(kind, px, target.mask);
    const what = target.kind === 'mask' ? 'mask' : 'layer';
    if (!res) return toast(`${label}: the ${what} already uses its full tonal range — nothing to change.`, 'info');
    const luts =
      res.filterId === 'levels'
        ? (() => {
            const l = levelsLutFromParams(res.params);
            return { r: l, g: l, b: l };
          })()
        : curvesLuts(res.params.curves);
    editRasterPixels(target, label, (img) => applyLuts(img, luts.r, luts.g, luts.b));
    return;
  }

  // Non-pixel layer (or none): analyse the composite up to the active layer and add an
  // adjustment layer above it with the computed parameters.
  const doc = s.doc;
  const maxSide = Math.max(doc.width, doc.height);
  const scale = Math.min(1, 640 / maxSide);
  const hidden = layer ? layersAbove(doc, layer.id) : undefined;
  const composite = renderDocument(doc, { scale, hidden });
  const img = readDownscaled(composite, 640);
  const res = autoParams(kind, img, null);
  if (!res) return toast(`${label}: the image already uses its full tonal range — nothing to change.`, 'info');
  // The history label says what happened (the shell announces it: "Auto Contrast (Levels Layer)
  // completed."), so no extra toast. Inside a clipping group the layer joins it.
  const kindName = res.filterId === 'levels' ? 'Levels' : 'Curves';
  createAdjustmentLayer(res.filterId, { params: res.params, name: label, label: `${label} (${kindName} Layer)`, ignoreClipPref: true });
}

function desaturate() {
  const target = activeRasterTarget('desaturate');
  if (!target) return;
  if (target.kind === 'mask') {
    toast('Layer masks are grayscale — Desaturate has no effect. Click the layer thumbnail to edit its pixels instead.', 'info');
    return;
  }
  editRasterPixels(target, 'Desaturate', (img) => hueSaturationPixels(img, { saturation: -100 }));
}

export function registerStaticCommands() {
  commands.registerMany([
    {
      id: 'image.autoTone',
      label: 'Auto Tone',
      menu: 'Image',
      group: '20-auto',
      order: 10,
      shortcut: 'Shift+Ctrl+L',
      icon: WandSparkles,
      keywords: ['auto', 'levels', 'tone', 'contrast', 'enhance'],
      enabled: hasDoc,
      run: () => runAuto('tone'),
    },
    {
      id: 'image.autoContrast',
      label: 'Auto Contrast',
      menu: 'Image',
      group: '20-auto',
      order: 20,
      shortcut: 'Alt+Shift+Ctrl+L',
      icon: Contrast,
      keywords: ['auto', 'contrast', 'enhance'],
      enabled: hasDoc,
      run: () => runAuto('contrast'),
    },
    {
      id: 'image.autoColor',
      label: 'Auto Color',
      menu: 'Image',
      group: '20-auto',
      order: 30,
      shortcut: 'Shift+Ctrl+B',
      icon: Palette,
      keywords: ['auto', 'color', 'white balance', 'cast', 'neutral'],
      enabled: hasDoc,
      run: () => runAuto('color'),
    },
    {
      id: 'adjustments.desaturate',
      label: 'Desaturate',
      menu: 'Image/Adjustments',
      // Own trailing group, like Photoshop (after the adjustment rows).
      group: '10-adjustments-z',
      order: 10,
      shortcut: 'Shift+Ctrl+U',
      icon: CircleSlash,
      keywords: ['desaturate', 'grayscale', 'gray', 'remove color'],
      enabled: hasDoc,
      run: desaturate,
    },
  ]);
}
