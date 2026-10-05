/**
 * Where text style changes go:
 *  - the layer being edited on canvas (live preview, committed with the edit session),
 *  - else the selected text layers (live preview while scrubbing, coalesced commit on release),
 *  - else the type tool defaults (used by the next text you create).
 */
import type { Document, ID, Point, TextLayer, TextProps } from '../../core/types';
import { flattenIds, isEffectivelyVisible } from '../../core/document';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { frameContains, mutateKeepingAnchor, textFrame } from './frame';
import { writeTypeOptions, type TypeToolOptions } from './options';
import { editingLayerId, isEditing, previewSessionLayer, refocusAfterStyleChange, useTypeEditing } from './session';

export type Phase = 'live' | 'commit';

/** Text layers a style change applies to (edited layer, else selected text layers, active first). */
export function textTargets(): TextLayer[] {
  const s = activeSession();
  if (!s) return [];
  const editing = editingLayerId();
  if (editing) {
    const l = s.doc.layers[editing];
    return l && l.type === 'text' ? [l] : [];
  }
  const active = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!active || active.type !== 'text') return [];
  const out: TextLayer[] = [active];
  for (const id of s.selectedLayerIds) {
    const l = s.doc.layers[id];
    if (l && l.type === 'text' && l.id !== active.id) out.push(l);
  }
  return out;
}

export function primaryTextTarget(): TextLayer | null {
  return textTargets()[0] ?? null;
}

let lockToastAt = 0;
function lockedToast() {
  const now = Date.now();
  if (now - lockToastAt < 1500) return;
  lockToastAt = now;
  toast('The text layer is locked — unlock it to change its style', 'warning');
}

export interface TextChange {
  /** Partial props, or a mutator (anchor-preserving: point text stays put when it grows). */
  text?: Partial<TextProps> | ((t: TextProps) => void);
  /** Extra mutation of the whole layer (effects, opacity…). */
  layer?: (l: TextLayer) => void;
}

function applyTo(l: TextLayer, change: TextChange) {
  const tx = change.text;
  if (tx) {
    mutateKeepingAnchor(l, (t) => {
      if (typeof tx === 'function') tx(t);
      else Object.assign(t, structuredClone(tx));
    });
  }
  change.layer?.(l);
}

/**
 * Tool option keys that describe one layer's look (fill, outline, warp, style preset). Changing
 * them on a selected layer never changes what the next new text looks like.
 */
const PER_LAYER_KEYS = new Set<keyof TypeToolOptions>(['warp', 'strokeOn', 'strokeColor', 'strokeWidth', 'fillType', 'gradient', 'stylePreset']);

/** The part of a tool patch that carries over to new text after editing a layer (typography only). */
export function typographicPatch(patch: Partial<TypeToolOptions>): Partial<TypeToolOptions> {
  const out: Partial<TypeToolOptions> = {};
  for (const k of Object.keys(patch) as (keyof TypeToolOptions)[]) {
    if (!PER_LAYER_KEYS.has(k)) (out as Record<string, unknown>)[k] = patch[k];
  }
  return out;
}

/**
 * Apply a change to the current targets. `toolPatch` is written to the type tool defaults when
 * there is no target; when layers are changed only its typographic part (font, size, spacing,
 * alignment…) is written on commit so the next text matches — fill, outline and warp stay per
 * layer. Returns where the change went.
 */
export function applyTextChange(change: TextChange, phase: Phase, label: string, toolPatch?: Partial<TypeToolOptions>): 'layers' | 'tool' | 'none' {
  if (isEditing()) {
    previewSessionLayer((l) => applyTo(l, change));
    viewport.requestOverlay();
    if (phase === 'commit') refocusAfterStyleChange();
    return 'layers';
  }
  const targets = textTargets();
  if (!targets.length) {
    if (toolPatch) {
      writeTypeOptions(toolPatch);
      return 'tool';
    }
    return 'none';
  }
  const editable = targets.filter((l) => !l.locks.all);
  if (!editable.length) {
    if (phase === 'commit') lockedToast();
    return 'none';
  }
  const ids = editable.map((l) => l.id);
  const recipe = (d: Document) => {
    for (const id of ids) {
      const l = d.layers[id];
      if (l && l.type === 'text') applyTo(l, change);
    }
  };
  const st = useEditor.getState();
  if (phase === 'live') st.preview(recipe);
  else {
    st.commit(label, recipe, { coalesce: true });
    if (toolPatch) writeTypeOptions(typographicPatch(toolPatch));
  }
  viewport.requestRender();
  return 'layers';
}

/** True when some text target exists (or the edit session runs). */
export function hasTextTarget(): boolean {
  return isEditing() || textTargets().length > 0;
}

/** React: the text layer the type UI edits (edited layer, else active text layer). */
export function useTextTarget(): TextLayer | null {
  const editing = useTypeEditing((s) => s.layerId);
  return useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    if (!s) return null;
    const id = editing ?? s.activeLayerId;
    const l = id ? s.doc.layers[id] : null;
    return l && l.type === 'text' ? l : null;
  });
}

/* ---------------- hit testing ---------------- */

/**
 * Text layer under a document point for the type tool: the active layer when it is a text layer
 * containing the point, else the topmost visible, unlocked text layer containing it.
 * `padPx` is a screen-space tolerance.
 */
export function textLayerAt(doc: Document, p: Point, padPx = 4, activeId: ID | null = null): ID | null {
  const z = viewport.zoom();
  const test = (l: TextLayer) => {
    const frame = textFrame(l);
    const s = Math.max(1e-6, Math.hypot(frame.M[0], frame.M[1]));
    return frameContains(frame, l.text, p, padPx / (z * s));
  };
  if (activeId) {
    const a = doc.layers[activeId];
    if (a && a.type === 'text' && isEffectivelyVisible(doc, a.id) && test(a)) return a.id;
  }
  const ids = flattenIds(doc);
  for (let i = ids.length - 1; i >= 0; i--) {
    const l = doc.layers[ids[i]];
    if (!l || l.type !== 'text' || l.locks.all) continue;
    if (!isEffectivelyVisible(doc, l.id)) continue;
    if (test(l)) return l.id;
  }
  return null;
}
