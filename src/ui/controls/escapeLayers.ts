/**
 * Escape closes only the innermost open surface.
 *
 * Every open dialog, popover and dropdown/context menu registers an escape layer when it mounts
 * (stack order = opening order). Only the topmost layer reacts to Escape:
 *
 * - Floating surfaces (popovers, menus) are closed by one shared window capture-phase listener
 *   when the key comes from outside the surface (focus on the swatch that opened it, in the
 *   dialog behind it, or nowhere), or by the surface's own root listener (`escapeFromInside`,
 *   bubble phase on the surface element) when it comes from a control inside it. That way a
 *   control that uses Escape itself (the font picker's search clears first) still gets it, and a
 *   field that stops key propagation in React (the hex input) can't swallow it: native listeners
 *   on the surface run before React's handlers at the portal container. Closing consumes the key
 *   (preventDefault + stopPropagation), so neither the dialog behind, the global shortcuts nor a
 *   tool's own Escape handling see it.
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

function consume(e: KeyboardEvent, layer: EscapeLayer) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  layer.close();
}

function isEscape(e: KeyboardEvent) {
  return e.key === 'Escape' && !e.isComposing;
}

/** The shared listener: the topmost floating surface closes on an Escape from outside it. */
function onKeyCapture(e: KeyboardEvent) {
  if (!isEscape(e)) return;
  const top = topEscapeLayer();
  if (!top || top.kind !== 'floating') return;
  // From inside the surface: its controls see the key first; escapeFromInside closes it after.
  if (e.target instanceof Node && top.contains(e.target)) return;
  consume(e, top);
}

/**
 * Bubble-phase keydown handler for a floating surface's root element: closes the surface on an
 * Escape from one of its controls, unless that control used the key itself (preventDefault /
 * stopPropagation before it got here) or a surface opened later is on top.
 */
export function escapeFromInside(layer: EscapeLayer, e: KeyboardEvent) {
  if (!isEscape(e) || e.defaultPrevented || !isTopEscapeLayer(layer)) return;
  consume(e, layer);
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
}
