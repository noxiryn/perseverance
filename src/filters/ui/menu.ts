/**
 * Filter menu: Last Filter, Filter Gallery and one command per browsable filter in
 * 'Filter/<Category>' submenus. Built dynamically from the filters registry, so filters
 * registered later by other modules (e.g. the Roblox character filters) appear too.
 */
import { GalleryHorizontalEnd, History, WandSparkles } from 'lucide-react';
import { commands, filters, type CommandDef, type FilterDef } from '../../registry';
import { activeDoc } from '../../state/editor';
import { openDialog, toast } from '../../state/ui';
import { openFilterDialog } from './filterDialog';
import { FilterGallery, type FilterGalleryProps } from './FilterGallery';
import { applyFilterNow } from './apply';
import { getLastFilter, setLastFilter, subscribeLastFilter } from './memory';
import { categoryRank, isBrowsableFilter } from './galleryModel';

export const LAST_FILTER_ID = 'filter.last';
export const GALLERY_ID = 'filter.gallery';
const APPLY_PREFIX = 'filter.apply.';

const hasDoc = () => !!activeDoc();

function lastFilterCommand(): CommandDef {
  const last = getLastFilter();
  const def = last ? filters.get(last.filterId) : undefined;
  return {
    id: LAST_FILTER_ID,
    label: def ? `Last Filter: ${def.name}` : 'Last Filter',
    menu: 'Filter',
    group: '10-last',
    order: 10,
    shortcut: 'Alt+Ctrl+F',
    icon: History,
    keywords: ['repeat', 'again', 'reapply', 'last filter'],
    enabled: () => hasDoc() && !!getLastFilter(),
    run: () => {
      const l = getLastFilter();
      if (!l) return void toast('No filter has been applied yet.', 'info');
      const d = filters.get(l.filterId);
      if (!d) return void toast('The last filter is no longer available.', 'warning');
      const res = applyFilterNow(l.filterId, l.params, l.mode);
      if (!res.ok) return void toast(res.error ?? `${d.name} could not be applied.`, 'info', 3600);
      setLastFilter({ ...l, mode: res.mode ?? l.mode });
      toast(`${d.name}${res.mode === 'smart' ? ' (Smart Filter)' : ''} applied`, 'success');
    },
  };
}

const galleryCommand: CommandDef = {
  id: GALLERY_ID,
  label: 'Filter Gallery…',
  menu: 'Filter',
  group: '20-gallery',
  order: 10,
  icon: GalleryHorizontalEnd,
  keywords: ['filters', 'browse', 'effects', 'thumbnails', 'fx'],
  run: () => {
    void openDialog<unknown, FilterGalleryProps>(FilterGallery, {});
  },
};

function applyCommand(f: FilterDef, order: number): CommandDef {
  return {
    id: APPLY_PREFIX + f.id,
    label: `${f.name}…`,
    menu: `Filter/${f.category}`,
    group: f.category === 'Roblox' ? '40-roblox' : '30-categories',
    order,
    icon: f.icon ?? WandSparkles,
    keywords: [f.id, f.category, ...(f.keywords ?? [])],
    enabled: hasDoc,
    run: () => openFilterDialog(f.id),
  };
}

/** Signature of what the command depends on (re-register only when it changes). */
function sig(f: FilterDef, order: number) {
  return `${f.name}|${f.category}|${order}|${f.icon ? 1 : 0}`;
}

const registered = new Map<string, string>(); // command id → signature
let scheduled = false;

function sync() {
  scheduled = false;
  const list = filters
    .list()
    .filter(isBrowsableFilter)
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name));
  const changed: CommandDef[] = [];
  const keep = new Set<string>();
  list.forEach((f, i) => {
    // order: category block × 1000 + alphabetical index → submenus sort by category order
    const order = categoryRank(f.category) * 1000 + i;
    const id = APPLY_PREFIX + f.id;
    keep.add(id);
    const s = sig(f, order);
    if (registered.get(id) === s && commands.has(id)) return;
    registered.set(id, s);
    changed.push(applyCommand(f, order));
  });
  if (changed.length) commands.registerMany(changed);
  for (const id of [...registered.keys()]) {
    if (!keep.has(id)) {
      registered.delete(id);
      commands.unregister(id);
    }
  }
}

function scheduleSync() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(sync);
}

let installed = false;

/** Register the Filter menu (idempotent). */
export function installFilterMenu() {
  if (installed) return;
  installed = true;
  commands.registerMany([lastFilterCommand(), galleryCommand]);
  subscribeLastFilter(() => commands.register(lastFilterCommand()));
  filters.subscribe(scheduleSync);
  sync();
}
