/**
 * "My Looks": looks the user saved from a finished composition — the target layer's smart
 * filters and effects plus the overlays and grades of the look groups and of the generated
 * asset / adjustment layers stacked above the target. Stored per user in localStorage and
 * registered in the looks registry (category "My Looks") so they apply like built-in looks.
 */
import type { Color, Document, ID, Layer, ParamValues } from '../core/types';
import { looks, type LookDef } from '../registry';
import { activeSession } from '../state/editor';
import { toast } from '../state/ui';
import { uid } from '../core/ids';
import { assetIdOfLayer } from '../assets/place';
import { parentOf } from '../core/document';
import { isLookGroup, lookTargets, type ExtLookDef, type LookOverlayDef } from './engine';
import { promptSave } from './SavePresetDialog';

export const USER_LOOK_CATEGORY = 'My Looks';
export const USER_LOOK_PREFIX = 'user-look:';
const KEY = 'perseverance.userLooks';

export interface UserLook extends ExtLookDef {
  created: number;
}

export const isUserLook = (id: string) => id.startsWith(USER_LOOK_PREFIX);

/** Top-level ancestor of a layer (itself when at the root). */
function topLevelOf(doc: Document, id: ID): ID {
  let cur = id;
  for (let p = parentOf(doc, cur); p; p = parentOf(doc, cur)) cur = p;
  return cur;
}

/** Colours found in params (strings like #rrggbb and gradient stops), for the look's swatch. */
function paramColors(params: ParamValues | undefined, out: Color[]) {
  if (!params) return;
  for (const v of Object.values(params)) {
    if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out.push(v);
    else if (v && typeof v === 'object' && Array.isArray((v as { stops?: unknown }).stops))
      for (const st of (v as { stops: { color?: unknown }[] }).stops) if (typeof st.color === 'string') out.push(st.color);
  }
}

export interface LookCapture {
  look: ExtLookDef;
  counts: { filters: number; effects: number; overlays: number; adjustments: number };
}

/**
 * Build a look from a document (pure): `targetId`'s enabled smart filters/effects, every layer
 * of the look groups (overlays in a "behind" group keep that placement) and the generated asset
 * / adjustment layers stacked above the target at the top level. Without a target, only the look
 * groups are captured (other layers can't be told apart from the composition itself).
 */
export function captureLook(doc: Document, targetId: ID | null, name: string, id = `${USER_LOOK_PREFIX}${uid('lk_')}`): LookCapture {
  const target = targetId ? doc.layers[targetId] : null;
  const look: ExtLookDef = { id, name, category: USER_LOOK_CATEGORY, description: 'Saved from your document.', swatch: [], overlays: [], adjustments: [] };
  const colors: Color[] = [];
  if (target && target.type !== 'adjustment') {
    const fl = target.filters.filter((f) => f.enabled).map((f) => ({ filterId: f.filterId, params: structuredClone(f.params) }));
    const ef = target.effects.filter((e) => e.enabled).map((e) => ({ effectId: e.effectId, params: structuredClone(e.params) }));
    if (fl.length) look.layerFilters = fl;
    if (ef.length) look.layerEffects = ef;
    fl.forEach((f) => paramColors(f.params, colors));
    ef.forEach((e) => paramColors(e.params, colors));
  }
  const take = (l: Layer, placement: 'top' | 'behind') => {
    if (!l.visible) return;
    if (l.type === 'adjustment') {
      look.adjustments!.push({ filterId: l.adjustment.filterId, params: structuredClone(l.adjustment.params), name: l.name, blendMode: l.blendMode, opacity: l.opacity });
      paramColors(l.adjustment.params, colors);
      return;
    }
    const assetId = assetIdOfLayer(l);
    if (!assetId || l.type !== 'raster') return;
    const o: LookOverlayDef = { assetId, params: structuredClone((l.generator?.params ?? {}) as ParamValues), name: l.name, blendMode: l.blendMode, opacity: l.opacity };
    if (placement === 'behind') o.placement = 'behind';
    look.overlays!.push(o);
    paramColors(o.params, colors);
  };
  const walk = (ids: ID[], placement: 'top' | 'behind') => {
    for (const cid of ids) {
      const l = doc.layers[cid];
      if (!l) continue;
      if (l.type === 'group') walk(l.childIds, placement);
      else take(l, placement);
    }
  };
  // Look groups (bottom → top as stacked).
  const roots = doc.rootIds;
  const lookGroupIds = Object.values(doc.layers).filter(isLookGroup);
  for (const g of lookGroupIds.filter((g) => g.meta?.lookPart === 'behind')) walk(g.childIds, 'behind');
  // Layers above the target (top level), then the regular look groups.
  if (target) {
    const top = topLevelOf(doc, target.id);
    const above = roots.slice(roots.indexOf(top) + 1);
    for (const rid of above) {
      const l = doc.layers[rid];
      if (!l || (l.type === 'group' && typeof l.meta?.lookId === 'string')) continue;
      if (l.type === 'group') walk(l.childIds, 'top');
      else take(l, 'top');
    }
  }
  for (const g of lookGroupIds.filter((g) => g.meta?.lookPart !== 'behind')) walk(g.childIds, 'top');
  look.swatch = [...new Set(colors)].slice(0, 4);
  if (!look.swatch.length) look.swatch = ['#2a2a2a', '#8a8a8a'];
  return {
    look,
    counts: {
      filters: look.layerFilters?.length ?? 0,
      effects: look.layerEffects?.length ?? 0,
      overlays: look.overlays!.length,
      adjustments: look.adjustments!.length,
    },
  };
}

/** Defensive parse of stored looks. Pure. */
export function parseUserLooks(raw: unknown): UserLook[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is UserLook => !!l && typeof l === 'object' && typeof (l as UserLook).id === 'string' && isUserLook((l as UserLook).id) && typeof (l as UserLook).name === 'string',
  ).map((l) => ({ ...l, category: USER_LOOK_CATEGORY, swatch: Array.isArray(l.swatch) && l.swatch.length ? l.swatch : ['#2a2a2a', '#8a8a8a'] }));
}

function readStore(): UserLook[] {
  try {
    return parseUserLooks(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function writeStore(list: UserLook[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    toast('Could not save your looks (storage is full or unavailable).', 'error');
    return false;
  }
}

/** Register the saved looks (called once at startup). */
export function loadUserLooks() {
  for (const l of readStore()) if (!looks.has(l.id)) looks.register(l as LookDef);
}

export function deleteUserLook(id: string) {
  if (!isUserLook(id)) return;
  const list = readStore().filter((l) => l.id !== id);
  if (writeStore(list)) {
    looks.unregister(id);
    toast('Look deleted.', 'info');
  }
}

export async function renameUserLook(id: string) {
  const cur = readStore().find((l) => l.id === id);
  if (!cur) return;
  const res = await promptSave({ title: 'Rename Look', confirm: 'Rename', defaultName: cur.name });
  if (!res) return;
  const list = readStore().map((l) => (l.id === id ? { ...l, name: res.name } : l));
  if (writeStore(list)) {
    looks.unregister(id);
    looks.register({ ...cur, name: res.name } as LookDef);
  }
}

/** Looks panel ▸ Save as Look…: capture the current target + look layers under a name. */
export async function saveCurrentLook(requestedTargetId: ID | null) {
  const s = activeSession();
  if (!s) return void toast('Open a document first.', 'info');
  const { targetId } = lookTargets(s.doc, requestedTargetId);
  const probe = captureLook(s.doc, targetId, '');
  const c = probe.counts;
  if (!c.filters && !c.effects && !c.overlays && !c.adjustments)
    return void toast('Nothing to save yet — style your character (smart filters, effects) or add overlays and adjustment layers above it.', 'info', 4600);
  const target = targetId ? s.doc.layers[targetId] : null;
  const parts = [
    c.filters && `${c.filters} smart filter${c.filters > 1 ? 's' : ''}`,
    c.effects && `${c.effects} effect${c.effects > 1 ? 's' : ''}`,
    c.overlays && `${c.overlays} overlay${c.overlays > 1 ? 's' : ''}`,
    c.adjustments && `${c.adjustments} adjustment${c.adjustments > 1 ? 's' : ''}`,
  ].filter(Boolean);
  const res = await promptSave({
    title: 'Save as Look',
    defaultName: `${s.doc.name} look`,
    description: `Saves ${parts.join(', ')}${target ? ` — from “${target.name}”, the layers above it and the look groups` : ' from the look groups'}. It appears under My Looks and applies like any look.`,
  });
  if (!res) return;
  const { look } = captureLook(s.doc, targetId, res.name);
  const entry: UserLook = { ...look, created: Date.now() };
  if (!writeStore([...readStore(), entry])) return;
  looks.register(entry as LookDef);
  toast(`Saved “${entry.name}” to My Looks.`, 'success');
}

