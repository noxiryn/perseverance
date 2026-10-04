/**
 * Recent files (desktop paths) persisted in localStorage 'perseverance.recent' and exposed as
 * the File ▸ Open Recent submenu (commands regenerated whenever the list changes).
 */
import { FileClock, Trash2 } from 'lucide-react';
import { commands, type CommandDef } from '../registry';
import { desktop, fileNameOf } from '../platform';
import { toast } from '../state/ui';
import { pushRecent, type RecentFile } from './math';
import { readJSON, writeJSON } from './util';

export const RECENT_KEY = 'perseverance.recent';
export const RECENT_MAX = 12;
const MENU = 'File/Open Recent';

export function readRecentFiles(): RecentFile[] {
  const v = readJSON<unknown>(RECENT_KEY, []);
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is RecentFile => !!e && typeof e === 'object' && typeof (e as RecentFile).path === 'string')
    .map((e) => ({ path: e.path, name: typeof e.name === 'string' && e.name ? e.name : fileNameOf(e.path), time: Number(e.time) || 0 }))
    .slice(0, RECENT_MAX);
}

function writeRecentFiles(list: RecentFile[]) {
  writeJSON(RECENT_KEY, list.slice(0, RECENT_MAX));
  refreshRecentCommands();
}

/** Record a file path (desktop only — browser "paths" are just names and cannot be reopened). */
export function addRecentFile(path: string | null | undefined, name?: string) {
  if (!path || !desktop) return;
  writeRecentFiles(pushRecent(readRecentFiles(), { path, name: name ?? fileNameOf(path), time: Date.now() }, RECENT_MAX));
}

export function removeRecentFile(path: string) {
  writeRecentFiles(readRecentFiles().filter((e) => e.path !== path));
}

export function clearRecentFiles() {
  writeRecentFiles([]);
}

export async function openRecentFile(entry: RecentFile) {
  if (!desktop) {
    toast('Recent files can be reopened in the desktop app — use File ▸ Open in the browser.', 'info');
    return;
  }
  let data: ArrayBuffer;
  try {
    data = await desktop.readFile(entry.path);
  } catch {
    removeRecentFile(entry.path);
    toast(`“${entry.name}” could not be found and was removed from Open Recent.`, 'error', 4200);
    return;
  }
  const { openFile } = await import('./open');
  await openFile({ path: entry.path, name: entry.name || fileNameOf(entry.path), data }, { asNewDocument: true });
}

let registered: string[] = [];

/** (Re)register the Open Recent submenu commands from the stored list. */
export function refreshRecentCommands() {
  for (const id of registered) commands.unregister(id);
  registered = [];
  const list = readRecentFiles();
  const defs: CommandDef[] = list.map((e, i) => ({
    id: `file.openRecent.${i}`,
    label: e.name,
    menu: MENU,
    group: '10-new',
    order: 40 + i,
    icon: FileClock,
    keywords: ['recent', 'open', e.path],
    run: () => openRecentFile(e),
  }));
  if (!list.length)
    defs.push({
      id: 'file.openRecent.none',
      label: 'No Recent Files',
      menu: MENU,
      group: '10-new',
      order: 40,
      run: () => undefined,
      enabled: () => false,
    });
  defs.push({
    id: 'file.clearRecent',
    label: 'Clear Recent Files',
    menu: MENU,
    group: '10-newz',
    order: 99,
    icon: Trash2,
    keywords: ['recent', 'history'],
    run: () => {
      clearRecentFiles();
      toast('Recent files cleared', 'success');
    },
    enabled: () => readRecentFiles().length > 0,
  });
  commands.registerMany(defs);
  registered = defs.map((d) => d.id);
}

// Keep in sync when another window changes the list.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key === RECENT_KEY) refreshRecentCommands();
  });
