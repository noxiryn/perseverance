// Release packaging guards (package.json "build", build/installer.nsh, the release workflow).
// These settings are only exercised by tagged CI runs and real installs, so pin them here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('macOS builds keep a valid ad-hoc signature', () => {
  it('re-signs the .app ad hoc right after the fuses are flipped (no signing identity in CI)', () => {
    // Flipping the fuses rewrites a page of "Electron Framework"; unsigned (CSC_IDENTITY_AUTO_DISCOVERY
    // false), nothing re-signs it and Apple Silicon kills the app at launch (invalid code page).
    const pkg = JSON.parse(read('package.json'));
    const fuses = pkg.build.electronFuses;
    expect(fuses.resetAdHocDarwinSignature).toBe(true);
    // The hardening fuses stay as they were.
    expect(fuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
    });
  });

  it('the release workflow fails the macOS job on a broken signature', () => {
    const wf = read('.github/workflows/release.yml');
    const pkgStep = wf.indexOf('npx electron-builder --mac');
    const verify = wf.indexOf('codesign --verify --deep --strict');
    expect(pkgStep).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(pkgStep);
    expect(wf).toMatch(/release\/mac\*\/Perseverance\.app/);
  });
});

describe('Windows installer leaves no updater copy behind', () => {
  it('build/installer.nsh drops %LOCALAPPDATA%\\<name>-updater on install and uninstall', () => {
    const pkg = JSON.parse(read('package.json'));
    // No updater: the stock template's Setup-exe copy is pure waste.
    expect(pkg.build.publish).toBe(null);
    // electron-builder includes buildResources/installer.nsh by default.
    expect(pkg.build.directories.buildResources).toBe('build');
    expect(pkg.build.nsis.include).toBeUndefined();
    const nsh = read('build/installer.nsh');
    const dir = `$LOCALAPPDATA\\${pkg.name}-updater`;
    const macro = (name: string) => {
      const m = nsh.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`));
      expect(m, name).not.toBeNull();
      return m![1];
    };
    const install = macro('customInstall');
    expect(install).toContain(`Delete "${dir}\\installer.exe"`);
    expect(install).toContain(`RMDir "${dir}"`);
    const uninstall = macro('customUnInstall');
    expect(uninstall).toContain(`RMDir /r "${dir}"`);
    // The copy is per-user even in all-users mode.
    for (const body of [install, uninstall]) {
      expect(body).toMatch(/\$installMode == "all"[\s\S]*SetShellVarContext current[\s\S]*SetShellVarContext all/);
    }
  });
});
