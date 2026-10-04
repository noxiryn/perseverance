/**
 * Filter Gallery: browse every creative filter as a live thumbnail of the active layer (or the
 * composite / a sample when nothing filterable is selected), tweak the selected one with a big
 * preview, and apply it as a smart filter or destructively.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, SlidersHorizontal, WandSparkles } from 'lucide-react';
import type { ParamValue, ParamValues } from '../../core/types';
import { createCanvas, ctx2d } from '../../core/canvas';
import { filters, useRegistry, type FilterContext, type FilterDef } from '../../registry';
import { defaultParams, makeFilterContext } from '../engine';
import { Button, Checkbox, Dialog, ParamEditor, SearchInput } from '../../ui/controls';
import { activeSession } from '../../state/editor';
import { toast } from '../../state/ui';
import { renderDocument } from '../../render/compositor';
import { renderPlaceholderCharacter } from '../../roblox/placeholder';
import { applyDestructive, applySmart, committedDoc, effectiveMode, resolveTarget, selectionAlpha, targetContext, targetSource, type FilterTarget } from './apply';
import { blendSelection } from './selectionBlend';
import { fitImage, paramsKey, runOnCopy } from './preview';
import { getLastFilter, rememberParams, rememberedParams, setLastFilter } from './memory';
import { categoriesOf, isBrowsableFilter, matchesQuery, sortFilters } from './galleryModel';
import { openFilterDialogWith } from './filterDialog';
import './fxfilters.css';

const THUMB_W = 136;
const THUMB_H = 102;
const BIG_W = 400;
const BIG_H = 300;

interface GallerySource {
  canvas: HTMLCanvasElement;
  target: FilterTarget | null;
  label: string;
  reason?: string;
  key: string;
  /** Document geometry the source represents (for non-layer sources). */
  docW: number;
  docH: number;
}

/** A neutral sample image (character on a backdrop) used when no document is open. */
function sampleCanvas(): HTMLCanvasElement {
  const w = 640,
    h = 480;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#f2b45a');
  g.addColorStop(0.55, '#c8432f');
  g.addColorStop(1, '#2a1630');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const rg = ctx.createRadialGradient(w * 0.62, h * 0.3, 10, w * 0.62, h * 0.3, h * 0.6);
  rg.addColorStop(0, 'rgba(255,240,200,0.85)');
  rg.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);
  const ch = renderPlaceholderCharacter({ width: 300, height: 420, pose: 'hero', style: 'shaded' });
  ctx.drawImage(ch, w * 0.5 - 150, h - 420);
  return c;
}

function buildSource(): GallerySource {
  const s = activeSession();
  const r = resolveTarget();
  const entry = s ? (s.history.entries[s.history.index]?.id ?? 'x') : 'none';
  if (!('error' in r)) {
    const t = r.target;
    const mode = effectiveMode(t, 'auto');
    return {
      canvas: targetSource(t, mode),
      target: t,
      label: t.kind === 'mask' ? `Mask of “${t.layer.name}”` : `Layer “${t.layer.name}”`,
      key: `${t.layer.id}:${t.kind}:${entry}`,
      docW: t.doc.width,
      docH: t.doc.height,
    };
  }
  const doc = committedDoc();
  if (doc) {
    const k = Math.min(1, 1100 / doc.width, 1100 / doc.height);
    return { canvas: renderDocument(doc, { scale: k }), target: null, label: 'Document composite', reason: r.error, key: `doc:${doc.id}:${entry}`, docW: doc.width, docH: doc.height };
  }
  const c = sampleCanvas();
  return { canvas: c, target: null, label: 'Sample image', reason: r.error, key: 'sample', docW: c.width, docH: c.height };
}

/* ---------------- thumbnail cache (module level, LRU-ish) ---------------- */
const thumbCache = new Map<string, ImageData>();
function cacheThumb(key: string, img: ImageData) {
  thumbCache.set(key, img);
  if (thumbCache.size > 500) {
    const first = thumbCache.keys().next().value;
    if (first !== undefined) thumbCache.delete(first);
  }
}

/** Illustrative context for tiny thumbnails: the thumbnail acts as a small document. */
function thumbContext(w: number, h: number, k: number): FilterContext {
  const s = Math.max(k, 0.32);
  return makeFilterContext({ docWidth: w / s, docHeight: h / s, offsetX: 0, offsetY: 0, scale: s });
}

const ThumbCanvas = memo(function ThumbCanvas({ img }: { img: ImageData | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
  }, [img]);
  return img ? <canvas ref={ref} className="fxf-thumb-canvas" /> : <LoaderCircle size={14} className="fxf-thumb-wait" />;
});

export interface FilterGalleryProps extends Record<string, unknown> {
  initialFilterId?: string;
}

export function FilterGallery({ initialFilterId, close }: FilterGalleryProps & { close: (r?: unknown) => void }) {
  const all = useRegistry(filters);
  const list = useMemo(() => sortFilters(all.filter(isBrowsableFilter)), [all]);
  const cats = useMemo(() => categoriesOf(list), [list]);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('All');
  const shown = useMemo(() => list.filter((f) => (cat === 'All' || f.category === cat) && matchesQuery(f, query)), [list, cat, query]);
  const [src] = useState(buildSource);
  const [selId, setSelId] = useState<string>(() => {
    const want = initialFilterId ?? getLastFilter()?.filterId;
    return want && list.some((f) => f.id === want) ? want : (list[0]?.id ?? '');
  });
  const sel = filters.get(selId) as FilterDef | undefined;
  const [params, setParams] = useState<ParamValues>(() => (sel ? rememberedParams(sel) : {}));
  const [smart, setSmart] = useState(() => (src.target ? effectiveMode(src.target, 'auto') === 'smart' : false));
  const [applying, setApplying] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, ImageData>>({});
  const bigRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const t = src.target;
  const canToggle = !!t && t.canSmart && t.canDestructive;

  const select = useCallback((id: string) => {
    const def = filters.get(id);
    if (!def) return;
    setSelId(id);
    setParams(rememberedParams(def));
  }, []);

  /* ---------------- thumbnails (lazy, time-sliced, cached) ---------------- */
  const thumbBase = useMemo(() => fitImage(src.canvas, THUMB_W, THUMB_H), [src]);
  const shownIds = shown.map((f) => f.id).join(',');
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const base = thumbBase;
    const fctx = thumbContext(base.img.width, base.img.height, base.k);
    const todo = shownIds ? shownIds.split(',') : [];
    const ready: Record<string, ImageData> = {};
    for (const id of todo) {
      const def = filters.get(id);
      const hit = def && thumbCache.get(`${src.key}|${paramsKey(id, rememberedParams(def))}`);
      if (hit) ready[id] = hit;
    }
    if (Object.keys(ready).length) setThumbs((prev) => ({ ...prev, ...ready }));
    const queue = todo.filter((id) => !ready[id]);
    const tick = () => {
      if (cancelled) return;
      const t0 = performance.now();
      const batch: Record<string, ImageData> = {};
      while (queue.length && performance.now() - t0 < 14) {
        const id = queue.shift()!;
        const def = filters.get(id);
        if (!def) continue;
        const p = rememberedParams(def);
        try {
          const { out } = runOnCopy(def, p, base.img, fctx);
          cacheThumb(`${src.key}|${paramsKey(id, p)}`, out);
          batch[id] = out;
        } catch (err) {
          console.warn(`[fx-filters] thumbnail for ${id} failed`, err);
        }
      }
      if (Object.keys(batch).length) setThumbs((prev) => ({ ...prev, ...batch }));
      if (queue.length) timer = window.setTimeout(tick, 0);
    };
    timer = window.setTimeout(tick, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shownIds, thumbBase, src.key]);

  /* ---------------- big preview ---------------- */
  const bigBase = useMemo(() => {
    const f = fitImage(src.canvas, BIG_W, BIG_H);
    const destructive = !!t && !smart;
    return { ...f, sel: destructive && t ? selectionAlpha(t, f.img.width, f.img.height, f.k) : null };
  }, [src, t, smart]);
  const raf = useRef(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (!sel) return;
    raf.current = requestAnimationFrame(() => {
      const c = bigRef.current;
      if (!c) return;
      const b = bigBase;
      c.width = b.img.width;
      c.height = b.img.height;
      const fctx = t
        ? targetContext(t, b.k)
        : makeFilterContext({ docWidth: src.docW, docHeight: src.docH, offsetX: 0, offsetY: 0, scale: b.img.width / src.docW });
      const { out, ms } = runOnCopy(sel, params, b.img, fctx);
      if (b.sel) blendSelection(b.img.data, out.data, b.sel);
      c.getContext('2d')!.putImageData(out, 0, 0);
      setSlow(ms > 120);
    });
    return () => cancelAnimationFrame(raf.current);
  }, [sel, params, bigBase, t, src]);

  // keep the selected thumbnail in view when filtering/searching
  useEffect(() => {
    gridRef.current?.querySelector('.fxf-thumb.active')?.scrollIntoView({ block: 'nearest' });
  }, [selId, cat]);

  /* ---------------- actions ---------------- */
  const apply = useCallback(() => {
    if (!sel || !t || applying) return;
    setApplying(true);
    window.setTimeout(() => {
      try {
        if (smart) applySmart(sel, params, t.layer.id);
        else if (!applyDestructive(sel, params, t)) toast('The selection doesn’t overlap this layer — nothing was filtered.', 'warning');
        rememberParams(sel.id, params);
        setLastFilter({ filterId: sel.id, params, mode: smart ? 'smart' : 'destructive' });
        close('ok');
      } catch (err) {
        console.error('[fx-filters] gallery apply failed', err);
        toast(`${sel.name} failed: ${(err as Error).message}`, 'error');
        setApplying(false);
      }
    }, 20);
  }, [applying, close, params, sel, smart, t]);

  const openInDialog = (id: string, p: ParamValues) => {
    if (!t) return;
    close();
    void openFilterDialogWith(id, smart ? 'smart' : 'destructive', p);
  };

  const onChange = useCallback((_k: string, _v: ParamValue, allP: ParamValues) => setParams(allP), []);
  const Icon = sel?.icon ?? WandSparkles;

  return (
    <div className="fxf-gallery-wrap">
      <Dialog
        title="Filter Gallery"
        width="min(1240px, calc(100vw - 60px))"
        onClose={() => !applying && close()}
        onSubmit={apply}
        footer={
          <div className="fxf-foot">
            <span className="fxf-source" title={src.reason}>
              Source: {src.label}
              {src.reason && <em> — {src.reason}</em>}
            </span>
            <Checkbox
              checked={smart}
              disabled={!canToggle || applying}
              onChange={setSmart}
              label="Smart Filter (non-destructive)"
              title={canToggle ? 'Keep the filter editable in the Layers panel' : t?.destructiveNote}
            />
            <span style={{ flex: 1 }} />
            <Button icon={SlidersHorizontal} disabled={!t || !sel || applying} onClick={() => sel && openInDialog(sel.id, params)} title="Open the full filter dialog with live canvas preview">
              Open in Dialog…
            </Button>
            <Button onClick={() => close()} disabled={applying}>
              Cancel
            </Button>
            <Button variant="primary" onClick={apply} disabled={!t || !sel || applying}>
              {applying ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        }
      >
        <div className="fxf-gallery">
          <div className="fxf-cats">
            <SearchInput value={query} onChange={setQuery} placeholder="Search filters" autoFocus />
            <div className="fxf-cat-list">
              <button className={`fxf-cat${cat === 'All' ? ' active' : ''}`} onClick={() => setCat('All')}>
                <span>All filters</span>
                <span className="fxf-count">{list.length}</span>
              </button>
              {cats.map((c) => (
                <button key={c.category} className={`fxf-cat${cat === c.category ? ' active' : ''}`} onClick={() => setCat(c.category)}>
                  <span>{c.category}</span>
                  <span className="fxf-count">{c.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="fxf-grid" ref={gridRef}>
            {shown.length === 0 && <div className="fxf-empty">No filters match “{query}”.</div>}
            {shown.map((f) => {
              const FI = f.icon ?? WandSparkles;
              return (
                <button
                  key={f.id}
                  className={`fxf-thumb${f.id === selId ? ' active' : ''}`}
                  onClick={() => select(f.id)}
                  onDoubleClick={() => openInDialog(f.id, f.id === selId ? params : rememberedParams(f))}
                  title={`${f.name}${f.description ? ` — ${f.description}` : ''}\nDouble-click to open the filter dialog`}
                >
                  <div className="fxf-thumb-img" style={{ width: THUMB_W, height: THUMB_H }}>
                    <ThumbCanvas img={thumbs[f.id]} />
                  </div>
                  <div className="fxf-thumb-label">
                    <FI size={12} strokeWidth={1.75} />
                    <span>{f.name}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="fxf-side">
            {sel ? (
              <>
                <div className="fxf-side-head">
                  <Icon size={15} strokeWidth={1.75} />
                  <span className="fxf-side-name">{sel.name}</span>
                  <span className="fxf-side-cat">{sel.category}</span>
                </div>
                <div className="fxf-big" style={{ height: BIG_H }}>
                  <canvas ref={bigRef} className="fxf-preview-canvas" />
                  {slow && <span className="fxf-badge">Heavy filter — preview is downscaled</span>}
                </div>
                {sel.description && <p className="fxf-desc">{sel.description}</p>}
                <div className="fxf-side-params">
                  {sel.params.length ? <ParamEditor defs={sel.params} values={params} onChange={onChange} /> : <div className="fxf-empty">No settings.</div>}
                </div>
                <div className="fxf-side-actions">
                  <Button size="small" variant="ghost" onClick={() => setParams(defaultParams(sel.params))}>
                    Reset settings
                  </Button>
                </div>
              </>
            ) : (
              <div className="fxf-empty">Select a filter</div>
            )}
          </div>
        </div>
        {applying && (
          <div className="fxf-applying">
            <LoaderCircle size={22} />
            <span>Applying {sel?.name}…</span>
          </div>
        )}
      </Dialog>
    </div>
  );
}
