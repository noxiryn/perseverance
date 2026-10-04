/**
 * System fonts via the Local Font Access API (`window.queryLocalFonts`). On desktop the main
 * process grants the 'local-fonts' permission. Loaded lazily — the first time the font picker or
 * the Fonts panel opens — never at startup.
 */
import { create } from 'zustand';
import { fonts, type FontDef } from '../registry';
import { isDesktop } from '../platform';
import { weightFromStyleName } from './sfnt';

export type SystemFontStatus = 'idle' | 'loading' | 'loaded' | 'denied' | 'unsupported' | 'error';

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

type QueryLocalFonts = (opts?: { postscriptNames?: string[] }) => Promise<LocalFontData[]>;

export const useSystemFonts = create<{ status: SystemFontStatus; count: number }>()(() => ({
  status: systemFontsSupported() ? 'idle' : 'unsupported',
  count: 0,
}));

export function systemFontsSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function';
}

/** Group local font records into one FontDef per family (pure). */
export function groupLocalFonts(list: LocalFontData[], skip: (family: string) => boolean): FontDef[] {
  const byFamily = new Map<string, { weights: Set<number>; italic: boolean }>();
  for (const f of list) {
    const family = (f.family || '').trim();
    // Hidden platform UI families (".SF NS", ".AppleSystemUIFont"…) are not usable by name.
    if (!family || family.startsWith('.') || skip(family)) continue;
    const style = f.style || 'Regular';
    let entry = byFamily.get(family);
    if (!entry) byFamily.set(family, (entry = { weights: new Set(), italic: false }));
    if (/italic|oblique/i.test(style)) entry.italic = true;
    else entry.weights.add(weightFromStyleName(style));
  }
  const defs: FontDef[] = [];
  for (const [family, e] of byFamily) {
    const weights = [...(e.weights.size ? e.weights : new Set([400]))].sort((a, b) => a - b);
    const lower = family.toLowerCase();
    const tags = ['system'];
    if (/mono|courier|consol|code/.test(lower)) tags.push('mono');
    if (/script|hand|brush|signature/.test(lower)) tags.push('script');
    if (/gothic|fraktur|blackletter|old english/.test(lower)) tags.push('gothic');
    if (/condensed|narrow|compressed/.test(lower)) tags.push('condensed');
    defs.push({ id: family, family, category: 'System', weights, italic: e.italic || undefined, source: 'system', tags });
  }
  return defs.sort((a, b) => a.family.localeCompare(b.family));
}

let inflight: Promise<SystemFontStatus> | null = null;

/**
 * Query and register the system's font families (once). Safe to call repeatedly. In a plain
 * browser the API may need a user gesture — call it from a click handler there.
 */
export function loadSystemFonts(): Promise<SystemFontStatus> {
  const st = useSystemFonts.getState().status;
  if (st === 'loaded' || st === 'unsupported') return Promise.resolve(st);
  if (inflight) return inflight;
  const q = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (!q) {
    useSystemFonts.setState({ status: 'unsupported' });
    return Promise.resolve('unsupported');
  }
  useSystemFonts.setState({ status: 'loading' });
  inflight = q
    .call(window)
    .then((list) => {
      const defs = groupLocalFonts(list, (family) => {
        const existing = fonts.get(family);
        return !!existing && existing.source !== 'system';
      });
      if (defs.length) fonts.registerMany(defs);
      useSystemFonts.setState({ status: 'loaded', count: defs.length });
      return 'loaded' as const;
    })
    .catch((err: unknown) => {
      const name = (err as { name?: string })?.name;
      const status: SystemFontStatus = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error';
      useSystemFonts.setState({ status });
      if (status === 'error') console.warn('[fonts] queryLocalFonts failed', err);
      return status;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Lazy trigger for pickers/panels: on desktop load automatically the first time; in a browser
 * only when invoked from a user gesture (`fromGesture`), since it shows a permission prompt.
 */
export function maybeLoadSystemFonts(fromGesture = false) {
  const st = useSystemFonts.getState().status;
  if (st !== 'idle') return;
  if (isDesktop || fromGesture) void loadSystemFonts();
}
