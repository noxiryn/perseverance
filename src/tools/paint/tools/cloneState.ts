/** Clone Stamp source state (shared by the tool and its options bar). */
import { viewport } from '../../../editor/viewport';
import { activeSession } from '../../../state/editor';

export interface CloneState {
  docId: string;
  /** Source point (doc px) set with Alt-click. */
  source: { x: number; y: number };
  /** Aligned offset (source − destination), set by the first stroke after defining the source. */
  offset: { x: number; y: number } | null;
}

let clone: CloneState | null = null;
const listeners = new Set<() => void>();

export function setCloneSource(s: CloneState | null) {
  clone = s;
  listeners.forEach((l) => l());
  viewport.requestOverlay();
}

/** The clone source for the active document, if any. */
export function cloneSource(): CloneState | null {
  const s = activeSession();
  return clone && s && clone.docId === s.doc.id ? clone : null;
}

export function clearCloneSource() {
  setCloneSource(null);
}

export function subscribeCloneSource(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
