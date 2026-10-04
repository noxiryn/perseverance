/**
 * Curated metadata for the bundled font families: category, vibe tags and preview samples.
 * Weights/italics come from the generated manifest (src/fonts/generated/faces.ts).
 */
import type { FontCategory } from '../registry';

export interface CatalogEntry {
  category: FontCategory;
  tags: string[];
  sample?: string;
}

/** Display order of categories in pickers and the Fonts panel. */
export const CATEGORY_ORDER: FontCategory[] = [
  'Blackletter',
  'Condensed',
  'Display',
  'Serif',
  'Sans',
  'Script',
  'Handwritten',
  'Grunge & Horror',
  'Typewriter & Mono',
  'Japanese',
  'Cartoon',
  'System',
];

/** Families that read great in Roblox thumbnails / icons / GFX. Order = display order. */
export const POPULAR_FAMILIES = [
  'UnifrakturMaguntia',
  'UnifrakturCook',
  'Anton',
  'Bebas Neue',
  'Oswald',
  'Cinzel',
  'Playfair Display',
  'Mrs Saint Delafield',
  'Bangers',
  'Luckiest Guy',
  'Creepster',
  'Lilita One',
  'Grenze Gotisch',
  'Pirata One',
  'League Gothic',
  'Teko',
  'Permanent Marker',
  'Great Vibes',
  'Titan One',
  'Fredoka',
  'Russo One',
  'Black Ops One',
  'Noto Serif JP',
  'Dela Gothic One',
];

export const CATALOG: Record<string, CatalogEntry> = {
  /* ---------------- Blackletter ---------------- */
  UnifrakturMaguntia: { category: 'Blackletter', tags: ['gothic title', 'blackletter', 'medieval', 'poster title'] },
  UnifrakturCook: { category: 'Blackletter', tags: ['gothic title', 'heavy blackletter', 'metal', 'tattoo'] },
  'Grenze Gotisch': { category: 'Blackletter', tags: ['gothic title', 'modern blackletter', 'fantasy', 'many weights'] },
  Fruktur: { category: 'Blackletter', tags: ['gothic title', 'fraktur', 'old german', 'rounded blackletter'] },
  'Pirata One': { category: 'Blackletter', tags: ['gothic title', 'pirate', 'condensed blackletter'] },
  'Germania One': { category: 'Blackletter', tags: ['gothic title', 'bold blackletter', 'logo'] },
  'Jacquard 24': { category: 'Blackletter', tags: ['pixel blackletter', 'retro game', 'gothic'] },
  'New Rocker': { category: 'Blackletter', tags: ['rock', 'tattoo', 'gothic logo'] },

  /* ---------------- Condensed ---------------- */
  Anton: { category: 'Condensed', tags: ['newspaper headline', 'huge name', 'thumbnail title', 'impact'] },
  'Bebas Neue': { category: 'Condensed', tags: ['newspaper headline', 'all caps', 'clean title'] },
  Oswald: { category: 'Condensed', tags: ['headline', 'subtitle', 'many weights'] },
  'League Gothic': { category: 'Condensed', tags: ['newspaper headline', 'tall', 'poster'] },
  'Barlow Condensed': { category: 'Condensed', tags: ['ui', 'stats', 'sport', 'many weights'] },
  'Roboto Condensed': { category: 'Condensed', tags: ['clean', 'captions', 'many weights'] },
  'Fjalla One': { category: 'Condensed', tags: ['headline', 'news', 'bold'] },
  Teko: { category: 'Condensed', tags: ['sport', 'gaming', 'squared', 'stats'] },
  'Big Shoulders Display': { category: 'Condensed', tags: ['industrial', 'poster', 'chicago', 'many weights'] },
  Staatliches: { category: 'Condensed', tags: ['stencil-ish caps', 'poster', 'retro headline'] },

  /* ---------------- Display ---------------- */
  'Abril Fatface': { category: 'Display', tags: ['fashion', 'magazine', 'high contrast'] },
  'Alfa Slab One': { category: 'Display', tags: ['slab', 'western', 'bold title'] },
  'Archivo Black': { category: 'Display', tags: ['heavy', 'punchy title', 'grotesque'] },
  Audiowide: { category: 'Display', tags: ['sci-fi', 'racing', 'futuristic'] },
  'Black Ops One': { category: 'Display', tags: ['military', 'stencil', 'shooter game'] },
  'Bowlby One': { category: 'Display', tags: ['ultra bold', 'sticker', 'loud'] },
  Bungee: { category: 'Display', tags: ['urban', 'signage', 'blocky'] },
  Orbitron: { category: 'Display', tags: ['sci-fi', 'space', 'tech', 'cyber'] },
  Righteous: { category: 'Display', tags: ['retro', 'groovy', 'rounded'] },
  'Russo One': { category: 'Display', tags: ['game logo', 'tech', 'bold'] },
  'Cinzel Decorative': { category: 'Display', tags: ['fantasy', 'epic title', 'roman decorative'] },

  /* ---------------- Serif ---------------- */
  Cinzel: { category: 'Serif', tags: ['roman numeral', 'epic quote', 'movie poster', 'elegant caps'] },
  'Playfair Display': { category: 'Serif', tags: ['elegant title', 'editorial', 'quote', 'italic'] },
  'Bodoni Moda': { category: 'Serif', tags: ['fashion', 'luxury', 'high contrast'] },
  'Cormorant Garamond': { category: 'Serif', tags: ['classic', 'book', 'delicate', 'quote'] },
  'DM Serif Display': { category: 'Serif', tags: ['headline serif', 'editorial', 'warm'] },
  'EB Garamond': { category: 'Serif', tags: ['book', 'old style', 'quote', 'newspaper body'] },
  'IM Fell English': { category: 'Serif', tags: ['antique print', 'old book', 'grungy serif'] },
  'Libre Baskerville': { category: 'Serif', tags: ['classic', 'newspaper body', 'readable'] },

  /* ---------------- Sans ---------------- */
  Inter: { category: 'Sans', tags: ['ui', 'clean', 'neutral', 'many weights'] },
  Montserrat: { category: 'Sans', tags: ['geometric', 'modern', 'many weights'] },
  Poppins: { category: 'Sans', tags: ['geometric', 'friendly', 'update log'] },
  Archivo: { category: 'Sans', tags: ['grotesque', 'versatile', 'many weights'] },

  /* ---------------- Script ---------------- */
  'Mrs Saint Delafield': { category: 'Script', tags: ['signature', 'subtitle', 'elegant script'] },
  'Monsieur La Doulaise': { category: 'Script', tags: ['signature', 'calligraphy', 'flourish'] },
  'Herr Von Muellerhoff': { category: 'Script', tags: ['signature', 'fast handwriting', 'autograph'] },
  'Great Vibes': { category: 'Script', tags: ['wedding', 'elegant script', 'title'] },
  Allura: { category: 'Script', tags: ['elegant script', 'invitation', 'soft'] },
  Parisienne: { category: 'Script', tags: ['casual script', 'romantic'] },
  'Pinyon Script': { category: 'Script', tags: ['copperplate', 'formal', 'classic script'] },
  'Dancing Script': { category: 'Script', tags: ['casual script', 'bouncy', 'friendly'] },

  /* ---------------- Handwritten ---------------- */
  Caveat: { category: 'Handwritten', tags: ['notes', 'casual', 'annotations'] },
  Kalam: { category: 'Handwritten', tags: ['marker', 'casual', 'readable'] },
  'Permanent Marker': { category: 'Handwritten', tags: ['marker', 'graffiti', 'bold handwriting'] },
  'Reenie Beanie': { category: 'Handwritten', tags: ['scribble', 'notebook', 'messy'] },
  'Rock Salt': { category: 'Handwritten', tags: ['grunge handwriting', 'rock', 'rough'] },

  /* ---------------- Grunge & Horror ---------------- */
  Creepster: { category: 'Grunge & Horror', tags: ['horror', 'halloween', 'dripping'] },
  Butcherman: { category: 'Grunge & Horror', tags: ['horror', 'slasher', 'cut'] },
  Eater: { category: 'Grunge & Horror', tags: ['horror', 'zombie', 'distressed'] },
  Nosifer: { category: 'Grunge & Horror', tags: ['horror', 'blood drip', 'wide'] },
  Frijole: { category: 'Grunge & Horror', tags: ['worn', 'western', 'rough stamp'] },
  'Metal Mania': { category: 'Grunge & Horror', tags: ['heavy metal', 'band logo', 'spiky'] },
  'Rubik Dirt': { category: 'Grunge & Horror', tags: ['grunge', 'dirty', 'textured'] },
  'Rubik Distressed': { category: 'Grunge & Horror', tags: ['grunge', 'distressed', 'stamp'] },
  'Rubik Wet Paint': { category: 'Grunge & Horror', tags: ['dripping paint', 'horror', 'graffiti'] },
  'Rubik Glitch': { category: 'Grunge & Horror', tags: ['glitch', 'cyber', 'broken'] },

  /* ---------------- Typewriter & Mono ---------------- */
  'Special Elite': { category: 'Typewriter & Mono', tags: ['typewriter', 'case file', 'noir', 'worn'] },
  'Courier Prime': { category: 'Typewriter & Mono', tags: ['typewriter', 'screenplay', 'report'] },
  'Space Mono': { category: 'Typewriter & Mono', tags: ['mono', 'retro tech', 'stats'] },
  'JetBrains Mono': { category: 'Typewriter & Mono', tags: ['code', 'mono', 'terminal'] },

  /* ---------------- Japanese ---------------- */
  'Noto Sans JP': { category: 'Japanese', tags: ['kanji', 'gothic', 'clean japanese'], sample: '最強の戦士' },
  'Noto Serif JP': { category: 'Japanese', tags: ['kanji', 'mincho', 'faint kanji behind title'], sample: '永遠の英雄' },
  'Shippori Mincho': { category: 'Japanese', tags: ['kanji', 'mincho', 'elegant'], sample: '鳥籠の物語' },
  'Zen Antique': { category: 'Japanese', tags: ['kanji', 'antique print', 'samurai'], sample: '侍の魂' },
  'Yuji Syuku': { category: 'Japanese', tags: ['kanji', 'brush calligraphy', 'ink'], sample: '運命の刻' },
  'Dela Gothic One': { category: 'Japanese', tags: ['kanji', 'ultra bold', 'anime title'], sample: '必殺技' },
  'Rampart One': { category: 'Japanese', tags: ['kanji', '3d outline', 'pop'], sample: 'ゲーム開始' },
  'Reggae One': { category: 'Japanese', tags: ['kanji', 'brush', 'action'], sample: '覚醒せよ' },

  /* ---------------- Cartoon ---------------- */
  Bangers: { category: 'Cartoon', tags: ['comic', 'action', 'superhero'] },
  'Luckiest Guy': { category: 'Cartoon', tags: ['simulator title', 'bubbly', 'kids game'] },
  'Lilita One': { category: 'Cartoon', tags: ['simulator title', 'game ui', 'bold rounded'] },
  Chewy: { category: 'Cartoon', tags: ['playful', 'candy', 'kids'] },
  Fredoka: { category: 'Cartoon', tags: ['rounded', 'friendly', 'game ui', 'many weights'] },
  'Baloo 2': { category: 'Cartoon', tags: ['rounded', 'friendly', 'tycoon'] },
  'Bubblegum Sans': { category: 'Cartoon', tags: ['bubbly', 'cute', 'pastel'] },
  'Titan One': { category: 'Cartoon', tags: ['simulator title', 'chunky', 'sticker'] },
  'Carter One': { category: 'Cartoon', tags: ['playful script', 'logo', 'retro cartoon'] },
  Sniglet: { category: 'Cartoon', tags: ['rounded', 'soft', 'cute'] },
};

/** Map an @fontsource metadata category to ours (for families not in the catalog). */
export function fallbackCategory(fsCategory: string | undefined): FontCategory {
  switch (fsCategory) {
    case 'serif':
      return 'Serif';
    case 'handwriting':
      return 'Handwritten';
    case 'monospace':
      return 'Typewriter & Mono';
    case 'display':
      return 'Display';
    default:
      return 'Sans';
  }
}

/** Default preview text for a category (used when the preview field is empty). */
export function defaultPreviewText(category: FontCategory, sample?: string): string {
  if (sample) return sample;
  switch (category) {
    case 'Blackletter':
    case 'Script':
      return 'Birdcage';
    case 'Condensed':
    case 'Sans':
    case 'Grunge & Horror':
      return 'THE EXTERMINATOR.';
    case 'Serif':
      return '"For their one and only hero."';
    case 'Typewriter & Mono':
      return 'CASE FILE No. 07';
    case 'Handwritten':
      return 'see you at midnight';
    case 'Cartoon':
      return 'MEGA SIMULATOR!';
    case 'Japanese':
      return '永遠の英雄';
    case 'Display':
      return 'ETERNITY';
    default:
      return 'The quick brown fox';
  }
}
