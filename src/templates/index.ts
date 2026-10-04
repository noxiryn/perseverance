/** Module entry: registers doc presets, templates and File ▸ New from Template (imported by src/features.ts). */
import { LayoutTemplate } from 'lucide-react';
import { assets, commands, docPresets, templates } from '../registry';
import { openDialog } from '../state/ui';
import { BLANK_TEMPLATES } from './blank';
import { EXTRA_TEMPLATES } from './extra';
import { NewFromTemplateDialog } from './NewFromTemplateDialog';
import { DOC_PRESETS } from './presets';
import { REFERENCE_TEMPLATES } from './reference';
import { billowSmokeAsset } from './smokeAsset';

export { openTemplate } from './open';
export { buildTemplate } from './define';
export { getTemplatePreview, loadTemplatePreview, useTemplatePreview } from './previews';
export { NewFromTemplateDialog } from './NewFromTemplateDialog';

// Procedural soft smoke used by templates and looks (regenerable like any library asset).
if (!assets.has(billowSmokeAsset.id)) assets.register(billowSmokeAsset);
docPresets.registerMany(DOC_PRESETS);
templates.registerMany([...REFERENCE_TEMPLATES, ...EXTRA_TEMPLATES, ...BLANK_TEMPLATES]);

/** Open the New-from-Template dialog. Resolves with the new document id (or undefined if cancelled). */
export function showNewFromTemplate() {
  return openDialog<string>(NewFromTemplateDialog);
}

commands.register({
  id: 'file.newFromTemplate',
  label: 'New from Template…',
  menu: 'File',
  group: '10-new',
  order: 15,
  shortcut: 'Alt+Ctrl+N',
  icon: LayoutTemplate,
  keywords: ['template', 'new', 'thumbnail', 'icon', 'roblox', 'preset', 'start'],
  run: () => {
    void showNewFromTemplate();
  },
});
