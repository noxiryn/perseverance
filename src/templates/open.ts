/** Opening templates as new documents (exported for other modules). */
import type { ID } from '../core/types';
import { templates } from '../registry';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { buildTemplate } from './define';
import { docFonts, loadFonts } from '../looks/shared';

/**
 * Build template `id` and open it as a new document (active layer = the placeholder character,
 * so the Looks panel targets it). Returns the new document id, or null on failure.
 */
export async function openTemplate(id: string): Promise<ID | null> {
  const def = templates.get(id);
  if (!def) {
    toast(`Template “${id}” is not available.`, 'error');
    return null;
  }
  try {
    const { doc, characterId } = await buildTemplate(id);
    void loadFonts(docFonts(doc));
    const docId = useEditor.getState().openDocument(doc, { label: `New from “${def.name}”`, activeLayerId: characterId });
    toast(
      characterId
        ? `Created “${def.name}”. Swap in your character: drop your render on the canvas or use Roblox ▸ Replace Character… (keeps the template’s styling).`
        : `Created “${def.name}” from template.`,
      'success',
      characterId ? 6000 : 2600,
    );
    return docId;
  } catch (e) {
    console.error(e);
    toast(`Template “${def.name}” failed: ${(e as Error)?.message ?? e}`, 'error', 4000);
    return null;
  }
}
