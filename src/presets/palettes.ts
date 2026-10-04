/**
 * Built-in palettes (`palettes` registry). The default "Swatches" palette is registered first —
 * Photoshop-like: a gray ramp, then pastel / pure / deep hue rows (as in the UI reference).
 */
import type { PaletteDef } from '../registry';

const hues = (s: number, l: number, n = 12) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(hsl((i * 360) / n, s, l));
  return out;
};

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const grayRamp = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const v = Math.round((i / (n - 1)) * 255)
      .toString(16)
      .padStart(2, '0');
    return `#${v}${v}${v}`;
  });

export const DEFAULT_PALETTE_ID = 'swatches';

export const BUILTIN_PALETTES: PaletteDef[] = [
  {
    id: DEFAULT_PALETTE_ID,
    name: 'Swatches',
    category: 'Default',
    colors: [
      ...grayRamp(12),
      ...hues(1, 0.8),
      ...hues(1, 0.5),
      ...hues(1, 0.35),
      ...hues(0.55, 0.22),
    ],
  },

  /* ---------------- Reference styles ---------------- */
  {
    id: 'gothic-paper',
    name: 'Gothic Paper',
    category: 'Reference Styles',
    colors: ['#0b0b0b', '#1c1c1f', '#3a3a40', '#2a2440', '#6f63c9', '#8f87d6', '#b9b2e6', '#ece8df', '#d8d2c4', '#a89f8f', '#5a4a3a', '#8b6a4a', '#b98a5e', '#e7d3b0'],
  },
  {
    id: 'amber-halftone',
    name: 'Amber Halftone',
    category: 'Reference Styles',
    colors: ['#1c0a03', '#3d1606', '#6b2a0b', '#8b1a0a', '#a8410f', '#c4500f', '#d8641b', '#f08a2c', '#f6b04f', '#fbd27f', '#fde9c4', '#fff6e0'],
  },
  {
    id: 'noir-press',
    name: 'Noir Press',
    category: 'Reference Styles',
    colors: ['#000000', '#111111', '#222222', '#3a3a3a', '#555555', '#777777', '#999999', '#bbbbbb', '#d9d7d2', '#eeece6', '#f6f4ef', '#ffffff'],
  },
  {
    id: 'crimson-film',
    name: 'Crimson Film',
    category: 'Reference Styles',
    colors: ['#050505', '#140405', '#2b0508', '#5c0a10', '#8f0f17', '#c4141c', '#e5262f', '#ff4a4a', '#ff8c7a', '#e6763a', '#f0c9a0', '#f2f2f2'],
  },

  /* ---------------- Themes ---------------- */
  {
    id: 'classic-bricks',
    name: 'Classic Bricks',
    category: 'Themes',
    colors: ['#f2f3f3', '#a1a5a2', '#6c6e68', '#1b2a35', '#c4281c', '#da8541', '#f5cd30', '#4b974b', '#287f47', '#0d69ac', '#6b327c', '#ff66cc', '#cc8e69', '#694028', '#9ff3e9', '#b1a7ff', '#ffc9c9', '#f8d96d'],
  },
  {
    id: 'neon-arcade',
    name: 'Neon Arcade',
    category: 'Themes',
    colors: ['#0d0221', '#1a0b3d', '#2d1b69', '#ff2bd6', '#b026ff', '#00f0ff', '#39ff14', '#fffb00', '#ff6b00', '#ff003c', '#ffffff'],
  },
  {
    id: 'pastel-sim',
    name: 'Pastel Sim',
    category: 'Themes',
    colors: ['#ffd1dc', '#f9c6c9', '#ffdac1', '#ffe5b4', '#fffacd', '#e2f0cb', '#d4f0c0', '#b5ead7', '#c1e7e3', '#c9d6ff', '#c7ceea', '#e0c3fc'],
  },
  {
    id: 'horror',
    name: 'Horror',
    category: 'Themes',
    colors: ['#000000', '#0d0d0d', '#1f1a17', '#3b2f2a', '#5c0a0a', '#8a0303', '#b30000', '#3d4a2a', '#6b6b4d', '#7a7a7a', '#c2b280', '#e8e0c8'],
  },
  {
    id: 'anime-action',
    name: 'Anime Action',
    category: 'Themes',
    colors: ['#1d1d2c', '#2b2d42', '#ff3d3d', '#ff7a1a', '#ffb800', '#ffe94d', '#00d084', '#2ec4ff', '#1a73e8', '#8c52ff', '#ff66c4', '#f7f7ff'],
  },
  {
    id: 'toxic',
    name: 'Toxic',
    category: 'Themes',
    colors: ['#0a1a05', '#1f3d0a', '#3c7a12', '#6fd11a', '#a8ff3e', '#e4ff7a', '#f5ff3b', '#2b2b2b', '#5b2a86', '#a020f0'],
  },
  {
    id: 'royal',
    name: 'Royal',
    category: 'Themes',
    colors: ['#0f0f1a', '#1a0b3d', '#2e1065', '#4c1d95', '#6d28d9', '#8b7cf6', '#c4b5fd', '#7f1d1d', '#8a6414', '#d4a237', '#f5d061', '#f8f4e3'],
  },
  {
    id: 'ice',
    name: 'Ice',
    category: 'Themes',
    colors: ['#020814', '#0b2545', '#13315c', '#1e5f8c', '#3fa7d6', '#7fd1f5', '#bde9fb', '#e8f8ff', '#ffffff', '#a0b4c8', '#5c7a99'],
  },
  {
    id: 'desert',
    name: 'Desert',
    category: 'Themes',
    colors: ['#3b2414', '#6b4226', '#a0673a', '#c98b4f', '#e0b07a', '#f2d3a2', '#f7e7c6', '#d96c3b', '#8a9a5b', '#556b2f', '#87a8c9'],
  },
  {
    id: 'forest',
    name: 'Forest',
    category: 'Themes',
    colors: ['#0b1a0f', '#1b3022', '#2d4a33', '#3f6b45', '#5c8d55', '#8cb369', '#c7d59f', '#6b4f2c', '#8a6a43', '#d9c8a0'],
  },
  {
    id: 'ocean',
    name: 'Ocean',
    category: 'Themes',
    colors: ['#03045e', '#023e8a', '#0077b6', '#0096c7', '#00b4d8', '#48cae4', '#90e0ef', '#ade8f4', '#caf0f8', '#f1faee'],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    category: 'Themes',
    colors: ['#1d1135', '#3c1642', '#6b1e5a', '#a6255e', '#e0475d', '#f47c48', '#f9a03f', '#fbc760', '#ffe29a', '#fff3d6'],
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    category: 'Themes',
    colors: ['#0b0c10', '#091833', '#133e7c', '#1f2833', '#711c91', '#ea00d9', '#ff003c', '#0abdc6', '#00f0ff', '#fcee0a'],
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    category: 'Themes',
    colors: ['#2d1b4e', '#8795e8', '#ad8cff', '#b967ff', '#ff71ce', '#ff9de2', '#01cdfe', '#94d0ff', '#05ffa1', '#fffb96'],
  },
  {
    id: 'comic-pop',
    name: 'Comic Pop',
    category: 'Themes',
    colors: ['#000000', '#ffffff', '#ffde00', '#ff3b3b', '#0057ff', '#00b050', '#ff8fab', '#ff7a00', '#7a3cff', '#f5f1e8'],
  },
  {
    id: 'earth',
    name: 'Earth',
    category: 'Themes',
    colors: ['#3d2b1f', '#5c4033', '#7b5e3b', '#a0785a', '#c2a878', '#d9c5a0', '#b5651d', '#8b8c5a', '#6b7a3c', '#4a5d23'],
  },

  /* ---------------- Utility ---------------- */
  { id: 'grayscale-ramp', name: 'Grayscale Ramp', category: 'Utility', colors: grayRamp(16) },
  {
    id: 'skin-tones',
    name: 'Skin Tones',
    category: 'Utility',
    colors: ['#ffe9d6', '#ffdbac', '#f9dcc4', '#f2c6a0', '#f1c27d', '#e0ac69', '#d6a77a', '#c68642', '#b07a4f', '#8d5524', '#7a4a2b', '#613d24', '#4a2c1a', '#f5cd30'],
  },
  {
    id: 'metallics',
    name: 'Metallics',
    category: 'Utility',
    colors: ['#fff1b0', '#ffd700', '#d4af37', '#b8860b', '#b5a642', '#e5e4e2', '#dbe4eb', '#c0c0c0', '#8c8c8c', '#2a3439', '#cd7f32', '#b87333', '#b76e79'],
  },
  { id: 'rainbow-hues', name: 'Hue Wheel', category: 'Utility', colors: [...hues(1, 0.5, 24)] },
];
