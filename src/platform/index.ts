/**
 * Platform bridge. In the desktop app (Electron) `window.desktop` is exposed by the preload
 * script; in a plain browser (dev / tests) we fall back to web APIs.
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenedFile {
  /** Absolute path (desktop) or file name (browser). */
  path: string | null;
  name: string;
  data: ArrayBuffer;
}

interface DesktopBridge {
  isDesktop: true;
  platform: 'win32' | 'darwin' | 'linux' | string;
  version: string;
  openFiles(opts: { title?: string; filters?: FileFilter[]; multiple?: boolean }): Promise<OpenedFile[]>;
  saveFile(opts: { title?: string; defaultPath?: string; filters?: FileFilter[]; data: ArrayBuffer | string }): Promise<string | null>;
  writeFile(path: string, data: ArrayBuffer | string): Promise<void>;
  readFile(path: string): Promise<ArrayBuffer>;
  showItemInFolder(path: string): void;
  openExternal(url: string): void;
  setTitle(title: string): void;
  setDocumentEdited(edited: boolean): void;
  /** Files passed on the command line / double-clicked in Explorer / dropped on the dock icon. */
  onOpenFile(cb: (file: OpenedFile) => void): () => void;
  /** Main process asks before closing; respond with confirmClose(true|false). */
  onCloseRequested(cb: () => void): () => void;
  confirmClose(ok: boolean): void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  /** Directory for user data (assets library, autosave). */
  userDataPath(): Promise<string>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | null = typeof window !== 'undefined' && window.desktop ? window.desktop : null;
export const isDesktop = !!desktop;
export const platformName: string = desktop?.platform ?? (navigator.userAgent.includes('Mac') ? 'darwin' : 'web');
export const isMac = platformName === 'darwin';
export const appVersion: string = desktop?.version ?? (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev';

/** Open one or more files via native dialog (desktop) or a hidden <input type=file> (browser). */
export async function openFiles(opts: { title?: string; filters?: FileFilter[]; multiple?: boolean } = {}): Promise<OpenedFile[]> {
  if (desktop) return desktop.openFiles(opts);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!opts.multiple;
    if (opts.filters?.length) input.accept = opts.filters.flatMap((f) => f.extensions.map((e) => (e === '*' ? '*' : `.${e}`))).join(',');
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(await Promise.all(files.map(async (f) => ({ path: null, name: f.name, data: await f.arrayBuffer() }))));
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/**
 * Save data via native Save dialog (desktop, returns the chosen path) or a download (browser,
 * returns the file name).
 */
export async function saveFile(opts: { title?: string; defaultPath: string; filters?: FileFilter[]; data: ArrayBuffer | Blob | string }): Promise<string | null> {
  const data = opts.data instanceof Blob ? await opts.data.arrayBuffer() : opts.data;
  if (desktop) return desktop.saveFile({ ...opts, data });
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.defaultPath.split(/[\\/]/).pop() || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return a.download;
}

/** Write directly to a known path (desktop only). Returns false in the browser. */
export async function writeFile(path: string, data: ArrayBuffer | Blob | string): Promise<boolean> {
  if (!desktop) return false;
  const d = data instanceof Blob ? await data.arrayBuffer() : data;
  await desktop.writeFile(path, d);
  return true;
}

export function openExternal(url: string) {
  if (desktop) desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

export function setWindowTitle(title: string) {
  document.title = title;
  desktop?.setTitle(title);
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
