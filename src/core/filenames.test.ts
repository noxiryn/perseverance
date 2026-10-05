/**
 * Windows and macOS file systems are case-insensitive: two source files whose names differ only in
 * case or in .ts/.tsx (e.g. filterDialog.ts + FilterDialog.tsx) make imports resolve to the wrong
 * file there, breaking the installer build even though Linux builds pass.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('source file names', () => {
  it('have no case-insensitive clashes (incl. .ts vs .tsx with the same base name)', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const f of walk(join(process.cwd(), 'src'))) {
      const ext = extname(f);
      const key = (['.ts', '.tsx'].includes(ext) ? f.slice(0, -ext.length) : f).toLowerCase();
      const prev = seen.get(key);
      if (prev && prev !== f) clashes.push(`${prev} <-> ${f}`);
      else seen.set(key, f);
    }
    expect(clashes).toEqual([]);
  });
});
