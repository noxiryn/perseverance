/**
 * Template definitions: specs are authored against DocBuilder and registered as TemplateDefs.
 * Keeping the spec lets previews rebuild a template at low bitmap resolution.
 */
import type { Color, Document, ID } from '../core/types';
import { templates, type TemplateDef } from '../registry';
import { loadFonts } from '../looks/shared';
import { DocBuilder, resolveFont, resolveWeight, type BuildOptions, type FontChoice } from './builder';

export interface TemplateSpec extends Omit<TemplateDef, 'build'> {
  /** Document background color (null = transparent). Default white. */
  background?: Color | null;
  /** Font faces to load before building (text is measured for centering); optional sample text for non-latin glyphs. */
  fonts?: [FontChoice, number?, string?][];
  build(b: DocBuilder): void;
}

const specs = new Map<string, TemplateSpec>();

export interface BuiltTemplate {
  doc: Document;
  /** Main placeholder character layer (made active when opened), if any. */
  characterId: ID | null;
}

/** Build a template document (full resolution by default). */
export async function buildTemplate(id: string, opts: BuildOptions = {}): Promise<BuiltTemplate> {
  const spec = specs.get(id);
  if (!spec) {
    // Template registered by someone else: use its own build().
    const def = templates.get(id);
    if (!def) throw new Error(`Unknown template “${id}”`);
    const doc = await def.build();
    const cid = doc.meta?.characterId;
    return { doc, characterId: typeof cid === 'string' && doc.layers[cid] ? cid : null };
  }
  await loadFonts(
    (spec.fonts ?? []).map(([f, w, text]) => {
      const family = resolveFont(f);
      // Ask for a weight that exists, otherwise the load would only end at the timeout.
      return { family, weight: resolveWeight(family, w ?? 400), text };
    }),
    3500,
  );
  const b = new DocBuilder(spec.name, spec.width, spec.height, spec.background === undefined ? '#ffffff' : spec.background, opts);
  spec.build(b);
  // doc.meta.characterId lets other openers (start screen, palette) select the placeholder too.
  return { doc: b.finish({ template: id, ...(b.characterId ? { characterId: b.characterId } : {}) }), characterId: b.characterId };
}

export function hasTemplateSpec(id: string) {
  return specs.has(id);
}

export function defineTemplate(spec: TemplateSpec): TemplateDef {
  specs.set(spec.id, spec);
  const { build: _b, fonts: _f, background: _bg, ...rest } = spec;
  return {
    ...rest,
    build: async () => (await buildTemplate(spec.id)).doc,
  };
}
