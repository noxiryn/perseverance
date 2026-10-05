/** Module entry: registers doc presets, templates and File ▸ New from Template (imported by src/features.ts). */
import { LayoutTemplate } from 'lucide-react';
import { assets, commands, docPresets, templates } from '../registry';
import type { ID } from '../core/types';
import { useEditor } from '../state/editor';
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

/**
 * Templates opened by other code paths (start screen, command palette) call `build()` +
 * `openDocument` without an active layer, which leaves the top layer (e.g. a border) active.
 * Select the placeholder character recorded in `doc.meta.characterId` once, when such a
 * document appears untouched (single history entry), so the Looks panel targets it.
 */
const seenSessions = new Set<ID>();
useEditor.subscribe((st, prev) => {
  if (st.sessions === prev.sessions) return;
  for (const id of [...seenSessions]) if (!st.sessions[id]) seenSessions.delete(id);
  for (const [id, s] of Object.entries(st.sessions)) {
    if (seenSessions.has(id)) continue;
    seenSessions.add(id);
    if (prev.sessions[id]) continue;
    const cid = s.doc.meta?.characterId;
    if (typeof s.doc.meta?.template !== 'string' || typeof cid !== 'string' || !s.doc.layers[cid]) continue;
    if (s.history.entries.length !== 1 || s.activeLayerId === cid) continue;
    queueMicrotask(() => {
      const cur = useEditor.getState();
      const ss = cur.sessions[id];
      if (cur.activeDocId === id && ss && ss.history.entries.length === 1 && ss.activeLayerId !== cid && ss.doc.layers[cid]) cur.setActiveLayer(cid);
    });
  }
});

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
