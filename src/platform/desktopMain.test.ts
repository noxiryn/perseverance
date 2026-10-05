/**
 * Electron main-process helpers (electron/lib.cjs): path policy, Save As extension fix, crash-safe
 * writes, window-state restore, and the native chrome colours staying in sync with the CSS.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const lib: any = require('../../electron/lib.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'pgfx-desktop-'));

/** CSP directives → their source tokens (directive names and keywords lower-cased). */
function cspDirectives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name) out.set(name.toLowerCase(), sources.map((s) => (s.startsWith("'") ? s.toLowerCase() : s)));
  }
  return out;
}

/** Whether any directive lists the plain 'unsafe-eval' keyword (as a whole token; 'wasm-unsafe-eval' is a different keyword). */
function allowsPlainEval(csp: string): boolean {
  for (const sources of cspDirectives(csp).values()) if (sources.includes("'unsafe-eval'")) return true;
  return false;
}

describe('path policy', () => {
  it('accepts only absolute, NUL-free paths and rejects Win32 device namespaces', () => {
    expect(lib.isSafeAbsPath('/home/a/b.pgfx', 'linux')).toBe(true);
    expect(lib.isSafeAbsPath('relative/b.pgfx', 'linux')).toBe(false);
    expect(lib.isSafeAbsPath('/a/b\0.pgfx', 'linux')).toBe(false);
    expect(lib.isSafeAbsPath(42, 'linux')).toBe(false);
    expect(lib.isSafeAbsPath('', 'linux')).toBe(false);
    expect(lib.isSafeAbsPath('C:\\Users\\Me\\Poster.pgfx', 'win32')).toBe(true);
    expect(lib.isSafeAbsPath('C:/Users/Me/Poster.pgfx', 'win32')).toBe(true);
    expect(lib.isSafeAbsPath('\\\\server\\share\\Poster.pgfx', 'win32')).toBe(true);
    expect(lib.isSafeAbsPath('\\\\.\\PhysicalDrive0', 'win32')).toBe(false);
    expect(lib.isSafeAbsPath('\\\\?\\GLOBALROOT\\Device\\x', 'win32')).toBe(false);
    expect(lib.isSafeAbsPath('\\Users\\Me\\x.pgfx', 'win32')).toBe(false); // drive-relative
    expect(lib.isSafeAbsPath('C:Poster.pgfx', 'win32')).toBe(false);
  });

  it('compares Windows paths case- and slash-insensitively', () => {
    expect(lib.pathKey('C:\\Users\\Me\\Poster.PGFX', 'win32')).toBe(lib.pathKey('c:/users/me/poster.pgfx', 'win32'));
    expect(lib.pathKey('C:\\a\\..\\b\\x.pgfx', 'win32')).toBe(lib.pathKey('C:\\b\\x.pgfx', 'win32'));
    expect(lib.pathKey('/A/b.pgfx', 'linux')).not.toBe(lib.pathKey('/a/b.pgfx', 'linux'));
  });

  it('resolves command-line files against the launching working directory', () => {
    const argv = ['C:\\Program Files\\Perseverance\\Perseverance.exe', '--flag', 'art\\Poster.pgfx', 'D:\\x\\cover.PNG', 'notes.txt'];
    expect(lib.fileArgs(argv, { skip: 1, cwd: 'C:\\Users\\Me', platform: 'win32' })).toEqual([
      'C:\\Users\\Me\\art\\Poster.pgfx',
      'D:\\x\\cover.PNG',
    ]);
    // `electron .` (process.defaultApp) puts the app path at argv[1].
    expect(lib.fileArgs(['/usr/bin/electron', '/app', 'a.pgfx'], { skip: 2, cwd: '/home/me', platform: 'linux' })).toEqual(['/home/me/a.pgfx']);
    expect(lib.fileArgs(null)).toEqual([]);
  });

  it('only opens http(s) URLs externally', () => {
    expect(lib.isExternalUrl('https://www.roblox.com/users/1/profile')).toBe(true);
    expect(lib.isExternalUrl('http://example.com')).toBe(true);
    expect(lib.isExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(lib.isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(lib.isExternalUrl('ms-msdt:/id')).toBe(false);
    expect(lib.isExternalUrl('smb://evil/share')).toBe(false);
    expect(lib.isExternalUrl(undefined)).toBe(false);
  });
});

describe('file:// requests from the page', () => {
  it('allows only the app bundle folder (POSIX)', () => {
    const dist = '/opt/Perseverance/resources/app.asar/dist';
    const ok = (u: string) => lib.fileUrlInside(u, dist, 'linux');
    expect(ok('file:///opt/Perseverance/resources/app.asar/dist/index.html')).toBe(true);
    expect(ok('file:///opt/Perseverance/resources/app.asar/dist/assets/index-abc.js?v=1#x')).toBe(true);
    expect(ok('file:///opt/Perseverance/resources/app.asar/dist')).toBe(true);
    expect(ok('file:///etc/hostname')).toBe(false);
    expect(ok('file:///opt/Perseverance/resources/app.asar/dist/../../secret.txt')).toBe(false);
    expect(ok('file:///opt/Perseverance/resources/app.asar/dist/%2e%2e/x')).toBe(false);
    expect(ok('file:///opt/Perseverance/resources/app.asar/dist%2f..%2fx')).toBe(false); // encoded slash
    expect(ok('file:///opt/Perseverance/resources/app.asar/distX/a.js')).toBe(false); // sibling prefix
    expect(ok('file://evil.example/opt/Perseverance/resources/app.asar/dist/index.html')).toBe(false);
    expect(ok('https://example.com/opt/Perseverance/resources/app.asar/dist/index.html')).toBe(false);
    expect(ok('not a url')).toBe(false);
  });

  it('allows only the app bundle folder (Windows: any case/slash, no UNC hosts)', () => {
    const dist = 'C:\\Program Files\\Perseverance\\resources\\app.asar\\dist';
    const ok = (u: string) => lib.fileUrlInside(u, dist, 'win32');
    expect(ok('file:///C:/Program%20Files/Perseverance/resources/app.asar/dist/index.html')).toBe(true);
    expect(ok('file:///c:/program%20files/PERSEVERANCE/resources/app.asar/dist/assets/a.woff2')).toBe(true);
    expect(ok('file:///C:/Users/me/Documents/secret.txt')).toBe(false);
    expect(ok('file://attacker/share/x.pgfx')).toBe(false);
    expect(ok('file:///C:/Program%20Files/Perseverance/resources/app.asar/dist%5c..%5cx')).toBe(false);
  });
});

describe('Save in place failures that fall back to Save As (src/io/save)', () => {
  it('classifies read-only, missing-folder and full-disk errors', async () => {
    const { saveInPlaceProblem } = await import('../io/save');
    const ipc = (code: string) => new Error(`Error invoking remote method 'desktop:write-file': Error: ${code}: x, open '/a/.b.tmp'`);
    expect(saveInPlaceProblem(ipc('EACCES'))).toBe('read-only');
    expect(saveInPlaceProblem(ipc('EBUSY'))).toBe('read-only');
    expect(saveInPlaceProblem(ipc('ENOENT'))).toBe('missing');
    expect(saveInPlaceProblem(ipc('ENOTDIR'))).toBe('missing');
    expect(saveInPlaceProblem(ipc('ENOSPC'))).toBe('full');
    expect(saveInPlaceProblem(ipc('ENOTGRANTED'))).toBe(null);
    expect(saveInPlaceProblem(new Error('encoder failed'))).toBe(null);
  });
});

describe('file access grants', () => {
  it('reads only granted paths, writes only write-granted ones, persists across launches', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'file-access.json');
      const g = new lib.FileGrants(file, { platform: 'win32' });
      g.grant('C:\\Art\\Poster.pgfx', { write: true });
      g.grant('C:\\Art\\cover.png');
      expect(g.canRead('c:/art/poster.pgfx')).toBe(true);
      expect(g.canWrite('C:\\ART\\POSTER.PGFX')).toBe(true);
      expect(g.canRead('C:\\Art\\cover.png')).toBe(true);
      expect(g.canWrite('C:\\Art\\cover.png')).toBe(false);
      expect(g.canRead('C:\\Windows\\win.ini')).toBe(false);
      expect(g.canWrite('C:\\Windows\\win.ini')).toBe(false);
      expect(g.grant('relative.pgfx')).toBe(false);
      // a later read-only grant never downgrades a write grant
      g.grant('C:\\Art\\Poster.pgfx');
      expect(g.canWrite('C:\\Art\\Poster.pgfx')).toBe(true);
      const again = new lib.FileGrants(file, { platform: 'win32' });
      expect(again.canWrite('C:\\Art\\Poster.pgfx')).toBe(true);
      expect(again.canRead('C:\\Art\\cover.png')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the most recent grants', () => {
    const g = new lib.FileGrants(null, { platform: 'linux', max: 3 });
    for (const n of ['a', 'b', 'c', 'd']) g.grant(`/p/${n}.pgfx`);
    g.grant('/p/b.pgfx'); // refresh
    g.grant('/p/e.pgfx');
    expect(['a', 'b', 'c', 'd', 'e'].filter((n) => g.canRead(`/p/${n}.pgfx`))).toEqual(['b', 'd', 'e']);
  });

  it('survives a corrupt grants file', () => {
    const dir = tmp();
    try {
      const file = join(dir, 'file-access.json');
      writeFileSync(file, '{not json');
      const g = new lib.FileGrants(file, { platform: 'linux' });
      expect(g.canRead('/x.pgfx')).toBe(false);
      g.grant('/x.pgfx', { write: true });
      expect(JSON.parse(readFileSync(file, 'utf8')).files[0].path).toBe('/x.pgfx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Save As extension', () => {
  const PROJECT = [{ name: 'Perseverance Project', extensions: ['pgfx'] }];
  it('appends the filter extension when it is missing or wrong', () => {
    expect(lib.ensureExtension('/home/me/Poster', PROJECT, 'linux')).toBe('/home/me/Poster.pgfx');
    expect(lib.ensureExtension('C:\\Art\\Poster', PROJECT, 'win32')).toBe('C:\\Art\\Poster.pgfx');
    expect(lib.ensureExtension('C:\\Art\\Poster.', PROJECT, 'win32')).toBe('C:\\Art\\Poster.pgfx');
    expect(lib.ensureExtension('C:\\My.Folder\\Poster', PROJECT, 'win32')).toBe('C:\\My.Folder\\Poster.pgfx');
    expect(lib.ensureExtension('/home/me/Poster v1.2', PROJECT, 'linux')).toBe('/home/me/Poster v1.2.pgfx');
    expect(lib.ensureExtension('/home/me/Poster.png', PROJECT, 'linux')).toBe('/home/me/Poster.png.pgfx');
  });
  it('keeps names that already match (any case) and wildcard filters', () => {
    expect(lib.ensureExtension('C:\\Art\\Poster.PGFX', PROJECT, 'win32')).toBe('C:\\Art\\Poster.PGFX');
    const jpg = [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }];
    expect(lib.ensureExtension('/x/thumb.jpeg', jpg, 'linux')).toBe('/x/thumb.jpeg');
    expect(lib.ensureExtension('/x/thumb', jpg, 'linux')).toBe('/x/thumb.jpg');
    expect(lib.ensureExtension('/x/thumb', [{ name: 'All', extensions: ['*'] }], 'linux')).toBe('/x/thumb');
    expect(lib.ensureExtension('/x/thumb', undefined, 'linux')).toBe('/x/thumb');
  });
  it('sanitizes renderer-supplied filters', () => {
    expect(lib.sanitizeFilters([{ name: 'X', extensions: ['png', '../../evil', 3, '*'] }, null, { name: 'Y' }])).toEqual([
      { name: 'X', extensions: ['png', '*'] },
    ]);
    expect(lib.sanitizeFilters('pgfx')).toBeUndefined();
  });
});

describe('IPC payloads', () => {
  it('accepts ArrayBuffer / views / strings without copying buffers', () => {
    const ab = new ArrayBuffer(8);
    const b = lib.toBuffer(ab);
    expect(b.buffer).toBe(ab);
    const u8 = new Uint8Array(ab, 2, 4);
    expect(lib.toBuffer(u8).byteLength).toBe(4);
    expect(lib.toBuffer('héllo').toString('utf8')).toBe('héllo');
    expect(() => lib.toBuffer({ length: 3 })).toThrow(TypeError);
    expect(() => lib.toBuffer(null)).toThrow(TypeError);
    expect(() => lib.toBuffer(42)).toThrow(TypeError);
  });
  it('recognises project files by magic', () => {
    expect(lib.hasPgfxMagic(Buffer.from('PGFX\x01rest'))).toBe(true);
    expect(lib.hasPgfxMagic(Buffer.from('\x89PNG'))).toBe(false);
    expect(lib.hasPgfxMagic(Buffer.from('PG'))).toBe(false);
  });
});

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    const dir = tmp();
    try {
      const f = join(dir, 'Poster.pgfx');
      writeFileSync(f, 'old');
      await lib.atomicWrite(f, Buffer.from('new contents'));
      expect(readFileSync(f, 'utf8')).toBe('new contents');
      expect(readdirSync(dir)).toEqual(['Poster.pgfx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes through symlinks to the real file', async () => {
    const dir = tmp();
    try {
      const real = join(dir, 'real.pgfx');
      const link = join(dir, 'link.pgfx');
      writeFileSync(real, 'old');
      symlinkSync(real, link);
      await lib.atomicWrite(link, Buffer.from('via link'));
      expect(readFileSync(real, 'utf8')).toBe('via link');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the old file when the write fails', async () => {
    const dir = tmp();
    try {
      const f = join(dir, 'Poster.pgfx');
      writeFileSync(f, 'old');
      const failing = {
        realpath: async (p: string) => p,
        writeFile: async () => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
        unlink: async () => {},
        rename: async () => {},
        copyFile: async () => {},
      };
      await expect(lib.atomicWrite(f, Buffer.from('new'), { fs: failing })).rejects.toThrow('disk full');
      expect(readFileSync(f, 'utf8')).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to copying when the rename keeps failing (file locked on Windows)', async () => {
    const dir = tmp();
    try {
      const f = join(dir, 'Poster.pgfx');
      writeFileSync(f, 'old');
      const fsp = await import('node:fs/promises');
      let renames = 0;
      const locked = {
        realpath: fsp.realpath,
        writeFile: fsp.writeFile,
        unlink: fsp.unlink,
        copyFile: fsp.copyFile,
        rename: async () => {
          renames++;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
      };
      await lib.atomicWrite(f, Buffer.from('copied'), { fs: locked });
      expect(renames).toBeGreaterThan(1);
      expect(readFileSync(f, 'utf8')).toBe('copied');
      expect(readdirSync(dir)).toEqual(['Poster.pgfx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the permissions of the file it replaces', async () => {
    if (process.platform === 'win32') return;
    const dir = tmp();
    try {
      const f = join(dir, 'Poster.pgfx');
      writeFileSync(f, 'old');
      chmodSync(f, 0o640);
      await lib.atomicWrite(f, Buffer.from('new'));
      expect(statSync(f).mode & 0o777).toBe(0o640);
      expect(readFileSync(f, 'utf8')).toBe('new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to replace a read-only file (a rename would silently ignore the lock)', async () => {
    const dir = tmp();
    try {
      const f = join(dir, 'Locked.pgfx');
      writeFileSync(f, 'old');
      const fsp = await import('node:fs/promises');
      let wrote = false;
      const readOnly = {
        realpath: fsp.realpath,
        stat: fsp.stat,
        access: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
        writeFile: async () => void (wrote = true),
        unlink: fsp.unlink,
        rename: fsp.rename,
        copyFile: fsp.copyFile,
      };
      const err = await lib.atomicWrite(f, Buffer.from('new'), { fs: readOnly }).catch((e: Error & { code?: string }) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('EACCES');
      expect(err.message).toMatch(/^EACCES: .*Locked\.pgfx.*read-only/);
      expect(wrote).toBe(false);
      expect(readFileSync(f, 'utf8')).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderer path comparison (src/platform samePath)', () => {
  it('matches Windows paths case- and slash-insensitively, POSIX paths exactly', () => {
    expect(samePath('C:\\Art\\Poster.pgfx', 'c:/art/POSTER.pgfx')).toBe(true);
    expect(samePath('\\\\nas\\share\\a.pgfx', '\\\\NAS\\share\\A.PGFX')).toBe(true);
    expect(samePath('C:\\Art\\Poster.pgfx', 'C:\\Art\\Poster2.pgfx')).toBe(false);
    expect(samePath('/home/me/a.pgfx', '/home/me/a.pgfx')).toBe(true);
    expect(samePath('/home/me/a.pgfx', '/home/me/A.pgfx')).toBe(false); // jsdom: not macOS
    expect(samePath(null, '/a.pgfx')).toBe(false);
    expect(samePath('', '')).toBe(false);
  });
});

describe('files opened from the OS', () => {
  it('keeps files until the page is ready and flushes without spinning while it is still loading', async () => {
    let ready = false;
    const delivered: string[] = [];
    const q = lib.createOpenQueue({ ready: () => ready, deliver: async (p: string) => void delivered.push(p) });
    expect(q.open('C:\\Art\\Poster.pgfx')).toBe(false);
    q.open('C:\\Art\\Poster.pgfx'); // duplicate (Explorer + argv) is kept once
    q.open('/Users/me/icon.png');
    // A flush while the page still can't take files (e.g. 'did-finish-load' with isLoading() true) must
    // finish and keep them — the old loop re-queued and retried forever, starving the main process.
    await q.flush();
    expect(q.pending).toEqual(['C:\\Art\\Poster.pgfx', '/Users/me/icon.png']);
    expect(delivered).toEqual([]);
    ready = true;
    await q.flush();
    expect(delivered).toEqual(['C:\\Art\\Poster.pgfx', '/Users/me/icon.png']);
    expect(q.pending).toEqual([]);
    expect(q.open('/second.pgfx')).toBe(true);
    await Promise.resolve();
    expect(delivered.at(-1)).toBe('/second.pgfx');
  });

  it('a failing delivery does not stop the others', async () => {
    let ready = false;
    const delivered: string[] = [];
    const q = lib.createOpenQueue({
      ready: () => ready,
      deliver: async (p: string) => {
        if (p === '/bad.pgfx') throw new Error('gone');
        delivered.push(p);
      },
    });
    q.open('/bad.pgfx');
    q.open('/good.pgfx');
    ready = true;
    await q.flush();
    expect(delivered).toEqual(['/good.pgfx']);
    expect(q.pending).toEqual([]);
  });
});

describe('window state', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };

  it('restores saved bounds on a connected display', () => {
    const b = lib.initialBounds({ x: 2000, y: 100, width: 1400, height: 900, maximized: false }, [primary, second]);
    expect(b).toMatchObject({ x: 2000, y: 100, width: 1400, height: 900, maximized: false, restored: true });
    expect(lib.initialBounds({ x: 10, y: 10, width: 1300, height: 800, maximized: true }, [primary]).maximized).toBe(true);
  });

  it('re-centres a window whose monitor is gone or whose title bar is off-screen', () => {
    const gone = lib.initialBounds({ x: 2000, y: 100, width: 1400, height: 900, maximized: false }, [primary]);
    expect(gone.restored).toBe(false);
    expect(gone).toMatchObject({ width: 1400, height: 900, x: 260, y: 70 });
    const above = lib.initialBounds({ x: 100, y: -500, width: 1400, height: 900 }, [primary]);
    expect(above.restored).toBe(false);
  });

  it('clamps sizes to the display and ignores garbage', () => {
    const small = { x: 0, y: 0, width: 1280, height: 680 };
    const b = lib.initialBounds({ x: 0, y: 0, width: 3000, height: 2000 }, [small]);
    expect(b.width).toBe(1280);
    expect(b.height).toBe(680);
    expect(lib.initialBounds('nope', [primary])).toMatchObject({ width: 1600, height: 960, maximized: null, restored: false });
    expect(lib.initialBounds({ width: NaN, height: 5 }, [primary]).maximized).toBe(null);
    expect(lib.initialBounds(null, [])).toMatchObject({ width: 1600, height: 960 });
  });
});

describe('native chrome matches the CSS', () => {
  const css = (p: string) => readFileSync(join(here, '..', p), 'utf8');
  const cssVar = (text: string, name: string) => text.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

  it('titleBarOverlay colour/height and window background equal the theme', () => {
    const theme = css('styles/theme.css');
    const shell = css('ui/shell/shell.css');
    expect(cssVar(shell, '--shell-titlebar')?.toLowerCase()).toBe(lib.THEME.titleBar);
    expect(cssVar(theme, '--bg-app')?.toLowerCase()).toBe(lib.THEME.background);
    expect(cssVar(theme, '--titlebar-h')).toBe(`${lib.THEME.titleBarHeight}px`);
    expect(lib.overlayHeight(1)).toBe(31);
    expect(lib.overlayHeight(1.5)).toBe(47);
    expect(lib.overlayHeight(99)).toBe(63);
    expect(lib.overlayHeight(NaN)).toBe(31);
  });

  it('the CSP in index.html blocks plugins, frames and base/form hijacks', () => {
    const html = readFileSync(join(here, '..', '..', 'index.html'), 'utf8');
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
    for (const d of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(d);
    // Scripts: only the app's own files, plus 'wasm-unsafe-eval' so the WebAssembly blur kernels
    // (src/core/wasm, bytes inlined in the bundle) can be compiled. That keyword allows WebAssembly
    // compilation only — never eval()/new Function(), which plain 'unsafe-eval' would allow, so that
    // token (or 'unsafe-inline') must not appear in any directive. Keywords are compared as whole
    // tokens, case-insensitively ('wasm-unsafe-eval' contains the text "unsafe-eval").
    const directives = cspDirectives(csp);
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(allowsPlainEval(csp)).toBe(false);
    expect(allowsPlainEval("default-src 'self'; script-src 'self' 'unsafe-eval'")).toBe(true);
    expect(allowsPlainEval("default-src 'self' 'UNSAFE-EVAL'")).toBe(true);
    expect(allowsPlainEval("script-src 'self' 'wasm-unsafe-eval'")).toBe(false);
    for (const [name, sources] of directives) if (name !== 'style-src') expect(sources, name).not.toContain("'unsafe-inline'");
    // Network access only to the Roblox APIs/CDN the avatar fetch uses (no "any https host" exfiltration
    // channel, no dev-server leftovers in the production policy).
    expect(csp).not.toMatch(/\shttps:[\s;]/);
    expect(csp).not.toContain('ws://');
    expect(csp).toMatch(/connect-src [^;]*https:\/\/\*\.roblox\.com/);
    expect(existsSync(join(here, '..', '..', 'electron', 'main.cjs'))).toBe(true);
  });
});
