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
  /**
   * Native Save dialog + write. Resolves the path actually written: the main process appends the
   * first filter's extension when the chosen name lacks it ("Poster" → "Poster.pgfx"). `busyPaths`:
   * files open in other tabs — choosing one asks for another name instead of replacing it.
   */
  saveFile(opts: { title?: string; defaultPath?: string; filters?: FileFilter[]; data: ArrayBuffer | string; busyPaths?: string[] }): Promise<string | null>;
  /**
   * Crash-safe write (temp file + rename) to a path the user chose: a Save dialog result, or a project
   * opened via dialog / Explorer / Finder. Any other path rejects with an `ENOTGRANTED` error.
   */
  writeFile(path: string, data: ArrayBuffer | string): Promise<void>;
  /** Read a file the user opened or saved before (recent files). Other paths reject with `ENOTGRANTED`. */
  readFile(path: string): Promise<ArrayBuffer>;
  showItemInFolder(path: string): void;
  openExternal(url: string): void;
  setTitle(title: string): void;
  setDocumentEdited(edited: boolean): void;
  /** Files passed on the command line / double-clicked in Explorer / dropped on the dock icon. */
  onOpenFile(cb: (file: OpenedFile) => void): () => void;
  /**
   * A file dropped on the window (from Explorer/Finder): its absolute path, granted like a file the OS
   * handed over (projects may be saved back in place) — or null (dragged from a browser or an archive,
   * or `data` is not the file's content). The path comes from Electron's own File object, so page
   * script can't name arbitrary files.
   */
  grantDroppedFile?(file: File, data: ArrayBuffer): Promise<string | null>;
  /**
   * Main process asks before closing; respond with confirmClose(true|false). The preload acknowledges
   * the request at once; if the page is hung (no acknowledgement within a few seconds) the main
   * process offers "Quit Anyway", so a busy or crashed renderer never traps the user.
   */
  onCloseRequested(cb: () => void): () => void;
  /**
   * Right before a forced quit ("Quit Anyway" in a native prompt, Windows ending the session) the main
   * process asks the page to bring its autosaved copies up to date; it waits for the returned promise
   * (a page that doesn't answer within a few seconds is not waited for). Not a close handler: a page
   * without onCloseRequested still counts as unguarded.
   */
  onFlushRecovery?(cb: () => Promise<unknown>): () => void;
  confirmClose(ok: boolean): void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  /** Directory for user data (assets library, autosave). */
  userDataPath(): Promise<string>;
  /** Native page zoom (UI scale preference). */
  setZoomFactor?(factor: number): void;
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
export async function saveFile(opts: {
  title?: string;
  defaultPath: string;
  filters?: FileFilter[];
  data: ArrayBuffer | Blob | string;
  /** Desktop: files open in other tabs, never replaced (the user is asked for another name). */
  busyPaths?: string[];
}): Promise<string | null> {
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

/**
 * True for the error the desktop bridge raises when the main process refuses a path the user never
 * chose (see DesktopBridge.writeFile/readFile). Callers fall back to a Save As / Open dialog.
 */
export function isAccessDenied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return msg.includes('ENOTGRANTED');
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

/**
 * True when two desktop paths name the same file: Windows paths compare case- and slash-insensitively
 * ("C:\Art\Poster.pgfx" = "c:/art/poster.PGFX"), macOS case-insensitively (default APFS), Linux exactly.
 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const win = platformName === 'win32' || /^([a-zA-Z]:[\\/]|\\\\)/.test(a);
  const key = (p: string) => {
    let k = win ? p.replace(/\//g, '\\') : p;
    if (win || platformName === 'darwin') k = k.toLowerCase();
    return k.length > 1 ? k.replace(/[\\/]+$/, '') : k;
  };
  return key(a) === key(b);
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
