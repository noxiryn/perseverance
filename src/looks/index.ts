/** Module entry: registers looks, the Looks panel and look commands (imported by src/features.ts). */
import { WandSparkles, Eraser } from 'lucide-react';
import { commands, looks, panels } from '../registry';
import { activeDoc } from '../state/editor';
import { useUI } from '../state/ui';
import { BUILTIN_LOOKS } from './defs';
import { hasLook, removeLook, resolveTarget } from './engine';
import { LooksPanel } from './LooksPanel';
import { currentTargetId, useLooksUI } from './store';

export { applyLook, removeLook } from './engine';
export { currentTargetId } from './store';
export { renderLookPreview } from './preview';

looks.registerMany(BUILTIN_LOOKS);

/** The effective target of the Looks panel right now (same resolution the panel uses). */
function resolvedTargetId() {
  const doc = activeDoc();
  return doc ? resolveTarget(doc, currentTargetId()).targetId : null;
}

panels.register({
  id: 'looks',
  title: 'Looks',
  icon: WandSparkles,
  component: LooksPanel,
  defaultSlot: 'middle',
  order: 30,
  menu: () => {
    const st = useLooksUI.getState();
    const doc = activeDoc();
    return [
      { label: 'Apply to Active Layer', checked: st.target === 'layer', run: () => st.setTarget('layer') },
      { label: 'Apply to Whole Document', checked: st.target === 'doc', run: () => st.setTarget('doc') },
      { label: 'Live Previews', checked: st.previews, run: () => st.setPreviews(!st.previews) },
      { label: 'Remove Look', disabled: !doc || !hasLook(doc, resolvedTargetId()), run: () => removeLook(resolvedTargetId()) },
    ];
  },
});

commands.register({
  id: 'looks.remove',
  label: 'Remove Look',
  icon: Eraser,
  keywords: ['look', 'style', 'preset', 'clear'],
  enabled: () => !!activeDoc(),
  run: () => removeLook(resolvedTargetId()),
});

commands.register({
  id: 'looks.showPanel',
  label: 'Browse Looks…',
  icon: WandSparkles,
  keywords: ['look', 'style', 'preset', 'filter', 'grade'],
  run: () => useUI.getState().showPanel('looks'),
});

// Individual looks are listed in the command palette by the shell (one entry per registered look).
