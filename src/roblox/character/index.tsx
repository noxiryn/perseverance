/**
 * Character workflow entry points: Roblox ▸ Replace Character…, Layer ▸ Replace Contents…,
 * Layer ▸ Trim Transparent Pixels, the "replace the selected character" offer when an image is
 * dropped on the window — and when File ▸ Place Image… or Edit ▸ Paste brings one in while a
 * template placeholder is selected — and the Character section of the Properties panel.
 */
import { Crop, ImagePlus, Replace, Scissors } from 'lucide-react';
import type { CommandDef } from '../../registry';
import { commands, propertiesSections, runCommand } from '../../registry';
import type { ID } from '../../core/types';
import { activeDoc, activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';
import { viewport } from '../../editor/viewport';
import { Button, showContextMenu } from '../../ui/controls';
import { registerFileDropHandler } from '../../ui/shell/dropHooks';
import { askChoice } from '../../ui/shell/dialogs/ChoiceDialog';
import { openFile } from '../../io/open';
import { registerPlacedImageHandler } from '../../io/placeHooks';
import { requireDoc } from '../util';
import { trimRasterLayer } from './cutout';
import { characterTarget, contentsTarget, decodeImageFile, imageBaseName, isCharacterLayer, isPlaceholder, isReplaceableImage, replaceLayerContents } from './replace';
import { autoCutoutPref, openReplaceDialog } from './ReplaceDialog';

function replaceCharacter() {
  const doc = requireDoc('replace the character');
  if (!doc) return;
  const target = characterTarget(doc, activeSession()?.activeLayerId);
  if (!target) {
    toast('Select the character (pixel) layer to replace — or open a template with a placeholder character.', 'info', 4200);
    return;
  }
  if (activeSession()?.activeLayerId !== target.id) useEditor.getState().setActiveLayer(target.id);
  void openReplaceDialog(target.id, 'character');
}

function replaceContents() {
  const doc = requireDoc('replace a layer’s contents');
  if (!doc) return;
  const target = contentsTarget(doc, activeSession()?.activeLayerId);
  if (!target) {
    toast('Select a pixel layer to replace its contents.', 'info');
    return;
  }
  void openReplaceDialog(target.id, isCharacterLayer(doc, target) ? 'character' : 'contents');
}

/** Layer ▸ Trim Transparent Pixels: shrink the active pixel layer to its visible pixels (one undo step). */
export function trimActiveLayer() {
  const s = activeSession();
  const layer = s?.activeLayerId ? s.doc.layers[s.activeLayerId] : null;
  if (!s || !layer || layer.type !== 'raster') {
    toast('Select a pixel layer to trim.', 'info');
    return;
  }
  if (layer.locks.all || layer.locks.pixels) {
    toast(`“${layer.name}” is locked — unlock its pixels to trim it.`, 'warning');
    return;
  }
  if (layer.generator) {
    toast(`“${layer.name}” is a generated layer (asset or render) — rasterize it first (Layer ▸ Rasterize Layer) to trim it.`, 'info', 4200);
    return;
  }
  const t = trimRasterLayer(layer);
  if (!t) {
    toast(`“${layer.name}” has no transparent margin to trim.`, 'info');
    return;
  }
  useEditor.getState().commit('Trim Transparent Pixels', (d) => {
    const l = d.layers[layer.id];
    if (!l || l.type !== 'raster') return;
    l.bitmapId = t.bitmapId;
    l.width = t.width;
    l.height = t.height;
    l.transform = t.transform;
  });
  viewport.requestRender();
  toast(`Trimmed “${layer.name}” to ${t.width}×${t.height} px`, 'success');
}

const activeRaster = () => {
  const s = activeSession();
  return !!s && !!contentsTarget(s.doc, s.activeLayerId);
};

export const characterCommands: CommandDef[] = [
  {
    id: 'roblox.replaceCharacter',
    label: 'Replace Character…',
    menu: 'Roblox',
    group: '20-character',
    order: 5,
    icon: Replace,
    keywords: ['placeholder', 'template', 'swap', 'my avatar', 'render', 'replace contents', 'character'],
    enabled: () => !!activeDoc(),
    run: replaceCharacter,
  },
  {
    id: 'layer.replaceContents',
    label: 'Replace Contents…',
    menu: 'Layer',
    group: '50-convert',
    order: 40,
    icon: Replace,
    keywords: ['replace', 'swap image', 'placeholder', 'character', 'relink'],
    enabled: activeRaster,
    run: replaceContents,
  },
  {
    id: 'layer.trimTransparent',
    label: 'Trim Transparent Pixels',
    menu: 'Layer',
    group: '50-convert',
    order: 45,
    icon: Crop,
    keywords: ['trim', 'crop layer', 'fit bounds', 'transparent'],
    enabled: activeRaster,
    run: trimActiveLayer,
  },
];

/* ---------------- drop an image on a selected character ---------------- */


function dropTarget() {
  const s = activeSession();
  if (!s) return null;
  const t = contentsTarget(s.doc, s.activeLayerId);
  return t && isCharacterLayer(s.doc, t) ? t : null;
}

registerFileDropHandler({
  id: 'roblox.replaceCharacter',
  hint: () => {
    const t = dropTarget();
    return t ? `Drop one image to replace “${t.name}” (you'll be asked)` : null;
  },
  claim: (ctx) => {
    // Only renders the decoder reads: a PSD / project / SVG falls through to the normal open path.
    if (!ctx.hasDoc || ctx.shift || ctx.count !== 1 || !isReplaceableImage(ctx.file.name, ctx.file.type, ctx.data)) return false;
    const target = dropTarget();
    if (!target) return false;
    const file = { path: null, name: ctx.file.name, data: ctx.data };
    const replace = async () => {
      try {
        const canvas = await decodeImageFile(file);
        replaceLayerContents(target.id, canvas, { name: imageBaseName(file.name), cutout: autoCutoutPref() });
      } catch (e) {
        console.error('[replace] drop failed', e);
        toast(`Could not read “${file.name}”`, 'error');
      }
    };
    const place = async () => {
      try {
        await openFile(file);
      } catch (e) {
        toast(`Could not open ${file.name}: ${(e as Error)?.message ?? e}`, 'error');
      }
    };
    showContextMenu({ clientX: ctx.clientX, clientY: ctx.clientY }, [
      { label: `Dropped “${file.name}”`, heading: true },
      { label: isPlaceholder(target) ? 'Replace Placeholder Character' : `Replace “${target.name}”`, icon: Replace, run: () => void replace() },
      { label: 'Add as New Layer', icon: ImagePlus, run: () => void place() },
    ]);
    return true;
  },
});

/* ---------------- Place Image / Paste with the placeholder selected ---------------- */

registerPlacedImageHandler({
  id: 'roblox.replacePlaceholder',
  claim: async ({ canvas, name, source }) => {
    const s = activeSession();
    const target = s ? contentsTarget(s.doc, s.activeLayerId) : null;
    if (!target || !isPlaceholder(target) || target.locks.all || target.locks.pixels) return false;
    const what = source === 'paste' ? 'the pasted image' : `“${name}”`;
    const choice = await askChoice({
      title: 'Replace the placeholder character?',
      message: `Use ${what} as your character in place of “${target.name}”?`,
      detail: 'Replacing keeps the template’s spot, size, smart filters and effects (Ctrl+Z undoes it). Add as New Layer places the image above the placeholder, which stays visible.',
      icon: Replace,
      choices: [
        { value: 'layer', label: 'Add as New Layer' },
        { value: 'replace', label: 'Replace Placeholder Character', variant: 'primary' },
      ],
    });
    if (choice === 'replace') return replaceLayerContents(target.id, canvas, { name: source === 'paste' ? undefined : name, cutout: autoCutoutPref() });
    // 'layer' → placed as usual; dismissed (Esc) → nothing is placed.
    return choice !== 'layer';
  },
});

/* ---------------- Properties ▸ Character ---------------- */

function CharacterSection({ layerId }: { layerId: ID }) {
  const layer = useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return s?.doc.layers[layerId] ?? null;
  });
  if (!layer || layer.type !== 'raster') return null;
  const placeholder = isPlaceholder(layer);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="roblox-hint">
        {placeholder
          ? 'Template placeholder — replace it with your own render. It keeps this spot, size, smart filters and effects.'
          : 'Swap in another render while keeping this layer’s spot, size, smart filters and effects.'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button size="small" variant={placeholder ? 'primary' : undefined} icon={Replace} onClick={() => runCommand('roblox.replaceCharacter')}>
          Replace Character…
        </Button>
        <Button size="small" icon={Scissors} onClick={() => runCommand('roblox.removeBackground')}>
          Remove Background…
        </Button>
      </div>
    </div>
  );
}

propertiesSections.register({
  id: 'roblox-character',
  order: 29,
  title: 'Character',
  appliesTo: (layerId) => {
    const doc = activeDoc();
    return isCharacterLayer(doc, doc?.layers[layerId]);
  },
  component: CharacterSection,
});

commands.registerMany(characterCommands);
