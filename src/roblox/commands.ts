/** Roblox module commands: Roblox menu + File/Select/View entries (see ARCHITECTURE §5.3). */
import { Box, CloudDownload, Gamepad2, ImagePlus, Monitor, Palette, PersonStanding, ScanFace, Scissors, SquareDashed, UserRoundPen } from 'lucide-react';
import type { CommandDef } from '../registry';
import { activeLayer } from '../state/editor';
import { toast, useUI } from '../state/ui';
import { newDocumentWithBackground, requireDoc, requireRasterLayer } from './util';
import { openModelImport, openPoseStudio } from './studio/lazy';
import { openRemoveBackground } from './bg/RemoveBgDialog';
import { selectSubject } from './bg/apply';
import { openRobloxPreview } from './preview/PreviewDialog';
import { toggleSafeZones } from './preview/safeZones';
import { openAvatarFetch } from './avatar/AvatarDialog';

const safeZonesOn = () => useUI.getState().view.safeZones;

function editCharacterRender() {
  if (!requireDoc('edit a character render')) return;
  const l = activeLayer();
  if (l?.type === 'raster' && l.generator?.kind === 'rig') return void openPoseStudio({ layerId: l.id });
  if (l?.type === 'raster' && l.generator?.kind === 'model') return void openModelImport({ layerId: l.id });
  toast('Select a layer rendered with Pose Studio (or Import Model) to edit it — or open Roblox ▸ Pose Studio to create one.', 'info', 4200);
}

function removeBackground() {
  const l = requireRasterLayer('remove the background');
  if (l) void openRemoveBackground(l.id);
}

function preview() {
  if (requireDoc('preview it as a Roblox icon or thumbnail')) void openRobloxPreview();
}

export const robloxCommands: CommandDef[] = [
  /* ---- Roblox menu ---- */
  {
    id: 'roblox.poseStudio',
    label: 'Pose Studio…',
    menu: 'Roblox',
    group: '10-create',
    order: 10,
    icon: PersonStanding,
    keywords: ['3d', 'character', 'rig', 'r6', 'r15', 'pose', 'avatar', 'render'],
    run: () => void openPoseStudio(),
  },
  {
    id: 'roblox.importModel',
    label: 'Import 3D Model…',
    menu: 'Roblox',
    group: '10-create',
    order: 20,
    icon: Box,
    keywords: ['obj', 'glb', 'gltf', 'fbx', 'studio', 'export selection', 'avatar'],
    run: () => void openModelImport({ pick: true }),
  },
  {
    id: 'roblox.fetchAvatar',
    label: 'Fetch Avatar by Username…',
    menu: 'Roblox',
    group: '10-create',
    order: 30,
    icon: CloudDownload,
    keywords: ['avatar', 'username', 'download', 'headshot', 'bust'],
    run: () => void openAvatarFetch(),
  },
  {
    id: 'roblox.editRig',
    label: 'Edit Character Render…',
    menu: 'Roblox',
    group: '10-create',
    order: 40,
    icon: UserRoundPen,
    keywords: ['pose studio', 're-edit', 'rig', 'model'],
    run: editCharacterRender,
  },
  {
    id: 'roblox.removeBackground',
    label: 'Remove Background…',
    menu: 'Roblox',
    group: '20-character',
    order: 10,
    icon: Scissors,
    keywords: ['cut out', 'green screen', 'chroma key', 'mask', 'transparent'],
    run: removeBackground,
  },
  {
    id: 'roblox.selectSubject',
    label: 'Select Subject',
    menu: 'Roblox',
    group: '20-character',
    order: 20,
    icon: ScanFace,
    keywords: ['selection', 'character', 'auto'],
    run: selectSubject,
  },
  {
    id: 'roblox.styler',
    label: 'Character Styler',
    menu: 'Roblox',
    group: '20-character',
    order: 30,
    icon: Palette,
    keywords: ['toon', 'cel', 'comic', 'noir', 'rim', 'style', 'panel'],
    run: () => useUI.getState().showPanel('roblox'),
  },
  {
    id: 'roblox.preview',
    label: 'Roblox Preview…',
    menu: 'Roblox',
    group: '30-preview',
    order: 10,
    icon: Gamepad2,
    keywords: ['mockup', 'game card', 'tile', 'readability', 'discover'],
    run: preview,
  },
  {
    id: 'roblox.safeZones',
    label: 'Show Safe Zones',
    menu: 'Roblox',
    group: '30-preview',
    order: 20,
    icon: SquareDashed,
    keywords: ['icon mask', 'badge', 'title safe', 'overlay'],
    checked: safeZonesOn,
    run: () => toggleSafeZones(),
  },
  {
    id: 'roblox.newIcon',
    label: 'New Game Icon (512×512)',
    menu: 'Roblox',
    group: '40-new',
    order: 10,
    icon: ImagePlus,
    keywords: ['new', 'icon', 'square', '512'],
    run: () => void newDocumentWithBackground('Game Icon', 512, 512),
  },
  {
    id: 'roblox.newThumbnail',
    label: 'New Thumbnail (1920×1080)',
    menu: 'Roblox',
    group: '40-new',
    order: 20,
    icon: Monitor,
    keywords: ['new', 'thumbnail', '16:9', '1080p'],
    run: () => void newDocumentWithBackground('Thumbnail', 1920, 1080),
  },

  /* ---- Other menus ---- */
  {
    id: 'select.subject',
    label: 'Subject',
    menu: 'Select',
    group: '30-color',
    order: 20,
    icon: ScanFace,
    keywords: ['select subject', 'character', 'auto selection'],
    run: selectSubject,
  },
  {
    id: 'view.safeZones',
    label: 'Roblox Safe Zones',
    menu: 'View',
    group: '20-show',
    order: 60,
    icon: SquareDashed,
    keywords: ['safe area', 'icon mask', 'title safe'],
    checked: safeZonesOn,
    run: () => toggleSafeZones(),
  },
  {
    id: 'file.importModel',
    label: 'Import 3D Model…',
    menu: 'File',
    group: '30-place',
    order: 30,
    icon: Box,
    keywords: ['obj', 'glb', 'fbx', 'roblox studio'],
    run: () => void openModelImport({ pick: true }),
  },
  {
    id: 'file.fetchAvatar',
    label: 'Fetch Roblox Avatar…',
    menu: 'File',
    group: '30-place',
    order: 40,
    icon: CloudDownload,
    keywords: ['avatar', 'username'],
    run: () => void openAvatarFetch(),
  },
];
