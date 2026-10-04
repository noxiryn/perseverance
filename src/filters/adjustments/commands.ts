/**
 * Menus: Image ▸ Adjustments (destructive, via the filter dialog), Layer ▸ New Adjustment Layer,
 * Image ▸ Auto Tone / Auto Contrast / Auto Color, Image ▸ Adjustments ▸ Desaturate.
 * Adjustment commands are kept in sync with the filters registry, so adjustments registered by
 * other modules (e.g. Vignette) show up automatically.
 */
import { CircleSlash, Contrast, Palette, WandSparkles } from 'lucide-react';
import type { CurvesValue, ParamValues } from '../../core/types';
import { commands, filters, type CommandDef, type FilterDef } from '../../registry';
import { activeDoc, activeSession } from '../../state/editor';
import { toast } from '../../state/ui';
import { renderDocument } from '../../render/compositor';
import { autoColorCurves, autoContrastParams, autoToneCurves } from './auto';
import { activeRasterTarget, editRasterPixels, readLayerPixels } from './apply';
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
  if (layer.type === 'adjustment' || layer.type === 'group' || layer.type === 'fill') {
    return toast(
      `${def.name} can't be applied to ${layer.type === 'group' ? 'a group' : `a ${layer.type} layer`}. Use Layer ▸ New Adjustment Layer ▸ ${def.name} instead.`,
      'warning',
    );
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
  const defs = filters.list().filter((f) => f.adjustment);
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
        label: `${def.name}…`,
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

function autoParams(kind: AutoKind, img: ImageData, mask: ArrayLike<number> | null): { filterId: 'levels' | 'curves'; params: ParamValues } | null {
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

  if (layer?.type === 'raster') {
    const target = activeRasterTarget(label.toLowerCase());
    if (!target) return;
    const px = readLayerPixels(target.layer);
    const res = autoParams(kind, px, target.mask);
    if (!res) return toast(`${label}: the layer already uses its full tonal range — nothing to change.`, 'info');
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
  const id = createAdjustmentLayer(res.filterId, { params: res.params, name: label, label, clipped: false });
  if (id) toast(`${label} added as a ${res.filterId === 'levels' ? 'Levels' : 'Curves'} adjustment layer.`, 'success');
}

function desaturate() {
  const target = activeRasterTarget('desaturate');
  if (!target) return;
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
      group: '10-adjustments-c',
      order: 250,
      shortcut: 'Shift+Ctrl+U',
      icon: CircleSlash,
      keywords: ['desaturate', 'grayscale', 'gray', 'remove color'],
      enabled: hasDoc,
      run: desaturate,
    },
  ]);
}
