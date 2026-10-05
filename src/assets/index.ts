/**
 * Module entry (imported by src/features.ts): registers the procedural asset library, the
 * Libraries panel, the asset Properties section, File ▸ Place Asset… and canvas drag & drop.
 */
import { createElement } from 'react';
import { ImagePlus, Library } from 'lucide-react';
import { assets, commands, panels, propertiesSections } from '../registry';
import { activeDoc } from '../state/editor';
import { openDialog, toast, useUI } from '../state/ui';
import { BUILTIN_ASSETS } from './catalog';
import { installCanvasDrop } from './lib/dnd';
import { loadAssetFonts } from './lib/fonts';
import { loadUserAssets } from './lib/userAssets';
import { AssetPropertiesSection, appliesToAssetLayer } from './ui/AssetPropertiesSection';
import { LibrariesPanel } from './ui/LibrariesPanel';
import { importFromDialog } from './ui/MyAssetsTab';
import { PlaceAssetDialog } from './ui/PlaceAssetDialog';
import { useLibrary } from './ui/store';

assets.registerMany(BUILTIN_ASSETS);

panels.register({
  id: 'libraries',
  title: 'Libraries',
  icon: Library,
  component: LibrariesPanel,
  defaultSlot: 'top',
  order: 20,
  menu: () => {
    const st = useLibrary.getState();
    return [
      { label: 'Assets', checked: st.tab === 'assets', run: () => st.setTab('assets') },
      { label: 'Shapes', checked: st.tab === 'shapes', run: () => st.setTab('shapes') },
      { label: 'My Assets', checked: st.tab === 'mine', run: () => st.setTab('mine') },
      { label: 'Add Images to My Assets…', run: () => void importFromDialog() },
      { label: 'Place Asset…', disabled: !activeDoc(), run: () => void openPlaceAssetDialog() },
    ];
  },
});

propertiesSections.register({
  id: 'asset-generator',
  order: 15,
  title: 'Asset',
  appliesTo: appliesToAssetLayer,
  component: ({ layerId }) => createElement(AssetPropertiesSection, { key: layerId, layerId }),
});

export async function openPlaceAssetDialog() {
  if (!activeDoc()) {
    toast('Open or create a document to place assets', 'info');
    return;
  }
  await openDialog(PlaceAssetDialog);
}

commands.register({
  id: 'file.placeAsset',
  label: 'Place Asset…',
  menu: 'File',
  group: '30-place',
  order: 20,
  icon: Library,
  keywords: ['asset', 'library', 'texture', 'overlay', 'paper', 'smoke', 'border', 'sticker', 'insert'],
  enabled: () => !!activeDoc(),
  run: () => openPlaceAssetDialog(),
});

commands.register({
  id: 'assets.showLibraries',
  label: 'Browse Asset Library',
  icon: Library,
  keywords: ['assets', 'libraries', 'textures', 'shapes', 'my assets'],
  run: () => {
    useLibrary.getState().setTab('assets');
    useUI.getState().showPanel('libraries');
  },
});

commands.register({
  id: 'assets.importImages',
  label: 'Add Images to My Assets…',
  icon: ImagePlus,
  keywords: ['import', 'my assets', 'library', 'images', 'logo'],
  run: () => importFromDialog(),
});

installCanvasDrop();
// Once the app is idle: open the My Assets library (small previews only — full images decode on
// demand) so imported images show up in the registry, and warm up the few faces text-drawing
// assets use (tiny local files) so placing a newspaper/film-frame asset renders right away.
if (typeof window !== 'undefined') {
  const warm = () => {
    void loadUserAssets();
    void loadAssetFonts();
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 2500 });
  else setTimeout(warm, 1200);
}

export { createAssetLayer, placeAsset, placeAssetAt, placeAssetWhenReady, prepareAsset, regenerateAssetLayer } from './place';
export { BUILTIN_ASSETS } from './catalog';
