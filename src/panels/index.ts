/**
 * layers-panels module entry (imported by src/features.ts): registers the Layers, Properties,
 * Effects, History and Navigator panels and the whole Layer menu.
 */
import { Compass, History, Layers, SlidersHorizontal, Sparkle } from 'lucide-react';
import { panels } from '../registry';
import { LayersPanel, layersPanelMenu } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { EffectsPanel } from './EffectsPanel';
import { HistoryPanel } from './HistoryPanel';
import { NavigatorPanel } from './NavigatorPanel';
import { registerLayerCommands } from './commands';
import { useEditor } from '../state/editor';
import * as ops from './layerOps';

panels.register({
  id: 'navigator',
  title: 'Navigator',
  icon: Compass,
  component: NavigatorPanel,
  defaultSlot: 'top',
  order: 10,
});

panels.register({
  id: 'layers',
  title: 'Layers',
  icon: Layers,
  component: LayersPanel,
  defaultSlot: 'bottom',
  order: 10,
  menu: layersPanelMenu,
});

panels.register({
  id: 'properties',
  title: 'Properties',
  icon: SlidersHorizontal,
  component: PropertiesPanel,
  defaultSlot: 'bottom',
  order: 20,
});

panels.register({
  id: 'history',
  title: 'History',
  icon: History,
  component: HistoryPanel,
  defaultSlot: 'bottom',
  order: 30,
  menu: () => {
    const st = useEditor.getState();
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return [
      { label: 'Step Backward', run: () => st.undo(), disabled: !s || s.history.index <= 0 },
      { label: 'Step Forward', run: () => st.redo(), disabled: !s || s.history.index >= s.history.entries.length - 1 },
    ];
  },
});

panels.register({
  id: 'effects',
  title: 'Effects',
  icon: Sparkle,
  component: EffectsPanel,
  defaultSlot: 'strip',
  order: 20,
  menu: () => [
    { label: 'Copy Layer Style', run: ops.copyStyle, disabled: !ops.hasLayer() },
    { label: 'Paste Layer Style', run: ops.pasteStyle, disabled: !ops.useLayersUI.getState().styleClipboard },
    { label: 'Clear Layer Style', run: ops.clearStyle, disabled: !ops.hasLayer() },
  ],
});

registerLayerCommands();
