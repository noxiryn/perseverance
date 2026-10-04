/**
 * All extension points of the editor. Feature modules import these registries and register
 * their definitions at module load. Nothing in here depends on feature code.
 */
import type { ComponentType, ReactNode } from 'react';
import type {
  BlendMode,
  Color,
  Document,
  Gradient,
  ID,
  LayerEffect,
  ParamDef,
  ParamValues,
  Point,
} from '../core/types';
import { Registry } from './registry';

export { Registry, useRegistry } from './registry';

/* ================================================================== */
/* Tools                                                               */
/* ================================================================== */

export interface ToolPointerEvent {
  /** Document-space coordinates (float). */
  docX: number;
  docY: number;
  /** Viewport-relative screen coordinates (CSS px). */
  screenX: number;
  screenY: number;
  button: number;
  buttons: number;
  shiftKey: boolean;
  altKey: boolean;
  /** ctrl on Windows/Linux, cmd on macOS */
  ctrlKey: boolean;
  pressure: number;
  pointerType: string;
  native: PointerEvent;
}

export interface ToolDef {
  id: string;
  name: string;
  /** Single-key shortcut, e.g. 'V', 'B'. Shift+key cycles tools within the same group. */
  shortcut?: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Toolbar slot. Tools sharing a group appear as a flyout in one slot. */
  group: string;
  /** Sort order of the group in the toolbar (lower = higher up). */
  order: number;
  /** CSS cursor (or function of current state). */
  cursor?: string | (() => string);
  /** Options bar contents for this tool. */
  OptionsBar?: ComponentType;
  /** Default options stored in the editor store under toolOptions[id]. */
  defaultOptions?: Record<string, unknown>;
  onActivate?(): void;
  onDeactivate?(): void;
  onPointerDown?(e: ToolPointerEvent): void;
  onPointerMove?(e: ToolPointerEvent): void;
  onPointerUp?(e: ToolPointerEvent): void;
  /** Pointer move while no button pressed. */
  onHover?(e: ToolPointerEvent): void;
  onDoubleClick?(e: ToolPointerEvent): void;
  /** Return true if handled (prevents global shortcut handling). */
  onKeyDown?(e: KeyboardEvent): boolean | void;
  onKeyUp?(e: KeyboardEvent): boolean | void;
  /**
   * Draw tool UI on the overlay canvas. The context is in SCREEN space (CSS px, DPR handled);
   * use viewport.docToScreen() to map document coordinates.
   */
  renderOverlay?(ctx: CanvasRenderingContext2D): void;
}

export const tools = new Registry<ToolDef>('tools');

/* ================================================================== */
/* Panels (dockable)                                                   */
/* ================================================================== */

export type DockSlot = 'top' | 'middle' | 'bottom' | 'strip';

export interface PanelDef {
  id: string;
  title: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  component: ComponentType;
  /** Default dock slot in the "Essentials" workspace. */
  defaultSlot: DockSlot;
  order?: number;
  /** Optional menu (⋯) items in the panel header. */
  menu?: () => { label: string; run: () => void; checked?: boolean; disabled?: boolean }[];
}

export const panels = new Registry<PanelDef>('panels');

/* ================================================================== */
/* Commands (menus, shortcuts, command palette)                        */
/* ================================================================== */

export interface CommandDef {
  id: string;
  label: string;
  /**
   * Menu path. Top-level menus: File, Edit, Image, Layer, Type, Select, Filter, Roblox, View,
   * Window, Help. Use '/' for submenus, e.g. 'Image/Adjustments'. Omit to show only in the palette.
   */
  menu?: string;
  /** Commands with the same group are clustered; separators are drawn between groups. */
  group?: string;
  order?: number;
  /** e.g. 'Ctrl+Shift+N', 'Ctrl+Alt+Z', 'Delete', 'F7'. 'Ctrl' maps to Cmd on macOS. */
  shortcut?: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  keywords?: string[];
  run(): void | Promise<void>;
  enabled?(): boolean;
  checked?(): boolean;
}

export const commands = new Registry<CommandDef>('commands');

export function runCommand(id: string) {
  const c = commands.get(id);
  if (!c) return console.warn(`Unknown command ${id}`);
  if (c.enabled && !c.enabled()) return;
  return c.run();
}

/* ================================================================== */
/* Filters & adjustments                                               */
/* ================================================================== */

export type FilterCategory =
  | 'Adjustments'
  | 'Color'
  | 'Stylize'
  | 'Comic & Print'
  | 'Blur'
  | 'Sharpen'
  | 'Distort'
  | 'Noise & Grain'
  | 'Light'
  | 'Artistic'
  | 'Retro & Glitch'
  | 'Roblox'
  | 'Other';

export interface FilterContext {
  /** Full document size. */
  docWidth: number;
  docHeight: number;
  /** Position of the image's top-left in document space (for doc-anchored patterns). */
  offsetX: number;
  offsetY: number;
  /**
   * Preview scale relative to document pixels (1 = full res). Size-based params (radius, dot
   * size…) should be multiplied by this so previews match the final render.
   */
  scale: number;
  /** Primary/secondary colors at the time of rendering. */
  primaryColor: Color;
  secondaryColor: Color;
}

export interface FilterDef {
  id: string;
  name: string;
  category: FilterCategory;
  description?: string;
  keywords?: string[];
  params: ParamDef[];
  /** Offer as an adjustment layer (Layer ▸ New Adjustment Layer) and in the Adjustments panel. */
  adjustment?: boolean;
  /** Icon for menus/panels. */
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  /**
   * Pure pixel operation. May modify `img` in place and return it, or return a new ImageData of
   * the SAME size. Must not depend on anything but its arguments (deterministic → cacheable).
   */
  apply(img: ImageData, params: ParamValues, ctx: FilterContext): ImageData;
}

export const filters = new Registry<FilterDef>('filters');

/* ================================================================== */
/* Layer effects (layer styles)                                         */
/* ================================================================== */

export interface EffectRenderArgs {
  /** Doc-sized (× scale) canvas containing the layer's rendered content; its alpha is the shape. */
  content: HTMLCanvasElement;
  params: ParamValues;
  /** Context of a doc-sized (× scale) canvas to draw the effect into. */
  target: CanvasRenderingContext2D;
  scale: number;
  docWidth: number;
  docHeight: number;
}

export interface EffectDef {
  id: string;
  name: string;
  params: ParamDef[];
  /** 'behind' effects are drawn under the content (shadows, outer glow, outside stroke);
   *  'above' effects are drawn over it and should be clipped to the content alpha. */
  stage: 'behind' | 'above';
  /** Order within stage (lower first). */
  order: number;
  render(args: EffectRenderArgs): void;
}

export const effects = new Registry<EffectDef>('effects');

/* ================================================================== */
/* Asset library                                                       */
/* ================================================================== */

export type AssetCategory =
  | 'Paper & Grunge'
  | 'Overlays'
  | 'Light & Glow'
  | 'Smoke & Atmosphere'
  | 'Comic & Halftone'
  | 'Borders & Frames'
  | 'Ornaments'
  | 'Splatter & Ink'
  | 'Backgrounds'
  | 'Particles'
  | 'Shapes'
  | 'Roblox'
  | 'My Assets';

export interface AssetGenerateContext {
  width: number;
  height: number;
}

export interface AssetDef {
  id: string;
  name: string;
  category: AssetCategory;
  tags?: string[];
  /**
   * 'document' assets fill the canvas (textures, overlays, borders) and are generated at document
   * size. 'element' assets are free-floating stickers with their own default size.
   */
  sizing: 'document' | { width: number; height: number };
  params: ParamDef[];
  /** Suggested layer blending when placed (e.g. overlay textures → 'multiply' / 'screen'). */
  defaultBlendMode?: BlendMode;
  defaultOpacity?: number;
  /** Render the asset at the requested size. Must be deterministic for the same params (use seed params). */
  generate(params: ParamValues, ctx: AssetGenerateContext): HTMLCanvasElement;
  /** Optional cheaper thumbnail renderer; defaults to generate() at small size. */
  thumbnail?(size: number): HTMLCanvasElement;
}

export const assets = new Registry<AssetDef>('assets');

/** Vector shape presets for the Custom Shape tool and the Shapes library. */
export interface ShapePresetDef {
  id: string;
  name: string;
  category: string;
  /** SVG path data (may contain multiple subpaths, nonzero fill). */
  path: string;
  viewBox: [number, number, number, number];
  /** Use evenodd fill rule. */
  evenOdd?: boolean;
}

export const shapePresets = new Registry<ShapePresetDef>('shapePresets');

/* ================================================================== */
/* Presets                                                             */
/* ================================================================== */

export interface GradientPresetDef {
  id: string;
  name: string;
  category: string;
  gradient: Gradient;
}
export const gradientPresets = new Registry<GradientPresetDef>('gradientPresets');

export interface PaletteDef {
  id: string;
  name: string;
  category?: string;
  colors: Color[];
}
export const palettes = new Registry<PaletteDef>('palettes');

/** Brush tip presets (shared by brush, eraser, dodge/burn, etc.). */
export interface BrushPresetDef {
  id: string;
  name: string;
  category: string;
  /** px */
  size: number;
  /** 0..1 (ignored for textured tips) */
  hardness: number;
  /** spacing as a fraction of size */
  spacing: number;
  /** 0..1 */
  flow: number;
  /** Random jitter amounts 0..1 */
  sizeJitter?: number;
  angleJitter?: number;
  scatter?: number;
  opacityJitter?: number;
  /** Tip angle (deg) and roundness (0..1). */
  angle?: number;
  roundness?: number;
  /** Optional textured tip generator (grayscale; white = paint). Called once and cached. */
  tip?: (size: number) => HTMLCanvasElement;
}
export const brushPresets = new Registry<BrushPresetDef>('brushPresets');

/**
 * A "Look" is a one-click style preset. Declarative parts are applied by the presets engine:
 *  - layerFilters/layerEffects are added to the target layer (e.g. a Roblox character),
 *  - adjustments are added as adjustment layers above the target (or at the top),
 *  - overlays are generated assets placed at the top of the document.
 * `apply` may implement anything custom instead.
 */
export interface LookDef {
  id: string;
  name: string;
  category: string;
  description?: string;
  /** Colors used to draw the preview chip. */
  swatch: Color[];
  layerFilters?: { filterId: string; params?: ParamValues }[];
  layerEffects?: { effectId: string; params?: ParamValues }[];
  adjustments?: { filterId: string; params?: ParamValues; name?: string; blendMode?: BlendMode; opacity?: number }[];
  overlays?: { assetId: string; params?: ParamValues; blendMode?: BlendMode; opacity?: number; name?: string }[];
  apply?(targetLayerId: ID | null): void | Promise<void>;
}
export const looks = new Registry<LookDef>('looks');

export interface TemplateDef {
  id: string;
  name: string;
  category: 'Thumbnail' | 'Icon' | 'Banner' | 'Social' | 'Blank';
  description?: string;
  width: number;
  height: number;
  /** Preview colors / accent for the template card. */
  swatch?: Color[];
  /** Build the document (fill layers, text, assets…). Return the finished document. */
  build(): Document | Promise<Document>;
}
export const templates = new Registry<TemplateDef>('templates');

/** Document size presets for File ▸ New. */
export interface DocPresetDef {
  id: string;
  name: string;
  category: 'Roblox' | 'Social' | 'Video' | 'Print' | 'Common';
  width: number;
  height: number;
  description?: string;
}
export const docPresets = new Registry<DocPresetDef>('docPresets');

/* ================================================================== */
/* Fonts                                                               */
/* ================================================================== */

export type FontCategory =
  | 'Blackletter'
  | 'Condensed'
  | 'Display'
  | 'Serif'
  | 'Sans'
  | 'Script'
  | 'Handwritten'
  | 'Grunge & Horror'
  | 'Typewriter & Mono'
  | 'Japanese'
  | 'Cartoon'
  | 'System';

export interface FontDef {
  /** id = CSS font-family name */
  id: string;
  family: string;
  category: FontCategory;
  weights: number[];
  italic?: boolean;
  source: 'bundled' | 'system' | 'user';
  /** Short description of the vibe ("gothic title", "newspaper headline"…). */
  tags?: string[];
  /** Sample text override for previews (e.g. Japanese fonts). */
  sample?: string;
}
export const fonts = new Registry<FontDef>('fonts');

/* ================================================================== */
/* Misc extension points                                               */
/* ================================================================== */

/** Overlays drawn by the viewport above the document (guides, safe zones…), independent of tools. */
export interface ViewOverlayDef {
  id: string;
  order: number;
  /** Return false to skip (e.g. when hidden in View menu). */
  enabled(): boolean;
  render(ctx: CanvasRenderingContext2D): void;
}
export const viewOverlays = new Registry<ViewOverlayDef>('viewOverlays');

/** Dialogs/side features that want a slot in the status bar (right side). */
export interface StatusItemDef {
  id: string;
  order: number;
  component: ComponentType;
}
export const statusItems = new Registry<StatusItemDef>('statusItems');

/** Layer-type specific property editors shown in the Properties panel. */
export interface PropertiesSectionDef {
  id: string;
  order: number;
  title: string;
  /** Return true when the section applies to the active layer. */
  appliesTo(layerId: ID): boolean;
  component: ComponentType<{ layerId: ID }>;
}
export const propertiesSections = new Registry<PropertiesSectionDef>('propertiesSections');

/** Helper type for things rendered in menus. */
export type MenuNode = { label: string; children?: MenuNode[]; command?: CommandDef; render?: () => ReactNode };

export type { Point, LayerEffect };
