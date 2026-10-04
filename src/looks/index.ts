/** Module entry: registers looks, the Looks panel and look commands (imported by src/features.ts). */
import { WandSparkles, Eraser } from 'lucide-react';
import { commands, looks, panels } from '../registry';
import { activeDoc } from '../state/editor';
import { useUI } from '../state/ui';
import { BUILTIN_LOOKS } from './defs';
import { applyLook, hasLook, removeLook } from './engine';
import { LooksPanel } from './LooksPanel';
import { currentTargetId, useLooksUI } from './store';

export { applyLook, removeLook } from './engine';
export { renderLookPreview } from './preview';

looks.registerMany(BUILTIN_LOOKS);

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
      { label: 'Remove Look', disabled: !doc || !hasLook(doc, currentTargetId()), run: () => removeLook(currentTargetId()) },
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
  id: 'looks.showPanel',
  label: 'Browse Looks…',
  icon: WandSparkles,
  keywords: ['look', 'style', 'preset', 'filter', 'grade'],
  run: () => useUI.getState().showPanel('looks'),
});

for (const look of BUILTIN_LOOKS) {
  commands.register({
    id: `looks.apply.${look.id}`,
    label: `Apply Look: ${look.name}`,
    icon: WandSparkles,
    keywords: ['look', 'style', look.category.toLowerCase(), ...(look.description ?? '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).slice(0, 6)],
    enabled: () => !!activeDoc(),
    run: () => applyLook(look.id, currentTargetId()),
  });
}
