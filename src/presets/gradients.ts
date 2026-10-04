/**
 * Gradient presets (`gradientPresets` registry). "Gradient Maps" run dark → light so they map
 * luminance sensibly when used with the gradient-map adjustment (ref2's amber look = Sunset Amber).
 */
import type { Gradient, GradientKind } from '../core/types';
import type { GradientPresetDef } from '../registry';

type Stops = [number, string][];

function g(stops: Stops, kind: GradientKind = 'linear', angle = 0): Gradient {
  return { kind, angle, scale: 1, stops: stops.map(([offset, color]) => ({ offset, color })) };
}

function preset(id: string, name: string, category: string, gradient: Gradient): GradientPresetDef {
  return { id, name, category, gradient };
}

const MAPS = 'Gradient Maps';
const DUO = 'Duotones';
const LIGHT = 'Light';
const METAL = 'Metals';
const FADE = 'Fades';
const VIVID = 'Vivid';

export const GRADIENT_PRESETS: GradientPresetDef[] = [
  /* ---------------- Gradient maps (dark → light) ---------------- */
  preset('gm-noir', 'Noir', MAPS, g([[0, '#050505'], [0.35, '#2b2b2b'], [0.72, '#b8b6b1'], [1, '#f5f2ea']])),
  preset('gm-sunset-amber', 'Sunset Amber', MAPS, g([[0, '#1c0a03'], [0.22, '#561d07'], [0.48, '#c24f0e'], [0.74, '#f1993a'], [1, '#fde9c4']])),
  preset('gm-crimson', 'Crimson', MAPS, g([[0, '#050000'], [0.32, '#470006'], [0.64, '#c4141c'], [0.86, '#ff6a5a'], [1, '#ffe2da']])),
  preset('gm-royal-violet', 'Royal Violet', MAPS, g([[0, '#0b0420'], [0.38, '#3b1a7a'], [0.72, '#8b7cf6'], [1, '#f0eaff']])),
  preset('gm-toxic', 'Toxic', MAPS, g([[0, '#020a02'], [0.38, '#1f4d0a'], [0.72, '#7fe62a'], [1, '#f2ffd2']])),
  preset('gm-ice', 'Ice', MAPS, g([[0, '#020814'], [0.38, '#12406b'], [0.72, '#6cc4f0'], [1, '#f2fbff']])),
  preset('gm-gold', 'Gold', MAPS, g([[0, '#140b00'], [0.34, '#5c3a06'], [0.7, '#d4a237'], [1, '#fff4cf']])),
  preset('gm-sepia', 'Sepia', MAPS, g([[0, '#1a1008'], [0.5, '#8a6a43'], [1, '#f3e6cc']])),
  preset('gm-teal-orange', 'Teal & Orange', MAPS, g([[0, '#031417'], [0.34, '#11555f'], [0.66, '#e38b4f'], [1, '#fff1de']])),
  preset('gm-vaporwave', 'Vaporwave', MAPS, g([[0, '#1a0533'], [0.35, '#6b2fa6'], [0.66, '#ff5fb6'], [1, '#9ff6ff']])),
  preset('gm-inferno', 'Inferno', MAPS, g([[0, '#000004'], [0.25, '#420a68'], [0.5, '#932667'], [0.72, '#dd513a'], [0.88, '#fca50a'], [1, '#fcffa4']])),
  preset('gm-blood-moon', 'Blood Moon', MAPS, g([[0, '#050101'], [0.4, '#3d0505'], [0.7, '#a3200f'], [0.88, '#ff6a2b'], [1, '#ffe2c2']])),
  preset('gm-ocean', 'Ocean', MAPS, g([[0, '#00060f'], [0.4, '#023e7d'], [0.75, '#0096c7'], [1, '#caf0f8']])),
  preset('gm-forest', 'Forest', MAPS, g([[0, '#030a05'], [0.4, '#1b4332'], [0.72, '#52b788'], [1, '#e9f5db']])),
  preset('gm-neon', 'Neon', MAPS, g([[0, '#05010f'], [0.32, '#3a0ca3'], [0.62, '#f72585'], [1, '#fff3b0']])),
  preset('gm-cyber', 'Cyber', MAPS, g([[0, '#04000f'], [0.32, '#2b0a5e'], [0.58, '#e0158f'], [0.8, '#19d3f5'], [1, '#eaffff']])),
  preset('gm-rose', 'Rose', MAPS, g([[0, '#14040a'], [0.45, '#8c2f4f'], [0.8, '#f2a7bf'], [1, '#fff0f4']])),
  preset('gm-bronze', 'Bronze', MAPS, g([[0, '#120a04'], [0.4, '#5e3a1c'], [0.75, '#c08a52'], [1, '#f6e2c6']])),
  preset('gm-midnight', 'Midnight', MAPS, g([[0, '#000005'], [0.5, '#1b2a4a'], [1, '#c9d6f0']])),
  preset('gm-cold-steel', 'Cold Steel', MAPS, g([[0, '#05080b'], [0.5, '#4a5a68'], [1, '#e6eef4']])),
  preset('gm-faded-film', 'Faded Film', MAPS, g([[0, '#2a2522'], [0.5, '#8a7f74'], [1, '#efe6d6']])),
  preset('gm-infrared', 'Infrared', MAPS, g([[0, '#1a0010'], [0.4, '#b0174a'], [0.75, '#ffb36b'], [1, '#fff7e8']])),
  preset('gm-night-vision', 'Night Vision', MAPS, g([[0, '#000a00'], [0.5, '#0f6b1c'], [0.85, '#7dff7a'], [1, '#e8ffe0']])),
  preset('gm-paper-ink', 'Paper & Ink', MAPS, g([[0, '#0b0b0b'], [0.45, '#3a3836'], [0.62, '#d8d2c4'], [1, '#efebe2']])),

  /* ---------------- Duotones ---------------- */
  preset('duo-violet-gold', 'Violet & Gold', DUO, g([[0, '#2b1055'], [1, '#f6c453']])),
  preset('duo-navy-peach', 'Navy & Peach', DUO, g([[0, '#0e1b3d'], [1, '#ffb38a']])),
  preset('duo-black-red', 'Black & Red', DUO, g([[0, '#0a0a0a'], [1, '#e01b24']])),
  preset('duo-blue-pink', 'Blue & Pink', DUO, g([[0, '#1b2b8f'], [1, '#ff7ab6']])),
  preset('duo-green-yellow', 'Green & Yellow', DUO, g([[0, '#0b3d2e'], [1, '#f9e94e']])),
  preset('duo-purple-cyan', 'Purple & Cyan', DUO, g([[0, '#3a0ca3'], [1, '#4cc9f0']])),
  preset('duo-maroon-cream', 'Maroon & Cream', DUO, g([[0, '#3b0a0a'], [1, '#f6ead2']])),
  preset('duo-charcoal-orange', 'Charcoal & Orange', DUO, g([[0, '#1f1f1f'], [1, '#ff7a00']])),
  preset('duo-teal-coral', 'Teal & Coral', DUO, g([[0, '#044e54'], [1, '#ff8a7a']])),
  preset('duo-ink-paper', 'Ink & Paper', DUO, g([[0, '#111111'], [1, '#f5f1e8']])),

  /* ---------------- Light ---------------- */
  preset('light-sunlight', 'Sunlight', LIGHT, g([[0, '#ffffff'], [0.35, '#fff1b8'], [0.7, '#ffb347'], [1, '#ff7a1a00']], 'radial')),
  preset('light-moonlight', 'Moonlight', LIGHT, g([[0, '#ffffff'], [0.4, '#cfe3ff'], [1, '#2a4a8a00']], 'radial')),
  preset('light-golden-hour', 'Golden Hour', LIGHT, g([[0, '#fff6d8'], [0.45, '#ffc46b'], [1, '#d9480f']], 'linear', 90)),
  preset('light-spotlight', 'Spotlight', LIGHT, g([[0, '#ffffffff'], [0.25, '#ffffffb3'], [1, '#ffffff00']], 'radial')),
  preset('light-halo', 'Halo', LIGHT, g([[0, '#ffffff00'], [0.55, '#ffffff00'], [0.72, '#fff7d6e6'], [0.85, '#ffffff00'], [1, '#ffffff00']], 'radial')),
  preset('light-neon-glow', 'Neon Glow', LIGHT, g([[0, '#ffffff'], [0.2, '#ff4fd8'], [1, '#7a00ff00']], 'radial')),
  preset('light-god-rays', 'God Rays', LIGHT, g([[0, '#fffbe6'], [0.5, '#ffe9a6aa'], [1, '#ffd36b00']], 'linear', 75)),

  /* ---------------- Metals ---------------- */
  preset('metal-silver', 'Silver', METAL, g([[0, '#f4f4f4'], [0.45, '#a9a9a9'], [0.5, '#8a8a8a'], [0.55, '#d8d8d8'], [1, '#6e6e6e']], 'linear', 90)),
  preset('metal-chrome', 'Chrome', METAL, g([[0, '#ffffff'], [0.3, '#9aa3ad'], [0.48, '#f7f9fb'], [0.5, '#2c2f33'], [0.7, '#8d96a0'], [1, '#ffffff']], 'linear', 90)),
  preset('metal-gold', 'Gold', METAL, g([[0, '#fff1b0'], [0.25, '#f5d77b'], [0.5, '#a8791f'], [0.75, '#f0c75e'], [1, '#7a5a13']], 'linear', 90)),
  preset('metal-bronze', 'Bronze', METAL, g([[0, '#f3c99a'], [0.35, '#b07035'], [0.55, '#6e3f17'], [0.8, '#c88a4a'], [1, '#5a3010']], 'linear', 90)),
  preset('metal-copper', 'Copper', METAL, g([[0, '#ffd2b0'], [0.4, '#c56b3c'], [0.6, '#7a3517'], [1, '#e08b5b']], 'linear', 90)),
  preset('metal-rose-gold', 'Rose Gold', METAL, g([[0, '#ffe3dc'], [0.4, '#e3a196'], [0.6, '#b76e79'], [1, '#f6cfc7']], 'linear', 90)),
  preset('metal-gunmetal', 'Gunmetal', METAL, g([[0, '#8b97a3'], [0.45, '#3b444d'], [0.55, '#2a3138'], [1, '#68737e']], 'linear', 90)),
  preset('metal-titanium', 'Titanium', METAL, g([[0, '#e8ecef'], [0.5, '#9aa5ad'], [0.52, '#7c8790'], [1, '#d3d9de']], 'linear', 90)),

  /* ---------------- Fades (color → transparent) ---------------- */
  preset('fade-black', 'Black Fade', FADE, g([[0, '#000000ff'], [1, '#00000000']])),
  preset('fade-white', 'White Fade', FADE, g([[0, '#ffffffff'], [1, '#ffffff00']])),
  preset('fade-red', 'Crimson Fade', FADE, g([[0, '#c4141cff'], [1, '#c4141c00']])),
  preset('fade-amber', 'Amber Fade', FADE, g([[0, '#f08a2cff'], [1, '#f08a2c00']])),
  preset('fade-violet', 'Violet Fade', FADE, g([[0, '#6f63c9ff'], [1, '#6f63c900']])),
  preset('fade-smoke', 'Smoke', FADE, g([[0, '#3a3a3acc'], [0.6, '#5a5a5a55'], [1, '#80808000']])),
  preset('fade-vignette', 'Vignette', FADE, g([[0, '#00000000'], [0.55, '#00000000'], [1, '#000000e6']], 'radial')),
  preset('fade-bottom-shadow', 'Bottom Shadow', FADE, g([[0, '#00000000'], [0.5, '#00000033'], [1, '#000000d9']], 'linear', 90)),

  /* ---------------- Vivid ---------------- */
  preset('vivid-rainbow', 'Rainbow', VIVID, g([[0, '#ff0000'], [0.17, '#ff8a00'], [0.33, '#ffe600'], [0.5, '#14e81e'], [0.67, '#00a2ff'], [0.83, '#6a00ff'], [1, '#ff00c8']])),
  preset('vivid-sunset', 'Sunset', VIVID, g([[0, '#ff512f'], [1, '#dd2476']])),
  preset('vivid-lava', 'Lava', VIVID, g([[0, '#3a0000'], [0.4, '#d31027'], [0.75, '#ff7a00'], [1, '#ffe259']])),
  preset('vivid-aurora', 'Aurora', VIVID, g([[0, '#00c9a7'], [0.5, '#845ec2'], [1, '#ff6f91']])),
  preset('vivid-candy', 'Candy', VIVID, g([[0, '#ff9a9e'], [0.5, '#fecfef'], [1, '#a1c4fd']])),
  preset('vivid-electric', 'Electric', VIVID, g([[0, '#00f260'], [1, '#0575e6']])),
  preset('vivid-fire', 'Fire', VIVID, g([[0, '#f12711'], [1, '#f5af19']])),
  preset('vivid-deep-space', 'Deep Space', VIVID, g([[0, '#000428'], [1, '#004e92']])),
  preset('vivid-toxic-slime', 'Toxic Slime', VIVID, g([[0, '#a8ff00'], [1, '#00b36b']])),
  preset('vivid-galaxy', 'Galaxy', VIVID, g([[0, '#0f0c29'], [0.5, '#302b63'], [1, '#e94bff']])),
];

export const GRADIENT_CATEGORIES = [MAPS, DUO, LIGHT, METAL, FADE, VIVID];
