/**
 * Escape closes only the innermost open surface.
 *
 * Every open dialog, popover and dropdown/context menu registers an escape layer when it mounts
 * (stack order = opening order). Only the topmost layer reacts to Escape:
 *
 * - Floating surfaces (popovers, menus) are closed by this module (one window capture-phase and
 *   one document bubble-phase listener):
 *   - Escape from outside the surface (focus on the swatch that opened it, in the dialog behind
 *     it, or nowhere) closes it at once.
 *   - Escape from a control inside it goes to that control first: a field that uses the key
 *     (preventDefault — the font picker's search clears first) keeps the surface open; a number
 *     field reverts its typed text, then the surface closes. It closes when the key reaches the
 *     document unused, or — when a control stopped its propagation without using it (the colour
 *     picker's hex field stops every key) — right after the event's dispatch.
 *   Closing consumes the key (preventDefault + stopPropagation), so neither the dialog behind, the
 *   global shortcuts nor a tool's own Escape handling see it.
 * - Dialogs keep handling Escape in their own listener (Dialog.tsx) but only while they are the
 *   topmost layer — a popover opened from a dialog closes first, a second Escape closes the dialog.
 */

export interface EscapeLayer {
  /** 'floating': closed by this module; 'dialog': Dialog.tsx handles its own Escape. */
  kind: 'floating' | 'dialog';
  /** Close the surface (only called for floating layers). */
  close: () => void;
  /** Whether a node is part of the surface (keys from inside it are left to its controls first). */
  contains: (node: Node) => boolean;
}

const stack: EscapeLayer[] = [];
let installed = false;

/** Register an open surface; returns the function that unregisters it (call on close/unmount). */
export function pushEscapeLayer(layer: EscapeLayer): () => void {
  stack.push(layer);
  install();
  return () => {
    const i = stack.lastIndexOf(layer);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function topEscapeLayer(): EscapeLayer | null {
  return stack.length ? stack[stack.length - 1] : null;
}

export function isTopEscapeLayer(layer: EscapeLayer): boolean {
  return topEscapeLayer() === layer;
}

/** Number of open layers (tests / diagnostics). */
export function escapeLayerCount(): number {
  return stack.length;
}

function isEscape(e: KeyboardEvent) {
  return e.key === 'Escape' && !e.isComposing;
}

/** An Escape from inside the topmost floating surface, waiting for its controls to see it. */
interface Pending {
  e: KeyboardEvent;
  layer: EscapeLayer;
  done: boolean;
}
let pending: Pending | null = null;

/**
 * Close the surface a pending Escape came from unless one of its controls used the key (or the
 * surface closed / another opened on top meanwhile). `consume`: the event is still dispatching.
 */
function settle(p: Pending, consume: boolean) {
  if (p.done) return;
  p.done = true;
  if (pending === p) pending = null;
  if (p.e.defaultPrevented || !isTopEscapeLayer(p.layer)) return;
  if (consume) {
    p.e.preventDefault();
    p.e.stopPropagation();
  }
  p.layer.close();
}

/** Window, capture phase: runs before everything else. */
function onKeyCapture(e: KeyboardEvent) {
  if (!isEscape(e)) return;
  const top = topEscapeLayer();
  if (!top || top.kind !== 'floating') return;
  if (e.target instanceof Node && top.contains(e.target)) {
    // From inside: its controls see the key first (see the module comment).
    const p: Pending = { e, layer: top, done: false };
    pending = p;
    setTimeout(() => settle(p, false), 0);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  top.close();
}

/** Document, bubble phase: the key came back from the surface's controls unstopped. */
function onKeyBubble(e: KeyboardEvent) {
  const p = pending;
  if (p && p.e === e) settle(p, true);
}

/**
 * Whether `target` belongs to a surface registered after `layer` — opened from it (the colour
 * picker of a gradient stop) or on top of it. Such clicks are not "outside" `layer`.
 */
export function insideLaterLayer(layer: EscapeLayer, target: EventTarget | null): boolean {
  const i = stack.indexOf(layer);
  if (i < 0 || !(target instanceof Node)) return false;
  for (let j = i + 1; j < stack.length; j++) if (stack[j].contains(target)) return true;
  return false;
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyCapture, true);
  document.addEventListener('keydown', onKeyBubble);
}
