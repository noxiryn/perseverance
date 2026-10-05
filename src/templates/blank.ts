/** Blank templates for the main Roblox formats (category 'Blank'). */
import type { TemplateDef } from '../registry';
import { defineTemplate } from './define';

interface BlankSpec {
  id: string;
  name: string;
  width: number;
  height: number;
  description: string;
  /** null = transparent canvas with an empty pixel layer. */
  background: string | null;
  /** Add center guides (round/square formats). */
  centerGuides?: boolean;
  swatch: string[];
}

const BLANKS: BlankSpec[] = [
  { id: 'tpl-blank-icon-1024', name: 'Roblox Icon 1024×1024', width: 1024, height: 1024, background: '#ffffff', centerGuides: true, description: 'Experience icon at full upload size.', swatch: ['#2b2b2b', '#f2f2f2'] },
  { id: 'tpl-blank-icon-512', name: 'Roblox Icon 512×512', width: 512, height: 512, background: '#ffffff', centerGuides: true, description: 'Experience icon (512 × 512).', swatch: ['#2b2b2b', '#e6e6e6'] },
  { id: 'tpl-blank-thumbnail-1920', name: 'Roblox Thumbnail 1920×1080', width: 1920, height: 1080, background: '#ffffff', description: 'Experience thumbnail, full HD 16:9.', swatch: ['#1f1f1f', '#f2f2f2'] },
  { id: 'tpl-blank-thumbnail-1280', name: 'Roblox Thumbnail 1280×720', width: 1280, height: 720, background: '#ffffff', description: 'Experience thumbnail, 1280 × 720.', swatch: ['#1f1f1f', '#e6e6e6'] },
  { id: 'tpl-blank-badge', name: 'Badge 512', width: 512, height: 512, background: null, centerGuides: true, description: 'Badge image — Roblox crops it to a circle.', swatch: ['#3b1670', '#ffd23f'] },
  { id: 'tpl-blank-gamepass', name: 'Game Pass 512', width: 512, height: 512, background: null, centerGuides: true, description: 'Game pass icon — shown as a circle.', swatch: ['#0f5e6e', '#7afcff'] },
  { id: 'tpl-blank-devproduct', name: 'Developer Product 512', width: 512, height: 512, background: null, centerGuides: true, description: 'Developer product icon.', swatch: ['#1e4bff', '#a9c8ff'] },
  { id: 'tpl-blank-group-emblem', name: 'Group Emblem 512', width: 512, height: 512, background: null, centerGuides: true, description: 'Community/group emblem.', swatch: ['#c9a24a', '#1e1630'] },
  { id: 'tpl-blank-tshirt', name: 'T-Shirt 512', width: 512, height: 512, background: null, description: 'Classic T-shirt decal (transparent).', swatch: ['#e63946', '#f4f4f4'] },
  { id: 'tpl-blank-ad-banner', name: 'Ad Banner 728×90', width: 728, height: 90, background: '#ffffff', description: 'Horizontal sponsored ad banner.', swatch: ['#ff9a1f', '#fff36b'] },
];

export const BLANK_TEMPLATES: TemplateDef[] = BLANKS.map((s) =>
  defineTemplate({
    id: s.id,
    name: s.name,
    category: 'Blank',
    description: s.description,
    width: s.width,
    height: s.height,
    swatch: s.swatch,
    background: s.background,
    build(b) {
      if (s.background) b.emptyRaster('Background', { color: s.background });
      else b.emptyRaster('Layer 1');
      if (s.centerGuides) {
        b.guide('vertical', s.width / 2);
        b.guide('horizontal', s.height / 2);
      }
    },
  }),
);
