/**
 * User brush presets: saved to localStorage and registered into `brushPresets` on startup.
 */
import { brushPresets } from '../../../registry';
import { uid } from '../../../core/ids';
import { useEditor } from '../../../state/editor';
import { forgetTexture } from '../engine/tips';
import { TIP_TOOLS, setOpts, type BrushSettings } from '../options';
import type { PaintBrushPreset } from './presets';

const KEY = 'perseverance.paint.userBrushes.v1';
export const USER_CATEGORY = 'My Brushes';

interface StoredPreset {
  id: string;
  name: string;
  settings: BrushSettings;
  airbrush?: boolean;
  created: number;
}

function readStore(): StoredPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredPreset[];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string' && p.settings) : [];
  } catch {
    return [];
  }
}

function writeStore(list: StoredPreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[paint] could not save brush presets', err);
  }
}

/** Follow tipFrom chains to the preset that actually owns a tip generator. */
function tipOwner(id: string, depth = 0): PaintBrushPreset | undefined {
  const p = brushPresets.get(id) as PaintBrushPreset | undefined;
  if (!p || depth > 8) return p;
  if (p.tipFrom && p.tipFrom !== id) return tipOwner(p.tipFrom, depth + 1) ?? p;
  return p;
}

function toPreset(s: StoredPreset): PaintBrushPreset {
  const st = s.settings;
  const owner = tipOwner(st.presetId);
  return {
    id: s.id,
    name: s.name,
    category: USER_CATEGORY,
    size: st.size,
    hardness: st.hardness,
    spacing: st.spacing,
    flow: st.flow,
    sizeJitter: st.sizeJitter,
    angleJitter: st.angleJitter,
    scatter: st.scatter,
    opacityJitter: st.opacityJitter,
    angle: st.angle,
    roundness: st.roundness,
    tip: owner?.tip,
    opacity: st.opacity,
    pressureSize: st.pressureSize,
    pressureOpacity: st.pressureOpacity,
    followDirection: st.followDirection,
    smoothing: st.smoothing,
    airbrush: s.airbrush,
    user: true,
    tipFrom: owner?.id ?? st.presetId,
    description: owner ? `Based on ${owner.name}` : 'Custom brush',
  };
}

/** Register all saved user presets (call once after the built-ins are registered). */
export function loadUserPresets() {
  for (const s of readStore()) brushPresets.register(toPreset(s));
}

export function saveUserPreset(name: string, settings: BrushSettings, airbrush?: boolean): PaintBrushPreset {
  const stored: StoredPreset = { id: uid('ubrush_'), name: name.trim() || 'My Brush', settings: { ...settings }, airbrush, created: Date.now() };
  writeStore([...readStore(), stored]);
  const p = toPreset(stored);
  brushPresets.register(p);
  return p;
}

export function deleteUserPreset(id: string) {
  const removed = brushPresets.get(id) as PaintBrushPreset | undefined;
  writeStore(readStore().filter((p) => p.id !== id));
  brushPresets.unregister(id);
  forgetTexture(id);
  // Tools still pointing at the deleted preset keep its tip via the preset it was based on.
  const fallback = removed?.tipFrom && removed.tipFrom !== id && brushPresets.get(removed.tipFrom) ? removed.tipFrom : 'round-hard';
  const opts = useEditor.getState().toolOptions;
  for (const toolId of TIP_TOOLS) {
    if ((opts[toolId] as { presetId?: string } | undefined)?.presetId === id) setOpts(toolId, { presetId: fallback });
  }
}

export function renameUserPreset(id: string, name: string) {
  const list = readStore();
  const s = list.find((p) => p.id === id);
  if (!s) return;
  s.name = name.trim() || s.name;
  writeStore(list);
  brushPresets.register(toPreset(s));
}
