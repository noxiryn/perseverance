/**
 * Font picker popover content (used by <FontSelect/>): search, category chips, favorites, recents
 * and a virtualized list rendering every family in its own face.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Plus, Star } from 'lucide-react';
import { fonts, useRegistry, type FontDef } from '../registry';
import { SearchInput } from '../ui/controls/basic';
import { ensureFont } from './loader';
import { useFontPrefs } from './prefs';
import { filterFonts, groupByCategory, presentCategories, previewWeight, SPECIAL_FILTERS, weightsHint, type FontFilter } from './search';
import { VirtualList, type VirtualListHandle } from './VirtualList';
import { loadSystemFonts, maybeLoadSystemFonts, useSystemFonts } from './system';
import { addFontFiles } from './userFonts';
import './fonts.css';

type Row = { kind: 'header'; key: string; label: string } | { kind: 'font'; key: string; font: FontDef };

const ROW_H = 30;
/** Optical size tweaks: thin scripts read better a bit larger in the list. */
const PICKER_SIZE: Partial<Record<FontDef['category'], number>> = { Script: 21, Handwritten: 18, Blackletter: 17 };
const HEADER_H = 24;

export function fontCss(f: { family: string }): string {
  return `"${f.family.replace(/"/g, '')}", var(--font-ui)`;
}

/** One family rendered in its own face; loads the face when mounted (i.e. when visible). */
export function FontFaceText({ font, text, size, className }: { font: FontDef; text?: string; size?: number; className?: string }) {
  const w = previewWeight(font);
  useEffect(() => {
    void ensureFont(font.family, w, 'normal', text);
  }, [font.family, w, text]);
  return (
    <span className={className} style={{ fontFamily: fontCss(font), fontWeight: w, fontSize: size }}>
      {text ?? font.family}
    </span>
  );
}

export function StarButton({ family, size = 12 }: { family: string; size?: number }) {
  const fav = useFontPrefs((s) => s.favorites.includes(family));
  const toggle = useFontPrefs((s) => s.toggleFavorite);
  return (
    <button
      className={`fc-star${fav ? ' on' : ''}`}
      title={fav ? 'Remove from favorites' : 'Add to favorites'}
      onClick={(e) => {
        e.stopPropagation();
        toggle(family);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // Keep keyboard focus where it is (e.g. the picker's search field).
      onMouseDown={(e) => e.preventDefault()}
    >
      <Star size={size} strokeWidth={1.8} fill={fav ? 'currentColor' : 'none'} />
    </button>
  );
}

const rowHeight = (r: Row) => (r.kind === 'header' ? HEADER_H : ROW_H);
const rowKey = (r: Row) => r.key;

export function FontPicker({ value, onPick, onClose }: { value: string; onPick: (family: string) => void; onClose?: () => void }) {
  const list = useRegistry(fonts);
  const favorites = useFontPrefs((s) => s.favorites);
  const recents = useFontPrefs((s) => s.recents);
  const sys = useSystemFonts((s) => s.status);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FontFilter>('all');
  /** Highlighted row, by key (row indices shift when favorites / recents / system fonts change). */
  const [hlKey, setHlKey] = useState<string | null>(null);
  const listRef = useRef<VirtualListHandle>(null);

  useEffect(() => maybeLoadSystemFonts(), []);

  const chips = useMemo(() => {
    const cats = presentCategories(list).map((c) => ({ value: c as FontFilter, label: c }));
    const user = list.some((f) => f.source === 'user') ? [{ value: 'user' as FontFilter, label: 'My Fonts' }] : [];
    return [...SPECIAL_FILTERS, ...user, ...cats];
  }, [list]);

  // A filter whose chip is gone (e.g. "My Fonts" after removing the last user font) falls back to All.
  const activeFilter: FontFilter = chips.some((c) => c.value === filter) ? filter : 'all';

  const rows = useMemo<Row[]>(() => {
    const ctx = { favorites, recents };
    const out: Row[] = [];
    const byFamily = new Map(list.map((f) => [f.family, f]));
    if (activeFilter === 'all' && !query.trim()) {
      const rec = recents.map((r) => byFamily.get(r)).filter((f): f is FontDef => !!f).slice(0, 5);
      if (rec.length) {
        out.push({ kind: 'header', key: 'h:recent', label: 'Recent' });
        rec.forEach((f) => out.push({ kind: 'font', key: `r:${f.family}`, font: f }));
      }
      const fav = favorites.map((r) => byFamily.get(r)).filter((f): f is FontDef => !!f);
      if (fav.length) {
        out.push({ kind: 'header', key: 'h:fav', label: 'Favorites' });
        fav.forEach((f) => out.push({ kind: 'font', key: `f:${f.family}`, font: f }));
      }
      for (const g of groupByCategory(filterFonts(list, '', 'all', ctx))) {
        out.push({ kind: 'header', key: `h:${g.category}`, label: `${g.category} · ${g.fonts.length}` });
        g.fonts.forEach((f) => out.push({ kind: 'font', key: `a:${f.family}`, font: f }));
      }
    } else {
      filterFonts(list, query, activeFilter, ctx).forEach((f) => out.push({ kind: 'font', key: `a:${f.family}`, font: f }));
    }
    return out;
  }, [list, favorites, recents, activeFilter, query]);

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const hl = hlKey != null ? (rowIndex.get(hlKey) ?? -1) : -1;
  const latest = useRef({ rows, rowIndex });
  latest.current = { rows, rowIndex };

  const fontCount = rows.reduce((n, r) => n + (r.kind === 'font' && r.key.startsWith('a:') ? 1 : 0), 0);

  // Jump to the current family when the popover opens and when the search / category changes.
  // Other list changes (starring a font, recents, system fonts arriving) keep the user's place —
  // the list anchors the first visible row.
  const viewKey = `${activeFilter}\u0000${query.trim()}`;
  const lastView = useRef<string | null>(null);
  useEffect(() => {
    if (lastView.current === viewKey) return;
    const first = lastView.current === null;
    lastView.current = viewKey;
    const current = `a:${value}`;
    const firstFont = rows.find((r) => r.kind === 'font')?.key ?? null;
    const target = !query.trim() && rowIndex.has(current) ? current : firstFont;
    setHlKey(target);
    if (target === current && target) {
      // After layout (the list measures its viewport first).
      requestAnimationFrame(() => {
        const i = latest.current.rowIndex.get(target);
        if (i !== undefined) listRef.current?.scrollToIndex(i, 'center');
      });
    } else if (!first) listRef.current?.scrollToTop();
  }, [viewKey, rows, rowIndex, value, query]);

  const move = (dir: 1 | -1) => {
    if (!rows.length) return;
    let i = hl;
    for (let n = 0; n < rows.length; n++) {
      i = (i + dir + rows.length) % rows.length;
      if (rows[i].kind === 'font') break;
    }
    setHlKey(rows[i].key);
    listRef.current?.scrollToIndex(i);
  };

  const pick = (f: FontDef) => {
    void ensureFont(f.family, previewWeight(f));
    useFontPrefs.getState().pushRecent(f.family);
    onPick(f.family);
  };

  return (
    <div
      className="fc-picker"
      onKeyDownCapture={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Escape') {
          // The search field swallows key events, so the popover never sees Escape: handle it
          // here — first clear the search, then close.
          e.preventDefault();
          e.stopPropagation();
          if (query) setQuery('');
          else onClose?.();
        } else if (e.key === 'Enter') {
          const r = rows[hl];
          if (r?.kind === 'font') {
            e.preventDefault();
            e.stopPropagation();
            pick(r.font);
          }
        }
      }}
    >
      <SearchInput value={query} onChange={setQuery} placeholder="Search fonts or vibes (gothic, signature…)" autoFocus />
      <div
        className="fc-chips scroll"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {chips.map((c) => (
          <button
            key={c.value}
            className={`fc-chip${activeFilter === c.value ? ' active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFilter(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <VirtualList
        className="fc-picker-list"
        items={rows}
        listRef={listRef}
        itemHeight={rowHeight}
        itemKey={rowKey}
        empty={
          <div className="ui-empty">
            {activeFilter === 'favorites' && !query.trim()
              ? 'No favorites yet — click ☆ next to a font.'
              : activeFilter === 'recent' && !query.trim()
                ? 'Fonts you use will show up here.'
                : 'No fonts match your search.'}
            {activeFilter !== 'all' && query.trim() && (
              <button className="ui-btn small ghost fc-picker-all" onMouseDown={(e) => e.preventDefault()} onClick={() => setFilter('all')}>
                Search all fonts
              </button>
            )}
          </div>
        }
        renderItem={(r, i) =>
          r.kind === 'header' ? (
            <div className="fc-picker-header">{r.label}</div>
          ) : (
            <div
              className={`fc-picker-row${i === hl ? ' hl' : ''}${r.font.family === value ? ' current' : ''}`}
              title={`${r.font.family} — ${r.font.category}${r.font.tags?.length ? ` · ${r.font.tags.slice(0, 3).join(', ')}` : ''}`}
              onPointerEnter={() => setHlKey(r.key)}
              onClick={() => pick(r.font)}
            >
              <StarButton family={r.font.family} />
              <FontFaceText font={r.font} className="fc-picker-name" size={PICKER_SIZE[r.font.category]} />
              {r.font.sample && <FontFaceText font={r.font} text={r.font.sample} className="fc-picker-sample" />}
              <span className="fc-picker-meta">{r.font.source === 'bundled' ? weightsHint(r.font) : r.font.source}</span>
            </div>
          )
        }
      />
      <div className="fc-picker-foot">
        <span>{fontCount} fonts</span>
        <span style={{ flex: 1 }} />
        {(sys === 'idle' || sys === 'denied' || sys === 'error') && (
          <button className="ui-btn small ghost" title="Load the fonts installed on this computer" onClick={() => void loadSystemFonts()}>
            <Monitor size={12} /> System fonts
          </button>
        )}
        {sys === 'loading' && <span className="fc-dim">Loading system fonts…</span>}
        <button className="ui-btn small ghost" title="Add a .ttf / .otf / .woff / .woff2 file" onClick={async () => {
            const added = await addFontFiles();
            if (added[0]) {
              useFontPrefs.getState().pushRecent(added[0]);
              onPick(added[0]);
            }
          }}>
          <Plus size={12} /> Add font…
        </button>
      </div>
    </div>
  );
}
