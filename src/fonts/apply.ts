/**
 * Apply a font family: to the selected text layer(s) (one undoable step) or, when no text layer is
 * selected, as the Type tool's default font.
 *
 * While text is being edited on the canvas the document holds an uncommitted live preview owned by
 * the Type tool. A font change then joins that preview (so Enter saves text + font as one step and
 * Esc discards both) instead of committing the half-typed text behind the tool's back.
 */
import type { Document, ID, TextLayer } from '../core/types';
import { fonts, type FontDef } from '../registry';
import { activeSession, toolOptions, useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { viewport } from '../editor/viewport';
import { mutateKeepingAnchor } from '../tools/type/frame';
import { ensureFont, fontWeightFor } from './loader';
import { useFontPrefs } from './prefs';
import { weightName } from './search';

export function findFont(family: string): FontDef | undefined {
  return fonts.get(family) ?? fonts.list().find((f) => f.family.toLowerCase() === family.toLowerCase());
}

/** True when the active document shows an uncommitted live preview (e.g. on-canvas text editing). */
export function hasPendingPreview(): boolean {
  const s = activeSession();
  if (!s) return false;
  const base = s.history.entries[s.history.index];
  return !!base && s.doc !== base.doc;
}

/**
 * Text layers the font would apply to. While a live edit is pending (on-canvas typing) only the
 * active text layer — the one being edited — is targeted; otherwise the selected text layers.
 */
export function targetTextLayers(): TextLayer[] {
  const s = activeSession();
  if (!s) return [];
  if (hasPendingPreview() && s.activeLayerId) {
    const l = s.doc.layers[s.activeLayerId];
    if (l && l.type === 'text') return [l];
  }
  const ids = s.selectedLayerIds.length ? s.selectedLayerIds : s.activeLayerId ? [s.activeLayerId] : [];
  return ids.map((id) => s.doc.layers[id]).filter((l): l is TextLayer => !!l && l.type === 'text');
}

const withTimeout = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => undefined), new Promise<void>((r) => window.setTimeout(r, ms))]);

export type ApplyResult = 'layers' | 'tool' | 'none';

/** Monotonic id of the latest apply request: a slower earlier request never overrides a later one. */
let applySeq = 0;

/** Weight a layer gets: `wanted` (or its current weight) snapped to one the family ships. */
function weightFor(weights: number[], current: number, wanted?: number): number {
  return fontWeightFor(weights, wanted ?? (current || 400));
}

/** Italic survives only when the family ships an italic. */
function styleFor(def: FontDef | undefined, current: string | undefined): 'normal' | 'italic' {
  return current === 'italic' && def?.italic ? 'italic' : 'normal';
}

/**
 * Give keyboard focus back to the on-canvas text editor after a click in a panel (never steals it
 * from a field the user is typing in). No-op when no editor is active.
 */
function refocusTextEditor() {
  window.setTimeout(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea.type-ime');
    if (!ta || !ta.isConnected) return;
    const ae = document.activeElement as HTMLElement | null;
    const tag = ae?.tagName;
    if (ae && ae !== document.body && ae !== ta && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable)) return;
    ta.focus({ preventScroll: true });
  }, 0);
}

/**
 * Apply `family` (optionally with a specific `weight`; otherwise each layer keeps the available
 * weight nearest to its current one). Returns where it went. Locked layers are skipped.
 * Rapid successive calls are resolved in call order: only the latest request is applied.
 */
export async function applyFontFamily(family: string, opts: { quiet?: boolean; weight?: number } = {}): Promise<ApplyResult> {
  const seq = ++applySeq;
  const def = findFont(family);
  const weights = def?.weights?.length ? def.weights : [400];
  useFontPrefs.getState().pushRecent(family);

  const layers = targetTextLayers();
  if (!layers.length) {
    setTypeToolFont(family, opts);
    return 'tool';
  }
  const editable = layers.filter((l) => !l.locks.all);
  if (!editable.length) {
    toast('The selected text layer is locked — unlock it to change its font', 'warning');
    return 'none';
  }
  const docId = useEditor.getState().activeDocId;
  const ids: ID[] = editable.map((l) => l.id);

  // Give the faces a moment to load so the canvas doesn't flash the fallback font (and so the
  // anchor-preserving re-layout below measures the real glyphs).
  await withTimeout(
    Promise.all(
      editable.map((l) =>
        ensureFont(family, weightFor(weights, l.text.fontWeight, opts.weight), styleFor(def, l.text.fontStyle), l.text.content || undefined),
      ),
    ),
    600,
  );
  // A later click (or a document switch) during the wait wins.
  if (seq !== applySeq) return 'none';
  const st = useEditor.getState();
  if (st.activeDocId !== docId || !activeSession()) return 'none';

  // Weight/style come from the layer's state at apply time (not the pre-wait snapshot), so a
  // weight or italic change made while the face loaded is respected.
  const recipe = (d: Document) => {
    for (const id of ids) {
      const l = d.layers[id];
      if (!l || l.type !== 'text' || l.locks.all) continue;
      const weight = weightFor(weights, l.text.fontWeight, opts.weight);
      const style = styleFor(def, l.text.fontStyle);
      if (l.text.fontFamily === family && l.text.fontWeight === weight && l.text.fontStyle === style) continue;
      mutateKeepingAnchor(l, (t) => {
        t.fontFamily = family;
        t.fontWeight = weight;
        t.fontStyle = style;
      });
    }
  };

  if (hasPendingPreview()) {
    // Another tool (on-canvas text editing) owns an uncommitted preview: join it rather than
    // committing it. The owner saves (or discards) everything as one step.
    st.preview(recipe);
    viewport.requestOverlay();
    refocusTextEditor();
  } else {
    st.commit(ids.length > 1 ? 'Change Fonts' : 'Change Font', recipe);
  }
  viewport.requestRender();
  if (editable.length < layers.length) toast('Locked text layers were skipped', 'info');
  return 'layers';
}

/**
 * Make `family` the Type tool's default font (weight snapped to one the family has, italic kept
 * only when the family ships an italic). Shows a toast unless `quiet`.
 */
export function setTypeToolFont(family: string, opts: { quiet?: boolean; weight?: number } = {}) {
  // Supersedes any in-flight layer apply (its result would otherwise land after this choice).
  ++applySeq;
  const def = findFont(family);
  const weights = def?.weights?.length ? def.weights : [400];
  const st = useEditor.getState();
  st.setToolOption('type', 'fontFamily', family);
  const curOpts = toolOptions('type', { fontWeight: 400, fontStyle: 'normal' as string });
  const cur = Number(curOpts.fontWeight) || 400;
  const w = fontWeightFor(weights, opts.weight ?? cur);
  if (w !== cur) st.setToolOption('type', 'fontWeight', w);
  const style = styleFor(def, curOpts.fontStyle);
  if (style !== curOpts.fontStyle) st.setToolOption('type', 'fontStyle', style);
  void ensureFont(family, w, style);
  if (!opts.quiet) {
    const label = opts.weight ? `${family} ${weightName(w)}` : family;
    const hint = st.activeDocId && !targetTextLayers().length ? ' — select a text layer to restyle it' : '';
    toast(`Type tool font set to ${label}${hint}`, 'info');
  }
}
