/**
 * Swatches panel (like the UI reference): "Search swatches", palette selector, grid of small
 * squares. Click → foreground (Alt-click → background), + adds the foreground to "My Swatches",
 * right-click for rename/delete, folder → "Extract palette from image".
 */
import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { palettes, useRegistry, type PaletteDef } from '../registry';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';
import { IconButton, SearchInput, showContextMenu, showMenuAt, type MenuItem } from '../ui/controls';
import { describeColor, normalizeHex, opaqueHex } from './colorMath';
import { DEFAULT_PALETTE_ID } from './palettes';
import { MY_SWATCHES_ID, useUserPalettes, type UserPalette } from './userPalettes';
import { confirmAction, openExtractPalette, promptText } from './dialogs';
import './presets.css';

const PALETTE_KEY = 'perseverance.swatches.palette';

function readPaletteId(): string {
  try {
    return localStorage.getItem(PALETTE_KEY) || DEFAULT_PALETTE_ID;
  } catch {
    return DEFAULT_PALETTE_ID;
  }
}

interface Selection {
  paletteId: string;
  index: number;
}

/* ---- shared state so the panel menu / commands can drive the panel ---- */
let setActivePaletteExternal: ((id: string) => void) | null = null;

export function selectSwatchPalette(id: string) {
  try {
    localStorage.setItem(PALETTE_KEY, id);
  } catch {
    /* ignore */
  }
  setActivePaletteExternal?.(id);
}

export function setForeground(color: string) {
  const st = useEditor.getState();
  st.setPrimaryColor(color);
  st.pushRecentColor(color);
}

export function setBackground(color: string) {
  const st = useEditor.getState();
  st.setSecondaryColor(color);
  st.pushRecentColor(color);
}

/** "+": add the current foreground color to My Swatches. */
export function addPrimaryToSwatches() {
  const color = opaqueHex(useEditor.getState().primaryColor);
  const mine = useUserPalettes.getState().palettes.find((p) => p.id === MY_SWATCHES_ID);
  if (mine?.swatches.some((s) => s.color.toLowerCase() === color.toLowerCase())) {
    toast(`${color} is already in My Swatches`, 'info');
    return;
  }
  useUserPalettes.getState().addSwatch(MY_SWATCHES_ID, color);
  toast(`Added ${color} to My Swatches`, 'success');
}

/** Ask, then delete a user palette (palettes are app data — not undoable with Edit ▸ Undo). */
export async function deleteUserPalette(id: string): Promise<boolean> {
  if (id === MY_SWATCHES_ID) return clearMySwatches();
  const p = useUserPalettes.getState().palettes.find((x) => x.id === id);
  if (!p) return false;
  const ok = await confirmAction({
    title: 'Delete Palette',
    message: (
      <>
        Delete the palette <b>“{p.name}”</b> ({p.swatches.length} color{p.swatches.length === 1 ? '' : 's'})?
      </>
    ),
    detail: 'This cannot be undone.',
    confirm: 'Delete',
  });
  if (!ok) return false;
  useUserPalettes.getState().deletePalette(id);
  if (readPaletteId() === id) selectSwatchPalette(DEFAULT_PALETTE_ID);
  toast(`Deleted palette “${p.name}”`, 'success');
  return true;
}

/** Ask, then remove every color from My Swatches. */
export async function clearMySwatches(): Promise<boolean> {
  const n = useUserPalettes.getState().palettes.find((x) => x.id === MY_SWATCHES_ID)?.swatches.length ?? 0;
  if (!n) {
    toast('My Swatches is already empty', 'info');
    return false;
  }
  const ok = await confirmAction({
    title: 'Clear My Swatches',
    message: `Remove all ${n} color${n === 1 ? '' : 's'} from My Swatches?`,
    detail: 'This cannot be undone.',
    confirm: 'Clear',
  });
  if (!ok) return false;
  useUserPalettes.getState().deletePalette(MY_SWATCHES_ID);
  toast('My Swatches cleared', 'success');
  return true;
}

export async function extractPaletteFlow() {
  const id = await openExtractPalette();
  if (id) selectSwatchPalette(id);
}

function copyHex(c: string) {
  void navigator.clipboard?.writeText(c).then(
    () => toast(`Copied ${c}`, 'success'),
    () => toast('Clipboard unavailable', 'warning'),
  );
}

function swatchName(p: UserPalette | undefined, index: number, color: string): string {
  return p?.swatches[index]?.name || describeColor(color);
}

export function SwatchesPanel() {
  const list = useRegistry(palettes);
  const userPals = useUserPalettes((s) => s.palettes);
  const recent = useEditor((s) => s.recentColors);
  const primary = useEditor((s) => s.primaryColor);
  const [paletteId, setPaletteId] = useState(readPaletteId);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<Selection | null>(null);

  useEffect(() => {
    setActivePaletteExternal = setPaletteId;
    return () => {
      if (setActivePaletteExternal === setPaletteId) setActivePaletteExternal = null;
    };
  }, []);

  const active = list.find((p) => p.id === paletteId) ?? list.find((p) => p.id === DEFAULT_PALETTE_ID) ?? list[0];
  const userById = useMemo(() => new Map(userPals.map((p) => [p.id, p])), [userPals]);
  const mySwatches = userById.get(MY_SWATCHES_ID);

  const choosePalette = (id: string) => {
    setPaletteId(id);
    setSel(null);
    selectSwatchPalette(id);
  };

  /** Palette groups in the selector, by category. */
  const groups = useMemo(() => {
    const m = new Map<string, PaletteDef[]>();
    for (const p of list) {
      const c = p.category ?? 'Other';
      const arr = m.get(c);
      if (arr) arr.push(p);
      else m.set(c, [p]);
    }
    return [...m.entries()];
  }, [list]);

  /** Search across every palette: palette names, hex codes, color names, swatch names. */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hex = normalizeHex(q);
    const hexPrefix = q.replace(/^#/, '');
    const isHexy = /^#?[0-9a-f]{1,6}$/.test(q);
    const out: { palette: PaletteDef; items: { color: string; index: number }[] }[] = [];
    let total = 0;
    for (const p of list) {
      const nameHit = p.name.toLowerCase().includes(q) || (p.category ?? '').toLowerCase().includes(q);
      const up = userById.get(p.id);
      const items: { color: string; index: number }[] = [];
      p.colors.forEach((c, index) => {
        const lc = c.toLowerCase();
        const hit =
          nameHit ||
          (hex && lc.startsWith(hex)) ||
          (isHexy && lc.slice(1).startsWith(hexPrefix)) ||
          swatchName(up, index, c).toLowerCase().includes(q);
        if (hit) items.push({ color: c, index });
      });
      if (items.length && total < 600) {
        out.push({ palette: p, items });
        total += items.length;
      }
    }
    return out;
  }, [query, list, userById]);

  const onSwatch = (e: React.MouseEvent, paletteIdOf: string, index: number, color: string) => {
    setSel({ paletteId: paletteIdOf, index });
    if (e.altKey) setBackground(color);
    else setForeground(color);
  };

  const onSwatchMenu = (e: React.MouseEvent, paletteIdOf: string, index: number, color: string) => {
    setSel({ paletteId: paletteIdOf, index });
    const up = userById.get(paletteIdOf);
    const items: MenuItem[] = [
      { label: 'Set as Foreground', run: () => setForeground(color) },
      { label: 'Set as Background', run: () => setBackground(color) },
      { label: `Copy ${color}`, run: () => copyHex(color) },
      { separator: true },
    ];
    if (up) {
      items.push(
        {
          label: 'Rename Swatch…',
          run: async () => {
            const n = await promptText('Rename Swatch', 'Name', swatchName(up, index, color), 'Rename');
            if (n) useUserPalettes.getState().renameSwatch(up.id, index, n);
          },
        },
        {
          label: 'Delete Swatch',
          run: () => {
            useUserPalettes.getState().removeSwatch(up.id, index);
            setSel(null);
          },
        },
      );
      if (up.id !== MY_SWATCHES_ID) {
        items.push(
          { separator: true },
          {
            label: 'Rename Palette…',
            run: async () => {
              const n = await promptText('Rename Palette', 'Name', up.name, 'Rename');
              if (n) useUserPalettes.getState().renamePalette(up.id, n);
            },
          },
          { label: 'Delete Palette…', run: () => void deleteUserPalette(up.id) },
        );
      }
    } else {
      items.push({
        label: 'Add to My Swatches',
        run: () => {
          useUserPalettes.getState().addSwatch(MY_SWATCHES_ID, color);
          toast(`Added ${color} to My Swatches`, 'success');
        },
      });
    }
    showContextMenu(e, items);
  };

  const selUser = sel ? userById.get(sel.paletteId) : undefined;
  const canDelete = !!selUser && sel!.index < selUser.swatches.length;

  const deleteSelected = () => {
    if (!sel || !selUser) return;
    useUserPalettes.getState().removeSwatch(selUser.id, sel.index);
    setSel(null);
  };

  const grid = (p: PaletteDef, items: { color: string; index: number }[], withAdd = false) => {
    const up = userById.get(p.id);
    return (
      <div className="fc-sw-grid">
        {items.map(({ color, index }) => {
          const isSel = sel?.paletteId === p.id && sel.index === index;
          return (
            <div
              key={`${index}:${color}`}
              className={`fc-sw-cell${isSel ? ' sel' : ''}`}
              style={{ background: color }}
              title={`${swatchName(up, index, color)}  ${color}\nClick: foreground · Alt-click: background`}
              onClick={(e) => onSwatch(e, p.id, index, color)}
              onContextMenu={(e) => onSwatchMenu(e, p.id, index, color)}
            />
          );
        })}
        {withAdd && (
          <button className="fc-sw-cell fc-sw-add" title={`Add foreground ${opaqueHex(primary)} to My Swatches`} onClick={addPrimaryToSwatches}>
            <Plus size={10} strokeWidth={2.2} />
          </button>
        )}
      </div>
    );
  };

  const items = (p: PaletteDef) => p.colors.map((color, index) => ({ color, index }));

  return (
    <div className="fc-swatches">
      <div className="fc-sw-top">
        <SearchInput value={query} onChange={setQuery} placeholder="Search swatches" />
        <select
          className="ui-select fc-sw-select"
          value={active?.id ?? ''}
          title="Palette"
          onChange={(e) => choosePalette(e.target.value)}
        >
          {groups.map(([cat, pals]) => (
            <optgroup key={cat} label={cat}>
              {pals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.colors.length})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="fc-sw-body">
        {results ? (
          results.length ? (
            results.map((r) => (
              <div className="fc-sw-group" key={r.palette.id}>
                <div className="fc-sw-label">{r.palette.name}</div>
                {grid(r.palette, r.items)}
              </div>
            ))
          ) : (
            <div className="ui-empty">No swatches match “{query}”. Try a color name (red, beige) or a hex code.</div>
          )
        ) : (
          <>
            {active && active.id !== MY_SWATCHES_ID && (
              <div className="fc-sw-group">
                <div className="fc-sw-label">
                  {active.name}
                  {userById.has(active.id) && (
                    <button className="fc-sw-link" onClick={() => void deleteUserPalette(active.id)} title="Delete this palette…">
                      delete
                    </button>
                  )}
                </div>
                {active.colors.length ? grid(active, items(active)) : <div className="fc-note">Empty palette</div>}
              </div>
            )}
            {mySwatches && (
              <div className="fc-sw-group">
                <div className="fc-sw-label">My Swatches</div>
                {grid({ id: MY_SWATCHES_ID, name: 'My Swatches', colors: mySwatches.swatches.map((s) => s.color) }, mySwatches.swatches.map((s, index) => ({ color: s.color, index })), true)}
                {!mySwatches.swatches.length && <div className="fc-note fc-sw-hint">Click + to save the foreground color here.</div>}
              </div>
            )}
            {recent.length > 0 && (
              <div className="fc-sw-group">
                <div className="fc-sw-label">Recent</div>
                <div className="fc-sw-grid fc-sw-recent">
                  {recent.slice(0, 24).map((c) => (
                    <div
                      key={c}
                      className="fc-sw-cell"
                      style={{ background: c }}
                      title={`${describeColor(c)}  ${c}\nClick: foreground · Alt-click: background`}
                      // Picking a recent color doesn't reorder the row (the same spot keeps the same color).
                      onClick={(e) => (e.altKey ? useEditor.getState().setSecondaryColor(c) : useEditor.getState().setPrimaryColor(c))}
                      onContextMenu={(e) =>
                        showContextMenu(e, [
                          { label: 'Set as Foreground', run: () => useEditor.getState().setPrimaryColor(c) },
                          { label: 'Set as Background', run: () => useEditor.getState().setSecondaryColor(c) },
                          { label: `Copy ${c}`, run: () => copyHex(c) },
                          {
                            label: 'Add to My Swatches',
                            run: () => {
                              useUserPalettes.getState().addSwatch(MY_SWATCHES_ID, opaqueHex(c));
                              toast(`Added ${opaqueHex(c)} to My Swatches`, 'success');
                            },
                          },
                        ])
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="fc-sw-foot">
        <IconButton
          icon={FolderOpen}
          size="sm"
          title="Palettes: extract from image…"
          onClick={(e) =>
            showMenuAt(e.currentTarget, [
              { label: 'Extract Palette from Image…', run: () => void extractPaletteFlow() },
              { separator: true },
              { heading: true, label: 'Show Palette' },
              ...groups.map(([cat, pals]) => ({
                label: cat,
                checked: pals.some((p) => p.id === active?.id),
                submenu: pals.map((p) => ({ label: `${p.name} (${p.colors.length})`, checked: p.id === active?.id, run: () => choosePalette(p.id) })),
              })),
            ])
          }
        />
        <IconButton icon={Plus} size="sm" title="Add foreground color to My Swatches" onClick={addPrimaryToSwatches} />
        <IconButton icon={Trash2} size="sm" title={canDelete ? 'Delete selected swatch' : 'Select one of your swatches to delete it'} disabled={!canDelete} onClick={deleteSelected} />
        <span style={{ flex: 1 }} />
        <span className="fc-dim">{active ? `${active.colors.length} colors` : ''}</span>
      </div>
    </div>
  );
}

/** Panel ⋯ menu. */
export function swatchesPanelMenu() {
  return [
    { label: 'Add Foreground to My Swatches', run: addPrimaryToSwatches },
    { label: 'Extract Palette from Image…', run: () => void extractPaletteFlow() },
    {
      label: 'Clear My Swatches…',
      disabled: !useUserPalettes.getState().palettes.find((p) => p.id === MY_SWATCHES_ID)?.swatches.length,
      run: () => void clearMySwatches(),
    },
    { label: 'Show Default Swatches', run: () => selectSwatchPalette(DEFAULT_PALETTE_ID) },
  ];
}
