/** Document size presets for File ▸ New (docPresets registry). */
import type { DocPresetDef } from '../registry';

export const DOC_PRESETS: DocPresetDef[] = [
  // Roblox
  { id: 'roblox-icon-512', name: 'Game Icon', category: 'Roblox', width: 512, height: 512, description: 'Experience icon (512 × 512)' },
  { id: 'roblox-icon-1024', name: 'Game Icon (HD)', category: 'Roblox', width: 1024, height: 1024, description: 'Experience icon at full upload size' },
  { id: 'roblox-thumbnail-1920', name: 'Game Thumbnail', category: 'Roblox', width: 1920, height: 1080, description: 'Experience thumbnail, 16:9 full HD' },
  { id: 'roblox-thumbnail-1280', name: 'Thumbnail', category: 'Roblox', width: 1280, height: 720, description: 'Experience thumbnail, 16:9 HD' },
  { id: 'roblox-badge', name: 'Badge', category: 'Roblox', width: 512, height: 512, description: 'Badge image (displayed as a circle)' },
  { id: 'roblox-gamepass', name: 'Game Pass', category: 'Roblox', width: 512, height: 512, description: 'Game pass icon (displayed as a circle)' },
  { id: 'roblox-devproduct', name: 'Developer Product', category: 'Roblox', width: 512, height: 512, description: 'Developer product icon' },
  { id: 'roblox-group-emblem', name: 'Group Emblem', category: 'Roblox', width: 512, height: 512, description: 'Community / group emblem' },
  { id: 'roblox-event-thumbnail', name: 'Event Thumbnail', category: 'Roblox', width: 1920, height: 1080, description: 'Experience event thumbnail' },
  { id: 'roblox-ad-banner', name: 'Ad Banner', category: 'Roblox', width: 728, height: 90, description: 'Horizontal sponsored banner (728 × 90)' },
  { id: 'roblox-ad-skyscraper', name: 'Skyscraper Ad', category: 'Roblox', width: 160, height: 600, description: 'Vertical sponsored ad (160 × 600)' },
  { id: 'roblox-ad-rectangle', name: 'Rectangle Ad', category: 'Roblox', width: 300, height: 250, description: 'Rectangle sponsored ad (300 × 250)' },
  { id: 'roblox-tshirt', name: 'T-Shirt', category: 'Roblox', width: 512, height: 512, description: 'Classic T-shirt decal' },
  { id: 'roblox-shirt-template', name: 'Shirt / Pants Template', category: 'Roblox', width: 585, height: 559, description: 'Classic clothing template (585 × 559)' },
  // Social
  { id: 'social-youtube-thumbnail', name: 'YouTube Thumbnail', category: 'Social', width: 1280, height: 720, description: 'YouTube video thumbnail' },
  { id: 'social-discord-banner', name: 'Discord Banner', category: 'Social', width: 960, height: 540, description: 'Discord server banner' },
  { id: 'social-discord-icon', name: 'Discord Server Icon', category: 'Social', width: 512, height: 512, description: 'Discord server icon' },
  { id: 'social-x-header', name: 'X Header', category: 'Social', width: 1500, height: 500, description: 'X / Twitter profile header' },
  { id: 'social-square-post', name: 'Square Post', category: 'Social', width: 1080, height: 1080, description: 'Instagram / X square post' },
  { id: 'social-story', name: 'Story', category: 'Social', width: 1080, height: 1920, description: 'Vertical story / short (9:16)' },
  // Video
  { id: 'video-hd', name: 'HD 1080p', category: 'Video', width: 1920, height: 1080, description: 'Full HD video frame' },
  { id: 'video-4k', name: '4K UHD', category: 'Video', width: 3840, height: 2160, description: 'Ultra HD video frame' },
  // Print
  { id: 'print-a4-300', name: 'A4 (300 dpi)', category: 'Print', width: 2480, height: 3508, description: 'A4 portrait at 300 dpi' },
  // Common
  { id: 'common-1000', name: 'Square 1000', category: 'Common', width: 1000, height: 1000, description: '1000 × 1000 square' },
  { id: 'common-2048', name: 'Square 2048', category: 'Common', width: 2048, height: 2048, description: '2048 × 2048 square' },
];
