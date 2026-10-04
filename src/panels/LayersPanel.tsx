/**
 * Layers panel (id 'layers'): kind filter + search, blend/opacity/locks/fill header, layer rows
 * (visibility, thumbnails, masks, clipping, groups, effects and smart filter sub-rows), drag
 * reorder, multi-select, inline rename, context menu and the footer buttons.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Contrast,
  CornerLeftDown,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  Image as ImageIcon,
  ListFilter,
  Lock,
  LockKeyhole,
  Move,
  Paintbrush,
  Search,
  Shapes,
  SlidersHorizontal,
  SquareDashed,
  SquarePlus,
  Trash2,
  Type,
  Wand,
  X,
} from 'lucide-react';
import type { BlendMode, Document, EditTarget, FillContent, GroupBlendMode, ID, Layer, LayerEffect, FilterInstance } from '../core/types';
import { isEffectivelyVisible } from '../core/document';
import { useEditor, activeSession } from '../state/editor';
import { commands, filters, runCommand } from '../registry';
import { IconButton, NumberField, SearchInput, Select, showContextMenu, showMenuAt, type MenuItem } from '../ui/controls';
import { isTypingTarget } from '../ui/shortcuts';
import type { SelectionMode } from '../editor/selection';
import * as ops from './layerOps';
import { canMoveInto, isFilterActive, panelRows, resolveDrop, type DropZone, type LayerKind, type PanelRow } from './treeOps';
import { THUMB_PX, useLayersPanel, type ThumbSize } from './panelState';
import { LayerThumbCanvas, MaskThumbCanvas } from './thumbs';
import { adjustmentMenuItems, effectContextMenu, effectMenuItems, filterContextMenu, labelCss, layerContextMenu, showFx, showProps } from './menus';
import { effectName } from './effectPresets';
import './panels.css';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'linear-dodge', label: 'Linear Dodge (Add)' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

export const GROUP_BLEND_MODES: { value: GroupBlendMode; label: string }[] = [{ value: 'pass-through', label: 'Pass Through' }, ...BLEND_MODES];

const KIND_TOGGLES: { kind: LayerKind; label: string; icon: typeof ImageIcon }[] = [
  { kind: 'pixel', label: 'Pixel layers', icon: ImageIcon },
  { kind: 'adjustment', label: 'Adjustment & fill layers', icon: Contrast },
  { kind: 'text', label: 'Text layers', icon: Type },
  { kind: 'shape', label: 'Shape layers', icon: Shapes },
  { kind: 'group', label: 'Groups', icon: Folder },
  { kind: 'smart', label: 'Layers with smart filters', icon: Wand },
];

const KIND_OPTIONS = [
  { value: 'all', label: 'Kind' },
  { value: 'pixel', label: 'Pixel' },
  { value: 'adjustment', label: 'Adjustment' },
  { value: 'text', label: 'Text' },
  { value: 'shape', label: 'Shape' },
  { value: 'group', label: 'Group' },
  { value: 'smart', label: 'Smart-filtered' },
  { value: 'multi', label: 'Multiple' },
] as const;

const cls = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

function selectionModeOf(e: { shiftKey: boolean; altKey: boolean }): SelectionMode {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return 'new';
}

const ctrlOf = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function LayersPanel() {
  const doc = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.doc ?? null) : null));
  if (!doc) {
    return (
      <div className="layers-panel">
        <LayersHeader doc={null} />
        <div className="layers-empty">
          <Folder size={22} strokeWidth={1.4} />
          <div>No document open</div>
          {commands.has('file.new') && (
            <button className="ui-btn small" onClick={() => runCommand('file.new')}>
              New Document…
            </button>
          )}
        </div>
        <LayersFooter disabled />
      </div>
    );
  }
  return <LayersPanelBody doc={doc} />;
}

/* ------------------------------------------------------------------ */
/* Header: kind filter, blend, opacity, locks, fill                    */
/* ------------------------------------------------------------------ */

function LayersHeader({ doc }: { doc: Document | null }) {
  const active = useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return s && s.activeLayerId ? (s.doc.layers[s.activeLayerId] ?? null) : null;
  });
  const { kinds, query, searchOpen, toggleKind, setKinds, setQuery, setSearchOpen, clearFilter } = useLayersPanel();
  const filterOn = kinds.length > 0 || query.trim().length > 0;
  const disabled = !doc || !active;
  const kindValue = kinds.length === 0 ? 'all' : kinds.length === 1 ? kinds[0] : 'multi';

  const editAll = (label: string, fn: (l: Layer) => void) => ({
    preview: () => ops.editSelected(label, fn, 'preview'),
    commit: () => ops.editSelected(label, fn, 'commit'),
  });

  const opacity = active?.opacity ?? 1;
  const fill = active?.fillOpacity ?? 1;
  const locks = active?.locks;
  const isGroup = active?.type === 'group';

  return (
    <div className="layers-head">
      <div className="layers-head-row">
        <div className="layers-kind">
          <ListFilter size={12} className="layers-kind-icon" />
          <Select
            value={kindValue}
            options={KIND_OPTIONS.filter((o) => o.value !== 'multi' || kindValue === 'multi')}
            onChange={(v) => setKinds(v === 'all' || v === 'multi' ? [] : [v as LayerKind])}
            title="Filter layers by kind"
            width={78}
            disabled={!doc}
          />
        </div>
        <div className="layers-kind-toggles">
          {KIND_TOGGLES.map((k) => (
            <IconButton
              key={k.kind}
              icon={k.icon}
              size="sm"
              iconSize={12}
              title={`Show only: ${k.label}`}
              active={kinds.includes(k.kind)}
              disabled={!doc}
              onClick={() => toggleKind(k.kind)}
            />
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {filterOn ? (
          <IconButton icon={X} size="sm" iconSize={12} title="Clear layer filter" className="layers-filter-on" onClick={clearFilter} />
        ) : (
          <IconButton icon={Search} size="sm" iconSize={12} title="Search layers by name" active={searchOpen} disabled={!doc} onClick={() => setSearchOpen(!searchOpen)} />
        )}
      </div>
      {searchOpen && (
        <div className="layers-head-row">
          <div style={{ flex: 1 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Filter by layer name" autoFocus />
          </div>
        </div>
      )}
      <div className="layers-head-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select<string>
            value={active ? active.blendMode : 'normal'}
            options={isGroup ? GROUP_BLEND_MODES : BLEND_MODES}
            width="100%"
            title="Blend mode"
            disabled={disabled}
            onChange={(v) => {
              const s = activeSession();
              if (!s) return;
              // Pass-through only applies to groups.
              ops.editSelected('Blend Mode', (l) => {
                if (v === 'pass-through' && l.type !== 'group') return;
                (l as { blendMode: string }).blendMode = v;
              });
            }}
          />
        </div>
        <span className="layers-vsep" />
        <div className={cls('layers-num', disabled && 'disabled')}>
          <NumberField
            value={opacity}
            min={0}
            max={1}
            step={1}
            displayScale={100}
            unit="%"
            width={56}
            title="Layer opacity (affects content and effects)"
            scrubLabel="Opacity"
            onChange={(v) => !disabled && editAll('Opacity', (l) => (l.opacity = v)).preview()}
            onCommit={(v) => !disabled && editAll('Opacity', (l) => (l.opacity = v)).commit()}
          />
        </div>
      </div>
      <div className="layers-head-row">
        <span className="ui-label">Lock:</span>
        <div className="layers-locks">
          <IconButton
            icon={Grid2x2}
            size="sm"
            iconSize={12}
            title="Lock transparent pixels"
            active={!!locks?.transparency}
            disabled={disabled || isGroup}
            onClick={() => ops.toggleLock('transparency')}
          />
          <IconButton
            icon={Paintbrush}
            size="sm"
            iconSize={12}
            title="Lock image pixels"
            active={!!locks?.pixels}
            disabled={disabled || isGroup}
            onClick={() => ops.toggleLock('pixels')}
          />
          <IconButton icon={Move} size="sm" iconSize={12} title="Lock position" active={!!locks?.position} disabled={disabled} onClick={() => ops.toggleLock('position')} />
          <IconButton icon={Lock} size="sm" iconSize={12} title="Lock all" active={!!locks?.all} disabled={disabled} onClick={() => ops.toggleLock('all')} />
        </div>
        <span style={{ flex: 1 }} />
        <span className="layers-vsep" />
        <div className={cls('layers-num', (disabled || isGroup || active?.type === 'adjustment') && 'disabled')}>
          <NumberField
            value={fill}
            min={0}
            max={1}
            step={1}
            displayScale={100}
            unit="%"
            width={56}
            title="Fill opacity (affects content but not layer effects)"
            scrubLabel="Fill"
            onChange={(v) => !disabled && editAll('Fill Opacity', (l) => (l.fillOpacity = v)).preview()}
            onCommit={(v) => !disabled && editAll('Fill Opacity', (l) => (l.fillOpacity = v)).commit()}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

function LayersFooter({ disabled }: { disabled?: boolean }) {
  const hasActive = useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return !!(s && s.activeLayerId && s.doc.layers[s.activeLayerId]);
  });
  return (
    <div className="layers-foot">
      <span style={{ flex: 1 }} />
      <button
        className="ui-icon-btn layers-fx-btn"
        title="Add a layer style"
        disabled={disabled || !hasActive}
        data-drop-action="fx"
        onClick={(e) => showMenuAt(e.currentTarget, effectMenuItems(), 190)}
      >
        fx
      </button>
      <IconButton
        icon={SquareDashed}
        title="Add layer mask (from selection if any) — Alt: hide all"
        disabled={disabled || !hasActive}
        data-drop-action="mask"
        onClick={(e) => ops.addMaskAuto(e.altKey)}
      />
      <IconButton
        icon={Contrast}
        title="Create new fill or adjustment layer"
        disabled={disabled}
        onClick={(e) => showMenuAt(e.currentTarget, adjustmentMenuItems(), 190)}
      />
      <IconButton icon={FolderPlus} title="Create a new group" disabled={disabled} onClick={() => ops.newGroup()} />
      <IconButton icon={SquarePlus} title="Create a new layer — drop a layer here to duplicate it" disabled={disabled} data-drop-action="duplicate" onClick={() => ops.newLayer()} />
      <IconButton icon={Trash2} title="Delete layer — or drop layers here" disabled={disabled || !hasActive} data-drop-action="delete" onClick={() => ops.deleteLayers()} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

interface DragState {
  id: ID;
  ids: ID[];
  x: number;
  y: number;
  active: boolean;
  pendingSelect: ID | null;
}

type DropTarget = { kind: 'row'; rowId: ID; zone: DropZone } | { kind: 'end' } | { kind: 'action'; action: string } | null;

interface RowHandlers {
  rowDown(e: React.PointerEvent, id: ID): void;
  eyeDown(e: React.PointerEvent, id: ID): void;
  eyeEnter(id: ID): void;
  toggleCollapse(id: ID): void;
  toggleExpanded(id: ID): void;
  context(e: React.MouseEvent, id: ID): void;
  doubleClick(e: React.MouseEvent, id: ID): void;
  startRename(id: ID): void;
  finishRename(id: ID, name: string | null): void;
}

function LayersPanelBody({ doc }: { doc: Document }) {
  const activeId = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.activeLayerId ?? null) : null));
  const selectedIds = useEditor((st) => (st.activeDocId ? st.sessions[st.activeDocId]?.selectedLayerIds : undefined));
  const editTarget = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.editTarget ?? 'content') : 'content'));
  const { kinds, query, thumbSize, expanded, toggleExpanded } = useLayersPanel();
  const filter = useMemo(() => ({ kinds, query }), [kinds, query]);
  const filtering = isFilterActive(filter);
  const rows = useMemo(() => panelRows(doc, filter), [doc, filter]);
  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const [renaming, setRenaming] = useState<ID | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<PanelRow[]>(rows);
  rowsRef.current = rows;
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  const anchorRef = useRef<ID | null>(null);
  const eyeDrag = useRef<{ value: boolean; ids: Set<ID> } | null>(null);

  // When the active layer changes (Alt+[ / Alt+], auto-select on canvas…): expand collapsed
  // groups around it and scroll its row into view once it is rendered.
  const pendingScroll = useRef<ID | null>(null);
  useEffect(() => {
    if (!activeId) return;
    pendingScroll.current = activeId;
    if (!filteringRef.current && !rowsRef.current.some((r) => r.id === activeId)) ops.revealLayer(activeId);
  }, [activeId]);
  useEffect(() => {
    const id = pendingScroll.current;
    if (!id || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (!el) return;
    pendingScroll.current = null;
    el.scrollIntoView({ block: 'nearest' });
  }, [activeId, rows]);

  const computeDrop = useCallback((clientX: number, clientY: number, moving: ID[]): DropTarget => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const action = el?.closest<HTMLElement>('[data-drop-action]')?.dataset.dropAction;
    if (action === 'delete' || action === 'duplicate') return { kind: 'action', action };
    const s = activeSession();
    if (!s) return null;
    const rowEl = el?.closest<HTMLElement>('[data-row-id],[data-sub-of]');
    if (!rowEl) {
      const list = listRef.current;
      if (list && el && list.contains(el)) return canMoveInto(s.doc, moving, null) ? { kind: 'end' } : null;
      return null;
    }
    const rowId = rowEl.dataset.rowId ?? rowEl.dataset.subOf!;
    const layer = s.doc.layers[rowId];
    if (!layer) return null;
    let zone: DropZone;
    if (rowEl.dataset.subOf) zone = 'below';
    else {
      const r = rowEl.getBoundingClientRect();
      const rel = (clientY - r.top) / r.height;
      if (layer.type === 'group') zone = rel < 0.28 ? 'above' : rel > 0.72 ? 'below' : 'into';
      else zone = rel < 0.5 ? 'above' : 'below';
    }
    if (moving.includes(rowId)) return null;
    const target = resolveDrop(s.doc, rowId, zone);
    if (!target || !canMoveInto(s.doc, moving, target.parentId)) return null;
    return { kind: 'row', rowId, zone };
  }, []);

  const handlers = useMemo<RowHandlers>(() => {
    const ed = () => useEditor.getState();

    const selectOnDown = (e: React.PointerEvent, id: ID): ID | null => {
      const s = activeSession();
      if (!s) return null;
      if (ctrlOf(e)) {
        ed().setActiveLayer(id, 'toggle');
        anchorRef.current = id;
        return null;
      }
      if (e.shiftKey) {
        const list = rowsRef.current.map((r) => r.id);
        const anchor = anchorRef.current && list.includes(anchorRef.current) ? anchorRef.current : s.activeLayerId;
        const a = anchor ? list.indexOf(anchor) : -1;
        const b = list.indexOf(id);
        if (a < 0 || b < 0) ed().setActiveLayer(id);
        else ed().setSelectedLayers(list.slice(Math.min(a, b), Math.max(a, b) + 1), id);
        return null;
      }
      anchorRef.current = id;
      if (s.selectedLayerIds.includes(id) && s.selectedLayerIds.length > 1) return id; // decide on release
      if (s.activeLayerId !== id || s.selectedLayerIds.length !== 1) ed().setActiveLayer(id);
      return null;
    };

    const startDrag = (e: React.PointerEvent, id: ID, pendingSelect: ID | null) => {
      const st: DragState = { id, ids: [], x: e.clientX, y: e.clientY, active: false, pendingSelect };
      let lastTarget: DropTarget = null;
      let scrollTimer = 0;
      const move = (ev: PointerEvent) => {
        if (!st.active) {
          if (Math.hypot(ev.clientX - st.x, ev.clientY - st.y) < 5) return;
          if (filteringRef.current) return; // no reordering in a filtered view
          const s = activeSession();
          if (!s) return;
          st.active = true;
          st.ids = s.selectedLayerIds.includes(id) ? ops.selectedTopLevel(s) : [id];
          document.body.classList.add('layers-dragging');
        }
        lastTarget = computeDrop(ev.clientX, ev.clientY, st.ids);
        setDrop(lastTarget);
        // Auto-scroll near the list edges.
        const list = listRef.current;
        window.clearInterval(scrollTimer);
        if (list) {
          const r = list.getBoundingClientRect();
          const dir = ev.clientY < r.top + 20 ? -1 : ev.clientY > r.bottom - 20 ? 1 : 0;
          if (dir) scrollTimer = window.setInterval(() => (list.scrollTop += dir * 8), 16);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.clearInterval(scrollTimer);
        document.body.classList.remove('layers-dragging');
        setDrop(null);
        if (!st.active) {
          if (st.pendingSelect) ed().setActiveLayer(st.pendingSelect);
          return;
        }
        const s = activeSession();
        if (!s || !lastTarget) return;
        if (lastTarget.kind === 'action') {
          if (lastTarget.action === 'delete') ops.deleteLayers(st.ids);
          else if (lastTarget.action === 'duplicate') ops.duplicateLayers({ ids: st.ids });
          return;
        }
        if (lastTarget.kind === 'end') return ops.moveLayers(st.ids, null, 0);
        const t = resolveDrop(s.doc, lastTarget.rowId, lastTarget.zone);
        if (t) ops.moveLayers(st.ids, t.parentId, t.index);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };

    return {
      rowDown(e, id) {
        if (e.button !== 0) return;
        const part = (e.target as HTMLElement).closest<HTMLElement>('[data-part]')?.dataset.part;
        if (part === 'eye' || part === 'disclosure' || part === 'badge' || part === 'rename') return;
        rootRef.current?.focus({ preventScroll: true });
        const s = activeSession();
        const layer = s?.doc.layers[id];
        if (!s || !layer) return;
        if (part === 'thumb' && ctrlOf(e)) {
          e.preventDefault();
          ops.loadSelectionFromLayer(id, selectionModeOf(e));
          return;
        }
        if (part === 'mask') {
          if (ctrlOf(e)) {
            e.preventDefault();
            ops.loadSelectionFromMask(id, selectionModeOf(e));
            return;
          }
          if (e.shiftKey) {
            ops.toggleMaskEnabled(id);
            return;
          }
          ops.editMaskOf(id);
          anchorRef.current = id;
          startDrag(e, id, null);
          return;
        }
        const pending = selectOnDown(e, id);
        if (part === 'thumb' && layer.mask && !ctrlOf(e) && !e.shiftKey) ops.editContentOf(id);
        startDrag(e, id, pending);
      },
      eyeDown(e, id) {
        e.stopPropagation();
        if (e.button !== 0) return;
        const s = activeSession();
        const l = s?.doc.layers[id];
        if (!s || !l) return;
        if (e.altKey) {
          ops.soloLayer(id);
          return;
        }
        const value = !l.visible;
        eyeDrag.current = { value, ids: new Set([id]) };
        ed().preview((d) => {
          if (d.layers[id]) d.layers[id].visible = value;
        });
        const up = () => {
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          const drag = eyeDrag.current;
          eyeDrag.current = null;
          if (!drag) return;
          const n = drag.ids.size;
          const ids = [...drag.ids];
          ed().commit(n > 1 ? 'Show/Hide Layers' : value ? 'Show Layer' : 'Hide Layer', (d) => {
            for (const x of ids) if (d.layers[x]) d.layers[x].visible = value;
          });
        };
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
      eyeEnter(id) {
        const drag = eyeDrag.current;
        if (!drag || drag.ids.has(id)) return;
        drag.ids.add(id);
        const v = drag.value;
        ed().preview((d) => {
          if (d.layers[id]) d.layers[id].visible = v;
        });
      },
      toggleCollapse(id) {
        const l = activeSession()?.doc.layers[id];
        if (l?.type === 'group') ops.setGroupCollapsed(id, !l.collapsed);
      },
      toggleExpanded(id) {
        toggleExpanded(id);
      },
      context(e, id) {
        e.preventDefault();
        const s = activeSession();
        const l = s?.doc.layers[id];
        if (!s || !l) return;
        if (!s.selectedLayerIds.includes(id)) ed().setActiveLayer(id);
        const layer = activeSession()!.doc.layers[id];
        showContextMenu(e, layerContextMenu(layer, (x) => setRenaming(x)));
      },
      doubleClick(e, id) {
        const part = (e.target as HTMLElement).closest<HTMLElement>('[data-part]')?.dataset.part;
        if (part === 'eye' || part === 'disclosure' || part === 'badge' || part === 'rename' || ctrlOf(e)) return;
        if (part === 'name') return setRenaming(id);
        const l = activeSession()?.doc.layers[id];
        if (!l) return;
        if (part === 'mask') return showProps(id);
        if (l.type === 'group' && part !== 'thumb') return setRenaming(id);
        if (part === 'thumb' && (l.type === 'adjustment' || l.type === 'fill' || l.type === 'text' || l.type === 'shape')) return showProps(id);
        if (l.type === 'adjustment') return showProps(id);
        showFx(id);
      },
      startRename(id) {
        setRenaming(id);
      },
      finishRename(id, name) {
        setRenaming(null);
        if (name !== null) ops.renameLayer(id, name);
        rootRef.current?.focus({ preventScroll: true });
      },
    };
  }, [computeDrop, toggleExpanded]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      ops.deleteLayers();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const list = rowsRef.current.map((r) => r.id);
      const s = activeSession();
      const i = s?.activeLayerId ? list.indexOf(s.activeLayerId) : -1;
      const j = Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)));
      if (list[j]) {
        if (e.shiftKey && s?.activeLayerId) useEditor.getState().setActiveLayer(list[j], 'toggle');
        else useEditor.getState().setActiveLayer(list[j]);
      }
    } else if (e.key === 'F2' && activeId) {
      e.preventDefault();
      setRenaming(activeId);
    } else if (e.key === 'Escape') {
      (e.target as HTMLElement).blur?.();
    }
  };

  const thumbPx = THUMB_PX[thumbSize];
  // Clipping bases: a non-clipped layer directly below clipped layers gets its name underlined.
  const clipBases = useMemo(() => {
    const set = new Set<ID>();
    for (const r of rows) {
      const l = doc.layers[r.id];
      if (!l?.clipped) continue;
      const parent = Object.values(doc.layers).find((g) => g.type === 'group' && g.childIds.includes(r.id));
      const list = parent && parent.type === 'group' ? parent.childIds : doc.rootIds;
      for (let i = list.indexOf(r.id) - 1; i >= 0; i--) {
        if (!doc.layers[list[i]]?.clipped) {
          set.add(list[i]);
          break;
        }
      }
    }
    return set;
  }, [rows, doc]);

  return (
    <div className="layers-panel" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} style={{ ['--thumb' as string]: `${Math.max(thumbPx, 18)}px` } as CSSProperties}>
      <LayersHeader doc={doc} />
      <div
        className={cls('layers-list', drop?.kind === 'end' && 'drop-end')}
        ref={listRef}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) rootRef.current?.focus({ preventScroll: true });
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          const items: MenuItem[] = [
            { label: 'New Layer', icon: SquarePlus, shortcut: 'Shift+Ctrl+N', run: () => void ops.newLayer() },
            { label: 'New Group', icon: FolderPlus, run: () => void ops.newGroup() },
            { label: 'New Fill or Adjustment Layer', icon: Contrast, submenu: adjustmentMenuItems() },
            { separator: true },
            { label: 'Merge Visible', run: ops.mergeVisible },
            { label: 'Flatten Image', run: ops.flattenImage },
            { separator: true },
            { label: 'Thumbnail Size', submenu: thumbSizeItems(thumbSize) },
          ];
          showContextMenu(e, items);
        }}
      >
        {rows.length === 0 && (
          <div className="layers-empty">
            {filtering ? (
              <>
                <div>No layers match the filter</div>
                <button className="ui-btn small" onClick={() => useLayersPanel.getState().clearFilter()}>
                  Clear filter
                </button>
              </>
            ) : (
              <>
                <div>This document has no layers</div>
                <button className="ui-btn small" onClick={() => ops.newLayer()}>
                  New Layer
                </button>
              </>
            )}
          </div>
        )}
        {rows.map((r) => {
          const layer = doc.layers[r.id];
          if (!layer) return null;
          const isActive = r.id === activeId;
          const open = !!expanded[r.id] && (layer.effects.length > 0 || layer.filters.length > 0);
          return (
            <LayerRowBlock
              key={r.id}
              doc={doc}
              layer={layer}
              depth={r.depth}
              dim={r.dim}
              active={isActive}
              selected={selected.has(r.id)}
              editTarget={isActive ? editTarget : 'content'}
              thumbPx={thumbPx}
              expanded={open}
              renaming={renaming === r.id}
              clipBase={clipBases.has(r.id)}
              effectivelyVisible={isEffectivelyVisible(doc, r.id)}
              dropZone={drop?.kind === 'row' && drop.rowId === r.id ? drop.zone : null}
              h={handlers}
            />
          );
        })}
      </div>
      <LayersFooter />
    </div>
  );
}

function thumbSizeItems(current: ThumbSize): MenuItem[] {
  const set = useLayersPanel.getState().setThumbSize;
  return (['none', 'small', 'medium', 'large'] as ThumbSize[]).map((s) => ({
    label: s === 'none' ? 'None' : s[0].toUpperCase() + s.slice(1),
    checked: current === s,
    run: () => set(s),
  }));
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

interface RowProps {
  doc: Document;
  layer: Layer;
  depth: number;
  dim: boolean;
  active: boolean;
  selected: boolean;
  editTarget: EditTarget;
  thumbPx: number;
  expanded: boolean;
  renaming: boolean;
  clipBase: boolean;
  effectivelyVisible: boolean;
  dropZone: DropZone | null;
  h: RowHandlers;
}

/** Rows only re-render when their own layer (or row state) changes — not on every document edit. */
function rowPropsEqual(a: RowProps, b: RowProps) {
  for (const k of Object.keys(a) as (keyof RowProps)[]) {
    if (k === 'doc') continue;
    if (a[k] !== b[k]) return false;
  }
  return a.doc.width === b.doc.width && a.doc.height === b.doc.height && a.doc.id === b.doc.id;
}

const LayerRowBlock = memo(function LayerRowBlock(p: RowProps) {
  const { layer, depth, h } = p;
  const indent = depth * 14;
  return (
    <>
      <LayerRow {...p} />
      {p.expanded && layer.effects.length > 0 && <EffectRows layer={layer} indent={indent} h={h} />}
      {p.expanded && layer.filters.length > 0 && <FilterRows layer={layer} indent={indent} h={h} />}
    </>
  );
}, rowPropsEqual);

function LayerRow({ doc, layer, depth, dim, active, selected, editTarget, thumbPx, expanded, renaming, clipBase, effectivelyVisible, dropZone, h }: RowProps) {
  const label = labelCss(layer.label);
  const locked = layer.locks.all || layer.locks.pixels || layer.locks.position || layer.locks.transparency;
  const isGroup = layer.type === 'group';
  return (
    <div
      className={cls(
        'layers-row',
        active && 'active',
        selected && 'selected',
        dim && 'dim',
        !effectivelyVisible && 'hidden-layer',
        dropZone && `drop-${dropZone}`,
      )}
      data-row-id={layer.id}
      onPointerDown={(e) => h.rowDown(e, layer.id)}
      onContextMenu={(e) => h.context(e, layer.id)}
      onDoubleClick={(e) => h.doubleClick(e, layer.id)}
    >
      <div
        className="layers-eye"
        data-part="eye"
        style={label ? { background: `color-mix(in srgb, ${label} 34%, transparent)` } : undefined}
        title="Toggle visibility (Alt-click: show only this layer, drag to toggle many)"
        onPointerDown={(e) => h.eyeDown(e, layer.id)}
        onPointerEnter={() => h.eyeEnter(layer.id)}
      >
        {layer.visible ? <Eye size={13} strokeWidth={1.6} /> : <span className="layers-eye-off" />}
      </div>
      <div className="layers-row-main" style={{ paddingLeft: 4 + depth * 14 }}>
        {layer.clipped && (
          <span className="layers-clip" title="Clipped to the layer below">
            <CornerLeftDown size={12} strokeWidth={1.8} />
          </span>
        )}
        {isGroup ? (
          <button
            className="layers-disclosure"
            data-part="disclosure"
            title={layer.collapsed ? 'Expand group' : 'Collapse group'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => h.toggleCollapse(layer.id)}
          >
            {layer.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : null}
        {thumbPx > 0 || isGroup ? (
          <LayerThumb doc={doc} layer={layer} px={thumbPx} target={active && !!layer.mask && editTarget === 'content'} />
        ) : null}
        {layer.mask && thumbPx > 0 && (
          <div
            className={cls('layers-thumb', 'mask', active && editTarget === 'mask' && 'target', !layer.mask.enabled && 'disabled')}
            data-part="mask"
            title="Layer mask — click to paint on the mask, Shift-click to disable, Ctrl-click to load as selection"
          >
            <MaskThumbCanvas doc={doc} bitmapId={layer.mask.bitmapId} size={thumbPx} />
            {!layer.mask.enabled && <X className="layers-mask-x" size={Math.max(12, thumbPx * 0.7)} strokeWidth={2.2} />}
          </div>
        )}
        {layer.mask && thumbPx === 0 && (
          <span className={cls('layers-mask-chip', active && editTarget === 'mask' && 'target')} data-part="mask" title="Layer mask">
            <SquareDashed size={12} />
          </span>
        )}
        <div className="layers-name" data-part={renaming ? 'rename' : 'name'}>
          {renaming ? (
            <RenameInput initial={layer.name} onDone={(v) => h.finishRename(layer.id, v)} />
          ) : (
            <span className={cls(clipBase && 'clip-base')} title={layer.name}>
              {layer.name}
            </span>
          )}
        </div>
        {locked && (
          <span className="layers-lock" title={layer.locks.all ? 'Locked' : 'Partially locked'}>
            {layer.locks.all ? <Lock size={11} /> : <LockKeyhole size={11} />}
          </span>
        )}
        {layer.filters.length > 0 && (
          <button
            className={cls('layers-badge', expanded && 'open')}
            data-part="badge"
            title="Smart filters — click to show"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => h.toggleExpanded(layer.id)}
          >
            <Wand size={11} />
          </button>
        )}
        {layer.effects.length > 0 && (
          <button
            className={cls('layers-badge', 'fx', expanded && 'open')}
            data-part="badge"
            title="Layer effects — click to show"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => h.toggleExpanded(layer.id)}
          >
            <span>fx</span>
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </div>
    </div>
  );
}

function LayerThumb({ doc, layer, px, target }: { doc: Document; layer: Layer; px: number; target: boolean }) {
  const size = Math.max(px, 18);
  const base = cls('layers-thumb', target && 'target', `type-${layer.type}`);
  if (layer.type === 'group') {
    const Icon = layer.collapsed ? Folder : FolderOpen;
    return (
      <div className={cls('layers-thumb', 'type-group')} data-part="thumb" style={{ width: Math.min(size, 24) }}>
        <Icon size={Math.min(16, size - 4)} strokeWidth={1.5} />
      </div>
    );
  }
  if (layer.type === 'text') {
    return (
      <div className={base} data-part="thumb" title="Text layer">
        <Type size={Math.round(size * 0.55)} strokeWidth={1.8} />
      </div>
    );
  }
  if (layer.type === 'adjustment') {
    const Icon = filters.get(layer.adjustment.filterId)?.icon ?? SlidersHorizontal;
    return (
      <div className={base} data-part="thumb" title={filters.get(layer.adjustment.filterId)?.name ?? 'Adjustment layer'}>
        <Icon size={Math.round(size * 0.55)} strokeWidth={1.6} />
      </div>
    );
  }
  if (layer.type === 'fill' && layer.fill.type !== 'pattern') {
    return <div className={cls(base, 'swatch')} data-part="thumb" style={{ background: fillCss(layer.fill) }} title="Fill layer" />;
  }
  return (
    <div className={cls(base, 'checker')} data-part="thumb">
      <LayerThumbCanvas doc={doc} layer={layer} size={size} />
    </div>
  );
}

const CHECKER = 'repeating-conic-gradient(#888 0% 25%, #bbb 0% 50%) 50% / 8px 8px';

/** CSS background previewing a solid / gradient fill (over a checkerboard for transparency). */
export function fillCss(fill: FillContent): string {
  if (fill.type === 'solid') return `linear-gradient(${fill.color}, ${fill.color}), ${CHECKER}`;
  if (fill.type === 'pattern') return CHECKER;
  const g = fill.gradient;
  const stops = [...g.stops].sort((a, b) => a.offset - b.offset);
  const list = (g.reverse ? stops.map((x) => ({ ...x, offset: 1 - x.offset })).reverse() : stops)
    .map((x) => `${x.color} ${(x.offset * 100).toFixed(1)}%`)
    .join(', ');
  const css = g.kind === 'radial' || g.kind === 'diamond' ? `radial-gradient(circle, ${list})` : g.kind === 'angle' ? `conic-gradient(from ${g.angle + 90}deg, ${list})` : `linear-gradient(${g.angle + 90}deg, ${list})`;
  return `${css}, ${CHECKER}`;
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (val: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(val);
  };
  return (
    <input
      className="layers-rename"
      value={v}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(v);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(v)}
    />
  );
}

function EffectRows({ layer, indent, h }: { layer: Layer; indent: number; h: RowHandlers }) {
  const anyOn = layer.effects.some((e) => e.enabled);
  return (
    <>
      <div className="layers-subrow" data-sub-of={layer.id} onContextMenu={(e) => e.preventDefault()} onDoubleClick={() => showFx(layer.id)}>
        <div className="layers-eye" data-part="eye" onPointerDown={(e) => (e.stopPropagation(), ops.toggleAllEffects(layer.id))} title="Show/hide all effects">
          {anyOn ? <Eye size={12} strokeWidth={1.6} /> : <span className="layers-eye-off" />}
        </div>
        <div className="layers-sub-main" style={{ paddingLeft: indent + 30 }}>
          <span className="layers-sub-title">Effects</span>
        </div>
      </div>
      {/* Top row = drawn on top (arrays are stored bottom → top). */}
      {[...layer.effects].reverse().map((fx: LayerEffect) => (
        <div
          key={fx.id}
          className={cls('layers-subrow', !fx.enabled && 'off')}
          data-sub-of={layer.id}
          onContextMenu={(e) => showContextMenu(e, effectContextMenu(layer.id, fx.id))}
          onDoubleClick={() => {
            ops.useLayersUI.getState().setExpandedEffect(fx.id);
            showFx(layer.id);
          }}
        >
          <div className="layers-eye" data-part="eye" onPointerDown={(e) => (e.stopPropagation(), ops.toggleEffect(layer.id, fx.id))} title="Show/hide effect">
            {fx.enabled ? <Eye size={12} strokeWidth={1.6} /> : <span className="layers-eye-off" />}
          </div>
          <div className="layers-sub-main" style={{ paddingLeft: indent + 44 }}>
            {effectName(fx.effectId)}
          </div>
        </div>
      ))}
    </>
  );
}

function FilterRows({ layer, indent, h }: { layer: Layer; indent: number; h: RowHandlers }) {
  void h;
  const anyOn = layer.filters.some((f) => f.enabled);
  return (
    <>
      <div className="layers-subrow" data-sub-of={layer.id} onContextMenu={(e) => e.preventDefault()} onDoubleClick={() => showProps(layer.id)}>
        <div className="layers-eye" data-part="eye" onPointerDown={(e) => (e.stopPropagation(), ops.toggleAllFilters(layer.id))} title="Show/hide all smart filters">
          {anyOn ? <Eye size={12} strokeWidth={1.6} /> : <span className="layers-eye-off" />}
        </div>
        <div className="layers-sub-main" style={{ paddingLeft: indent + 30 }}>
          <span className="layers-sub-title">Smart Filters</span>
        </div>
      </div>
      {[...layer.filters].reverse().map((f: FilterInstance) => (
        <div
          key={f.id}
          className={cls('layers-subrow', !f.enabled && 'off')}
          data-sub-of={layer.id}
          onContextMenu={(e) => showContextMenu(e, filterContextMenu(layer.id, f.id))}
          onDoubleClick={() => showProps(layer.id)}
        >
          <div className="layers-eye" data-part="eye" onPointerDown={(e) => (e.stopPropagation(), ops.toggleFilter(layer.id, f.id))} title="Show/hide smart filter">
            {f.enabled ? <Eye size={12} strokeWidth={1.6} /> : <span className="layers-eye-off" />}
          </div>
          <div className="layers-sub-main" style={{ paddingLeft: indent + 44 }}>
            {filters.get(f.filterId)?.name ?? f.filterId}
          </div>
        </div>
      ))}
    </>
  );
}

/** Panel ⋯ menu. */
export function layersPanelMenu() {
  const st = useLayersPanel.getState();
  const has = ops.hasDoc();
  const hasL = ops.hasLayer();
  return [
    { label: 'New Layer', run: () => void ops.newLayer(), disabled: !has },
    { label: 'New Group', run: () => void ops.newGroup(), disabled: !has },
    { label: 'Duplicate Layer', run: () => void ops.duplicateLayers(), disabled: !hasL },
    { label: 'Delete Layer', run: () => void ops.deleteLayers(), disabled: !hasL },
    { label: 'Merge Down', run: ops.mergeDown, disabled: !hasL },
    { label: 'Flatten Image', run: ops.flattenImage, disabled: !has },
    { label: 'Thumbnails: None', checked: st.thumbSize === 'none', run: () => st.setThumbSize('none') },
    { label: 'Thumbnails: Small', checked: st.thumbSize === 'small', run: () => st.setThumbSize('small') },
    { label: 'Thumbnails: Medium', checked: st.thumbSize === 'medium', run: () => st.setThumbSize('medium') },
    { label: 'Thumbnails: Large', checked: st.thumbSize === 'large', run: () => st.setThumbSize('large') },
  ];
}

