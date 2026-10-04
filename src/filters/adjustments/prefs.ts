/** Adjustments panel preferences (persisted in localStorage). */
import { create } from 'zustand';

const KEY = 'perseverance.adjustments.prefs';

interface Prefs {
  /** New adjustment layers are clipped to the layer below (Photoshop "Clip to Layer by Default"). */
  clipByDefault: boolean;
  /** Show the "Adjustment Presets" quick list in the panel. */
  showPresets: boolean;
}

interface PrefsState extends Prefs {
  set(p: Partial<Prefs>): void;
}

function load(): Prefs {
  const def: Prefs = { clipByDefault: false, showPresets: true };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* ignore corrupt prefs */
  }
  return def;
}

export const useAdjustmentsPrefs = create<PrefsState>()((set, get) => ({
  ...load(),
  set(p) {
    set(p);
    try {
      const { clipByDefault, showPresets } = get();
      localStorage.setItem(KEY, JSON.stringify({ clipByDefault, showPresets }));
    } catch {
      /* storage unavailable */
    }
  },
}));
