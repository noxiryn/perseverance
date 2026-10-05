/**
 * Adjustments module entry (imported by src/features.ts).
 * Registers: all adjustment filters (adjustment: true), the Adjustments panel, the
 * 'adjustment-params' Properties section, Image ▸ Adjustments / Auto commands and
 * Layer ▸ New Adjustment Layer commands (kept in sync with the filters registry).
 */
import { createElement } from 'react';
import { Blend } from 'lucide-react';
import { filters, panels, propertiesSections } from '../../registry';
import { activeDoc, activeSession } from '../../state/editor';
import { TONAL_DEFS } from './defs/tonal';
import { COLOR_DEFS } from './defs/color';
import { MAPPING_DEFS } from './defs/mapping';
import { AdjustmentsPanel } from './AdjustmentsPanel';
import { AdjustmentEditor } from './AdjustmentEditor';
import { registerStaticCommands, syncAdjustmentCommands } from './commands';
import { deleteAdjustmentLayer, resetAdjustment } from './layers';
import { useAdjustmentsPrefs } from './prefs';
import { prewarmLook } from './looks';

export const ADJUSTMENT_DEFS = [...TONAL_DEFS, ...COLOR_DEFS, ...MAPPING_DEFS];

filters.registerMany(ADJUSTMENT_DEFS);

const activeAdjustmentId = (): string | null => {
  const s = activeSession();
  const l = s?.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  return l && l.type === 'adjustment' ? l.id : null;
};

panels.register({
  id: 'adjustments',
  title: 'Adjustments',
  icon: Blend,
  component: AdjustmentsPanel,
  defaultSlot: 'strip',
  order: 10,
  menu: () => {
    const prefs = useAdjustmentsPrefs.getState();
    const adj = activeAdjustmentId();
    return [
      { label: 'Clip to Layer by Default', checked: prefs.clipByDefault, run: () => prefs.set({ clipByDefault: !prefs.clipByDefault }) },
      { label: 'Show Adjustment Presets', checked: prefs.showPresets, run: () => prefs.set({ showPresets: !prefs.showPresets }) },
      { label: 'Reset Adjustment', disabled: !adj, run: () => adj && resetAdjustment(adj) },
      { label: 'Delete Adjustment Layer', disabled: !adj, run: () => adj && deleteAdjustmentLayer(adj) },
    ];
  },
});

propertiesSections.register({
  id: 'adjustment-params',
  order: 20,
  title: 'Adjustment',
  appliesTo: (layerId) => activeDoc()?.layers[layerId]?.type === 'adjustment',
  component: ({ layerId }) => createElement(AdjustmentEditor, { key: layerId, layerId, context: 'properties' }),
});

registerStaticCommands();
syncAdjustmentCommands();
filters.subscribe(syncAdjustmentCommands);

// Build the default Color Lookup cube while the app is idle, so adding the layer is instant.
prewarmLook('teal-orange');

/* Public API for other modules (e.g. the Layers panel's adjustment button, looks). */
export { createAdjustmentLayer, revealEditor } from './layers';
export { AdjustmentEditor } from './AdjustmentEditor';
export { openAdjustmentDialog } from './AdjustmentDialog';
export { runAuto } from './commands';
export { presetsFor } from './presets';
export * from './histogram';
