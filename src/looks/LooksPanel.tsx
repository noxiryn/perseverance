import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BookmarkPlus, Check, Eraser, Eye, EyeOff, FilePlus2, Info, Layers, Image as ImageIcon, Loader2, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import type { Document, ID, Layer } from '../core/types';
import { commands, looks, runCommand, useRegistry, type LookDef } from '../registry';
import { useActiveDoc, useEditor } from '../state/editor';
import { Button, ChipRow, IconButton, SearchInput, showContextMenu } from '../ui/controls';
import { applyLook, currentLookId, hasLook, lookTargets, lookTouchesTarget, removeLook, type LookTargets } from './engine';
import { clearLookPreviewBases, contentSignature, renderLookPreviewURL } from './preview';
import { IdleQueue, isPointerDown, nextPaint } from './shared';
import { useLooksUI } from './store';
import { deleteUserLook, isUserLook, renameUserLook, saveCurrentLook } from './userLooks';
import './looks.css';

/* ------------------------------------------------------------------ */
/* Lazy previews                                                       */
/* ------------------------------------------------------------------ */

const PREVIEW_SIZE = 176;
/** Previews wait for real idle time and never run while a pointer is down (painting, dragging). */
const queue = new IdleQueue({ canRun: () => !isPointerDown() });

interface CachedPreview {
  /** contentSignature() of the document the preview was rendered from. */
  sig: string;
  url: string;
}

/**
 * LRU of rendered previews, key = docId|target|lookId (target is '*' for looks that don't touch
 * the target layer, so they are shared by every target). Capped at ~2 targets' worth of looks.
 */
const previewCache = new Map<string, CachedPreview>();

function cacheLimit() {
  return Math.max(40, looks.list().length * 2 + 8);
}

function cacheGet(key: string): CachedPreview | undefined {
  const hit = previewCache.get(key);
  if (hit) {
    previewCache.delete(key);
    previewCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, v: CachedPreview) {
  previewCache.delete(key);
  previewCache.set(key, v);
  const max = cacheLimit();
  while (previewCache.size > max) previewCache.delete(previewCache.keys().next().value as string);
}

/** Drop previews of documents that are no longer open. */
function pruneClosedDocs(open: Record<ID, unknown>) {
  for (const k of [...previewCache.keys()]) if (!open[k.slice(0, k.indexOf('|'))]) previewCache.delete(k);
}

function previewKey(docId: ID, look: LookDef, target: Layer | null) {
  return `${docId}|${target && lookTouchesTarget(look, target) ? target.id : '*'}|${look.id}`;
}

/** Track which look cards are on screen (inside the scroll container, panel tab visible). */
function useVisibleIds(rootRef: React.RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const io = useRef<IntersectionObserver | null>(null);
  const elems = useRef(new Map<string, Element>());

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(elems.current.keys()));
      return;
    }
    const obs = new IntersectionObserver(
      (entries) =>
        setVisible((prev) => {
          let next: Set<string> | null = null;
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.lookId;
            if (!id || e.isIntersecting === prev.has(id)) continue;
            next ??= new Set(prev);
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next ?? prev;
        }),
      { root: rootRef.current, rootMargin: '120px 0px' },
    );
    io.current = obs;
    elems.current.forEach((el) => obs.observe(el));
    return () => {
      obs.disconnect();
      io.current = null;
    };
  }, [rootRef]);

  const register = useCallback((id: string, el: Element | null) => {
    const prev = elems.current.get(id);
    if (prev === el) return;
    if (prev) io.current?.unobserve(prev);
    if (el) {
      elems.current.set(id, el);
      io.current?.observe(el);
    } else elems.current.delete(id);
  }, []);

  return [visible, register] as const;
}

function useLookPreviews(doc: Document | null, target: Layer | null, enabled: boolean, wanted: LookDef[], historyKey: string | null) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const wantedKey = wanted.map((l) => l.id).join(',');
  const targetId = target?.id ?? null;

  useEffect(() => {
    if (!enabled) {
      queue.clear();
      clearLookPreviewBases();
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !doc || !wanted.length) return;
    let cancelled = false;
    const sig = contentSignature(doc);
    const stale = wanted.filter((l) => cacheGet(previewKey(doc.id, l, target))?.sig !== sig);
    if (!stale.length) return;
    // First previews come quickly; refreshes after an edit wait until the user pauses.
    const refresh = stale.some((l) => previewCache.has(previewKey(doc.id, l, target)));
    const keys: string[] = [];
    const timer = window.setTimeout(
      () => {
        stale.forEach((look, i) => {
          const key = previewKey(doc.id, look, target);
          keys.push(key);
          queue.push(
            key,
            () => {
              if (cancelled || contentSignature(doc) !== sig) return;
              const url = renderLookPreviewURL(doc, look, targetId, PREVIEW_SIZE);
              if (url && !cancelled) {
                cacheSet(key, { sig, url });
                bump();
              }
            },
            i,
          );
        });
      },
      refresh ? 1500 : 80,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      keys.forEach((k) => queue.cancel(k));
    };
    // `doc` changes on every commit (also selection/guides); the signature check above keeps
    // those from re-rendering. historyKey catches pixel-only edits and their undo/redo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, historyKey, targetId, enabled, wantedKey]);

  return (look: LookDef) => (enabled && doc ? (previewCache.get(previewKey(doc.id, look, target))?.url ?? null) : null);
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

function swatchBackground(sw: string[]): string {
  if (!sw.length) return '#222';
  if (sw.length === 1) return sw[0];
  const stops = sw.map((c, i) => `${c} ${Math.round((i / (sw.length - 1)) * 100)}%`).join(', ');
  return `linear-gradient(150deg, ${stops})`;
}

const LookCard = memo(function LookCard({
  look,
  active,
  busy,
  preview,
  aspect,
  disabled,
  onApply,
  register,
}: {
  look: LookDef;
  active: boolean;
  busy: boolean;
  preview: string | null;
  aspect: number;
  disabled: boolean;
  onApply: (id: string) => void;
  register: (id: string, el: Element | null) => void;
}) {
  const ref = useCallback((el: HTMLButtonElement | null) => register(look.id, el), [look.id, register]);
  return (
    <button
      ref={ref}
      data-look-id={look.id}
      className={`looks-card${active ? ' active' : ''}${busy ? ' busy' : ''}`}
      title={`${look.name}${look.description ? ` — ${look.description}` : ''}`}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={() => onApply(look.id)}
      onContextMenu={
        isUserLook(look.id)
          ? (e) =>
              showContextMenu(e, [
                { label: look.name, heading: true },
                { label: 'Apply Look', run: () => onApply(look.id) },
                { label: 'Rename…', icon: Pencil, run: () => void renameUserLook(look.id) },
                { label: 'Delete Look', icon: Trash2, run: () => deleteUserLook(look.id) },
              ])
          : undefined
      }
    >
      <div className="looks-thumb" style={{ aspectRatio: String(aspect), background: swatchBackground(look.swatch) }}>
        {preview && <img src={preview} alt="" draggable={false} />}
        <div className="looks-chips">
          {look.swatch.slice(0, 5).map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </div>
        {active && !busy && (
          <span className="looks-badge" title="Applied">
            <Check size={10} strokeWidth={3} />
          </span>
        )}
        {busy && (
          <span className="looks-busy">
            <Loader2 size={16} className="looks-spin" />
          </span>
        )}
      </div>
      <div className="looks-name">{look.name}</div>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function LooksPanel() {
  const all = useRegistry(looks);
  const doc = useActiveDoc();
  const activeLayerId = useEditor((st) => (st.activeDocId ? (st.sessions[st.activeDocId]?.activeLayerId ?? null) : null));
  const historyKey = useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return s ? (s.history.entries[s.history.index]?.id ?? null) : null;
  });
  const sessions = useEditor((st) => st.sessions);
  const { target, previews, category, setTarget, setPreviews, setCategory } = useLooksUI();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, register] = useVisibleIds(wrapRef);

  useEffect(() => pruneClosedDocs(sessions), [sessions]);

  const requested = target === 'layer' ? activeLayerId : null;
  const resolved: LookTargets = doc ? lookTargets(doc, requested) : { targetId: null as ID | null };
  const targetId = resolved.targetId;
  const targetLayer = doc && targetId ? (doc.layers[targetId] ?? null) : null;
  const current = currentLookId(doc, targetId);
  const canRemove = hasLook(doc, targetId);

  const categories = useMemo(() => ['All', ...Array.from(new Set(all.map((l) => l.category)))], [all]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (l) =>
        (category === 'All' || l.category === category || !categories.includes(category)) &&
        (!q || `${l.name} ${l.category} ${l.description ?? ''} ${l.id}`.toLowerCase().includes(q)),
    );
  }, [all, query, category, categories]);
  const onScreen = useMemo(() => shown.filter((l) => visible.has(l.id)), [shown, visible]);

  const getPreview = useLookPreviews(doc, targetLayer, previews, onScreen, historyKey);
  const aspect = doc ? Math.max(0.75, Math.min(1.78, doc.width / doc.height)) : 1;

  const onApply = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(id);
      // Let the busy state paint before the (synchronous) overlay generation starts.
      await nextPaint();
      try {
        await applyLook(id, requested);
      } finally {
        setBusy(null);
      }
    },
    [busy, requested],
  );

  const targetName = targetLayer && !resolved.character ? targetLayer.name : 'Whole document';
  const targetTitle = `Target: ${targetName}${resolved.note ? ` — ${resolved.note}` : ''}`;
  const chipItems = useMemo(() => categories.map((c) => ({ value: c, label: c })), [categories]);

  // Compact header (≈88px) so a short dock group still shows cards: toggle + target on one row,
  // search + preview toggle on the next, categories in one horizontally scrolling chip row.
  return (
    <div className="looks-panel">
      <div className="looks-head">
        <div className="looks-seg" role="tablist" aria-label="Apply looks to">
          <button
            role="tab"
            aria-selected={target === 'layer'}
            className={target === 'layer' ? 'active' : ''}
            onClick={() => setTarget('layer')}
            title="Active layer — filters and effects go on the active layer"
          >
            <Layers size={12} /> Layer
          </button>
          <button
            role="tab"
            aria-selected={target === 'doc'}
            className={target === 'doc' ? 'active' : ''}
            onClick={() => setTarget('doc')}
            title="Whole document — grades and textures go into look groups; character filters go on the document’s character (when it has one)"
          >
            <ImageIcon size={12} /> Document
          </button>
        </div>
        {doc ? (
          <div className="looks-target" title={targetTitle} aria-label={targetTitle}>
            <span className="looks-target-name">{targetName}</span>
            {resolved.note &&
              (targetLayer ? <Info size={12} className="looks-target-icon info" aria-hidden /> : <TriangleAlert size={12} className="looks-target-icon warn" aria-hidden />)}
          </div>
        ) : null}
      </div>

      <div className="looks-filters">
        <div className="looks-search">
          <SearchInput value={query} onChange={setQuery} placeholder={`Search ${all.length} looks`} />
          <IconButton
            icon={previews ? Eye : EyeOff}
            size="sm"
            active={previews}
            title={previews ? 'Hide live previews' : 'Show live previews'}
            onClick={() => setPreviews(!previews)}
          />
        </div>
        <ChipRow items={chipItems} value={categories.includes(category) ? category : 'All'} onChange={setCategory} ariaLabel="Look categories" />
      </div>

      {!doc && (
        <div className="looks-empty">
          <span>Open or create a document to apply a look.</span>
          {commands.has('file.newFromTemplate') && (
            <Button size="small" icon={FilePlus2} onClick={() => runCommand('file.newFromTemplate')}>
              New from Template…
            </Button>
          )}
        </div>
      )}

      <div className="looks-grid-wrap ui-scroll" ref={wrapRef}>
        {shown.length ? (
          <div className="looks-grid">
            {shown.map((l) => (
              <LookCard
                key={l.id}
                look={l}
                active={current === l.id}
                busy={busy === l.id}
                preview={getPreview(l)}
                aspect={aspect}
                disabled={!doc || (busy !== null && busy !== l.id)}
                onApply={onApply}
                register={register}
              />
            ))}
          </div>
        ) : (
          <div className="ui-empty">No looks match “{query}”.</div>
        )}
      </div>

      <div className="looks-foot">
        <Button size="small" variant="ghost" icon={Eraser} disabled={!doc || !canRemove} onClick={() => removeLook(targetId)}>
          Remove look
        </Button>
        <IconButton
          icon={BookmarkPlus}
          size="sm"
          title="Save as Look… — keep the character’s filters/effects and the overlays above it under My Looks"
          disabled={!doc}
          onClick={() => void saveCurrentLook(requested)}
        />
        <span className="looks-count">{shown.length} looks</span>
      </div>
    </div>
  );
}
