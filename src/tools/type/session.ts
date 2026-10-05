/**
 * On-canvas text editing session.
 *
 * An invisible <textarea> (inside the viewport element, moved to the caret so IME popups appear in
 * the right place) owns the text, the caret and the selection: typing, IME composition,
 * copy/paste, keyboard selection and native undo all work for free. Every change is mirrored into
 * the document with `preview()` (live render) and the whole session becomes ONE history step on
 * commit ("Type Tool" / "Edit Type Layer"). Esc cancels (cancelPreview), committing empty text
 * removes the layer.
 *
 * The caret, selection highlight and text box are drawn by the type tool's overlay using the
 * compositor's text layout (caret/selection helpers), mapped through faux italic, warp and the
 * layer transform.
 */
import { create } from 'zustand';
import type { Point, TextLayer, TextProps, Transform } from '../../core/types';
import { insertLayerDraft, makeTextLayer, removeLayerDraft } from '../../core/document';
import { commands, runCommand, type ToolPointerEvent } from '../../registry';
import { caretAt, indexAtPoint, measureText, selectionRects } from '../../render/compositor';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { isMac } from '../../platform';
import { matchShortcut } from '../../ui/shortcuts';
import { apply, keepAnchor } from './affine';
import { anchorLocal, baselineNear, mutateKeepingAnchor, shear, textFrame, unshear, type TextFrame } from './frame';
import { TYPE_TOOL_ID, autoLayerName, optionsFromText, readTypeOptions, textPropsFromOptions, writeTypeOptions, type TypeToolOptions } from './options';
import { getTextStyle, presetEffects } from './styles';
import { caseMap, paragraphRangeAt, sanitizeTypedText, toDisplay, toSource, wordRangeAt, type CaseMap } from './textIndex';

/* ------------------------------------------------------------------ */
/* Public reactive state (for the options bar / panels)                */
/* ------------------------------------------------------------------ */

export interface TypeEditingState {
  layerId: string | null;
  docId: string | null;
  isNew: boolean;
  focused: boolean;
}

export const useTypeEditing = create<TypeEditingState>()(() => ({ layerId: null, docId: null, isNew: false, focused: false }));

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

type SessionDrag =
  | { kind: 'select'; anchor: number; pointerId: number }
  | { kind: 'box'; edge: 'left' | 'right'; startLocalX: number; width0: number; transform0: Transform; text0: TextProps };

interface Session {
  docId: string;
  layerId: string;
  isNew: boolean;
  originalContent: string;
  originalName: string;
  /** History entry the preview is based on (rebased when another command commits meanwhile). */
  baseEntryId: string;
  initialEntryId: string;
  prevActiveId: string | null;
  prevSelectedIds: string[];
  ta: HTMLTextAreaElement;
  blinkOn: boolean;
  blinkTimer: number;
  /** Sticky caret x for Up/Down navigation (layout px). */
  goalX: number | null;
  drag: SessionDrag | null;
  composing: boolean;
  disposers: (() => void)[];
}

let ses: Session | null = null;
let finalizing = false;

export function isEditing(): boolean {
  return !!ses;
}

export function editingLayerId(): string | null {
  return ses?.layerId ?? null;
}

/** The layer being edited, from the current (previewed) document. */
function sessionLayer(): TextLayer | null {
  if (!ses) return null;
  const st = useEditor.getState();
  const l = st.sessions[ses.docId]?.doc.layers[ses.layerId];
  return l && l.type === 'text' ? l : null;
}

function publish() {
  useTypeEditing.setState(
    ses
      ? { layerId: ses.layerId, docId: ses.docId, isNew: ses.isNew, focused: document.activeElement === ses.ta }
      : { layerId: null, docId: null, isNew: false, focused: false },
  );
}

/* ---------------- preview helpers ---------------- */

/** Preview a mutation of the edited layer (no history). */
export function previewSessionLayer(mutate: (l: TextLayer) => void) {
  if (!ses) return;
  const id = ses.layerId;
  const st = useEditor.getState();
  if (st.activeDocId !== ses.docId) return;
  st.preview((d) => {
    const l = d.layers[id];
    if (l && l.type === 'text') mutate(l);
  });
  viewport.requestRender();
}

/**
 * After a style change made with a button/menu while editing, give the keyboard back to the text
 * (never steals focus from a field the user is typing in).
 */
export function refocusAfterStyleChange() {
  if (!ses) return;
  const ae = document.activeElement as HTMLElement | null;
  const tag = ae?.tagName;
  if (ae && ae !== document.body && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable) && ae !== ses.ta) return;
  window.setTimeout(() => {
    const a2 = document.activeElement as HTMLElement | null;
    const t2 = a2?.tagName;
    if (a2 && a2 !== document.body && (t2 === 'INPUT' || t2 === 'TEXTAREA' || t2 === 'SELECT') && a2 !== ses?.ta) return;
    focusTextarea();
  }, 0);
}

function syncContentFromTextarea() {
  if (!ses) return;
  const raw = ses.ta.value;
  const clean = sanitizeTypedText(raw);
  if (clean !== raw) {
    const s = ses.ta.selectionStart;
    const e = ses.ta.selectionEnd;
    const delta = raw.length - clean.length;
    ses.ta.value = clean;
    ses.ta.setSelectionRange(Math.max(0, s - delta), Math.max(0, e - delta));
  }
  const l = sessionLayer();
  if (!l || l.text.content === clean) return;
  previewSessionLayer((d) => mutateKeepingAnchor(d, (t) => (t.content = clean)));
}

/* ---------------- caret blink ---------------- */

function wake() {
  if (!ses) return;
  ses.blinkOn = true;
  window.clearInterval(ses.blinkTimer);
  ses.blinkTimer = window.setInterval(() => {
    if (!ses) return;
    ses.blinkOn = !ses.blinkOn;
    viewport.requestOverlay();
  }, 530);
  viewport.requestOverlay();
}

/* ---------------- selection helpers ---------------- */

function focusEnd(ta: HTMLTextAreaElement): number {
  return ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
}

function anchorEnd(ta: HTMLTextAreaElement): number {
  return ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart;
}

function setSelection(anchor: number, focus: number) {
  if (!ses) return;
  const n = ses.ta.value.length;
  const a = Math.max(0, Math.min(n, anchor));
  const f = Math.max(0, Math.min(n, focus));
  ses.ta.setSelectionRange(Math.min(a, f), Math.max(a, f), f < a ? 'backward' : 'forward');
  wake();
}

export function focusTextarea() {
  if (!ses) return;
  if (document.activeElement !== ses.ta) ses.ta.focus({ preventScroll: true });
  publish();
}

function mapOf(t: TextProps): CaseMap {
  return caseMap(t.content ?? '', !!t.uppercase);
}

/* ------------------------------------------------------------------ */
/* Starting a session                                                  */
/* ------------------------------------------------------------------ */

function createTextarea(): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.className = 'type-ime';
  ta.setAttribute('autocomplete', 'off');
  ta.setAttribute('autocorrect', 'off');
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', 'Text layer contents');
  ta.setAttribute('wrap', 'off');
  ta.spellcheck = false;
  return ta;
}

function currentEntryId(docId: string): string | null {
  const s = useEditor.getState().sessions[docId];
  return s ? (s.history.entries[s.history.index]?.id ?? null) : null;
}

function startSession(layerId: string, isNew: boolean, prevActiveId: string | null, prevSelectedIds: string[]) {
  const st = useEditor.getState();
  const docId = st.activeDocId;
  if (!docId) return;
  const l = st.sessions[docId]?.doc.layers[layerId];
  if (!l || l.type !== 'text') return;
  const ta = createTextarea();
  ta.value = l.text.content;
  const host = viewport.element() ?? document.body;
  host.appendChild(ta);
  const entry = currentEntryId(docId) ?? '';
  const s: Session = {
    docId,
    layerId,
    isNew,
    originalContent: l.text.content,
    originalName: l.name,
    baseEntryId: entry,
    initialEntryId: entry,
    prevActiveId,
    prevSelectedIds,
    ta,
    blinkOn: true,
    blinkTimer: 0,
    goalX: null,
    drag: null,
    composing: false,
    disposers: [],
  };
  ses = s;

  const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    ta.addEventListener(type, fn as EventListener);
    s.disposers.push(() => ta.removeEventListener(type, fn as EventListener));
  };
  on('input', () => {
    if (ses !== s) return;
    s.goalX = null;
    syncContentFromTextarea();
    wake();
  });
  on('keydown', (e) => onTextareaKeyDown(e));
  on('keyup', () => viewport.requestOverlay());
  on('select', () => viewport.requestOverlay());
  on('compositionstart', () => (s.composing = true));
  on('compositionend', () => {
    s.composing = false;
    syncContentFromTextarea();
  });
  on('focus', () => {
    publish();
    wake();
  });
  on('blur', () => {
    publish();
    viewport.requestOverlay();
  });
  const onSel = () => {
    if (ses === s && document.activeElement === ta) viewport.requestOverlay();
  };
  document.addEventListener('selectionchange', onSel);
  s.disposers.push(() => document.removeEventListener('selectionchange', onSel));
  s.disposers.push(useEditor.subscribe(watchStore));

  publish();
  ta.focus({ preventScroll: true });
  wake();
  viewport.requestRender();
}

/** End any running session (commit) before starting another. */
function closeExisting() {
  if (ses) commitEditing();
}

/**
 * Create a new text layer at a document point (point text) or in a box (paragraph text) and start
 * editing it. Defaults come from the type tool options; the color is the primary color.
 */
export function beginNewText(at: Point, box?: { x: number; y: number; width: number } | null) {
  closeExisting();
  const s = activeSession();
  if (!s) {
    toast('Open or create a document to add text', 'info');
    return;
  }
  const st = useEditor.getState();
  const o: TypeToolOptions = readTypeOptions();
  const text = textPropsFromOptions(o, st.primaryColor, st.secondaryColor, '');
  if (box) text.boxWidth = Math.max(8, Math.round(box.width));
  const layer = makeTextLayer({ name: 'Text', text });
  const layout = measureText(layer.text);
  if (box) {
    layer.transform.x = box.x;
    layer.transform.y = box.y;
  } else {
    const a = anchorLocal(layer.text, layout);
    layer.transform.x = at.x - a.x;
    layer.transform.y = at.y - a.y;
  }
  const preset = getTextStyle(o.stylePreset);
  if (preset) {
    layer.effects = presetEffects(preset, text.fontSize);
    layer.opacity = preset.opacity ?? 1;
  }
  const prevActive = s.activeLayerId;
  const prevSelected = [...s.selectedLayerIds];
  const above = prevActive && s.doc.layers[prevActive] ? prevActive : null;
  st.preview((d) => insertLayerDraft(d, layer, { aboveId: above }));
  st.setActiveLayer(layer.id);
  startSession(layer.id, true, prevActive, prevSelected);
}

export interface EditOptions {
  /** Place the caret nearest this document point (and start a drag selection when pointerId is set). */
  at?: Point;
  pointerId?: number;
  /** Select all text (default when no point is given: caret at the end). */
  selectAll?: boolean;
}

/** Start editing an existing text layer of the active document. */
export function beginEditLayer(layerId: string, opts: EditOptions = {}): boolean {
  if (ses && ses.layerId === layerId) {
    if (opts.selectAll) setSelection(0, ses.ta.value.length);
    focusTextarea();
    return true;
  }
  closeExisting();
  const s = activeSession();
  const l = s?.doc.layers[layerId];
  if (!s || !l || l.type !== 'text') return false;
  if (l.locks.all) {
    toast(`“${l.name}” is locked — unlock it to edit its text`, 'warning');
    return false;
  }
  if (!l.visible) {
    toast(`“${l.name}” is hidden — show it to edit its text`, 'info');
    return false;
  }
  const prevActive = s.activeLayerId;
  const prevSelected = [...s.selectedLayerIds];
  if (s.activeLayerId !== layerId) useEditor.getState().setActiveLayer(layerId);
  startSession(layerId, false, prevActive, prevSelected);
  if (!ses) return false;
  const n = l.text.content.length;
  if (opts.at) {
    const idx = indexAtDoc(l, opts.at);
    setSelection(idx, idx);
    if (opts.pointerId !== undefined) (ses as Session).drag = { kind: 'select', anchor: idx, pointerId: opts.pointerId };
  } else if (opts.selectAll) setSelection(0, n);
  else setSelection(n, n);
  return true;
}

/**
 * Public helper: switch to the Type tool and edit a text layer (used by double-click with the move
 * tool, the Properties section, the Character panel and the `type.editText` command).
 */
export function editTextLayer(layerId: string, opts: EditOptions = {}): boolean {
  const st = useEditor.getState();
  if (st.activeTool !== TYPE_TOOL_ID) st.setTool(TYPE_TOOL_ID);
  return beginEditLayer(layerId, opts);
}

/* ------------------------------------------------------------------ */
/* Ending a session                                                    */
/* ------------------------------------------------------------------ */

function teardown(): Session | null {
  const s = ses;
  if (!s) return null;
  ses = null;
  window.clearInterval(s.blinkTimer);
  s.disposers.forEach((d) => d());
  if (document.activeElement === s.ta) {
    s.ta.blur();
    viewport.element()?.focus({ preventScroll: true });
  }
  s.ta.remove();
  publish();
  viewport.requestRender();
  return s;
}

/** Run `fn` with the session's document active (switching back afterwards). */
function onSessionDoc(s: Session, fn: () => void) {
  const st = useEditor.getState();
  if (!st.sessions[s.docId]) return;
  const back = st.activeDocId;
  const switched = back !== s.docId;
  finalizing = true;
  try {
    if (switched) st.setActiveDoc(s.docId);
    fn();
  } finally {
    if (switched && back) useEditor.getState().setActiveDoc(back);
    finalizing = false;
  }
}

function restoreSelection(s: Session) {
  const st = useEditor.getState();
  const doc = st.sessions[s.docId]?.doc;
  if (!doc) return;
  const sel = s.prevSelectedIds.filter((id) => doc.layers[id]);
  const active = s.prevActiveId && doc.layers[s.prevActiveId] ? s.prevActiveId : (sel[sel.length - 1] ?? null);
  st.setSelectedLayers(sel.length ? sel : active ? [active] : [], active);
}

/** Commit the edit (one history step). Empty text removes the layer. */
export function commitEditing() {
  const s = teardown();
  if (!s) return;
  onSessionDoc(s, () => {
    const st = useEditor.getState();
    const cur = st.sessions[s.docId];
    const l = cur?.doc.layers[s.layerId];
    if (!cur || !l || l.type !== 'text') return;
    const content = l.text.content;
    const unchanged = currentEntryId(s.docId) === s.initialEntryId;
    // Edited back to exactly what it was: no history step.
    const baseDoc = cur.history.entries[cur.history.index]?.doc;
    const baseLayer = baseDoc?.layers[s.layerId];
    if (!s.isNew && baseLayer && cur.doc !== baseDoc && JSON.stringify(baseLayer) === JSON.stringify(l)) {
      st.cancelPreview();
      return;
    }
    if (!content.trim()) {
      if (s.isNew && unchanged) {
        st.cancelPreview();
        restoreSelection(s);
      } else {
        st.commit(s.isNew ? 'Type Tool' : 'Delete Empty Text', (d) => removeLayerDraft(d, s.layerId));
        if (s.isNew) restoreSelection(s);
      }
      return;
    }
    const wasAuto = s.isNew || s.originalName === autoLayerName(s.originalContent) || s.originalName === (s.originalContent.split('\n')[0].slice(0, 32) || 'Text');
    st.commit(
      s.isNew ? 'Type Tool' : 'Edit Type Layer',
      (d) => {
        const dl = d.layers[s.layerId];
        if (dl && wasAuto) dl.name = autoLayerName(content);
      },
      { activeLayerId: s.layerId },
    );
    // The next text starts with the style just used (fill/warp/stroke stay per layer).
    const o = optionsFromText(l.text);
    writeTypeOptions({
      fontFamily: o.fontFamily,
      fontWeight: o.fontWeight,
      fontStyle: o.fontStyle,
      fontSize: o.fontSize,
      align: o.align,
      lineHeight: o.lineHeight,
      letterSpacing: o.letterSpacing,
      scaleX: o.scaleX,
      scaleY: o.scaleY,
      uppercase: o.uppercase,
      fauxBold: o.fauxBold,
      fauxItalic: o.fauxItalic,
    });
  });
}

/** Discard the edit (Esc). */
export function cancelEditing() {
  const s = teardown();
  if (!s) return;
  onSessionDoc(s, () => {
    const st = useEditor.getState();
    if (currentEntryId(s.docId) === s.baseEntryId) st.cancelPreview();
    if (s.isNew) {
      const doc = useEditor.getState().sessions[s.docId]?.doc;
      if (doc?.layers[s.layerId]) useEditor.getState().commit('Type Tool', (d) => removeLayerDraft(d, s.layerId));
      restoreSelection(s);
    }
  });
}

/** Drop the session without touching the document (it already moved on: undo, close…). */
function abandon() {
  teardown();
}

/* ---------------- store watchdog ---------------- */

function watchStore() {
  const s = ses;
  if (!s || finalizing) return;
  const st = useEditor.getState();
  const ds = st.sessions[s.docId];
  if (!ds) return abandon();
  if (st.activeDocId !== s.docId) {
    queueMicrotask(() => ses === s && commitEditing());
    return;
  }
  const entries = ds.history.entries;
  const cur = entries[ds.history.index];
  const layer = ds.doc.layers[s.layerId];
  if (cur && cur.id !== s.baseEntryId) {
    const bi = entries.findIndex((e) => e.id === s.baseEntryId);
    if (layer?.type === 'text' && (bi < 0 || bi < ds.history.index)) s.baseEntryId = cur.id;
    else {
      // Undo/redo/history jump moved the document underneath the edit.
      queueMicrotask(() => ses === s && abandon());
      return;
    }
  }
  if (!layer || layer.type !== 'text') {
    queueMicrotask(() => ses === s && abandon());
    return;
  }
  if (ds.activeLayerId && ds.activeLayerId !== s.layerId) {
    queueMicrotask(() => ses === s && commitEditing());
    return;
  }
  // Content changed from outside (e.g. Paste Lorem Ipsum while not focused): adopt it.
  if (!s.composing && layer.text.content !== s.ta.value) {
    const caret = Math.min(focusEnd(s.ta), layer.text.content.length);
    s.ta.value = layer.text.content;
    s.ta.setSelectionRange(caret, caret);
  }
}

/* ------------------------------------------------------------------ */
/* Text operations                                                     */
/* ------------------------------------------------------------------ */

/** Insert text at the caret (replacing the selection), keeping native undo. */
export function insertAtCaret(text: string): boolean {
  if (!ses) return false;
  const ta = ses.ta;
  ta.focus({ preventScroll: true });
  const clean = sanitizeTypedText(text);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, clean);
  } catch {
    ok = false;
  }
  if (!ok) {
    ta.setRangeText(clean, ta.selectionStart, ta.selectionEnd, 'end');
    syncContentFromTextarea();
  }
  wake();
  return true;
}

export function selectAllText() {
  if (!ses) return;
  setSelection(0, ses.ta.value.length);
  focusTextarea();
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

/** Ctrl/⌘ combos that belong to text editing (handled natively by the textarea). */
const TEXT_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace', 'delete', 'home', 'end', 'insert']);

function commandForKey(e: KeyboardEvent) {
  for (const c of commands.list()) {
    if (!c.shortcut) continue;
    for (const sc of c.shortcut.split(/\s+\/\s+|\s*\|\s*/)) {
      if (sc && matchShortcut(e, sc.trim())) return c;
    }
  }
  return null;
}

function onTextareaKeyDown(e: KeyboardEvent) {
  const s = ses;
  if (!s) return;
  if (e.isComposing || s.composing || e.keyCode === 229) return;
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.key === 'Escape') {
    handled();
    cancelEditing();
    return;
  }
  if (e.key === 'Enter' && (ctrl || e.code === 'NumpadEnter')) {
    handled();
    commitEditing();
    return;
  }
  if (e.key === 'Tab') {
    handled();
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !ctrl && !e.altKey) {
    handled();
    moveVertical(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey);
    return;
  }
  if ((e.key === 'Home' || e.key === 'End') && !ctrl && !e.altKey) {
    handled();
    moveLineEdge(e.key === 'Home' ? 'start' : 'end', e.shiftKey);
    return;
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') s.goalX = null;
  if (ctrl) {
    const k = e.key.toLowerCase();
    if (!e.altKey && TEXT_KEYS.has(k)) return; // native editing
    const cmd = commandForKey(e);
    if (cmd) {
      handled();
      // Type commands apply to the edited text; anything else commits first.
      if (cmd.id.startsWith('type.')) void runCommand(cmd.id);
      else {
        commitEditing();
        void runCommand(cmd.id);
      }
      return;
    }
    if (k.length === 1) e.preventDefault(); // no browser save/print/find while typing
  }
  wake();
}

function moveVertical(dir: -1 | 1, extend: boolean) {
  const s = ses;
  const l = sessionLayer();
  if (!s || !l) return;
  const t = l.text;
  const layout = measureText(t);
  const map = mapOf(t);
  const focus = focusEnd(s.ta);
  const anchor = anchorEnd(s.ta);
  const c = caretAt(t, toDisplay(map, focus), layout);
  const x = s.goalX ?? c.x;
  const target = c.line + dir;
  let disp: number;
  if (target < 0) disp = 0;
  else if (target >= layout.lines.length) disp = layout.content.length;
  else disp = indexAtPoint(t, x, layout.lines[target].y + layout.lineHeight / 2, layout);
  const next = toSource(map, disp);
  setSelection(extend ? anchor : next, next);
  s.goalX = x;
}

function moveLineEdge(edge: 'start' | 'end', extend: boolean) {
  const s = ses;
  const l = sessionLayer();
  if (!s || !l) return;
  const t = l.text;
  const layout = measureText(t);
  const map = mapOf(t);
  const focus = focusEnd(s.ta);
  const anchor = anchorEnd(s.ta);
  const c = caretAt(t, toDisplay(map, focus), layout);
  const line = layout.lines[c.line];
  if (!line) return;
  let disp = line.start;
  if (edge === 'end') {
    const last = c.line === layout.lines.length - 1;
    disp = !line.hard && !last && line.end > line.start && /\s/.test(layout.content[line.end - 1] ?? '') ? line.end - 1 : line.end;
  }
  const next = toSource(map, disp);
  setSelection(extend ? anchor : next, next);
  s.goalX = null;
}

/* ------------------------------------------------------------------ */
/* Pointer                                                             */
/* ------------------------------------------------------------------ */

function frameOf(l: TextLayer): TextFrame {
  return textFrame(l);
}

/** Source index nearest a document point. */
function indexAtDoc(l: TextLayer, p: Point): number {
  const t = l.text;
  const frame = frameOf(l);
  const loc = frame.toLocal(p);
  const base = baselineNear(frame.layout, loc.y);
  const [ux, uy] = unshear(t, loc.x, loc.y, base);
  const disp = indexAtPoint(t, ux, uy, frame.layout);
  return toSource(mapOf(t), disp);
}

const HANDLE_PX = 9;

type SessionHit = 'inside' | 'left' | 'right' | 'outside';

/** What a document/screen point hits in the edited text (handles in screen px). */
export function sessionHit(e: Pick<ToolPointerEvent, 'docX' | 'docY' | 'screenX' | 'screenY'>): SessionHit {
  const l = sessionLayer();
  if (!l) return 'outside';
  const frame = frameOf(l);
  if (l.text.boxWidth) {
    for (const edge of ['left', 'right'] as const) {
      const lx = edge === 'left' ? 0 : frame.w;
      const p = viewport.docToScreen(apply(frame.M, { x: lx, y: frame.h / 2 }));
      if (Math.abs(p.x - e.screenX) <= HANDLE_PX && Math.abs(p.y - e.screenY) <= HANDLE_PX) return edge;
    }
  }
  const z = viewport.zoom();
  const scale = Math.max(1e-6, Math.hypot(frame.M[0], frame.M[1]));
  const pad = 10 / (z * scale);
  const loc = frame.inv ? apply(frame.inv, { x: e.docX, y: e.docY }) : null;
  if (!loc) return 'outside';
  if (frame.warp) {
    const wl = frame.toLocal({ x: e.docX, y: e.docY });
    if (wl.x >= -pad && wl.y >= -pad && wl.x <= frame.w + pad && wl.y <= frame.h + pad) return 'inside';
    return 'outside';
  }
  const italic = l.text.fauxItalic ? 0.21 * (frame.layout.fontAscent + frame.layout.fontDescent) : 0;
  if (loc.x >= -pad - italic * 0.3 && loc.y >= -pad && loc.x <= frame.w + pad + italic && loc.y <= frame.h + pad) return 'inside';
  return 'outside';
}

export function sessionCursor(e: ToolPointerEvent): string {
  const h = sessionHit(e);
  if (h === 'left' || h === 'right') return 'ew-resize';
  return h === 'inside' ? 'text' : 'default';
}

/** Pointer down while editing. Returns false when the click is outside the text (caller commits). */
export function sessionPointerDown(e: ToolPointerEvent): boolean {
  const s = ses;
  const l = sessionLayer();
  if (!s || !l) return false;
  const hit = sessionHit(e);
  if (hit === 'outside') return false;
  if (hit === 'left' || hit === 'right') {
    const frame = frameOf(l);
    const loc = frame.inv ? apply(frame.inv, { x: e.docX, y: e.docY }) : { x: 0, y: 0 };
    s.drag = { kind: 'box', edge: hit, startLocalX: loc.x, width0: l.text.boxWidth ?? frame.w, transform0: { ...l.transform }, text0: { ...l.text } };
    focusTextarea();
    return true;
  }
  const idx = indexAtDoc(l, { x: e.docX, y: e.docY });
  const clicks = e.native?.detail ?? 1;
  if (clicks >= 3) {
    const [a, b] = clicks >= 4 ? [0, s.ta.value.length] : paragraphRangeAt(s.ta.value, idx);
    setSelection(a, b);
    s.drag = null;
  } else if (clicks === 2) {
    const [a, b] = wordRangeAt(s.ta.value, idx);
    setSelection(a, b);
    s.drag = null;
  } else {
    const anchor = e.shiftKey ? anchorEnd(s.ta) : idx;
    setSelection(anchor, idx);
    s.drag = { kind: 'select', anchor, pointerId: e.native?.pointerId ?? 0 };
  }
  s.goalX = null;
  focusTextarea();
  return true;
}

export function sessionPointerMove(e: ToolPointerEvent) {
  const s = ses;
  const l = sessionLayer();
  if (!s || !l || !s.drag) return;
  if (s.drag.kind === 'select') {
    const idx = indexAtDoc(l, { x: e.docX, y: e.docY });
    setSelection(s.drag.anchor, idx);
    return;
  }
  // Resize the paragraph box width (the opposite edge stays put).
  const d = s.drag;
  const w0 = d.width0;
  const frame0 = textFrame({ transform: d.transform0, text: d.text0 });
  const inv = frame0.inv;
  if (!inv) return;
  const loc = apply(inv, { x: e.docX, y: e.docY });
  const dx = loc.x - d.startLocalX;
  const w = Math.max(16, Math.round(d.edge === 'right' ? w0 + dx : w0 - dx));
  const anchorOld = d.edge === 'right' ? { x: 0, y: 0 } : { x: frame0.w, y: 0 };
  previewSessionLayer((dl) => {
    dl.text.boxWidth = w;
    const L1 = measureText({ ...dl.text });
    const anchorNew = d.edge === 'right' ? { x: 0, y: 0 } : { x: L1.width, y: 0 };
    const pos = keepAnchor(d.transform0, frame0.w, frame0.h, anchorOld, L1.width, L1.height, anchorNew);
    dl.transform.x = pos.x;
    dl.transform.y = pos.y;
  });
  viewport.requestOverlay();
}

export function sessionPointerUp() {
  if (!ses) return;
  ses.drag = null;
  focusTextarea();
}

/** Double click while editing: select the word under the pointer. */
export function sessionDoubleClick(e: ToolPointerEvent) {
  const s = ses;
  const l = sessionLayer();
  if (!s || !l || sessionHit(e) !== 'inside') return;
  const idx = indexAtDoc(l, { x: e.docX, y: e.docY });
  const [a, b] = wordRangeAt(s.ta.value, idx);
  setSelection(a, b);
  focusTextarea();
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

const ACCENT = '#8b7cf6';

function toScreen(frame: TextFrame, x: number, y: number): Point {
  return viewport.docToScreen(frame.toDoc(x, y));
}

function boxPath(ctx: CanvasRenderingContext2D, frame: TextFrame, w: number, h: number) {
  const pts = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => viewport.docToScreen(apply(frame.M, p)));
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

/** Draw the edit UI (box, selection, caret). Context is in screen space. */
export function drawSessionOverlay(ctx: CanvasRenderingContext2D) {
  const s = ses;
  const l = sessionLayer();
  if (!s || !l || useEditor.getState().activeDocId !== s.docId) return;
  const t = l.text;
  const frame = frameOf(l);
  const layout = frame.layout;
  const map = mapOf(t);
  const consistent = map.display === layout.content;
  const disp = (i: number) => (consistent ? toDisplay(map, i) : Math.min(i, layout.content.length));
  const focused = document.activeElement === s.ta;

  ctx.save();
  // Text box.
  const paragraph = !!t.boxWidth;
  boxPath(ctx, frame, frame.w, frame.h);
  ctx.lineWidth = 1;
  ctx.setLineDash(paragraph ? [] : [3, 3]);
  ctx.strokeStyle = paragraph ? 'rgba(139,124,246,0.95)' : 'rgba(139,124,246,0.7)';
  ctx.stroke();
  ctx.setLineDash([]);
  if (paragraph) {
    for (const lx of [0, frame.w]) {
      const p = viewport.docToScreen(apply(frame.M, { x: lx, y: frame.h / 2 }));
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = ACCENT;
      ctx.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
      ctx.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
    }
  } else {
    // Point text: small anchor mark at the start of the first baseline.
    const a = anchorLocal(t, layout);
    const p = viewport.docToScreen(apply(frame.M, a));
    ctx.fillStyle = ACCENT;
    ctx.fillRect(Math.round(p.x) - 2.5, Math.round(p.y) - 2.5, 5, 5);
  }

  // Selection highlight.
  const a = disp(s.ta.selectionStart);
  const b = disp(s.ta.selectionEnd);
  if (a !== b) {
    const rects = selectionRects(t, a, b, layout);
    ctx.fillStyle = focused ? 'rgba(139,124,246,0.42)' : 'rgba(150,150,150,0.35)';
    for (const r of rects) {
      const base = r.y + (layout.lines[0] ? layout.lines[0].baseline - layout.lines[0].y : layout.ascent);
      const N = frame.warp ? Math.max(2, Math.ceil(r.width / 6)) : 1;
      const top: Point[] = [];
      const bottom: Point[] = [];
      for (let i = 0; i <= N; i++) {
        const x = r.x + (r.width * i) / N;
        const [tx, ty] = shear(t, x, r.y, base);
        const [bx, by] = shear(t, x, r.y + r.height, base);
        top.push(toScreen(frame, tx, ty));
        bottom.push(toScreen(frame, bx, by));
      }
      ctx.beginPath();
      top.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i].x, bottom[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Caret.
  const fi = disp(focusEnd(s.ta));
  const c = caretAt(t, fi, layout);
  const top = c.baseline - layout.fontAscent;
  const bottom = c.baseline + layout.fontDescent;
  const pts: Point[] = [];
  const steps = frame.warp ? 6 : 1;
  for (let i = 0; i <= steps; i++) {
    const y = top + ((bottom - top) * i) / steps;
    const [x2, y2] = shear(t, c.x, y, c.baseline);
    pts.push(toScreen(frame, x2, y2));
  }
  placeTextarea(s, pts[0]);
  if (a === b && (s.blinkOn || !focused)) {
    ctx.lineCap = 'round';
    const line = () => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    };
    line();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    line();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = focused ? '#111111' : '#666666';
    ctx.stroke();
  }
  ctx.restore();
}
