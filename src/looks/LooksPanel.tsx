import { memo, useEffect, useMemo, useReducer, useState } from 'react';
import { Check, Eraser, Eye, EyeOff, FilePlus2, Layers, Image as ImageIcon } from 'lucide-react';
import type { Document, ID } from '../core/types';
import { commands, looks, runCommand, useRegistry, type LookDef } from '../registry';
import { useActiveDoc, useEditor } from '../state/editor';
import { Button, IconButton, SearchInput } from '../ui/controls';
import { applyLook, currentLookId, hasLook, removeLook, resolveTarget } from './engine';
import { renderLookPreviewURL } from './preview';
import { IdleQueue } from './shared';
import { useLooksUI } from './store';
import './looks.css';

/* ------------------------------------------------------------------ */
/* Lazy previews                                                       */
/* ------------------------------------------------------------------ */

const PREVIEW_SIZE = 176;
const queue = new IdleQueue();
/** key = docId|target|lookId → last rendered preview (kept while a newer one renders). */
const previewCache = new Map<string, { doc: Document; url: string }>();

function previewKey(docId: ID, targetId: ID | null, lookId: string) {
  return `${docId}|${targetId ?? '*'}|${lookId}`;
}

function trimCache(keepDocId: ID) {
  if (previewCache.size < 160) return;
  for (const k of [...previewCache.keys()]) if (!k.startsWith(`${keepDocId}|`)) previewCache.delete(k);
}

function useLookPreviews(doc: Document | null, targetId: ID | null, enabled: boolean, ids: string[]) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const idsKey = ids.join(',');
  useEffect(() => {
    if (!enabled || !doc) return;
    let cancelled = false;
    const keys: string[] = [];
    const hasAny = ids.some((id) => previewCache.has(previewKey(doc.id, targetId, id)));
    // Debounce while the user is editing; render quickly the first time.
    const timer = window.setTimeout(
      () => {
        ids.forEach((id, i) => {
          const key = previewKey(doc.id, targetId, id);
          const cached = previewCache.get(key);
          if (cached && cached.doc === doc) return;
          keys.push(key);
          queue.push(
            key,
            () => {
              if (cancelled) return;
              const look = looks.get(id);
              if (!look) return;
              const url = renderLookPreviewURL(doc, look, targetId, PREVIEW_SIZE);
              if (url && !cancelled) {
                previewCache.set(key, { doc, url });
                bump();
              }
            },
            i,
          );
        });
        trimCache(doc.id);
      },
      hasAny ? 900 : 60,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      keys.forEach((k) => queue.cancel(k));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, targetId, enabled, idsKey]);
  return (lookId: string) => (enabled && doc ? (previewCache.get(previewKey(doc.id, targetId, lookId))?.url ?? null) : null);
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
  preview,
  aspect,
  disabled,
  onApply,
}: {
  look: LookDef;
  active: boolean;
  preview: string | null;
  aspect: number;
  disabled: boolean;
  onApply: (id: string) => void;
}) {
  return (
    <button
      className={`looks-card${active ? ' active' : ''}`}
      title={`${look.name}${look.description ? ` — ${look.description}` : ''}`}
      disabled={disabled}
      onClick={() => onApply(look.id)}
    >
      <div className="looks-thumb" style={{ aspectRatio: String(aspect), background: swatchBackground(look.swatch) }}>
        {preview && <img src={preview} alt="" draggable={false} />}
        <div className="looks-chips">
          {look.swatch.slice(0, 5).map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </div>
        {active && (
          <span className="looks-badge" title="Applied">
            <Check size={10} strokeWidth={3} />
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
  const { target, previews, category, setTarget, setPreviews, setCategory } = useLooksUI();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const requested = target === 'layer' ? activeLayerId : null;
  const resolved = doc ? resolveTarget(doc, requested) : { targetId: null as ID | null };
  const targetId = resolved.targetId;
  const targetLayer = doc && targetId ? doc.layers[targetId] : null;
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

  const getPreview = useLookPreviews(
    doc,
    targetId,
    previews,
    shown.map((l) => l.id),
  );
  const aspect = doc ? Math.max(0.75, Math.min(1.78, doc.width / doc.height)) : 1;

  const onApply = async (id: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await applyLook(id, requested);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="looks-panel">
      <div className="looks-head">
        <div className="looks-seg" role="tablist" aria-label="Apply looks to">
          <button className={target === 'layer' ? 'active' : ''} onClick={() => setTarget('layer')} title="Filters and effects go on the active layer">
            <Layers size={12} /> Active layer
          </button>
          <button className={target === 'doc' ? 'active' : ''} onClick={() => setTarget('doc')} title="Everything goes into a look group at the top">
            <ImageIcon size={12} /> Whole document
          </button>
        </div>
        <IconButton
          icon={previews ? Eye : EyeOff}
          size="sm"
          active={previews}
          title={previews ? 'Hide live previews' : 'Show live previews'}
          onClick={() => setPreviews(!previews)}
        />
      </div>

      {doc ? (
        <div className="looks-target" title={resolved.note ?? undefined}>
          <span className="looks-target-label">Target</span>
          <span className="looks-target-name">
            {targetLayer ? targetLayer.name : 'Whole document'}
            {resolved.note && target === 'layer' && <em> · whole document</em>}
          </span>
        </div>
      ) : null}

      <div className="looks-filters">
        <SearchInput value={query} onChange={setQuery} placeholder="Search looks" />
        <div className="looks-cats">
          {categories.map((c) => (
            <button key={c} className={`looks-cat${category === c ? ' active' : ''}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
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

      <div className="looks-grid-wrap ui-scroll">
        {shown.length ? (
          <div className="looks-grid">
            {shown.map((l) => (
              <LookCard
                key={l.id}
                look={l}
                active={current === l.id}
                preview={getPreview(l.id)}
                aspect={aspect}
                disabled={!doc || (busy !== null && busy !== l.id)}
                onApply={onApply}
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
        <span className="looks-count">{shown.length} looks</span>
      </div>
    </div>
  );
}
