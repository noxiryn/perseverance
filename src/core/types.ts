/**
 * Core document model for Perseverance.
 *
 * The document is a plain, immutable JSON tree (updated with immer). Pixel data is NOT stored
 * in the document: raster layers, masks and selections reference bitmaps by id in the
 * BitmapStore (see ./bitmaps.ts). Bitmaps are mutated only through history patches, so any
 * historical document snapshot remains valid.
 *
 * Coordinate system: document pixels, origin top-left, +x right, +y down. Angles in degrees.
 * Colors are CSS hex strings: '#rrggbb' or '#rrggbbaa'.
 */

export type ID = string;
export type Color = string;

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Blend modes                                                         */
/* ------------------------------------------------------------------ */

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** Groups additionally support pass-through (children blend directly into what is below). */
export type GroupBlendMode = BlendMode | 'pass-through';

/* ------------------------------------------------------------------ */
/* Parameters (shared by filters, adjustments, effects, assets, tools) */
/* ------------------------------------------------------------------ */

export interface GradientStop {
  /** 0..1 */
  offset: number;
  color: Color;
}

export type GradientKind = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export interface Gradient {
  kind: GradientKind;
  stops: GradientStop[];
  /** degrees, 0 = left→right, 90 = top→bottom */
  angle: number;
  /** 1 = spans the whole target box */
  scale: number;
  reverse?: boolean;
  /** Center offset as a fraction of the box (-1..1). */
  offsetX?: number;
  offsetY?: number;
}

/** Curve control points in 0..255 space, sorted by x. */
export type CurvePoints = [number, number][];
export interface CurvesValue {
  rgb: CurvePoints;
  r: CurvePoints;
  g: CurvePoints;
  b: CurvePoints;
}

export type ParamValue = number | boolean | string | Gradient | CurvesValue | Point | number[] | null;
export type ParamValues = Record<string, ParamValue>;

interface ParamBase {
  key: string;
  label: string;
  /** Optional grouping header in auto-generated UIs. */
  group?: string;
  hint?: string;
  /** Hide the control when this returns false. */
  showIf?: (values: ParamValues) => boolean;
}

export type ParamDef =
  | (ParamBase & {
      type: 'number';
      min: number;
      max: number;
      step?: number;
      default: number;
      unit?: string;
      /** Display multiplier: show value*displayScale (e.g. 100 for percentages stored as 0..1). */
      displayScale?: number;
    })
  | (ParamBase & { type: 'angle'; default: number })
  | (ParamBase & { type: 'boolean'; default: boolean })
  | (ParamBase & { type: 'color'; default: Color; alpha?: boolean })
  | (ParamBase & { type: 'select'; options: { value: string; label: string }[]; default: string })
  | (ParamBase & { type: 'gradient'; default: Gradient })
  | (ParamBase & { type: 'curves'; default: CurvesValue })
  | (ParamBase & { type: 'seed'; default: number })
  | (ParamBase & { type: 'text'; default: string; multiline?: boolean })
  | (ParamBase & { type: 'font'; default: string })
  /** Normalized point (0..1 of the target box). */
  | (ParamBase & { type: 'point'; default: Point });

/* ------------------------------------------------------------------ */
/* Filters / adjustments / effects instances                           */
/* ------------------------------------------------------------------ */

/** A configured filter (see FilterDef in registry). Used for smart filters and adjustment layers. */
export interface FilterInstance {
  id: ID;
  filterId: string;
  enabled: boolean;
  params: ParamValues;
  /** Blend the filtered result over the unfiltered source (smart-filter blending options). */
  opacity?: number;
  blendMode?: BlendMode;
}

/** A configured layer style effect (see EffectDef in registry): drop shadow, stroke, glow… */
export interface LayerEffect {
  id: ID;
  effectId: string;
  enabled: boolean;
  params: ParamValues;
}

/* ------------------------------------------------------------------ */
/* Paints, text, shapes                                                */
/* ------------------------------------------------------------------ */

export type Paint =
  | { type: 'solid'; color: Color }
  | { type: 'gradient'; gradient: Gradient }
  /** Pattern from a registered asset (generated at `scale`). */
  | { type: 'pattern'; assetId: string; params?: ParamValues; scale: number };

export interface StrokeStyle {
  paint: Paint;
  width: number;
  align: 'center' | 'inside' | 'outside';
  dash?: number[];
  join?: CanvasLineJoin;
  cap?: CanvasLineCap;
}

export type TextWarpStyle =
  | 'none'
  | 'arc'
  | 'arch'
  | 'bulge'
  | 'flag'
  | 'wave'
  | 'rise'
  | 'fisheye'
  | 'squeeze';

export interface TextProps {
  content: string;
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  /** px */
  fontSize: number;
  fill: Paint;
  align: 'left' | 'center' | 'right';
  /** Line height multiplier (1.2 = 120%). */
  lineHeight: number;
  /** Tracking in px. */
  letterSpacing: number;
  /** Horizontal / vertical glyph scale (1 = 100%). */
  scaleX: number;
  scaleY: number;
  uppercase: boolean;
  /** Paragraph text wrap width in px; null = point text (no wrapping). */
  boxWidth: number | null;
  /** Built-in text outline (in addition to any stroke layer effect). */
  stroke: { color: Color; width: number } | null;
  warp: { style: TextWarpStyle; bend: number; horizontal: number; vertical: number };
  /** Baseline shift / small caps etc. kept minimal. */
  fauxBold: boolean;
  fauxItalic: boolean;
  antiAlias: boolean;
}

export type ShapeKind = 'rect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'path';

export interface ShapeProps {
  kind: ShapeKind;
  /** Local box size (the transform positions/rotates/scales it). */
  width: number;
  height: number;
  cornerRadius: number;
  /** polygon / star */
  sides: number;
  /** star inner radius ratio 0..1 */
  innerRatio: number;
  /** line thickness when kind='line' (drawn along the box diagonal) */
  lineWidth: number;
  /** For kind='path': SVG path data and its viewBox; scaled to width/height. */
  path?: string;
  viewBox?: [number, number, number, number];
  /** Optional reference to a registered shape preset id (informational). */
  presetId?: string;
  fill: Paint | null;
  stroke: StrokeStyle | null;
}

export type FillContent =
  | { type: 'solid'; color: Color }
  | { type: 'gradient'; gradient: Gradient }
  | { type: 'pattern'; assetId: string; params?: ParamValues; scale: number };

/* ------------------------------------------------------------------ */
/* Layers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Transform mapping a layer's local content box [0,w]x[0,h] to document space:
 *   M = translate(x + w/2, y + h/2) · rotate(rotation) · scale(scaleX, scaleY) · translate(-w/2, -h/2)
 * i.e. (x, y) is the top-left of the unrotated/unscaled box, and rotation/scale pivot on the
 * box center. Negative scale = flip. See core/geometry.ts for helpers.
 */
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** degrees, optional horizontal skew */
  skewX?: number;
}

export interface LayerLocks {
  /** cannot paint/edit pixels */
  pixels: boolean;
  /** cannot move/transform */
  position: boolean;
  /** painting preserves transparency */
  transparency: boolean;
  /** everything locked */
  all: boolean;
}

export interface LayerMask {
  /** Doc-sized bitmap in document space; luminance (R channel) = visibility (255 visible). */
  bitmapId: ID;
  enabled: boolean;
  /** Mask density 0..1 (1 = full effect). */
  density: number;
  /** Feather radius in px applied at render time. */
  feather: number;
  inverted: boolean;
}

export type LayerType = 'raster' | 'text' | 'shape' | 'fill' | 'adjustment' | 'group';

export type LabelColor = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';

export interface LayerBase {
  id: ID;
  name: string;
  type: LayerType;
  visible: boolean;
  locks: LayerLocks;
  /** 0..1, affects content and effects */
  opacity: number;
  /** 0..1, affects content but not layer effects (Photoshop "Fill") */
  fillOpacity: number;
  blendMode: BlendMode;
  /** Clipping mask: clip this layer to the nearest non-clipped layer below it. */
  clipped: boolean;
  mask: LayerMask | null;
  /** Layer styles (drop shadow, stroke, glow, overlays…), rendered by the compositor. */
  effects: LayerEffect[];
  /** Smart filters applied to the layer's content (before effects), non-destructive. */
  filters: FilterInstance[];
  label: LabelColor;
  /** Free-form metadata for features (e.g. roblox: {kind:'character'}). JSON only. */
  meta?: Record<string, unknown>;
}

/** Re-editable generator info (procedural asset or 3D rig render) attached to a raster layer. */
export interface GeneratorSource {
  /** 'asset:<assetId>' for library assets, 'rig' for Roblox Pose Studio renders, etc. */
  kind: string;
  params: ParamValues | Record<string, unknown>;
}

export interface RasterLayer extends LayerBase {
  type: 'raster';
  bitmapId: ID;
  /** Bitmap size (local content box). */
  width: number;
  height: number;
  transform: Transform;
  /** If set, the bitmap was produced by a generator and can be regenerated with new params. */
  generator?: GeneratorSource | null;
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: TextProps;
  transform: Transform;
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: ShapeProps;
  transform: Transform;
}

/** Fill layer: covers the whole canvas with a solid color / gradient / pattern. */
export interface FillLayer extends LayerBase {
  type: 'fill';
  fill: FillContent;
}

/** Adjustment layer: applies a filter (adjustment) to the composite of everything below it. */
export interface AdjustmentLayer extends LayerBase {
  type: 'adjustment';
  adjustment: FilterInstance;
}

export interface GroupLayer extends Omit<LayerBase, 'blendMode'> {
  type: 'group';
  blendMode: GroupBlendMode;
  /** Children, bottom → top. */
  childIds: ID[];
  collapsed: boolean;
}

export type Layer = RasterLayer | TextLayer | ShapeLayer | FillLayer | AdjustmentLayer | GroupLayer;
export type TransformableLayer = RasterLayer | TextLayer | ShapeLayer;

/* ------------------------------------------------------------------ */
/* Selection, guides, document                                         */
/* ------------------------------------------------------------------ */

export interface Selection {
  /** Doc-sized alpha mask bitmap (alpha channel = selection strength). */
  bitmapId: ID;
  /** Tight bounds of the selected area in document space. */
  bounds: Rect;
  /** Vector description when the selection is a simple shape (for crisp marching ants). */
  shape?: { type: 'rect' | 'ellipse'; rect: Rect } | null;
}

export interface Guide {
  id: ID;
  orientation: 'horizontal' | 'vertical';
  /** document px */
  position: number;
}

export interface Document {
  id: ID;
  name: string;
  width: number;
  height: number;
  /** Shown behind everything when exporting with background (null = transparent). */
  background: Color | null;
  /** Layer lookup table. */
  layers: Record<ID, Layer>;
  /** Top-level layer ids, bottom → top. */
  rootIds: ID[];
  selection: Selection | null;
  guides: Guide[];
  /** pixels per inch (informational, for export metadata) */
  dpi: number;
  meta?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Editor-level types                                                  */
/* ------------------------------------------------------------------ */

export interface ViewState {
  /** screen px per document px */
  zoom: number;
  /** screen-space offset of the document origin relative to the viewport center */
  panX: number;
  panY: number;
}

export interface BitmapPatch {
  bitmapId: ID;
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
}

export interface HistoryEntry {
  id: ID;
  label: string;
  /** Document state AFTER this step. */
  doc: Document;
  /** Bitmap pixel changes made by this step (applied after → redo, before → undo). */
  patches?: BitmapPatch[];
  timestamp: number;
}

export interface History {
  entries: HistoryEntry[];
  /** Index of the entry matching the current committed state. */
  index: number;
}

/** What painting tools target on the active layer. */
export type EditTarget = 'content' | 'mask';

export interface DocSession {
  doc: Document;
  history: History;
  view: ViewState;
  activeLayerId: ID | null;
  /** Multi-selection in the layers panel (includes activeLayerId). */
  selectedLayerIds: ID[];
  editTarget: EditTarget;
  /** Absolute path on disk when saved/opened as a project (desktop). */
  filePath: string | null;
  /** True when there are changes since last save. */
  dirty: boolean;
  /** History index at last save. */
  savedIndex: number;
}
