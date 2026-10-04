/**
 * Command palette (Ctrl+K): fuzzy search across commands, tools, panels, filters, looks,
 * templates, assets and fonts. ↑/↓ to move, Enter to run, Tab to filter by kind, Esc to close.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search } from 'lucide-react';
import { toast, useUI } from '../../state/ui';
import { isMac } from '../../platform';
import { Keys } from './Keys';
import { rankItems, type RankedGroup } from './paletteRank';
import {
  collectPaletteItems,
  KIND_BOOST,
  KIND_ICONS,
  KIND_LABELS,
  KIND_ORDER,
  pushPaletteRecent,
  readPaletteRecent,
  SUGGESTED,
  type PaletteItem,
  type PaletteKind,
} from './paletteSources';
import { shellPortalHost } from './uiScale';

const CAPS: Record<string, number> = { command: 12, tool: 6, panel: 5, filter: 8, look: 6, template: 6, asset: 6, font: 6 };

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const parts: { s: string; hl: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hl = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hl === hl) last.s += text[i];
    else parts.push({ s: text[i], hl });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hl ? (
          <mark key={i} className="shell-pal-hl">
            {p.s}
          </mark>
        ) : (
          <Fragment key={i}>{p.s}</Fragment>
        ),
      )}
    </>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<PaletteKind | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Snapshot sources when the palette opens (enabled() states are evaluated now).
  const items = useMemo(() => collectPaletteItems(), []);
  const recent = useMemo(() => readPaletteRecent(), []);

  const groups: RankedGroup<PaletteItem>[] = useMemo(() => {
    if (!query.trim() && !kind) {
      const byKey = new Map(items.map((i) => [i.key, i]));
      const out: RankedGroup<PaletteItem>[] = [];
      const rec = recent.map((k) => byKey.get(k)).filter((x): x is PaletteItem => !!x);
      if (rec.length) out.push({ kind: 'recent', items: rec.map((item) => ({ item, score: 0, indices: [] })) });
      const recSet = new Set(rec.map((r) => r.key));
      const sug = SUGGESTED.map((k) => byKey.get(k)).filter((x): x is PaletteItem => !!x && !recSet.has(x.key));
      if (sug.length) out.push({ kind: 'suggested', items: sug.map((item) => ({ item, score: 0, indices: [] })) });
      const toolsG = items.filter((i) => i.kind === 'tool');
      if (toolsG.length) out.push({ kind: 'tool', items: toolsG.slice(0, 20).map((item) => ({ item, score: 0, indices: [] })) });
      const panelsG = items.filter((i) => i.kind === 'panel');
      if (panelsG.length) out.push({ kind: 'panel', items: panelsG.map((item) => ({ item, score: 0, indices: [] })) });
      if (!out.length) {
        const cmds = items.filter((i) => i.kind === 'command').slice(0, 30);
        out.push({ kind: 'command', items: cmds.map((item) => ({ item, score: 0, indices: [] })) });
      }
      return out;
    }
    return rankItems(items, query, { kindOrder: KIND_ORDER, boost: KIND_BOOST, caps: CAPS, onlyKind: kind, limit: 150 });
  }, [items, query, kind, recent]);

  const flat = useMemo(() => groups.flatMap((g) => g.items.map((r) => r.item)), [groups]);
  const counts = useMemo(() => {
    const c: Partial<Record<PaletteKind, number>> = {};
    for (const i of items) c[i.kind as PaletteKind] = (c[i.kind as PaletteKind] ?? 0) + 1;
    return c;
  }, [items]);
  const kinds = KIND_ORDER.filter((k) => counts[k]);

  useEffect(() => setSel(0), [query, kind]);
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, groups]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (it: PaletteItem | undefined) => {
    if (!it) return;
    if (it.disabled) {
      toast(`“${it.title}” is not available right now`, 'info');
      return;
    }
    pushPaletteRecent(it.key);
    onClose();
    window.setTimeout(() => {
      try {
        const r = it.run();
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((e: unknown) => toast(`${it.title}: ${(e as Error)?.message ?? e}`, 'error', 4000));
        }
      } catch (e) {
        console.error(e);
        toast(`${it.title}: ${(e as Error)?.message ?? e}`, 'error', 4000);
      }
    }, 0);
  };

  const cycleKind = (dir: 1 | -1) => {
    const list: (PaletteKind | null)[] = [null, ...kinds];
    const i = list.indexOf(kind);
    setKind(list[(i + dir + list.length) % list.length]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      onClose();
      return;
    }
    const n = flat.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (n) setSel((s) => (s + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n) setSel((s) => (s - 1 + n) % n);
        break;
      case 'PageDown':
        e.preventDefault();
        if (n) setSel((s) => Math.min(n - 1, s + 8));
        break;
      case 'PageUp':
        e.preventDefault();
        if (n) setSel((s) => Math.max(0, s - 8));
        break;
      case 'Enter':
        e.preventDefault();
        run(flat[sel]);
        break;
      case 'Escape':
        e.preventDefault();
        if (query) setQuery('');
        else onClose();
        break;
      case 'Tab':
        e.preventDefault();
        cycleKind(e.shiftKey ? -1 : 1);
        break;
      case 'Backspace':
        if (!query && kind) {
          e.preventDefault();
          setKind(null);
        }
        break;
    }
  };

  let idx = -1;
  const groupLabel = (k: string) => (k === 'recent' ? 'Recent' : k === 'suggested' ? 'Suggested' : (KIND_LABELS[k as PaletteKind] ?? k));

  return (
    <div className="shell-pal" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()}>
      <div className="shell-pal-input">
        <Search size={15} strokeWidth={1.8} />
        {kind && (
          <button className="shell-pal-scope" onClick={() => setKind(null)} title="Clear filter (Backspace)">
            {KIND_LABELS[kind]}
          </button>
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={kind ? `Search ${KIND_LABELS[kind].toLowerCase()}…` : 'Search commands, tools, panels, filters, looks, assets, fonts…'}
          spellCheck={false}
        />
        <kbd className="shell-kbd">Esc</kbd>
      </div>
      <div className="shell-pal-chips">
        <button className={`shell-pal-chip${kind === null ? ' active' : ''}`} onClick={() => setKind(null)}>
          All
        </button>
        {kinds.map((k) => (
          <button key={k} className={`shell-pal-chip${kind === k ? ' active' : ''}`} onClick={() => setKind(kind === k ? null : k)}>
            {KIND_LABELS[k]}
            <span className="shell-pal-chip-n">{counts[k]}</span>
          </button>
        ))}
      </div>
      <div className="shell-pal-list" ref={listRef}>
        {groups.map((g) => (
          <div key={g.kind} className="shell-pal-group">
            <div className="shell-pal-group-head">{groupLabel(g.kind)}</div>
            {g.items.map(({ item, indices }) => {
              idx++;
              const i = idx;
              const Icon = item.icon ?? KIND_ICONS[item.kind];
              return (
                <div
                  key={item.key}
                  data-idx={i}
                  className={['shell-pal-row', i === sel && 'sel', item.disabled && 'disabled'].filter(Boolean).join(' ')}
                  onPointerMove={() => i !== sel && setSel(i)}
                  onClick={() => run(item)}
                >
                  <span className="shell-pal-icon">
                    <Icon size={14} strokeWidth={1.6} />
                  </span>
                  <span className="shell-pal-title" style={item.fontFamily ? { fontFamily: `"${item.fontFamily}", var(--font-ui)`, fontSize: 14 } : undefined}>
                    <Highlight text={item.title} indices={indices} />
                  </span>
                  {item.subtitle && <span className="shell-pal-sub">{item.subtitle}</span>}
                  <span className="shell-pal-right">
                    {item.shortcut && <Keys shortcut={item.shortcut} />}
                    {i === sel && <CornerDownLeft size={12} className="shell-pal-enter" />}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <div className="shell-pal-empty">
            No results for “{query}”{kind ? ` in ${KIND_LABELS[kind]}` : ''}
          </div>
        )}
      </div>
      <div className="shell-pal-foot">
        <span>
          <kbd className="shell-kbd">↑</kbd>
          <kbd className="shell-kbd">↓</kbd> navigate
        </span>
        <span>
          <kbd className="shell-kbd">↵</kbd> run
        </span>
        <span>
          <kbd className="shell-kbd">Tab</kbd> filter
        </span>
        <span className="shell-pal-foot-count">{flat.length} results</span>
      </div>
    </div>
  );
}

/** Mounted once by the shell; visible while useUI().commandPaletteOpen. */
export function CommandPalette() {
  const open = useUI((s) => s.commandPaletteOpen);
  const setOpen = useUI((s) => s.setCommandPalette);
  if (!open) return null;
  return createPortal(
    <div className="shell-pal-backdrop" onPointerDown={() => setOpen(false)}>
      <PaletteBody onClose={() => setOpen(false)} />
    </div>,
    shellPortalHost(),
  );
}
