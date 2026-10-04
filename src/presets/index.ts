/**
 * fonts-color module — presets half: gradient presets, palettes (default "Swatches" first, then
 * themed + user palettes), the Swatches and Color panels and their commands.
 * (Imported by src/features.ts.)
 */
import { Palette, Pipette, SquarePlus, SwatchBook } from 'lucide-react';
import { commands, gradientPresets, palettes, panels } from '../registry';
import { GRADIENT_PRESETS } from './gradients';
import { BUILTIN_PALETTES } from './palettes';
import { registerUserPalettes } from './userPalettes';
import { SwatchesPanel, addPrimaryToSwatches, extractPaletteFlow, swatchesPanelMenu } from './SwatchesPanel';
import { ColorPanel } from './ColorPanel';
import { useEditor } from '../state/editor';
import { toast } from '../state/ui';

// Default "Swatches" palette is first in BUILTIN_PALETTES (ColorPicker shows palettes[0]).
palettes.registerMany(BUILTIN_PALETTES);
registerUserPalettes();
gradientPresets.registerMany(GRADIENT_PRESETS);

panels.register({
  id: 'swatches',
  title: 'Swatches',
  icon: SwatchBook,
  component: SwatchesPanel,
  defaultSlot: 'middle',
  order: 10,
  menu: swatchesPanelMenu,
});

panels.register({
  id: 'color',
  title: 'Color',
  icon: Palette,
  component: ColorPanel,
  defaultSlot: 'middle',
  order: 20,
  menu: () => {
    const st = useEditor.getState();
    return [
      { label: 'Swap Colors', run: () => st.swapColors() },
      { label: 'Default Colors', run: () => st.resetColors() },
      {
        label: 'Copy Foreground Hex',
        run: () =>
          void navigator.clipboard?.writeText(st.primaryColor).then(
            () => toast(`Copied ${st.primaryColor}`, 'success'),
            () => toast('Clipboard unavailable', 'warning'),
          ),
      },
      { label: 'Add Foreground to My Swatches', run: addPrimaryToSwatches },
    ];
  },
});

commands.registerMany([
  {
    id: 'swatches.addForeground',
    label: 'Add Foreground Color to Swatches',
    icon: SquarePlus,
    keywords: ['swatch', 'palette', 'save color', 'my swatches'],
    run: addPrimaryToSwatches,
  },
  {
    id: 'swatches.extractPalette',
    label: 'Extract Palette from Image…',
    icon: Pipette,
    keywords: ['palette', 'swatches', 'colors from image', 'k-means', 'median cut'],
    run: () => void extractPaletteFlow(),
  },
]);
