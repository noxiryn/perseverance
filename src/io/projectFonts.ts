/**
 * Fonts and .pgfx projects.
 *
 *  - Saving embeds the user-added font files ("Add Font File…", or fonts that came embedded in an
 *    opened project) used by the document's text layers, so a shared project renders the same on
 *    a friend's computer. Bundled fonts ship with every copy; system fonts are never embedded
 *    (they belong to the operating system and are often not redistributable).
 *  - Opening registers embedded fonts the machine doesn't have (for the session) and warns about
 *    families that are still unavailable, instead of silently rendering a fallback font.
 */
import type { Document } from '../core/types';
import { fonts } from '../registry';
import { toast } from '../state/ui';
import { registerEmbeddedFonts, userFontFiles, userFontsReady, type EmbeddedFontFile } from '../fonts/userFonts';
import type { ContainerFont } from './container';

const norm = (f: string) => f.replace(/["']/g, '').trim().toLowerCase();

/** Font families used by the document's text layers (first spelling wins, in layer order). */
export function documentFamilies(doc: Document): string[] {
  const seen = new Map<string, string>();
  for (const l of Object.values(doc.layers)) {
    if (l.type !== 'text') continue;
    const f = (l.text.fontFamily || '').trim();
    if (f && !seen.has(norm(f))) seen.set(norm(f), f);
  }
  return [...seen.values()];
}

/** Families of `families` for which `available` is false (pure). */
export function missingFamilies(families: string[], available: (family: string) => boolean): string[] {
  return families.filter((f) => !available(f));
}

/** Short human list: "A, B and 2 more". */
export function listFamilies(list: string[], max = 3): string {
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/* ---------------- availability ---------------- */

function registered(family: string): boolean {
  const n = norm(family);
  return fonts.list().some((f) => norm(f.family) === n);
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * True when the system has a font with this family name. Canvas text resolves local fonts by
 * name, so a family that changes the width of a sample string against all three generic
 * fallbacks is installed. Works without the Local Font Access permission.
 */
function installedLocally(family: string): boolean {
  if (probe === undefined) {
    try {
      probe = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      probe = null;
    }
  }
  // No way to tell (no canvas): don't cry wolf.
  if (!probe) return true;
  const sample = 'mmmmmmmmmmlliI1WQ@#&wwAé';
  const name = family.replace(/["\\]/g, '');
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    probe.font = `72px ${generic}`;
    const base = probe.measureText(sample).width;
    probe.font = `72px "${name}", ${generic}`;
    if (Math.abs(probe.measureText(sample).width - base) > 0.5) return true;
  }
  return false;
}

const CSS_GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

/** Whether text in `family` renders with that font here (bundled, installed, embedded or system). */
export function isFamilyAvailable(family: string): boolean {
  if (!family.trim() || CSS_GENERIC.has(norm(family))) return true;
  return registered(family) || installedLocally(family);
}

/* ---------------- save ---------------- */

/**
 * User-added font files used by the document, ready to embed in a project file. `sessionOnly`: only
 * the files this machine has for the current session alone (fonts embedded in an opened project,
 * fonts added while font storage was unavailable) — the ones a recovery entry must carry, since
 * they are gone after a restart.
 */
export async function embeddableFonts(doc: Document, opts: { sessionOnly?: boolean } = {}): Promise<ContainerFont[]> {
  const families = documentFamilies(doc).filter((f) => {
    const def = fonts.list().find((d) => norm(d.family) === norm(f));
    // Unregistered families may still be embedded-for-the-session files (re-saving a shared
    // project); bundled and system fonts never are.
    return !def || def.source === 'user';
  });
  if (!families.length) return [];
  try {
    const files = await userFontFiles(families, { sessionOnly: opts.sessionOnly });
    return files.map((f) => ({ family: f.family, weight: f.weight, style: f.style, fileName: f.fileName, format: f.format, data: f.data }));
  } catch (err) {
    console.warn('[io] could not read user fonts to embed', err);
    return [];
  }
}

/* ---------------- open ---------------- */

/** Register the fonts embedded in a project (only those this machine lacks). Returns their families. */
export async function registerProjectFonts(list: { family: string; weight: number; style: 'normal' | 'italic'; fileName: string; format: string; data: Uint8Array }[]): Promise<string[]> {
  if (!list.length) return [];
  const files: EmbeddedFontFile[] = list.map((f) => ({
    family: f.family,
    weight: f.weight,
    style: f.style,
    fileName: f.fileName,
    format: f.format,
    // Own copy: the container bytes are a view into the whole project buffer.
    data: f.data.slice().buffer as ArrayBuffer,
  }));
  try {
    return await registerEmbeddedFonts(files, isFamilyAvailable);
  } catch (err) {
    console.warn('[io] could not register embedded fonts', err);
    return [];
  }
}

/**
 * After opening a project: say which fonts came from the file and warn about families that are
 * still missing (text then renders with a fallback font).
 */
export async function reportProjectFonts(doc: Document, embedded: string[]): Promise<void> {
  const families = documentFamilies(doc);
  if (!families.length) return;
  // Installed user fonts register asynchronously at startup (e.g. a project opened by double-click).
  await Promise.race([userFontsReady(), new Promise((r) => setTimeout(r, 3000))]);
  const missing = missingFamilies(families, isFamilyAvailable);
  if (missing.length) {
    toast(
      `Missing font${missing.length > 1 ? 's' : ''} in “${doc.name}”: ${listFamilies(missing)} — text uses a fallback font. Install ${missing.length > 1 ? 'them' : 'it'} with Type ▸ Add Font File… and the text updates.`,
      'warning',
      8000,
    );
  }
  const used = embedded.filter((f) => families.some((x) => norm(x) === norm(f)));
  if (used.length) toast(`Using font${used.length > 1 ? 's' : ''} embedded in “${doc.name}”: ${listFamilies(used)}`, 'info', 4200);
}
