/**
 * Apply a font family: to the selected text layer(s) (one undoable step) or, when no text layer is
 * selected, as the Type tool's default font.
 */
import type { TextLayer } from '../core/types';
import { fonts, type FontDef } from '../registry';
import { activeSession, toolOptions, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { ensureFont, fontWeightFor } from './loader';
import { useFontPrefs } from './prefs';

export function findFont(family: string): FontDef | undefined {
  return fonts.get(family) ?? fonts.list().find((f) => f.family.toLowerCase() === family.toLowerCase());
}

/** Text layers the font would apply to (selected text layers, or the active one). */
export function targetTextLayers(): TextLayer[] {
  const s = activeSession();
  if (!s) return [];
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  return ids.map((id) => s.doc.layers[id]).filter((l): l is TextLayer => !!l && l.type === 'text');
}

const withTimeout = (p: Promise<void>, ms: number) =>
  Promise.race([p, new Promise<void>((r) => window.setTimeout(r, ms))]);

export type ApplyResult = 'layers' | 'tool' | 'none';

/**
 * Apply `family`. Returns where it went. Locked layers are skipped with a message.
 */
export async function applyFontFamily(family: string, opts: { quiet?: boolean } = {}): Promise<ApplyResult> {
  const def = findFont(family);
  const weights = def?.weights?.length ? def.weights : [400];
  useFontPrefs.getState().pushRecent(family);

  const layers = targetTextLayers();
  if (layers.length) {
    const editable = layers.filter((l) => !l.locks.all);
    if (!editable.length) {
      toast('The selected text layer is locked — unlock it to change its font', 'warning');
      return 'none';
    }
    const plan = editable.map((l) => {
      const weight = fontWeightFor(weights, l.text.fontWeight);
      const style: 'normal' | 'italic' = l.text.fontStyle === 'italic' && def?.italic ? 'italic' : 'normal';
      return { id: l.id, weight, style };
    });
    // Give the face a moment to load so the canvas doesn't flash the fallback font.
    await withTimeout(Promise.all(plan.map((p) => ensureFont(family, p.weight, p.style))).then(() => undefined), 600);
    useEditor.getState().commit(editable.length > 1 ? 'Change Fonts' : 'Change Font', (d) => {
      for (const p of plan) {
        const l = d.layers[p.id];
        if (!l || l.type !== 'text') continue;
        l.text.fontFamily = family;
        l.text.fontWeight = p.weight;
        l.text.fontStyle = p.style;
      }
    });
    viewport.requestRender();
    if (editable.length < layers.length) toast('Locked text layers were skipped', 'info');
    return 'layers';
  }

  const st = useEditor.getState();
  st.setToolOption('type', 'fontFamily', family);
  const cur = Number(toolOptions('type', { fontWeight: 400 }).fontWeight) || 400;
  const w = fontWeightFor(weights, cur);
  if (w !== cur) st.setToolOption('type', 'fontWeight', w);
  void ensureFont(family, w);
  if (!opts.quiet) {
    toast(
      st.activeDocId ? `Type tool font set to ${family} — select a text layer to restyle it` : `Type tool font set to ${family}`,
      'info',
    );
  }
  return 'tool';
}
