/**
 * Electron main-process helpers (electron/lib.cjs): path policy, Save As extension fix, crash-safe
 * writes, window-state restore, and the native chrome colours staying in sync with the CSS.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
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

  it('opens only the allow-listed https pages externally (Roblox, the project page)', () => {
    const ok = (u: unknown) => lib.isExternalUrl(u);
    // What the app links to: the avatar dialog's profile button (src/roblox/avatar/fetch.ts profileUrl).
    expect(ok('https://www.roblox.com/users/profile?username=Builderman')).toBe(true);
    expect(ok('https://www.roblox.com/users/1/profile')).toBe(true);
    expect(ok('https://roblox.com/')).toBe(true);
    expect(ok('https://WWW.ROBLOX.COM/users/1/profile')).toBe(true);
    expect(ok('https://github.com/noxiryn/perseverance')).toBe(true);
    expect(ok('https://github.com/noxiryn/perseverance/')).toBe(true);
    expect(ok('https://github.com/noxiryn/perseverance/releases/latest')).toBe(true);
    expect(ok('https://github.com/Noxiryn/Perseverance/issues/1')).toBe(true);
    // Any other site is a way to send data out (stolen contents in the query string).
    expect(ok('https://attacker.example/?d=secret')).toBe(false);
    expect(ok('http://www.roblox.com/users/1/profile')).toBe(false); // https only
    expect(ok('https://www.roblox.com.attacker.example/')).toBe(false);
    expect(ok('https://attacker.example/www.roblox.com')).toBe(false);
    expect(ok('https://evil.roblox.com.example/')).toBe(false);
    expect(ok('https://user:pw@www.roblox.com/')).toBe(false);
    expect(ok('https://www.roblox.com:8443/')).toBe(false);
    expect(ok('https://github.com/attacker/repo?d=secret')).toBe(false);
    expect(ok('https://github.com/noxiryn/perseverance-evil')).toBe(false);
    expect(ok('https://gist.github.com/noxiryn/perseverance')).toBe(false);
    expect(ok('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('ms-msdt:/id')).toBe(false);
    expect(ok('smb://evil/share')).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok('not a url')).toBe(false);
  });

  it('the project page in the allowlist is package.json "homepage"', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    expect(lib.PROJECT_HOMEPAGE).toBe(pkg.homepage);
    expect(lib.isExternalUrl(pkg.homepage)).toBe(true);
  });
});

describe('Vite dev server URL (VITE_DEV_SERVER_URL)', () => {
  it('is ignored by a packaged app', () => {
    expect(lib.devServerUrl('http://localhost:5173', true)).toBe(null);
    expect(lib.devServerUrl('http://127.0.0.1:5399/', true)).toBe(null);
  });
  it('is honoured unpackaged only for a server on this machine', () => {
    expect(lib.devServerUrl('http://localhost:5173', false)).toBe('http://localhost:5173/');
    expect(lib.devServerUrl('http://127.0.0.1:5399/', false)).toBe('http://127.0.0.1:5399/');
    expect(lib.devServerUrl('http://[::1]:5173', false)).toBe('http://[::1]:5173/');
    expect(lib.devServerUrl('https://attacker.example/', false)).toBe(null);
    expect(lib.devServerUrl('http://192.168.1.20:5173', false)).toBe(null);
    expect(lib.devServerUrl('http://localhost.attacker.example:5173', false)).toBe(null);
    expect(lib.devServerUrl('http://user:pw@localhost:5173', false)).toBe(null);
    expect(lib.devServerUrl('file:///tmp/x.html', false)).toBe(null);
    expect(lib.devServerUrl('', false)).toBe(null);
    expect(lib.devServerUrl(undefined, false)).toBe(null);
    expect(lib.devServerUrl('not a url', false)).toBe(null);
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

  /*
   * Install folders with URL-special characters ('%', '#', '?', spaces, non-ASCII). The page URL comes from
   * lib.fileUrlOf (main.cjs loads it with loadURL): it and every relative request the page makes must
   * decode back to a path inside dist, and nothing outside dist may slip through. Windows profile names may
   * contain '%' (per-user installs and the portable exe's %TEMP% live under the profile folder).
   */
  const SPECIAL_NAMES = ['100%Real', 'Apps 50%off', 'Sale 25%ad', 'x%41y', 'Promo %20off', '100% x#y ?q', 'a#b', 'C++ & (Work) {1}', "O'Brien", 'Ünïcödé 用户 Пользователь', 'semi;colon=1'];
  const roots = {
    win32: (n: string) => [`C:\\Users\\${n}\\AppData\\Local\\Programs\\Perseverance\\resources\\app.asar`, `D:\\${n}\\Perseverance\\resources\\app.asar`],
    linux: (n: string) => [`/home/${n}/Applications/Perseverance/resources/app.asar`, `/tmp/${n}/inst/app`],
  } as const;
  for (const platform of ['win32', 'linux'] as const) {
    const P = platform === 'win32' ? win32 : posix;
    it(`loads the app from install folders with %, #, ?, spaces and unicode (${platform})`, () => {
      for (const n of SPECIAL_NAMES) {
        for (const root of roots[platform](n)) {
          const dist = P.join(root, 'dist');
          const index = P.join(dist, 'index.html');
          const page = lib.fileUrlOf(index, platform);
          const inside = (u: string) => lib.fileUrlInside(u, dist, platform);
          expect(page, page).not.toMatch(/%(?![0-9A-F]{2})/i); // every '%' escaped
          expect(lib.fileUrlPath(page, platform), n).toBe(index);
          expect(inside(page), page).toBe(true);
          expect(lib.fileUrlIs(page, index, platform), page).toBe(true); // isAppUrl → IPC trusted
          expect(lib.fileUrlIs(`${page}#hash`, index, platform)).toBe(true);
          // Lazy chunks / fonts / images the page requests relative to its own URL.
          expect(inside(new URL('./assets/index-abc.js', page).href)).toBe(true);
          expect(inside(new URL('assets/Font%20Name%20100%25.woff2', page).href)).toBe(true);
          expect(inside(new URL('./favicon.png?v=1#x', page).href)).toBe(true);
          // …and nothing outside the bundle.
          expect(inside(new URL('../../secret.txt', page).href)).toBe(false);
          expect(inside(new URL('../dist-other/a.js', page).href)).toBe(false);
          expect(inside(new URL('/etc/hostname', page).href)).toBe(false);
          expect(lib.fileUrlIs(new URL('./other.html', page).href, index, platform)).toBe(false);
        }
      }
    });
  }

  it('the old loadFile-style URL (raw %) never names the app page', () => {
    // Electron's loadFile left '%' unescaped: '%Re' is an invalid escape (refused) and '%ad' / '%41'
    // decode to a different folder. The page URL must therefore come from fileUrlOf, never be patched here.
    const raw = (p: string) => `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}`;
    const cases = ['C:\\Users\\100%Real\\app\\dist', 'D:\\Sale 25%ad\\app\\dist', 'C:\\x%41y\\app\\dist'];
    for (const dist of cases) expect(lib.fileUrlInside(raw(`${dist}\\index.html`), dist, 'win32'), dist).toBe(false);
    expect(lib.fileUrlPath('file:///tmp/100%Real/x', 'linux')).toBe(null);
    expect(lib.fileUrlPath('https://example.com/x', 'linux')).toBe(null);
    expect(lib.fileUrlPath(undefined, 'linux')).toBe(null);
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

describe('Save dialog options from the page (desktop:save-file)', () => {
  it('keeps only project / image / PSD types, and none at all means no save', () => {
    // Everything the app itself saves (src/io/save.ts, exportRender.ts, psd.ts).
    for (const f of [[{ name: 'Perseverance Project', extensions: ['pgfx'] }], [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }], [{ name: 'PNG Image', extensions: ['png'] }], [{ name: 'WebP Image', extensions: ['webp'] }], [{ name: 'Photoshop Document', extensions: ['psd'] }]])
      expect(lib.saveFilters(f)).toEqual(f);
    expect(lib.saveFilters([{ name: 'P', extensions: ['PGFX', 'bat', 'pgfx'] }, { name: 'Run', extensions: ['lnk', 'hta', 'exe', 'scr'] }])).toEqual([{ name: 'P', extensions: ['pgfx'] }]);
    for (const bad of [undefined, null, [], 'pgfx', [{ name: 'Startup', extensions: ['bat'] }], [{ name: 'All files', extensions: ['*'] }], [{ name: 'x', extensions: ['cmd', 'ps1', 'vbs', 'js'] }]])
      expect(lib.saveFilters(bad), JSON.stringify(bad)).toBeUndefined();
    // With an allow-listed filter, the written name always ends in one of its types.
    expect(lib.ensureExtension('C:\\Users\\Me\\Start Menu\\Programs\\Startup\\run.bat', lib.saveFilters([{ name: 'P', extensions: ['pgfx', 'bat'] }]), 'win32')).toBe(
      'C:\\Users\\Me\\Start Menu\\Programs\\Startup\\run.bat.pgfx',
    );
  });

  it('defaultPath: a file the user chose before (or a new name in its folder) is kept, anything else becomes a plain file name', () => {
    const g = new lib.FileGrants(null, { platform: 'win32' });
    g.grant('C:\\Art\\Poster.pgfx', { write: true });
    g.grant('\\\\nas\\share\\Team Poster.pgfx', { write: true });
    const dp = (p: unknown) => lib.saveDefaultPath(p, g, 'win32');
    // The app's own calls: the document's granted path, or `${safeFileName(name)}.ext`.
    expect(dp('c:/art/POSTER.pgfx')).toBe('C:\\Art\\Poster.pgfx');
    expect(dp('\\\\nas\\share\\Team Poster.pgfx')).toBe('\\\\nas\\share\\Team Poster.pgfx'); // granted share: the user chose it
    expect(dp('Poster.pgfx')).toBe('Poster.pgfx');
    expect(dp('My Thumbnail 1920x1080.png')).toBe('My Thumbnail 1920x1080.png');
    // A new document's Save As starts next to the last project (src/io/save defaultProjectSavePath): the
    // folder of a granted file is one the user chose, so it is kept (spelled as the grant spells it).
    expect(dp('C:\\Art\\Untitled.pgfx')).toBe('C:\\Art\\Untitled.pgfx');
    expect(dp('c:/ART/Untitled.pgfx')).toBe('C:\\Art\\Untitled.pgfx');
    expect(dp('C:\\Art\\..\\Art\\New:Name?.pgfx')).toBe('C:\\Art\\New_Name_.pgfx');
    expect(dp('\\\\nas\\share\\Team Banner.pgfx')).toBe('\\\\nas\\share\\Team Banner.pgfx');
    expect(dp('C:\\Art\\Sub\\Untitled.pgfx')).toBe('Untitled.pgfx'); // a sub-folder was never chosen
    expect(dp('C:\\Untitled.pgfx')).toBe('Untitled.pgfx');
    expect(g.folder('c:\\art\\')).toBe('C:\\Art');
    expect(g.folder('C:\\Art\\Sub')).toBe(null);
    expect(g.folder('Art')).toBe(null);
    // Page-chosen folders never reach the dialog (UNC probe / NTLM leak, pre-filled startup folder).
    expect(dp('\\\\attacker\\share\\Poster.pgfx')).toBe('Poster.pgfx');
    expect(dp('//attacker/share/Poster.pgfx')).toBe('Poster.pgfx');
    expect(dp('\\\\?\\UNC\\attacker\\share\\x.pgfx')).toBe('x.pgfx');
    expect(dp('C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Poster.bat')).toBe('Poster.bat');
    expect(dp('C:\\Art\\..\\Windows\\Poster.pgfx')).toBe('Poster.pgfx');
    expect(dp('C:Poster.pgfx')).toBe('Poster.pgfx'); // drive-relative
    expect(dp('..\\..\\Poster.pgfx')).toBe('Poster.pgfx');
    expect(dp('Poster.pgfx:evil.exe')).toBe('Poster.pgfx_evil.exe'); // no NTFS alternate stream
    expect(dp('a\u0000b<>|?*".pgfx')).toBe('a_b_.pgfx');
    expect(dp('\\\\attacker\\share\\')).toBe(undefined);
    expect(dp('...')).toBe(undefined);
    expect(dp('')).toBe(undefined);
    expect(dp(42)).toBe(undefined);
    expect(dp('x'.repeat(40000))).toBe(undefined);
    expect(dp(`${'y'.repeat(400)}.pgfx`)?.length).toBe(255);
    // POSIX: same rules.
    const gp = new lib.FileGrants(null, { platform: 'linux' });
    gp.grant('/home/me/Art/Poster.pgfx');
    expect(lib.saveDefaultPath('/home/me/Art/Poster.pgfx', gp, 'linux')).toBe('/home/me/Art/Poster.pgfx');
    expect(lib.saveDefaultPath('/home/me/.config/autostart/evil.desktop', gp, 'linux')).toBe('evil.desktop');
    expect(lib.saveDefaultPath('/home/me/Art/Other.pgfx', gp, 'linux')).toBe('/home/me/Art/Other.pgfx');
    expect(lib.saveDefaultPath('/home/me/art/Other.pgfx', gp, 'linux')).toBe('Other.pgfx'); // case-sensitive file system
    expect(lib.saveDefaultPath('/home/me/Art/../.config/autostart/Other.pgfx', gp, 'linux')).toBe('Other.pgfx');
    expect(lib.saveDefaultPath('Poster.pgfx', null, 'linux')).toBe('Poster.pgfx');
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

describe('editor page load state (lib.createLoadState)', () => {
  const ERR_FILE_NOT_FOUND = -6;
  const ERR_ABORTED = -3;

  it('a load that succeeds is the editor; subframe failures and superseded loads are no page failures', () => {
    const s = lib.createLoadState();
    s.start();
    expect(s.fail(ERR_FILE_NOT_FOUND, false)).toBe(null); // an iframe
    expect(s.fail(ERR_ABORTED, true)).toBe(null); // a newer navigation / reload took over
    expect(s.failed).toBe(false);
    expect(s.finish()).toBe(true);
  });

  it("a failed load is reported, and Chromium's error page that follows is not the editor until the next load", () => {
    const s = lib.createLoadState();
    s.start();
    expect(s.fail(ERR_FILE_NOT_FOUND, true)).toBe('report');
    expect(s.failed).toBe(true);
    expect(s.finish()).toBe(false); // 'did-finish-load' of the error page
    expect(s.failed).toBe(true); // still showing it
    s.start(); // "Try Again"
    expect(s.failed).toBe(false);
    expect(s.finish()).toBe(true);
  });

  it("a dead or dying renderer's load is the crash flow's, but the reload in the new renderer is reported again", () => {
    const s = lib.createLoadState();
    s.start();
    expect(s.finish()).toBe(true);
    s.abandon(); // crashed (or about to be killed because it hung)
    expect(s.fail(-2, true)).toBe('abandoned');
    s.start(); // the crash prompt's / hung-renderer Reload: a new renderer
    expect(s.fail(ERR_FILE_NOT_FOUND, true)).toBe('report'); // the bundle vanished while the app ran
    expect(s.finish()).toBe(false);
  });

  it('wired like main.cjs: a file handed over while the editor is down survives a failed reload and opens after Try Again', async () => {
    // Events from the bug report: crash → Reload with the bundle gone → did-fail-load → did-finish-load (error page).
    const s = lib.createLoadState();
    let ready = false;
    const delivered: string[] = [];
    const queue = lib.createOpenQueue({ ready: () => ready, deliver: async (p: string) => void delivered.push(p) });
    const reported: number[] = [];
    const ev = {
      start: () => {
        s.start();
        ready = false;
      },
      finish: async () => {
        if (!s.finish()) return;
        ready = true;
        await queue.flush();
      },
      gone: () => {
        ready = false;
        s.abandon();
      },
      fail: (code: number) => {
        if (s.fail(code, true) === 'report') reported.push(code);
      },
    };
    ev.start();
    await ev.finish();
    ev.gone();
    queue.open('C:\\Art\\Poster.pgfx'); // Explorer double-click while the crash prompt is up
    ev.start();
    ev.fail(ERR_FILE_NOT_FOUND);
    await ev.finish(); // the error page: must not swallow the file
    expect(reported).toEqual([ERR_FILE_NOT_FOUND]);
    expect(delivered).toEqual([]);
    expect(queue.pending).toEqual(['C:\\Art\\Poster.pgfx']);
    ev.start(); // Try Again, bundle back
    await ev.finish();
    expect(delivered).toEqual(['C:\\Art\\Poster.pgfx']);
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
    // No workers of any kind. Requests from Dedicated/Shared Workers never reach the main process'
    // file:// filter, and on a file:// page 'self' matches every local file: a blob: worker could read
    // any file on disk. The app uses none (the WebAssembly blur runs on the page's own thread).
    expect(directives.get('worker-src')).toEqual(["'none'"]);
    // child-src is the fallback for frames AND workers when worker-src is missing: never loosen it either.
    expect(directives.get('child-src') ?? ["'none'"]).toEqual(["'none'"]);
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

describe('main process wiring (electron/main.cjs)', () => {
  const main = readFileSync(join(here, '..', '..', 'electron', 'main.cjs'), 'utf8');
  it('loads the page from an escaped file:// URL, never loadFile ("%" in the install folder)', () => {
    expect(main).not.toMatch(/\.loadFile\(/);
    expect(main).toMatch(/INDEX_URL = lib\.fileUrlOf\(INDEX_HTML\)/);
    expect(main).toMatch(/loadURL\(isDev \? DEV_URL : INDEX_URL\)/);
  });
  it('honours VITE_DEV_SERVER_URL only through lib.devServerUrl (never when packaged)', () => {
    expect(main).toMatch(/lib\.devServerUrl\(process\.env\.VITE_DEV_SERVER_URL, app\.isPackaged\)/);
    expect(main.match(/process\.env\.VITE_DEV_SERVER_URL/g)?.length).toBe(2); // the guarded read + the "ignored" log line
  });
  it('never hands a renderer navigation to the browser', () => {
    const nav = main.slice(main.indexOf("contents.on('will-navigate'"), main.indexOf("contents.on('will-redirect'"));
    expect(nav).toContain('e.preventDefault()');
    expect(nav).not.toMatch(/openExternal/);
  });
  /** The body of `wc.on('<event>', …)` up to the next handler. */
  const handler = (event: string) => {
    const at = main.indexOf(`wc.on('${event}'`);
    expect(at).toBeGreaterThan(0);
    const next = main.slice(at + 1).search(/\n {2}(wc|w)\.on\(/);
    return main.slice(at, next < 0 ? undefined : at + 1 + next);
  };
  it("treats Chromium's error page as no editor: files stay queued, the reload watch keeps running", () => {
    const finish = handler('did-finish-load');
    expect(finish).toMatch(/if \(!pageLoad\.finish\(\)\) return;/);
    expect(finish.indexOf('pageLoad.finish()')).toBeLessThan(finish.indexOf('openQueue.flush()'));
    expect(finish.indexOf('pageLoad.finish()')).toBeLessThan(finish.indexOf('clearReloadWatch()'));
    expect(handler('did-start-loading')).toContain('pageLoad.start()');
  });
  it('reports a failed load also on the reload after a crash or a hang (no silent blank window)', () => {
    const fail = handler('did-fail-load');
    expect(fail).toContain('pageLoad.fail(code, isMainFrame)');
    expect(fail).not.toMatch(/rendererGone|expectedKill/); // the old guards that swallowed the reload's failure
    expect(fail.indexOf('clearReloadWatch()')).toBeLessThan(fail.indexOf('onLoadFailed('));
    const gone = main.slice(main.indexOf('async function onRenderGone'), main.indexOf('async function crashPrompt'));
    expect(gone).toContain('pageLoad.abandon()');
    const hung = main.slice(main.indexOf('function reloadHungRenderer'), main.indexOf('async function onLoadFailed'));
    expect(hung.indexOf('pageLoad.abandon()')).toBeLessThan(hung.indexOf('forcefullyCrashRenderer()'));
  });
  it('a renderer that recovers only takes back the "not responding" prompt', () => {
    const responsive = main.slice(main.indexOf("w.on('responsive'"), main.indexOf("wc.on('preload-error'"));
    expect(responsive).toMatch(/if \(promptKind === 'unresponsive'\) dismissPrompt\(\);/);
  });
});

describe('packaging (package.json "build")', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
  it('publishes nothing itself (no updater): builds without a detectable GitHub remote exit 0', () => {
    // Without this, electron-builder picks the github provider whenever GH_TOKEN/GITHUB_TOKEN is set, finds no
    // repo (source zip, git worktree) and crashes after writing the installers (exit 1). CI uploads the
    // installers with softprops/action-gh-release and passes --publish never.
    expect('publish' in pkg.build).toBe(true);
    expect(pkg.build.publish).toBe(null);
    expect(pkg.repository?.url).toMatch(/github\.com\/noxiryn\/perseverance/);
  });
});
