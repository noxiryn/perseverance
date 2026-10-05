/**
 * Editor store (zustand). Holds open documents (each a DocSession with its own history),
 * the active tool and its options, and the foreground/background colors.
 *
 * Mutation rules:
 *  - Use `commit(label, recipe)` for any undoable document change. `recipe` receives an immer
 *    draft of the active Document.
 *  - For live interactions (dragging), call `preview(recipe)` repeatedly and then `commit(label)`
 *    with no recipe (or `cancelPreview()` to revert).
 *  - Pixel edits: mutate a bitmap via `bitmaps.edit()` (or manually + `bitmaps.touch`), collect the
 *    BitmapPatch(es) and call `commit(label, recipe?, { patches })`.
 */
import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import type { BitmapPatch, DocSession, Document, EditTarget, HistoryEntry, ID, Layer, ViewState } from '../core/types';
import { bitmaps } from '../core/bitmaps';
import { uid } from '../core/ids';
import { useUI } from './ui';
import {
  detachLayerDraft,
  flattenIds,
  insertLayerDraft,
  makeGroupLayer,
  parentOf,
  removeLayerDraft,
  siblingsOf,
} from '../core/document';

setAutoFreeze(false);

export const HISTORY_LIMIT = 80;

export type Recipe = (draft: Document) => void | Document;

export interface CommitOptions {
  patches?: BitmapPatch[];
  /** Set the active layer after commit. */
  activeLayerId?: ID | null;
  selectedLayerIds?: ID[];
  /** Merge into the previous history entry if it has the same label and is < 1s old (e.g. slider scrubbing). */
  coalesce?: boolean;
}

export interface EditorState {
  sessions: Record<ID, DocSession>;
  docOrder: ID[];
  activeDocId: ID | null;

  activeTool: string;
  /** Previous tool (for temporary tool switching, e.g. holding Space for Hand). */
  previousTool: string | null;
  toolOptions: Record<string, Record<string, unknown>>;

  primaryColor: string;
  secondaryColor: string;
  recentColors: string[];

  /* ---- documents ---- */
  openDocument(doc: Document, opts?: { filePath?: string | null; label?: string; activeLayerId?: ID | null }): ID;
  closeDocument(id: ID): void;
  setActiveDoc(id: ID): void;
  setFilePath(id: ID, path: string | null, markSaved?: boolean): void;
  /**
   * Mark a document as saved. Without `at`, the current history step is the saved state. With `at`
   * (the step and document a save actually wrote), that step becomes the saved state only if it
   * still holds exactly that document — a later edit coalesced into it, or the step having been
   * dropped, leaves the tab dirty.
   */
  markSaved(id?: ID, at?: SavedState): void;

  /* ---- history ---- */
  commit(label: string, recipe?: Recipe, opts?: CommitOptions): void;
  preview(recipe: Recipe): void;
  cancelPreview(): void;
  undo(): void;
  redo(): void;
  jumpToHistory(index: number): void;

  /* ---- layers ---- */
  setActiveLayer(id: ID | null, mode?: 'replace' | 'toggle' | 'range'): void;
  setSelectedLayers(ids: ID[], activeId?: ID | null): void;
  setEditTarget(t: EditTarget): void;
  addLayer(layer: Layer, opts?: { aboveId?: ID | null; parentId?: ID | null; index?: number; label?: string; select?: boolean }): ID;
  updateLayer<T extends Layer = Layer>(id: ID, change: Partial<T> | ((l: T) => void), label?: string, opts?: CommitOptions): void;
  removeLayers(ids: ID[], label?: string): void;
  moveLayer(id: ID, parentId: ID | null, index: number, label?: string): void;
  groupLayers(ids: ID[], name?: string): ID | null;
  ungroupLayer(id: ID): void;

  /* ---- view ---- */
  setView(v: Partial<ViewState>, docId?: ID): void;

  /* ---- tools & colors ---- */
  setTool(id: string, temporary?: boolean): void;
  restoreTool(): void;
  setToolOption(toolId: string, key: string, value: unknown): void;
  setPrimaryColor(c: string): void;
  setSecondaryColor(c: string): void;
  swapColors(): void;
  resetColors(): void;
  pushRecentColor(c: string): void;
}

/** A document state a save wrote: the history step it was taken from and that step's document. */
export interface SavedState {
  entryId: string;
  doc: Document;
}

/**
 * History index of the state a save wrote, or -1 when no step holds it any more. Entry ids alone are
 * not enough: a coalescing edit (nudge, slider scrub) replaces a step's document but keeps its id.
 * (Pixel edits never coalesce, so id + document identifies the pixels too.)
 */
export function savedIndexOf(entries: readonly HistoryEntry[], at: SavedState): number {
  const idx = entries.findIndex((e) => e.id === at.entryId);
  return idx >= 0 && entries[idx].doc === at.doc ? idx : -1;
}

function newEntry(label: string, doc: Document, patches?: BitmapPatch[]): HistoryEntry {
  return { id: uid('h_'), label, doc, patches, timestamp: Date.now() };
}

function makeSession(doc: Document, filePath: string | null, label: string, activeLayerId: ID | null): DocSession {
  const ids = flattenIds(doc);
  const active = activeLayerId ?? ids[ids.length - 1] ?? null;
  return {
    doc,
    history: { entries: [newEntry(label, doc)], index: 0 },
    view: { zoom: 0, panX: 0, panY: 0 }, // zoom 0 → viewport will "fit" on first render
    activeLayerId: active,
    selectedLayerIds: active ? [active] : [],
    editTarget: 'content',
    filePath,
    dirty: false,
    savedIndex: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Bitmap garbage collection                                           */
/* ------------------------------------------------------------------ */
/*
 * The bitmap store owns every canvas; documents only reference ids. Bitmaps become garbage when
 * a document closes, when history entries are dropped (a redo branch discarded by a new commit, or
 * the oldest steps trimmed past HISTORY_LIMIT), when a slider coalesces into a step, or when a tool
 * / dialog previewed with a temporary bitmap and cancelled. Three mechanisms free them:
 *
 *  1. Immediately (no grace period) for bitmaps referenced ONLY by a closed session or by dropped
 *     history entries (discarded redo branch, trimmed steps) — nothing can reach those any more
 *     (they are not in any open document, its live preview or remaining history). Freshly created
 *     tool bitmaps are never in that set.
 *  2. A throttled idle pass (`requestBitmapGc`) ~31 s after the first document change since the
 *     last pass: frees everything unreferenced that is older than the store's 30 s grace (bitmaps a
 *     tool created but has not committed yet are younger than that). It is postponed while a
 *     dialog is open (dialogs may hold preview bitmaps outside any document).
 *  3. Pinned bitmaps (`bitmaps.pin`, e.g. clipboard contents) are never collected.
 */

/** Grace period for bitmaps not referenced by any document (they may be about to be committed). */
export const BITMAP_GC_GRACE_MS = 30000;

/** Add every bitmap id a document references (raster contents, masks, selection) to `out`. */
function addDocBitmaps(d: Document, out: Set<ID>) {
  for (const l of Object.values(d.layers)) {
    if (l.type === 'raster') out.add(l.bitmapId);
    if (l.mask) out.add(l.mask.bitmapId);
  }
  if (d.selection) out.add(d.selection.bitmapId);
}

/** Bitmaps referenced by history entries (their documents and pixel patches). */
export function entryBitmaps(entries: readonly HistoryEntry[], out: Set<ID> = new Set()): Set<ID> {
  for (const e of entries) {
    addDocBitmaps(e.doc, out);
    e.patches?.forEach((p) => out.add(p.bitmapId));
  }
  return out;
}

/** Bitmaps a session can reach: its current document (possibly a live preview) and its history. */
export function sessionBitmaps(s: DocSession, out: Set<ID> = new Set()): Set<ID> {
  addDocBitmaps(s.doc, out);
  return entryBitmaps(s.history.entries, out);
}

/** Every bitmap id referenced by any open session. */
export function referencedBitmaps(sessions: Record<ID, DocSession>): Set<ID> {
  const keep = new Set<ID>();
  for (const s of Object.values(sessions)) sessionBitmaps(s, keep);
  return keep;
}

/**
 * Free the `candidates` that no open session references any more, right away (no grace period).
 * Returns the number of bitmaps removed.
 */
export function freeUnreferencedBitmaps(candidates: Set<ID>, sessions: Record<ID, DocSession>): number {
  if (!candidates.size) return 0;
  const live = referencedBitmaps(sessions);
  const drop = new Set<ID>();
  for (const id of candidates) if (!live.has(id) && bitmaps.has(id)) drop.add(id);
  if (!drop.size) return 0;
  // retainOnly with a negative grace removes every unpinned bitmap outside `keep`, however young.
  bitmaps.retainOnly(new Set(bitmaps.ids().filter((id) => !drop.has(id))), -1);
  return drop.size;
}

/**
 * Bitmaps of history steps replaced by coalescing, protected for a few seconds. A coalescing
 * gesture (arrow-key nudges, slider scrubbing) often keeps using the state it started from —
 * e.g. the selection nudge re-cuts every press from the mask it started with — and that state can
 * be the very step a later press coalesces into.
 */
const COALESCE_GUARD_MS = 5000;
let coalesceGuard: { ids: Set<ID>; until: number } = { ids: new Set(), until: 0 };

function guardCoalesced(entry: HistoryEntry) {
  const now = Date.now();
  const ids = now < coalesceGuard.until ? coalesceGuard.ids : new Set<ID>();
  entryBitmaps([entry], ids);
  coalesceGuard = { ids, until: now + COALESCE_GUARD_MS };
}

/** Full pass: remove every unreferenced bitmap older than the grace period (pinned ones stay). */
export function gcBitmaps(sessions: Record<ID, DocSession> = useEditor.getState().sessions) {
  const keep = referencedBitmaps(sessions);
  if (Date.now() < coalesceGuard.until) for (const id of coalesceGuard.ids) keep.add(id);
  bitmaps.retainOnly(keep, BITMAP_GC_GRACE_MS);
}

let gcTimer: ReturnType<typeof setTimeout> | null = null;

/** True while bitmaps may be held outside any document (an open dialog's previews). */
function gcDeferred(): boolean {
  return useUI.getState().dialogs.length > 0;
}

function runIdleGc() {
  gcTimer = null;
  if (gcDeferred()) {
    gcTimer = setTimeout(runIdleGc, 5000);
    return;
  }
  gcBitmaps();
}

/**
 * Schedule an idle GC pass. Throttled, not debounced: a pending pass is kept, so continuous
 * editing cannot postpone collection forever. Runs just after the grace period, so bitmaps that
 * were young at the time of the change are old enough to be collected by then.
 */
export function requestBitmapGc(delayMs = BITMAP_GC_GRACE_MS + 1000) {
  if (gcTimer !== null) return;
  gcTimer = setTimeout(runIdleGc, delayMs);
}

/** Cancel a pending idle pass (tests). */
export function cancelBitmapGc() {
  if (gcTimer !== null) clearTimeout(gcTimer);
  gcTimer = null;
}

function sanitizeSelection(s: DocSession, doc: Document): Pick<DocSession, 'activeLayerId' | 'selectedLayerIds'> {
  const active = s.activeLayerId && doc.layers[s.activeLayerId] ? s.activeLayerId : (flattenIds(doc).pop() ?? null);
  const selected = s.selectedLayerIds.filter((id) => doc.layers[id]);
  return { activeLayerId: active, selectedLayerIds: selected.length ? selected : active ? [active] : [] };
}

export const useEditor = create<EditorState>()((set, get) => {
  /** Update the active session immutably. */
  const patchActive = (fn: (s: DocSession) => Partial<DocSession> | null) => {
    const { activeDocId, sessions } = get();
    if (!activeDocId) return;
    const s = sessions[activeDocId];
    if (!s) return;
    const change = fn(s);
    if (!change) return;
    set({ sessions: { ...sessions, [activeDocId]: { ...s, ...change } } });
  };

  return {
    sessions: {},
    docOrder: [],
    activeDocId: null,
    activeTool: 'move',
    previousTool: null,
    toolOptions: {},
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    recentColors: [],

    openDocument(doc, opts = {}) {
      const session = makeSession(doc, opts.filePath ?? null, opts.label ?? 'Open', opts.activeLayerId ?? null);
      set((st) => ({
        sessions: { ...st.sessions, [doc.id]: session },
        docOrder: st.docOrder.includes(doc.id) ? st.docOrder : [...st.docOrder, doc.id],
        activeDocId: doc.id,
      }));
      return doc.id;
    },

    closeDocument(id) {
      const closing = get().sessions[id];
      set((st) => {
        const sessions = { ...st.sessions };
        delete sessions[id];
        const docOrder = st.docOrder.filter((d) => d !== id);
        let activeDocId = st.activeDocId;
        if (activeDocId === id) {
          const idx = st.docOrder.indexOf(id);
          activeDocId = docOrder[Math.min(idx, docOrder.length - 1)] ?? null;
        }
        return { sessions, docOrder, activeDocId };
      });
      // Pixels only this document used are freed now; anything younger that a tool still holds
      // is left to the idle pass.
      if (closing) freeUnreferencedBitmaps(sessionBitmaps(closing), get().sessions);
      requestBitmapGc();
    },

    setActiveDoc(id) {
      if (get().sessions[id]) set({ activeDocId: id });
    },

    setFilePath(id, path, markSaved = true) {
      const s = get().sessions[id];
      if (!s) return;
      set({
        sessions: {
          ...get().sessions,
          [id]: { ...s, filePath: path, ...(markSaved ? { dirty: false, savedIndex: s.history.index } : {}) },
        },
      });
    },

    markSaved(id, at) {
      const docId = id ?? get().activeDocId;
      if (!docId) return;
      const s = get().sessions[docId];
      if (!s) return;
      const savedIndex = at ? savedIndexOf(s.history.entries, at) : s.history.index;
      set({ sessions: { ...get().sessions, [docId]: { ...s, savedIndex, dirty: savedIndex !== s.history.index } } });
    },

    commit(label, recipe, opts = {}) {
      const { activeDocId, sessions } = get();
      if (!activeDocId) return;
      const s = sessions[activeDocId];
      if (!s) return;
      const doc = recipe ? (produce(s.doc, recipe) as Document) : s.doc;
      const base = s.history.entries[s.history.index];
      // Nothing changed and no patches → no history entry.
      if (doc === base.doc && !opts.patches?.length) {
        if (doc !== s.doc) patchActive(() => ({ doc }));
        return;
      }
      let entries = s.history.entries.slice(0, s.history.index + 1);
      // Entries no longer reachable after this commit: the discarded redo branch and steps trimmed
      // off the front. Their pixels are freed below. (A step replaced by coalescing is left to the
      // idle pass, after a short guard: the gesture may still be reading its pixels.)
      const dropped: HistoryEntry[] = s.history.entries.slice(s.history.index + 1);
      const last = entries[entries.length - 1];
      // Never coalesce into the saved step: the file holds that step's state, so changing it in place
      // would leave the tab clean with the change missing from the file.
      if (
        opts.coalesce &&
        entries.length > 1 &&
        s.savedIndex !== s.history.index &&
        last.label === label &&
        Date.now() - last.timestamp < 1000 &&
        !last.patches?.length &&
        !opts.patches?.length
      ) {
        entries[entries.length - 1] = { ...last, doc, timestamp: Date.now() };
        guardCoalesced(last);
      } else {
        entries.push(newEntry(label, doc, opts.patches));
      }
      // A saved step in the discarded redo branch is gone: no step matches the file any more (a new
      // step pushed at its old index must not count as saved).
      let savedIndex = s.savedIndex > s.history.index ? -1 : s.savedIndex;
      if (entries.length > HISTORY_LIMIT) {
        const drop = entries.length - HISTORY_LIMIT;
        dropped.push(...entries.slice(0, drop));
        entries = entries.slice(drop);
        savedIndex = savedIndex >= drop ? savedIndex - drop : -1;
      }
      const index = entries.length - 1;
      const next: DocSession = {
        ...s,
        doc,
        history: { entries, index },
        savedIndex,
        dirty: index !== savedIndex,
        ...sanitizeSelection(
          {
            ...s,
            activeLayerId: opts.activeLayerId !== undefined ? opts.activeLayerId : s.activeLayerId,
            selectedLayerIds:
              opts.selectedLayerIds ??
              (opts.activeLayerId !== undefined ? (opts.activeLayerId ? [opts.activeLayerId] : []) : s.selectedLayerIds),
          },
          doc,
        ),
      };
      set({ sessions: { ...sessions, [activeDocId]: next } });
      if (dropped.length) freeUnreferencedBitmaps(entryBitmaps(dropped), get().sessions);
    },

    preview(recipe) {
      patchActive((s) => ({ doc: produce(s.doc, recipe) as Document }));
    },

    cancelPreview() {
      patchActive((s) => ({ doc: s.history.entries[s.history.index].doc }));
    },

    undo() {
      patchActive((s) => {
        const { entries, index } = s.history;
        if (index <= 0) return null;
        entries[index].patches?.slice().reverse().forEach((p) => bitmaps.applyPatch(p, 'before'));
        const doc = entries[index - 1].doc;
        return {
          doc,
          history: { entries, index: index - 1 },
          dirty: index - 1 !== s.savedIndex,
          ...sanitizeSelection(s, doc),
        };
      });
    },

    redo() {
      patchActive((s) => {
        const { entries, index } = s.history;
        if (index >= entries.length - 1) return null;
        entries[index + 1].patches?.forEach((p) => bitmaps.applyPatch(p, 'after'));
        const doc = entries[index + 1].doc;
        return {
          doc,
          history: { entries, index: index + 1 },
          dirty: index + 1 !== s.savedIndex,
          ...sanitizeSelection(s, doc),
        };
      });
    },

    jumpToHistory(target) {
      const s = get().activeDocId ? get().sessions[get().activeDocId!] : null;
      if (!s) return;
      const clamped = Math.max(0, Math.min(target, s.history.entries.length - 1));
      while (get().sessions[get().activeDocId!].history.index > clamped) get().undo();
      while (get().sessions[get().activeDocId!].history.index < clamped) get().redo();
    },

    setActiveLayer(id, mode = 'replace') {
      patchActive((s) => {
        if (id === null) return { activeLayerId: null, selectedLayerIds: [], editTarget: 'content' };
        if (!s.doc.layers[id]) return null;
        let selected = s.selectedLayerIds;
        if (mode === 'replace') selected = [id];
        else if (mode === 'toggle') {
          selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
          if (!selected.length) selected = [id];
        } else if (mode === 'range' && s.activeLayerId) {
          const sibs = siblingsOf(s.doc, id);
          const a = sibs.indexOf(s.activeLayerId);
          const b = sibs.indexOf(id);
          if (a >= 0 && b >= 0) selected = sibs.slice(Math.min(a, b), Math.max(a, b) + 1);
          else selected = [id];
        }
        const activeLayerId = selected.includes(id) ? id : selected[selected.length - 1];
        return {
          activeLayerId,
          selectedLayerIds: selected,
          editTarget: activeLayerId === s.activeLayerId ? s.editTarget : 'content',
        };
      });
    },

    setSelectedLayers(ids, activeId) {
      patchActive((s) => {
        const valid = ids.filter((i) => s.doc.layers[i]);
        const active = activeId !== undefined ? activeId : (valid[valid.length - 1] ?? null);
        return { selectedLayerIds: valid, activeLayerId: active };
      });
    },

    setEditTarget(t) {
      patchActive((s) => {
        const l = s.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
        if (t === 'mask' && !l?.mask) return null;
        return { editTarget: t };
      });
    },

    addLayer(layer, opts = {}) {
      const s = get().activeDocId ? get().sessions[get().activeDocId!] : null;
      if (!s) return layer.id;
      let aboveId = opts.aboveId;
      if (aboveId === undefined && opts.parentId === undefined && opts.index === undefined) {
        aboveId = s.activeLayerId;
        // Adding above a collapsed/expanded group puts the layer above the group (same parent).
      }
      get().commit(
        opts.label ?? 'New Layer',
        (d) => insertLayerDraft(d, layer, { aboveId: aboveId ?? null, parentId: opts.parentId ?? null, index: opts.index }),
        opts.select === false ? {} : { activeLayerId: layer.id },
      );
      return layer.id;
    },

    updateLayer(id, change, label, opts) {
      get().commit(
        label ?? 'Layer Change',
        (d) => {
          const l = d.layers[id];
          if (!l) return;
          if (typeof change === 'function') (change as (l: Layer) => void)(l);
          else Object.assign(l, change);
        },
        opts,
      );
    },

    removeLayers(ids, label) {
      if (!ids.length) return;
      get().commit(label ?? (ids.length > 1 ? 'Delete Layers' : 'Delete Layer'), (d) => {
        for (const id of ids) removeLayerDraft(d, id);
      });
    },

    moveLayer(id, parentId, index, label) {
      get().commit(label ?? 'Move Layer', (d) => {
        if (!d.layers[id]) return;
        if (parentId === id) return;
        const list = siblingsOf(d, id);
        const oldIdx = list.indexOf(id);
        const oldParent = parentOf(d, id);
        detachLayerDraft(d, id);
        const target = parentId ? (d.layers[parentId] as Extract<Layer, { type: 'group' }>).childIds : d.rootIds;
        let i = index;
        if ((oldParent ?? null) === parentId && oldIdx < index) i -= 1;
        target.splice(Math.max(0, Math.min(i, target.length)), 0, id);
      });
    },

    groupLayers(ids, name) {
      const s = get().activeDocId ? get().sessions[get().activeDocId!] : null;
      if (!s || !ids.length) return null;
      // Keep only ids that share the parent of the topmost one, in stacking order.
      const parent = parentOf(s.doc, ids[0]) ?? null;
      const sibs = siblingsOf(s.doc, ids[0]);
      const ordered = sibs.filter((i) => ids.includes(i));
      if (!ordered.length) return null;
      const group = makeGroupLayer({ name: name ?? 'Group' });
      const topIndex = sibs.indexOf(ordered[ordered.length - 1]);
      get().commit(
        'Group Layers',
        (d) => {
          const list = parent ? (d.layers[parent] as Extract<Layer, { type: 'group' }>).childIds : d.rootIds;
          for (const id of ordered) detachLayerDraft(d, id);
          group.childIds = ordered;
          d.layers[group.id] = group;
          const insertAt = Math.max(0, topIndex - ordered.length + 1);
          list.splice(insertAt, 0, group.id);
        },
        { activeLayerId: group.id },
      );
      return group.id;
    },

    ungroupLayer(id) {
      const s = get().activeDocId ? get().sessions[get().activeDocId!] : null;
      const g = s?.doc.layers[id];
      if (!s || !g || g.type !== 'group') return;
      const children = [...g.childIds];
      get().commit(
        'Ungroup Layers',
        (d) => {
          const list = siblingsOf(d, id);
          const idx = list.indexOf(id);
          list.splice(idx, 1, ...children);
          delete d.layers[id];
        },
        { activeLayerId: children[children.length - 1] ?? null, selectedLayerIds: children },
      );
    },

    setView(v, docId) {
      const id = docId ?? get().activeDocId;
      if (!id) return;
      const s = get().sessions[id];
      if (!s) return;
      set({ sessions: { ...get().sessions, [id]: { ...s, view: { ...s.view, ...v } } } });
    },

    setTool(id, temporary = false) {
      const prev = get().activeTool;
      if (prev === id) return;
      set({ activeTool: id, previousTool: temporary ? prev : null });
    },

    restoreTool() {
      const p = get().previousTool;
      if (p) set({ activeTool: p, previousTool: null });
    },

    setToolOption(toolId, key, value) {
      set((st) => ({
        toolOptions: { ...st.toolOptions, [toolId]: { ...st.toolOptions[toolId], [key]: value } },
      }));
    },

    setPrimaryColor(c) {
      set({ primaryColor: c });
    },
    setSecondaryColor(c) {
      set({ secondaryColor: c });
    },
    swapColors() {
      set((st) => ({ primaryColor: st.secondaryColor, secondaryColor: st.primaryColor }));
    },
    resetColors() {
      set({ primaryColor: '#000000', secondaryColor: '#ffffff' });
    },
    pushRecentColor(c) {
      set((st) => ({ recentColors: [c, ...st.recentColors.filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 24) }));
    },
  };
});

// Any document change can leave bitmaps behind (cancelled previews, coalesced steps, tool
// leftovers): schedule an idle collection pass.
useEditor.subscribe((st, prev) => {
  if (st.sessions !== prev.sessions) requestBitmapGc();
});

/* ------------------------------------------------------------------ */
/* Convenience accessors (non-reactive, for tools/commands)            */
/* ------------------------------------------------------------------ */

export function activeSession(): DocSession | null {
  const st = useEditor.getState();
  return st.activeDocId ? (st.sessions[st.activeDocId] ?? null) : null;
}

export function activeDoc(): Document | null {
  return activeSession()?.doc ?? null;
}

export function activeLayer(): Layer | null {
  const s = activeSession();
  return s && s.activeLayerId ? (s.doc.layers[s.activeLayerId] ?? null) : null;
}

/** Tool options merged with the tool's defaults. */
export function toolOptions<T extends Record<string, unknown>>(toolId: string, defaults: T): T {
  return { ...defaults, ...(useEditor.getState().toolOptions[toolId] as Partial<T> | undefined) };
}

/* ---- React hooks ---- */

export function useActiveSession(): DocSession | null {
  return useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId] ?? null) : null));
}

export function useActiveDoc(): Document | null {
  return useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.doc ?? null) : null));
}

export function useActiveLayer(): Layer | null {
  return useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return s && s.activeLayerId ? (s.doc.layers[s.activeLayerId] ?? null) : null;
  });
}

export function useToolOptions<T extends Record<string, unknown>>(toolId: string, defaults: T): T {
  const opts = useEditor((st) => st.toolOptions[toolId]);
  return { ...defaults, ...(opts as Partial<T> | undefined) };
}
