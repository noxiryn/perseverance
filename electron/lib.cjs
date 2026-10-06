/*
 * Perseverance — pure helpers for the Electron main process (no `electron` import, so they are
 * unit-tested from vitest: src/platform/desktopMain.test.ts).
 */
const nodePath = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { fileURLToPath, pathToFileURL } = require('node:url');

const PROJECT_EXT = 'pgfx';
/** Files the app opens from the command line / Explorer / Finder. */
const OPENABLE_RE = /\.(pgfx|png|jpe?g|webp|gif|bmp|psd|psb)$/i;
const PGFX_MAGIC = Buffer.from('PGFX', 'ascii');

/**
 * Colours of the native window chrome. They must match the web UI:
 *  - background  = --bg-app (src/styles/theme.css), shown before the first paint
 *  - titleBar    = --shell-titlebar (src/ui/shell/shell.css), behind the Windows/Linux caption buttons
 *  - symbols     = the title bar's icon colour (.shell-tool in shell.css)
 *  - titleBarHeight = --titlebar-h (theme.css), in CSS px at 100% UI scale
 */
const THEME = Object.freeze({ background: '#121212', titleBar: '#161616', symbols: '#bdbdbd', titleBarHeight: 32 });

/** Height of the native caption-button overlay for a UI zoom factor. One px shorter than the bar so its
 * bottom hairline (border-bottom) continues under the buttons. */
function overlayHeight(zoom) {
  const z = Number.isFinite(zoom) && zoom > 0 ? Math.max(0.5, Math.min(2, zoom)) : 1;
  return Math.max(16, Math.round(THEME.titleBarHeight * z) - 1);
}

function pathApi(platform = process.platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** A path the main process accepts from the renderer: absolute, no NUL, no Win32 device namespace. */
function isSafeAbsPath(p, platform = process.platform) {
  if (typeof p !== 'string' || !p || p.length > 32767 || p.includes('\0')) return false;
  const P = pathApi(platform);
  if (!P.isAbsolute(p)) return false;
  if (platform === 'win32') {
    // \\.\PhysicalDrive0, \\?\GLOBALROOT\..., and drive-relative forms are never legit project paths.
    if (/^[\\/]{2}[.?][\\/]/.test(p)) return false;
    if (!/^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(p)) return false;
  }
  return true;
}

/**
 * Canonical comparison key for a path: resolved, and case-folded on file systems that are
 * case-insensitive by default (Windows NTFS, macOS APFS). Windows paths compare with either slash.
 */
function pathKey(p, platform = process.platform) {
  const P = pathApi(platform);
  let k = P.resolve(p);
  if (platform === 'win32') k = k.replace(/\//g, '\\');
  if (k.length > 1) k = k.replace(platform === 'win32' ? /\\+$/ : /\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? k.toLowerCase() : k;
}

/**
 * The file:// URL of a local file, every URL-special character in the path escaped ('%' → %25, '#',
 * '?', spaces, non-ASCII). The app page must be loaded from this URL, not with `loadFile()`: Electron
 * builds that URL without escaping '%', so an install folder such as "C:\Users\100%Real\…" or
 * "D:\Sale 25%ad\…" gave a URL that no longer names the real file (Chromium decodes "%ad", Node refuses
 * "%Re"), the file:// filter below refused the app's own index.html and the user got a blank window.
 * With this URL every request the page makes (relative chunks keep the escapes) decodes back to the
 * real path in fileUrlPath().
 */
function fileUrlOf(file, platform = process.platform) {
  return pathToFileURL(file, { windows: platform === 'win32' }).href;
}

/** The local path a file:// URL names (percent-escapes decoded), or null for anything else / malformed. */
function fileUrlPath(url, platform = process.platform) {
  if (typeof url !== 'string' || !/^file:/i.test(url)) return null;
  try {
    return fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return null; // encoded separators, a host on POSIX, invalid escapes
  }
}

/**
 * True when `url` is a file:// URL naming `root` itself or something inside it. The app page loads
 * from file:// with Electron's extra file privileges, which would let it fetch() or <img> ANY local
 * file (file:///C:/Users/…, file://server/share UNC paths); the main process cancels every file://
 * request outside the app's own dist folder with this check. Both sides are compared as decoded,
 * normalized paths (pathKey: resolved, case-folded where the file system is). Malformed URLs (encoded
 * separators, a host on POSIX, a stray '%') are refused.
 */
function fileUrlInside(url, root, platform = process.platform) {
  if (typeof root !== 'string' || !root) return false;
  const p = fileUrlPath(url, platform);
  if (p === null) return false;
  const k = pathKey(p, platform);
  const r = pathKey(root, platform);
  return k === r || k.startsWith(r + pathApi(platform).sep);
}

/** True when `url` is a file:// URL naming exactly `file` (query and hash ignored). */
function fileUrlIs(url, file, platform = process.platform) {
  const p = fileUrlPath(url, platform);
  return p !== null && typeof file === 'string' && !!file && pathKey(p, platform) === pathKey(file, platform);
}

/**
 * The Vite dev server URL to load instead of the bundled page, or null. Only an unpackaged app (`electron .`
 * from scripts/electron-dev.cjs) honours VITE_DEV_SERVER_URL, and only for a server on this machine: a
 * packaged app that obeyed it would load any page the environment names, with the full desktop bridge.
 */
function devServerUrl(value, isPackaged) {
  if (isPackaged || typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Files passed on a command line (first launch, or forwarded by a second instance). Relative paths
 * are resolved against the launching process' working directory.
 */
function fileArgs(argv, opts = {}) {
  const { skip = 1, cwd = process.cwd(), platform = process.platform } = opts;
  const P = pathApi(platform);
  if (!Array.isArray(argv)) return [];
  const out = [];
  for (const a of argv.slice(skip)) {
    if (typeof a !== 'string' || !a || a.startsWith('-') || !OPENABLE_RE.test(a)) continue;
    const abs = P.isAbsolute(a) ? P.normalize(a) : P.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), a);
    if (isSafeAbsPath(abs, platform) && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Sanitize dialog filters coming from the renderer. */
function sanitizeFilters(filters) {
  if (!Array.isArray(filters)) return undefined;
  const out = [];
  for (const f of filters.slice(0, 20)) {
    if (!f || typeof f !== 'object' || !Array.isArray(f.extensions)) continue;
    const extensions = f.extensions
      .filter((e) => typeof e === 'string' && /^(\*|[a-z0-9]{1,16})$/i.test(e))
      .slice(0, 20);
    if (!extensions.length) continue;
    out.push({ name: typeof f.name === 'string' ? f.name.slice(0, 120) : 'Files', extensions });
  }
  return out.length ? out : undefined;
}

/**
 * Save dialogs on Linux (GTK) and macOS don't always add the filter's extension. When the chosen
 * name has no extension, or one that matches none of the filters, append the first filter's
 * extension ("Untitled" → "Untitled.pgfx"). Filters with '*' accept anything.
 */
function ensureExtension(filePath, filters, platform = process.platform) {
  if (typeof filePath !== 'string' || !filePath) return filePath;
  const list = sanitizeFilters(filters);
  if (!list) return filePath;
  const all = list.flatMap((f) => f.extensions.map((e) => e.toLowerCase()));
  if (all.includes('*')) return filePath;
  const P = pathApi(platform);
  const ext = P.extname(filePath).slice(1).toLowerCase();
  if (ext && all.includes(ext)) return filePath;
  const base = filePath.replace(/\.+$/, '');
  return `${base}.${list[0].extensions[0].toLowerCase()}`;
}

/**
 * The only file types the page may save through the native Save dialog: projects, image exports and
 * PSD exports. A page-chosen .bat / .lnk / .hta pre-filled into a startup folder would run at the next
 * login after a single Enter press.
 */
const SAVE_EXTS = Object.freeze(['pgfx', 'png', 'jpg', 'jpeg', 'webp', 'psd']);

/**
 * Save-dialog filters from the renderer, reduced to SAVE_EXTS ('*' and anything else dropped). Undefined
 * when nothing usable is left: the caller must refuse the save, because without a filter ensureExtension()
 * can't guarantee the extension the file is written with.
 */
function saveFilters(filters) {
  const out = [];
  for (const f of sanitizeFilters(filters) ?? []) {
    const extensions = f.extensions.map((e) => e.toLowerCase()).filter((e, i, a) => SAVE_EXTS.includes(e) && a.indexOf(e) === i);
    if (extensions.length) out.push({ name: f.name, extensions });
  }
  return out.length ? out : undefined;
}

/**
 * The Save dialog's starting path from a renderer-supplied defaultPath. The dialog touches that path on
 * disk before the user does anything (Windows checks whether it or its folder exists and opens that
 * folder), so a page-chosen "\\attacker\share\x" would make Windows connect out and offer the user's
 * NTLM hash, and a page could pre-fill a startup folder. So the page never picks the folder:
 *  - a file the user chose before (opened/saved: `grants.get()`) is kept as is — also on a NAS share;
 *  - a new name in the folder of such a file (Save As of a new document starts next to the last project:
 *    src/io/save defaultProjectSavePath) keeps that trusted folder, with the name cleaned up;
 *  - anything else is cut down to a plain file name and the OS picks the folder (the one last used).
 */
function saveDefaultPath(defaultPath, grants, platform = process.platform) {
  if (typeof defaultPath !== 'string' || !defaultPath || defaultPath.length > 32767) return undefined;
  const name = saveFileName(defaultPath);
  if (isSafeAbsPath(defaultPath, platform) && grants && typeof grants.get === 'function') {
    const granted = grants.get(defaultPath);
    if (granted) return granted.path;
    const P = pathApi(platform);
    const dir = name && typeof grants.folder === 'function' ? grants.folder(P.dirname(defaultPath)) : null;
    if (dir) return P.join(dir, name);
  }
  return name;
}

/**
 * The file-name part of a page-supplied path, safe to hand to a Save dialog: the last segment (either
 * slash: a Windows path is cut on POSIX too) without the characters no file system accepts in a name (as
 * src/io safeFileName does; ':' would also name an NTFS stream or a drive), or undefined when nothing is left.
 */
function saveFileName(defaultPath) {
  const name = defaultPath
    .split(/[\\/]/)
    .pop()
    .replace(/^[a-zA-Z]:/, '')
    .replace(/[:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  return name ? name.slice(0, 255) : undefined;
}

/** Bytes to write from an IPC payload (string → UTF-8). Never copies an ArrayBuffer. */
function toBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('data must be an ArrayBuffer, a typed array or a string');
}

/** An ArrayBuffer holding exactly the bytes of a Node Buffer (no copy when it owns its memory). */
function toArrayBuffer(buf) {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) return buf.buffer;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function hasPgfxMagic(buf) {
  return !!buf && buf.length >= 4 && buf.subarray(0, 4).equals(PGFX_MAGIC);
}

/** True when the file at `p` starts with the PGFX container magic. */
async function fileHasPgfxMagic(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const b = Buffer.alloc(4);
    const { bytesRead } = await fh.read(b, 0, 4, 0);
    return bytesRead === 4 && hasPgfxMagic(b);
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crash-safe write: the bytes go to a temp file next to the target, which then replaces it. A crash
 * or a full disk mid-write leaves the previous version intact. Falls back to an in-place write when
 * the folder isn't writable or the rename keeps failing (Windows: file held open by another app).
 */
async function atomicWrite(target, buffer, deps = {}) {
  const f = deps.fs ?? fsp;
  let real = target;
  try {
    real = await f.realpath(target); // keep symlinks pointing at the real file
  } catch {
    /* new file */
  }
  // An existing file keeps its permissions, and a read-only one is refused: POSIX lets a rename replace
  // a read-only file whenever its folder is writable, which would silently ignore the lock.
  let mode = null;
  const existing = typeof f.stat === 'function' ? await f.stat(real).catch(() => null) : null;
  if (existing) {
    if (typeof f.access === 'function') {
      try {
        await f.access(real, fs.constants.W_OK);
      } catch (e) {
        const err = new Error(`${e && e.code ? `${e.code}: ` : ''}“${nodePath.basename(real)}” is read-only or you don't have permission to change it`);
        err.code = (e && e.code) || 'EACCES';
        throw err;
      }
    }
    mode = existing.mode & 0o7777;
  }
  const dir = nodePath.dirname(real);
  const tmp = nodePath.join(dir, `.${nodePath.basename(real)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    await f.writeFile(tmp, buffer);
    if (mode !== null && process.platform !== 'win32' && typeof f.chmod === 'function') await f.chmod(tmp, mode).catch(() => {});
  } catch (e) {
    await f.unlink(tmp).catch(() => {});
    if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) {
      await f.writeFile(real, buffer);
      return real;
    }
    throw e;
  }
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      await f.rename(tmp, real);
      return real;
    } catch (e) {
      lastErr = e;
      if (!e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      await sleep(40 * (i + 1));
    }
  }
  // Rename keeps failing (e.g. Windows antivirus/indexer holding the file): copy over the target.
  try {
    await f.copyFile(tmp, real);
    return real;
  } catch (e) {
    throw lastErr ?? e;
  } finally {
    await f.unlink(tmp).catch(() => {});
  }
}

/** Synchronous variant for small state files (window state, grants). */
function atomicWriteSync(target, text) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  } catch {
    try {
      fs.writeFileSync(target, text);
    } catch {
      /* ignore: state files are best effort */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Paths the user handed to the app (open/save dialogs, Explorer double-click, Finder, command line).
 * The renderer can only read those (and write the ones that are projects or Save targets), so a
 * compromised page can't touch arbitrary files. Persisted in userData so recent files and recovered
 * documents keep working across launches.
 */
class FileGrants {
  constructor(file, opts = {}) {
    this.file = file;
    this.platform = opts.platform ?? process.platform;
    this.max = opts.max ?? 400;
    /** @type {Map<string, {path: string, write: boolean, t: number}>} */
    this.map = new Map();
    if (file) {
      const data = readJsonSync(file, null);
      const list = data && Array.isArray(data.files) ? data.files : [];
      for (const e of list) {
        if (e && isSafeAbsPath(e.path, this.platform)) this.map.set(pathKey(e.path, this.platform), { path: e.path, write: !!e.write, t: Number(e.t) || 0 });
      }
    }
  }

  grant(p, { write = false } = {}) {
    if (!isSafeAbsPath(p, this.platform)) return false;
    const k = pathKey(p, this.platform);
    const prev = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, { path: p, write: write || !!prev?.write, t: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.save();
    return true;
  }

  get(p) {
    return isSafeAbsPath(p, this.platform) ? this.map.get(pathKey(p, this.platform)) ?? null : null;
  }

  /**
   * The folder of a granted file that `dir` names, as that file's path spells it ("C:\Art"), or null:
   * a folder the user picked in a dialog or opened a file from.
   */
  folder(dir) {
    if (!isSafeAbsPath(dir, this.platform)) return null;
    const P = pathApi(this.platform);
    const k = pathKey(dir, this.platform);
    for (const e of this.map.values()) {
      const d = P.dirname(e.path);
      if (pathKey(d, this.platform) === k) return d;
    }
    return null;
  }

  canRead(p) {
    return !!this.get(p);
  }

  canWrite(p) {
    return !!this.get(p)?.write;
  }

  save() {
    if (!this.file) return;
    atomicWriteSync(this.file, JSON.stringify({ version: 1, files: [...this.map.values()] }));
  }
}

/* ---------------- files opened from the OS ---------------- */

/**
 * Files the OS hands the app (command line, Explorer double-click forwarded by a second instance,
 * Finder) before the page can receive them. `ready()` says whether the renderer can take a file now;
 * `deliver(p)` sends it (and reports its own errors). flush() makes ONE pass over the files waiting at
 * that moment: one that still can't be delivered stays queued for the next flush and is never retried
 * in a loop (a synchronous retry loop starved the main process while the page was loading).
 */
function createOpenQueue({ ready, deliver }) {
  const pending = [];
  const keep = (p) => {
    if (!pending.includes(p)) pending.push(p);
  };
  const send = async (p) => {
    try {
      await deliver(p);
    } catch {
      /* deliver reports its own errors */
    }
  };
  return {
    get pending() {
      return [...pending];
    },
    /** Deliver now when the renderer is ready, else keep it for flush(). True when delivery started. */
    open(p) {
      if (!ready()) {
        keep(p);
        return false;
      }
      void send(p);
      return true;
    },
    async flush() {
      for (const p of pending.splice(0)) {
        if (ready()) await send(p);
        else keep(p);
      }
    },
  };
}

/* ---------------- editor page load state ---------------- */

/** net::ERR_ABORTED: a newer navigation or reload superseded the load (not a failure). */
const ERR_ABORTED = -3;

/**
 * Load state of the editor window's page, fed from its webContents events. Chromium reports a failed
 * load as 'did-fail-load' followed by 'did-finish-load' for its own error page: that page is not the
 * editor (it can't take files, and a reload that ends there did not bring the editor back). A failed load
 * is the user's to see, unless it belongs to a renderer that crashed or is being killed: the crash prompt
 * or the hung-renderer reload speaks for that one. The reload that follows starts in a new renderer, so a
 * failure of THAT load is reported again (a bundle that vanished while the app ran: antivirus, reinstall).
 */
function createLoadState() {
  let failed = false; // the last main-frame load failed: the window shows Chromium's error page
  let abandoned = false; // the current load belongs to a renderer that crashed / that we are killing
  return {
    /** 'did-start-loading': a new load (also the reload in a fresh renderer after a crash or a kill). */
    start() {
      failed = false;
      abandoned = false;
    },
    /** 'render-process-gone', or right before killing a hung renderer: the current load dies with it. */
    abandon() {
      abandoned = true;
    },
    /**
     * 'did-fail-load'. null: not a failure of the page (a subframe, or ERR_ABORTED). 'abandoned': the load
     * of a dead or dying renderer (reported by the crash flow). 'report': tell the user.
     */
    fail(code, isMainFrame) {
      if (!isMainFrame || code === ERR_ABORTED) return null;
      failed = true;
      return abandoned ? 'abandoned' : 'report';
    },
    /** 'did-finish-load'. True when the editor itself loaded, false for Chromium's error page. */
    finish() {
      return !failed;
    },
    /** Chromium's error page is showing: the last load failed and nothing has reloaded since. */
    get failed() {
      return failed;
    },
  };
}

/* ---------------- window state ---------------- */

const DEFAULT_SIZE = { width: 1600, height: 960 };
const MIN_SIZE = { width: 1024, height: 640 };

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** Parse a stored window state, dropping anything malformed. */
function parseWindowState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const width = num(raw.width);
  const height = num(raw.height);
  if (!width || !height || width < 200 || height < 150) return null;
  return { x: num(raw.x), y: num(raw.y), width, height, maximized: !!raw.maximized };
}

function intersect(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * Initial window bounds: the saved ones when their title bar is still reachable on a connected
 * display (monitor unplugged / resolution changed → centered on the primary display instead).
 * `displays` are work areas ({x, y, width, height}); the first one is the primary display.
 */
function initialBounds(state, displays) {
  const areas = (Array.isArray(displays) ? displays : []).filter((d) => d && d.width > 0 && d.height > 0);
  const primary = areas[0] ?? { x: 0, y: 0, ...DEFAULT_SIZE };
  const fit = (w, h, area) => ({
    width: Math.max(Math.min(MIN_SIZE.width, area.width), Math.min(w, area.width)),
    height: Math.max(Math.min(MIN_SIZE.height, area.height), Math.min(h, area.height)),
  });
  const s = parseWindowState(state);
  if (s && s.x !== null && s.y !== null) {
    // The top 32px strip (title bar) must overlap a display by ≥ 120×16 px to be draggable.
    const titleStrip = { x: s.x, y: s.y, width: s.width, height: THEME.titleBarHeight };
    const host = areas.find((a) => {
      const i = intersect(titleStrip, a);
      return i && i.width >= Math.min(120, s.width) && i.height >= 16;
    });
    if (host) {
      const size = fit(s.width, s.height, host);
      return { x: s.x, y: s.y, ...size, maximized: s.maximized, restored: true };
    }
  }
  const size = fit(s?.width ?? DEFAULT_SIZE.width, s?.height ?? DEFAULT_SIZE.height, primary);
  return {
    x: Math.round(primary.x + (primary.width - size.width) / 2),
    y: Math.round(primary.y + (primary.height - size.height) / 2),
    ...size,
    maximized: s ? s.maximized : null,
    restored: false,
  };
}

/* ---------------- logging ---------------- */

/** Append-only log with a single rotation (main.log → main.old.log at 1 MB). */
function createLogger(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  let ready = false;
  const write = (level, parts) => {
    const msg = parts
      .map((p) => (p instanceof Error ? `${p.stack || p.message}` : typeof p === 'string' ? p : safeJson(p)))
      .join(' ');
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    if (level === 'error') console.error(line.trimEnd());
    if (!file) return;
    try {
      if (!ready) {
        fs.mkdirSync(nodePath.dirname(file), { recursive: true });
        ready = true;
      }
      try {
        if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, line);
    } catch {
      /* logging must never throw */
    }
  };
  return {
    file,
    info: (...p) => write('info', p),
    warn: (...p) => write('warn', p),
    error: (...p) => write('error', p),
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The project's page (package.json "homepage"; desktopMain.test.ts keeps the two in sync). */
const PROJECT_HOMEPAGE = 'https://github.com/noxiryn/perseverance';
/** Hosts whose pages the app links to: the Roblox profile button in the avatar dialog. */
const EXTERNAL_HOSTS = Object.freeze(['www.roblox.com', 'roblox.com']);

/**
 * True when `url` may be opened in the user's browser: https only, and only the Roblox site or the
 * project's own GitHub page. Anything the page asks to open is a way to send data out of the app (a
 * compromised page could put stolen file contents in the query string of any other site), so the list
 * holds exactly what the app links to.
 */
function isExternalUrl(url) {
  if (typeof url !== 'string' || url.length > 8192) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (EXTERNAL_HOSTS.includes(host)) return true;
  const home = new URL(PROJECT_HOMEPAGE);
  if (host !== home.hostname) return false;
  const p = u.pathname.toLowerCase().replace(/\/+$/, '');
  const h = home.pathname.toLowerCase();
  return p === h || p.startsWith(`${h}/`);
}

module.exports = {
  PROJECT_EXT,
  OPENABLE_RE,
  THEME,
  MIN_SIZE,
  DEFAULT_SIZE,
  overlayHeight,
  isSafeAbsPath,
  pathKey,
  fileUrlOf,
  fileUrlPath,
  fileUrlInside,
  fileUrlIs,
  devServerUrl,
  fileArgs,
  sanitizeFilters,
  ensureExtension,
  SAVE_EXTS,
  saveFilters,
  saveDefaultPath,
  toBuffer,
  toArrayBuffer,
  hasPgfxMagic,
  fileHasPgfxMagic,
  atomicWrite,
  atomicWriteSync,
  readJsonSync,
  FileGrants,
  createOpenQueue,
  createLoadState,
  parseWindowState,
  initialBounds,
  createLogger,
  PROJECT_HOMEPAGE,
  isExternalUrl,
};
