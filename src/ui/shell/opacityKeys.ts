/**
 * Photoshop number keys for layer opacity (used by the global key handler when the active tool
 * didn't take the key — paint tools use digits for their own opacity first):
 *   1…9 → 10…90 %, 0 → 100 %; two digits typed quickly set that exact value ("4","5" → 45 %,
 *   "0","0" → 0 %, "0","5" → 5 %). Shift+digits set Fill instead of Opacity.
 * The second digit of a pair merges into the first digit's history step.
 */
import { parentOf } from '../../core/document';
import type { Document, ID } from '../../core/types';
import { activeSession, useEditor } from '../../state/editor';
import { toast } from '../../state/ui';

/** Max delay between the two digits of a two-digit value. */
export const DIGIT_CHAIN_MS = 700;

export interface DigitChain {
  /** The pending first digit ('' when no pair is in progress). */
  digit: string;
  at: number;
  /** What the pending digit applies to (a pair never mixes Opacity/Fill or documents). */
  scope: string;
}

/**
 * Digit of a key event ('0'…'9'), or null. The produced character wins (main row, numpad with
 * NumLock on, other layouts); the physical main-row code is only a fallback so Shift+digit (key '#',
 * '%'…) still sets Fill. Numpad keys that don't produce a digit (NumLock off: End, PageDown, Home,
 * Insert…) are navigation keys, not digits.
 */
export function digitOf(e: Pick<KeyboardEvent, 'code' | 'key'>): string | null {
  const key = e.key ?? '';
  if (/^[0-9]$/.test(key)) return key;
  const m = /^Digit([0-9])$/.exec(e.code ?? '');
  return m ? m[1] : null;
}

/**
 * Pure step of the digit state machine. Returns the opacity (0…1) to apply, whether it completes a
 * two-digit pair (and so should merge into the previous step), and the next chain state.
 */
export function digitOpacity(prev: DigitChain | null, digit: string, scope: string, now: number): { value: number; pair: boolean; next: DigitChain } {
  if (prev && prev.digit && prev.scope === scope && now - prev.at <= DIGIT_CHAIN_MS) {
    return { value: Number(prev.digit + digit) / 100, pair: true, next: { digit: '', at: now, scope } };
  }
  const d = Number(digit);
  return { value: d === 0 ? 1 : d / 10, pair: false, next: { digit, at: now, scope } };
}

function insideLockedGroup(doc: Document, id: ID): boolean {
  for (let p = parentOf(doc, id), guard = 0; p && guard < 64; p = parentOf(doc, p), guard++) {
    if (doc.layers[p]?.locks.all) return true;
  }
  return false;
}

/** Selected layers (or the active one) that may change opacity: not locked, not inside a locked group. */
export function opacityTargets(doc: Document, selected: ID[], active: ID | null): { ids: ID[]; locked: ID | null } {
  const pool = selected.filter((id) => doc.layers[id]);
  if (!pool.length && active && doc.layers[active]) pool.push(active);
  const ids: ID[] = [];
  let locked: ID | null = null;
  for (const id of pool) {
    const l = doc.layers[id];
    const blocked = l.locks.all || insideLockedGroup(doc, id);
    if (blocked) locked ??= id;
    else ids.push(id);
  }
  return { ids, locked };
}

let chain: DigitChain | null = null;

/** Apply a digit key to the selected layers. Returns true when the key was used. */
export function applyOpacityDigit(digit: string, fill: boolean, now = Date.now()): boolean {
  const s = activeSession();
  if (!s) return false;
  const { ids, locked } = opacityTargets(s.doc, s.selectedLayerIds, s.activeLayerId);
  if (!ids.length) {
    if (locked) toast(`“${s.doc.layers[locked]?.name ?? 'The layer'}” is locked — unlock it to change its ${fill ? 'fill' : 'opacity'}`, 'info');
    return !!locked;
  }
  const scope = `${s.doc.id}|${fill ? 'fill' : 'opacity'}|${ids.join(',')}`;
  const step = digitOpacity(chain, digit, scope, now);
  chain = step.next;
  const label = fill ? 'Fill' : 'Opacity';
  useEditor.getState().commit(
    label,
    (d) => {
      for (const id of ids) {
        const l = d.layers[id];
        if (!l) continue;
        if (fill) l.fillOpacity = step.value;
        else l.opacity = step.value;
      }
    },
    step.pair ? { coalesce: true } : undefined,
  );
  return true;
}

/** Forget a pending first digit (tests / document switches). */
export function resetOpacityDigits() {
  chain = null;
}
