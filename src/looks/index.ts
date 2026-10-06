/** Module entry: registers looks, the Looks panel and look commands (imported by src/features.ts). */
import { WandSparkles, Eraser, BookmarkPlus } from 'lucide-react';
import { commands, looks, panels } from '../registry';
import { activeDoc } from '../state/editor';
import { useUI } from '../state/ui';
import { BUILTIN_LOOKS } from './defs';
import { canRemoveLook, removeLook } from './engine';
import { LooksPanel } from './LooksPanel';
import { currentTargetId, useLooksUI } from './store';
import { loadUserLooks, saveCurrentLook } from './userLooks';

export { applyLook, removeLook } from './engine';
export { currentTargetId } from './store';
export { renderLookPreview } from './preview';

looks.registerMany(BUILTIN_LOOKS);
// The user's saved looks (My Looks).
loadUserLooks();

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
      { label: 'Apply to Whole Document', checked: st.target === 'doc', run: () => st.setTarget('doc') },
      { label: 'Apply to Active Layer Only', checked: st.target === 'layer', run: () => st.setTarget('layer') },
      { label: 'Live Previews', checked: st.previews, run: () => st.setPreviews(!st.previews) },
      { label: 'Remove Look', disabled: !canRemoveLook(doc, currentTargetId()), run: () => removeLook(currentTargetId()) },
      { label: 'Save as Look…', disabled: !doc, run: () => void saveCurrentLook(currentTargetId()) },
    ];
  },
});

commands.register({
  id: 'looks.remove',
  label: 'Remove Look',
  icon: Eraser,
  keywords: ['look', 'style', 'preset', 'clear'],
  enabled: () => !!activeDoc(),
  run: () => removeLook(currentTargetId()),
});

commands.register({
  id: 'looks.save',
  label: 'Save as Look…',
  icon: BookmarkPlus,
  keywords: ['my looks', 'save look', 'preset', 'reuse', 'series', 'style'],
  enabled: () => !!activeDoc(),
  run: () => void saveCurrentLook(currentTargetId()),
});

commands.register({
  id: 'looks.showPanel',
  label: 'Browse Looks…',
  icon: WandSparkles,
  keywords: ['look', 'style', 'preset', 'filter', 'grade'],
  run: () => useUI.getState().showPanel('looks'),
});

// Individual looks are listed in the command palette by the shell (one entry per registered look).
