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
    >
      <Star size={size} strokeWidth={1.8} fill={fav ? 'currentColor' : 'none'} />
    </button>
  );
}

export function FontPicker({ value, onPick }: { value: string; onPick: (family: string) => void }) {
  const list = useRegistry(fonts);
  const favorites = useFontPrefs((s) => s.favorites);
  const recents = useFontPrefs((s) => s.recents);
  const sys = useSystemFonts((s) => s.status);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FontFilter>('all');
  const [hl, setHl] = useState(-1);
  const listRef = useRef<VirtualListHandle>(null);

  useEffect(() => maybeLoadSystemFonts(), []);

  const chips = useMemo(() => {
    const cats = presentCategories(list).map((c) => ({ value: c as FontFilter, label: c }));
    const user = list.some((f) => f.source === 'user') ? [{ value: 'user' as FontFilter, label: 'My Fonts' }] : [];
    return [...SPECIAL_FILTERS, ...user, ...cats];
  }, [list]);

  const rows = useMemo<Row[]>(() => {
    const ctx = { favorites, recents };
    const out: Row[] = [];
    const byFamily = new Map(list.map((f) => [f.family, f]));
    if (filter === 'all' && !query.trim()) {
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
      filterFonts(list, query, filter, ctx).forEach((f) => out.push({ kind: 'font', key: `a:${f.family}`, font: f }));
    }
    return out;
  }, [list, favorites, recents, filter, query]);

  const fontCount = rows.reduce((n, r) => n + (r.kind === 'font' && r.key.startsWith('a:') ? 1 : 0), 0);

  // Highlight the current family when opening / when the list changes.
  const lastRows = useRef<Row[] | null>(null);
  useEffect(() => {
    if (lastRows.current === rows) return;
    const first = lastRows.current === null;
    lastRows.current = rows;
    let idx = rows.findIndex((r) => r.kind === 'font' && r.key === `a:${value}`);
    if (idx < 0 || (!first && query)) idx = rows.findIndex((r) => r.kind === 'font');
    setHl(idx);
    if (idx >= 0) requestAnimationFrame(() => listRef.current?.scrollToIndex(idx, first ? 'center' : 'auto'));
    else listRef.current?.scrollToTop();
  }, [rows, value, query]);

  const move = (dir: 1 | -1) => {
    let i = hl;
    for (let n = 0; n < rows.length; n++) {
      i = (i + dir + rows.length) % rows.length;
      if (rows[i].kind === 'font') break;
    }
    setHl(i);
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
      <div className="fc-chips scroll">
        {chips.map((c) => (
          <button key={c.value} className={`fc-chip${filter === c.value ? ' active' : ''}`} onClick={() => setFilter(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
      <VirtualList
        className="fc-picker-list"
        items={rows}
        listRef={listRef}
        itemHeight={(r) => (r.kind === 'header' ? HEADER_H : ROW_H)}
        itemKey={(r) => r.key}
        empty={
          <div className="ui-empty">
            {filter === 'favorites'
              ? 'No favorites yet — click ☆ next to a font.'
              : filter === 'recent'
                ? 'Fonts you use will show up here.'
                : 'No fonts match your search.'}
          </div>
        }
        renderItem={(r, i) =>
          r.kind === 'header' ? (
            <div className="fc-picker-header">{r.label}</div>
          ) : (
            <div
              className={`fc-picker-row${i === hl ? ' hl' : ''}${r.font.family === value ? ' current' : ''}`}
              title={`${r.font.family} — ${r.font.category}${r.font.tags?.length ? ` · ${r.font.tags.slice(0, 3).join(', ')}` : ''}`}
              onPointerEnter={() => setHl(i)}
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
