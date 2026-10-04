/**
 * Fonts panel: browse fonts by category with large live previews (editable preview text, size
 * slider), a "Popular for Roblox GFX" collection, favorites/recents, system and user fonts.
 * Click a font → applies it to the selected text layer(s), or sets the Type tool default.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Monitor, MousePointerClick, Plus, Type as TypeIcon } from 'lucide-react';
import { fonts, useRegistry, type FontDef } from '../registry';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { SearchInput, Slider, showContextMenu, type MenuItem } from '../ui/controls';
import { applyFontFamily } from './apply';
import { defaultPreviewText, POPULAR_FAMILIES } from './catalog';
import { FontFaceText, StarButton } from './FontPicker';
import { useFontPrefs } from './prefs';
import { fontWeightFor } from './loader';
import {
  filterFonts,
  groupByCategory,
  presentCategories,
  previewScale,
  SPECIAL_FILTERS,
  weightName,
  weightsHint,
  type FontFilter,
} from './search';
import { loadSystemFonts, maybeLoadSystemFonts, useSystemFonts } from './system';
import { addFontFiles } from './userFonts';
import { confirmRemoveUserFamily } from './dialogs';
import { VirtualList, type VirtualListHandle } from './VirtualList';
import './fonts.css';

type Row = { kind: 'header'; key: string; label: string; hint?: string } | { kind: 'font'; key: string; font: FontDef };

const HEADER_H = 28;

/** Primitive snapshot of what a click would target (keeps re-renders cheap). */
function useTarget(): { count: number; name: string; family: string; weight: number } {
  const sig = useEditor((s) => {
    const ss = s.activeDocId ? s.sessions[s.activeDocId] : null;
    if (!ss) return '0';
    const ids = ss.selectedLayerIds.length ? ss.selectedLayerIds : ss.activeLayerId ? [ss.activeLayerId] : [];
    const texts = ids.map((id) => ss.doc.layers[id]).filter((l) => l?.type === 'text');
    const first = texts[0];
    return first && first.type === 'text'
      ? `${texts.length}\u0000${first.name}\u0000${first.text.fontFamily}\u0000${first.text.fontWeight}`
      : '0';
  });
  const [count, name = '', family = '', weight = '400'] = sig.split('\u0000');
  return { count: Number(count), name, family, weight: Number(weight) || 400 };
}

export function FontsPanel() {
  const list = useRegistry(fonts);
  const favorites = useFontPrefs((s) => s.favorites);
  const recents = useFontPrefs((s) => s.recents);
  const preview = useFontPrefs((s) => s.preview);
  const setPreview = useFontPrefs((s) => s.setPreview);
  const sys = useSystemFonts((s) => s.status);
  const toolFamily = useEditor((s) => (s.toolOptions.type?.fontFamily as string | undefined) ?? '');
  const target = useTarget();
  const [query, setQuery] = useState('');
  const [size, setSize] = useState(preview.size);
  const listRef = useRef<VirtualListHandle>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const filter = (preview.category || 'all') as FontFilter;

  useEffect(() => maybeLoadSystemFonts(), []);
  useEffect(() => setSize(preview.size), [preview.size]);

  const chips = useMemo(() => {
    const cats = presentCategories(list).map((c) => ({ value: c as FontFilter, label: c }));
    const user = list.some((f) => f.source === 'user') ? [{ value: 'user' as FontFilter, label: 'My Fonts' }] : [];
    return [...SPECIAL_FILTERS, ...user, ...cats];
  }, [list]);

  const rows = useMemo<Row[]>(() => {
    const ctx = { favorites, recents };
    const out: Row[] = [];
    if (filter === 'all' && !query.trim()) {
      const byFamily = new Map(list.map((f) => [f.family, f]));
      const popular = POPULAR_FAMILIES.map((p) => byFamily.get(p)).filter((f): f is FontDef => !!f);
      out.push({ kind: 'header', key: 'h:popular', label: 'Popular for Roblox GFX', hint: `${popular.length}` });
      popular.forEach((f) => out.push({ kind: 'font', key: `p:${f.family}`, font: f }));
      for (const g of groupByCategory(filterFonts(list, '', 'all', ctx))) {
        out.push({ kind: 'header', key: `h:${g.category}`, label: g.category, hint: `${g.fonts.length}` });
        g.fonts.forEach((f) => out.push({ kind: 'font', key: `a:${f.family}`, font: f }));
      }
    } else {
      filterFonts(list, query, filter, ctx).forEach((f) => out.push({ kind: 'font', key: `a:${f.family}`, font: f }));
    }
    return out;
  }, [list, favorites, recents, filter, query]);

  useEffect(() => listRef.current?.scrollToTop(), [filter, query]);

  const fontCount = rows.filter((r) => r.kind === 'font' && !r.key.startsWith('p:')).length;
  /** Card height grows with the (optically scaled) preview size. */
  const itemHeight = useCallback(
    (r: Row) => (r.kind === 'header' ? HEADER_H : Math.round(size * previewScale(r.font.category) * 1.34) + 34),
    [size],
  );
  const textFor = (f: FontDef) => preview.text || defaultPreviewText(f.category, f.sample);

  const apply = (f: FontDef) => void applyFontFamily(f.family);

  const contextMenu = (e: React.MouseEvent, f: FontDef) => {
    const fav = favorites.includes(f.family);
    const weights = [...(f.weights?.length ? f.weights : [400])].sort((a, b) => a - b);
    const items: MenuItem[] = [
      {
        label: target.count > 1 ? `Apply to ${target.count} Text Layers` : 'Apply to Text Layer',
        disabled: !target.count,
        run: () => void applyFontFamily(f.family),
      },
      {
        label: 'Set as Type Tool Default',
        run: () => {
          const st = useEditor.getState();
          st.setToolOption('type', 'fontFamily', f.family);
          const cur = Number(st.toolOptions.type?.fontWeight) || 400;
          const w = fontWeightFor(weights, cur);
          if (w !== cur) st.setToolOption('type', 'fontWeight', w);
          toast(`Type tool font set to ${f.family}`, 'info');
        },
      },
    ];
    if (weights.length > 1) {
      items.push({
        label: target.count ? 'Apply with Weight' : 'Set Type Tool Weight',
        submenu: weights.map((w) => ({
          label: `${weightName(w)} (${w})`,
          checked: target.count ? target.family === f.family && target.weight === w : false,
          run: () => void applyFontFamily(f.family, { weight: w }),
        })),
      });
    }
    items.push(
      { separator: true },
      { label: fav ? 'Remove from Favorites' : 'Add to Favorites', run: () => useFontPrefs.getState().toggleFavorite(f.family) },
      {
        label: 'Copy Font Name',
        run: () => {
          void navigator.clipboard?.writeText(f.family).then(
            () => toast(`Copied “${f.family}”`, 'success'),
            () => toast('Clipboard unavailable', 'warning'),
          );
        },
      },
    );
    if (f.source === 'user') items.push({ separator: true }, { label: 'Remove Font…', run: () => void confirmRemoveUserFamily(f.family) });
    showContextMenu(e, items);
  };

  return (
    <div className="fc-fonts">
      <div className="fc-fonts-top">
        <SearchInput value={query} onChange={setQuery} placeholder="Search fonts, vibes (gothic, signature…)" />
        <div
          className="fc-chips scroll"
          ref={chipsRef}
          onWheel={(e) => {
            if (chipsRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) chipsRef.current.scrollLeft += e.deltaY;
          }}
        >
          {chips.map((c) => (
            <button
              key={c.value}
              className={`fc-chip${filter === c.value ? ' active' : ''}`}
              onClick={() => setPreview({ category: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="fc-fonts-preview">
          <input
            className="ui-input"
            value={preview.text}
            placeholder="Preview text (Birdcage, THE EXTERMINATOR.…)"
            onChange={(e) => setPreview({ text: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="fc-fonts-size" title="Preview size">
            <span className="fc-dim">Aa</span>
            <Slider value={size} min={14} max={72} step={1} showNumber={false} onChange={setSize} onCommit={(v) => setPreview({ size: v })} />
          </div>
        </div>
        <div className="fc-fonts-target">
          {target.count ? (
            <>
              <TypeIcon size={12} />
              <span>
                Click applies to <b>{target.count > 1 ? `${target.count} text layers` : `“${target.name}”`}</b>
              </span>
            </>
          ) : (
            <>
              <MousePointerClick size={12} />
              <span>
                Click sets the Type tool font{toolFamily ? <> (now <b>{toolFamily}</b>)</> : null}
              </span>
            </>
          )}
        </div>
      </div>

      <VirtualList
        className="fc-fonts-list"
        items={rows}
        listRef={listRef}
        overscan={Math.round(size * 1.34 + 34) * 3}
        itemHeight={itemHeight}
        itemKey={(r) => r.key}
        empty={
          <div className="ui-empty">
            {filter === 'favorites'
              ? 'No favorites yet — click ☆ on a font to keep it here.'
              : filter === 'recent'
                ? 'Fonts you apply will show up here.'
                : 'No fonts match your search.'}
          </div>
        }
        renderItem={(r) =>
          r.kind === 'header' ? (
            <div className="fc-fonts-header">
              <span>{r.label}</span>
              {r.hint && <span className="fc-dim">{r.hint}</span>}
            </div>
          ) : (
            <FontCard
              font={r.font}
              text={textFor(r.font)}
              size={size}
              applied={target.count ? target.family === r.font.family : toolFamily === r.font.family}
              onApply={apply}
              onMenu={contextMenu}
            />
          )
        }
      />

      <div className="fc-fonts-foot">
        <button className="ui-btn small" title="Add a .ttf / .otf / .woff / .woff2 font file" onClick={() => void addFontFiles()}>
          <Plus size={12} /> Add font file…
        </button>
        {(sys === 'idle' || sys === 'denied' || sys === 'error') && (
          <button
            className="ui-btn small ghost"
            title={sys === 'denied' ? 'Permission to read local fonts was denied — click to retry' : 'Show the fonts installed on this computer'}
            onClick={() => void loadSystemFonts().then((st) => st === 'denied' && toast('Permission to read system fonts was denied', 'warning'))}
          >
            <Monitor size={12} /> System fonts
          </button>
        )}
        {sys === 'loading' && <span className="fc-dim">Loading system fonts…</span>}
        <span style={{ flex: 1 }} />
        <span className="fc-dim">{fontCount} fonts</span>
      </div>
    </div>
  );
}

function FontCard({
  font,
  text,
  size,
  applied,
  onApply,
  onMenu,
}: {
  font: FontDef;
  text: string;
  size: number;
  applied: boolean;
  onApply: (f: FontDef) => void;
  onMenu: (e: React.MouseEvent, f: FontDef) => void;
}) {
  return (
    <div
      className={`fc-card${applied ? ' applied' : ''}`}
      onClick={() => onApply(font)}
      onContextMenu={(e) => onMenu(e, font)}
      title={`${font.family}${font.tags?.length ? ` — ${font.tags.join(', ')}` : ''}\nClick to apply · right-click for more`}
    >
      <div className="fc-card-head">
        <span className="fc-card-name">{font.family}</span>
        {applied && <Check size={12} className="fc-card-check" />}
        <span className="fc-card-meta">
          {font.source === 'bundled' ? font.category : font.source === 'user' ? 'My font' : 'System'} · {weightsHint(font)}
        </span>
        <StarButton family={font.family} />
      </div>
      <div className="fc-card-preview" style={{ fontSize: Math.round(size * previewScale(font.category)), lineHeight: 1.25 }}>
        <FontFaceText font={font} text={text} />
      </div>
    </div>
  );
}

/** Panel ⋯ menu. */
export function fontsPanelMenu() {
  const sys = useSystemFonts.getState().status;
  return [
    { label: 'Add Font File…', run: () => void addFontFiles() },
    {
      label: sys === 'loaded' ? 'System Fonts Loaded' : 'Load System Fonts',
      disabled: sys === 'loaded' || sys === 'unsupported' || sys === 'loading',
      run: () => void loadSystemFonts(),
    },
    { label: 'Clear Recent Fonts', run: () => useFontPrefs.getState().clearRecents() },
    { label: 'Reset Preview Text', run: () => useFontPrefs.getState().setPreview({ text: '', size: 30 }) },
  ];
}
