/** Framing helpers shared by Pose Studio and Model Import. */
import { useEffect, useRef, useState } from 'react';
import type { StudioScene } from './scene';
import type { Framing } from './types';

/**
 * The camera preset that last set the view angle. Mouse orbits switch the preset to 'custom';
 * those must not trigger an automatic re-frame (the view would jump after every drag).
 */
export function useStickyPreset(preset: string): string {
  const ref = useRef(preset);
  if (preset !== 'custom') ref.current = preset;
  return ref.current;
}

/**
 * Debounced check: does the framed content (character / model) reach past the frame edge with
 * the current camera? Re-evaluated after every state change (joint edits, accessories, zoom…).
 */
export function useFrameOverflow(scene: StudioScene | null, framing: Framing, aspect: number, version: unknown, enabled = true): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!scene || !enabled) {
      setOver(false);
      return;
    }
    const t = window.setTimeout(() => setOver(scene.frameExtent(framing, aspect) > 1.004), 160);
    return () => window.clearTimeout(t);
  }, [scene, framing, aspect, version, enabled]);
  return over;
}
