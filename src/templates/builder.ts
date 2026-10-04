/**
 * DocBuilder — a small fluent toolkit for building template documents programmatically.
 * Every helper is defensive: a missing asset / filter / effect / font is skipped (console.warn)
 * so a template never crashes because another module hasn't registered something.
 *
 * `preview` (0..1) lowers the resolution of generated bitmaps (assets, characters) while keeping
 * the document geometry identical — used for fast template thumbnails.
 */
import type {
  BlendMode,
  Color,
  Document,
  FillContent,
  Gradient,
  GroupLayer,
  ID,
  LabelColor,
  Layer,
  ParamValues,
  Paint,
  RasterLayer,
  ShapeLayer,
  ShapeProps,
  TextLayer,
  TextProps,
} from '../core/types';
import {
  createDocument,
  DEFAULT_TEXT,
  insertLayerDraft,
  makeAdjustmentLayer,
  makeFillLayer,
  makeFilterInstance,
  makeGroupLayer,
  makeRasterLayer,
  makeShapeLayer,
  makeTextLayer,
} from '../core/document';
import { assets, effects, filters, fonts } from '../registry';
import { bitmaps } from '../core/bitmaps';
import { createCanvas, opaqueBounds } from '../core/canvas';
import { uid } from '../core/ids';
import { resolveParams } from '../filters/engine';
import { measureText } from '../render/compositor';
import { renderPlaceholderCharacter, type PlaceholderOptions } from '../roblox/placeholder';
import { fitFontSize, segmentTransform } from './layout';
import { smokeCanvas, type SmokeOptions } from './paint';

export interface LayerOpts {
  name?: string;
  blendMode?: BlendMode;
  opacity?: number;
  fillOpacity?: number;
  visible?: boolean;
  clipped?: boolean;
  label?: LabelColor;
  locked?: boolean;
  meta?: Record<string, unknown>;
}

export interface BuildOptions {
  /** Bitmap resolution factor for previews (1 = full resolution). */
  preview?: number;
}

export type FontChoice = string | string[];

export interface TextOpts extends Partial<Omit<TextProps, 'fontFamily'>> {
  fontFamily?: FontChoice;
  /** Anchor point in document px. */
  x: number;
  y: number;
  /** Which part of the text box sits at x: left edge (default), center or right edge. */
  anchor?: 'start' | 'center' | 'end';
  /** Shrink/grow fontSize so the text box is exactly this wide. */
  fitWidth?: number;
  /** Upper bound when fitting. */
  maxFontSize?: number;
  rotation?: number;
}

export interface CharacterOpts extends Omit<PlaceholderOptions, 'width' | 'height'> {
  /** Horizontal center of the figure (doc px). */
  cx: number;
  /** Top of the figure's visible pixels (hair / raised weapon) in doc px. */
  top: number;
  /** Full figure height in doc px (parts below the canvas are simply cropped). */
  height: number;
  rotation?: number;
  flipX?: boolean;
}

export const PLACEHOLDER_NAME = 'Your Character (replace me)';

/** Pick the first registered family of a list (or the first entry when the registry is empty). */
export function resolveFont(choice: FontChoice | undefined, fallback = DEFAULT_TEXT.fontFamily): string {
  const list = choice === undefined ? [fallback] : Array.isArray(choice) ? choice : [choice];
  const registered = fonts.list();
  if (!registered.length) return list[0] ?? fallback;
  for (const f of list) if (fonts.has(f) || registered.some((r) => r.family === f)) return f;
  return list[0] ?? fallback;
}

/** Nearest available weight of a registered family. */
function resolveWeight(family: string, weight: number): number {
  const def = fonts.get(family) ?? fonts.list().find((f) => f.family === family);
  if (!def || !def.weights.length) return weight;
  return def.weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), def.weights[0]);
}

export function linear(stops: [number, Color][], angle = 90, extra: Partial<Gradient> = {}): Gradient {
  return { kind: 'linear', angle, scale: 1, stops: stops.map(([offset, color]) => ({ offset, color })), ...extra };
}

export function radial(stops: [number, Color][], extra: Partial<Gradient> = {}): Gradient {
  return { kind: 'radial', angle: 0, scale: 1, stops: stops.map(([offset, color]) => ({ offset, color })), ...extra };
}

export class DocBuilder {
  readonly doc: Document;
  readonly preview: number;
  /** The main placeholder character (made active when the template opens). */
  characterId: ID | null = null;
  private parents: ID[] = [];

  constructor(name: string, width: number, height: number, background: Color | null, opts: BuildOptions = {}) {
    this.doc = createDocument({ name, width, height, background });
    this.preview = Math.max(0.05, Math.min(1, opts.preview ?? 1));
  }

  get W() {
    return this.doc.width;
  }
  get H() {
    return this.doc.height;
  }

  /* ---------------- plumbing ---------------- */

  private apply<T extends Layer>(layer: T, o: LayerOpts = {}): T {
    if (o.name) layer.name = o.name;
    if (o.blendMode) (layer as Layer).blendMode = o.blendMode;
    if (o.opacity !== undefined) layer.opacity = o.opacity;
    if (o.fillOpacity !== undefined) layer.fillOpacity = o.fillOpacity;
    if (o.visible !== undefined) layer.visible = o.visible;
    if (o.clipped !== undefined) layer.clipped = o.clipped;
    if (o.label) layer.label = o.label;
    if (o.locked) layer.locks = { ...layer.locks, all: true };
    if (o.meta) layer.meta = { ...layer.meta, ...o.meta };
    return layer;
  }

  /** Insert a layer at the top of the current group (or root). */
  add<T extends Layer>(layer: T, o: LayerOpts = {}): T {
    this.apply(layer, o);
    insertLayerDraft(this.doc, layer, { parentId: this.parents[this.parents.length - 1] ?? null });
    return layer;
  }

  /** Build children inside a group. */
  group(name: string, build: () => void, o: LayerOpts & { collapsed?: boolean; passThrough?: boolean } = {}): GroupLayer {
    const g = makeGroupLayer({ name });
    g.collapsed = o.collapsed ?? false;
    if (o.passThrough === false) g.blendMode = 'normal';
    this.add(g, o);
    this.parents.push(g.id);
    try {
      build();
    } finally {
      this.parents.pop();
    }
    return g;
  }

  guide(orientation: 'horizontal' | 'vertical', position: number) {
    this.doc.guides.push({ id: uid('gd_'), orientation, position });
  }

  /* ---------------- fills ---------------- */

  fill(name: string, fill: FillContent, o: LayerOpts = {}) {
    return this.add(makeFillLayer({ name, fill }), o);
  }

  solid(name: string, color: Color, o: LayerOpts = {}) {
    return this.fill(name, { type: 'solid', color }, o);
  }

  gradient(name: string, gradient: Gradient, o: LayerOpts = {}) {
    return this.fill(name, { type: 'gradient', gradient }, o);
  }

  /** Doc-sized pixel layer, transparent or filled with a color (paintable "Background"). */
  emptyRaster(name = 'Layer 1', o: LayerOpts & { color?: Color } = {}) {
    const w = Math.max(1, Math.round(this.W * this.preview));
    const h = Math.max(1, Math.round(this.H * this.preview));
    const id = bitmaps.create(w, h, o.color);
    const layer = makeRasterLayer({ name, bitmapId: id, width: w, height: h });
    if (w !== this.W || h !== this.H) {
      layer.transform = { ...layer.transform, x: this.W / 2 - w / 2, y: this.H / 2 - h / 2, scaleX: this.W / w, scaleY: this.H / h };
    }
    return this.add(layer, o);
  }

  /* ---------------- generated bitmaps ---------------- */

  /** Register a bitmap rendered at preview resolution, scaled to cover the box (x, y, w, h). */
  private scaledRaster(canvas: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }, name: string, rotation = 0, flipX = false): RasterLayer {
    const layer = makeRasterLayer({
      name,
      bitmapId: bitmaps.add(canvas),
      width: canvas.width,
      height: canvas.height,
      transform: {
        x: box.x + box.width / 2 - canvas.width / 2,
        y: box.y + box.height / 2 - canvas.height / 2,
        scaleX: (box.width / canvas.width) * (flipX ? -1 : 1),
        scaleY: box.height / canvas.height,
        rotation,
      },
    });
    return layer;
  }

  /**
   * Procedural asset layer (§5.6 ids). Document assets fill the canvas; element assets use the
   * optional box. Returns null (and skips) when the asset isn't registered or fails.
   */
  asset(
    assetId: string,
    params: ParamValues = {},
    o: LayerOpts & { x?: number; y?: number; width?: number; height?: number; rotation?: number; flipX?: boolean; onlyElement?: boolean } = {},
  ): RasterLayer | null {
    const def = assets.get(assetId);
    if (!def) {
      console.warn(`[templates] asset "${assetId}" is not registered — layer skipped`);
      return null;
    }
    if (o.onlyElement && def.sizing === 'document') return null;
    try {
      const p = resolveParams(def, params);
      const full =
        def.sizing === 'document'
          ? { x: 0, y: 0, width: this.W, height: this.H }
          : {
              width: o.width ?? def.sizing.width,
              height: o.height ?? def.sizing.height,
              x: o.x ?? (this.W - (o.width ?? def.sizing.width)) / 2,
              y: o.y ?? (this.H - (o.height ?? def.sizing.height)) / 2,
            };
      const gw = Math.max(4, Math.round(full.width * this.preview));
      const gh = Math.max(4, Math.round(full.height * this.preview));
      const canvas = def.generate(p, { width: gw, height: gh });
      const layer = this.scaledRaster(canvas, full, def.name, o.rotation ?? 0, o.flipX);
      layer.generator = { kind: `asset:${assetId}`, params: p };
      layer.blendMode = def.defaultBlendMode ?? 'normal';
      layer.opacity = def.defaultOpacity ?? 1;
      return this.add(layer, o);
    } catch (e) {
      console.warn(`[templates] asset "${assetId}" failed — layer skipped`, e);
      return null;
    }
  }

  /**
   * Placeholder Roblox character (raster, meta {placeholder:true}), positioned by its actual
   * figure bounds so templates don't depend on the placeholder renderer's internal proportions.
   * The first one becomes the main character.
   */
  character(c: CharacterOpts, o: LayerOpts = {}): RasterLayer | null {
    try {
      const { cx, top, height, rotation, flipX, ...style } = c;
      const want = Math.max(16, height * this.preview);
      const render = (h: number) => renderPlaceholderCharacter({ ...style, width: Math.round(h * 0.9), height: Math.round(h) });
      let canvas = render(want * 1.15);
      let bounds = opaqueBounds(canvas, 8);
      if (!bounds) return null;
      // Re-render so the figure itself is `want` px tall (crisper than scaling the raster).
      const f = want / bounds.height;
      if (Math.abs(f - 1) > 0.02) {
        canvas = render(want * 1.15 * f);
        bounds = opaqueBounds(canvas, 8) ?? bounds;
      }
      const pad = 2;
      const bx = Math.max(0, bounds.x - pad);
      const by = Math.max(0, bounds.y - pad);
      const bw = Math.min(canvas.width - bx, bounds.width + pad * 2);
      const bh = Math.min(canvas.height - by, bounds.height + pad * 2);
      const cropped = createCanvas(bw, bh);
      cropped.getContext('2d')?.drawImage(canvas, bx, by, bw, bh, 0, 0, bw, bh);
      const s = height / bounds.height; // doc px per canvas px
      const box = {
        x: cx - (bounds.x + bounds.width / 2 - bx) * s,
        y: top - (bounds.y - by) * s,
        width: bw * s,
        height: bh * s,
      };
      const layer = this.scaledRaster(cropped, box, o.name ?? PLACEHOLDER_NAME, rotation ?? 0, flipX);
      layer.meta = { placeholder: true, kind: 'character' };
      this.add(layer, o);
      if (!this.characterId) this.characterId = layer.id;
      return layer;
    } catch (e) {
      console.warn('[templates] placeholder character failed — layer skipped', e);
      return null;
    }
  }

  /** Raster layer from an arbitrary canvas drawn at full resolution (box = doc px). */
  canvas(name: string, draw: (ctx: CanvasRenderingContext2D, scale: number) => void, box?: { x: number; y: number; width: number; height: number }, o: LayerOpts = {}) {
    const b = box ?? { x: 0, y: 0, width: this.W, height: this.H };
    const c = createCanvas(Math.max(1, Math.round(b.width * this.preview)), Math.max(1, Math.round(b.height * this.preview)));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.scale(c.width / b.width, c.height / b.height);
    draw(ctx, c.width / b.width);
    return this.add(this.scaledRaster(c, b, name), o);
  }

  /**
   * Procedural billowing smoke (see paint.ts) as a document-sized raster layer. Used where the
   * look must not depend on the asset library (e.g. the crimson reference's red smoke).
   */
  smoke(name: string, opts: SmokeOptions, o: LayerOpts = {}): RasterLayer | null {
    try {
      const w = Math.max(8, Math.round(this.W * this.preview));
      const h = Math.max(8, Math.round(this.H * this.preview));
      const canvas = smokeCanvas(w, h, opts);
      return this.add(this.scaledRaster(canvas, { x: 0, y: 0, width: this.W, height: this.H }, name), o);
    } catch (e) {
      console.warn('[templates] smoke layer failed — skipped', e);
      return null;
    }
  }

  /* ---------------- masks ---------------- */

  /**
   * Attach a layer mask painted in document coordinates (white = visible, black = hidden).
   * The mask starts black; `draw` paints the visible parts. Chainable on null.
   */
  mask<T extends Layer | null>(layer: T, draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void, o: { feather?: number; density?: number } = {}): T {
    if (!layer) return layer;
    try {
      const w = Math.max(1, Math.round(this.W * this.preview));
      const h = Math.max(1, Math.round(this.H * this.preview));
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      if (!ctx) return layer;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      ctx.scale(w / this.W, h / this.H);
      ctx.fillStyle = '#ffffff';
      draw(ctx, this.W, this.H);
      layer.mask = { bitmapId: bitmaps.add(c), enabled: true, density: o.density ?? 1, feather: o.feather ?? 0, inverted: false };
    } catch (e) {
      console.warn('[templates] mask failed — skipped', e);
    }
    return layer;
  }

  /** Linear fade mask: hidden at (x0, y0), fully visible at (x1, y1). */
  fadeMask<T extends Layer | null>(layer: T, x0: number, y0: number, x1: number, y1: number): T {
    return this.mask(layer, (ctx, W, H) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, '#000000');
      g.addColorStop(1, '#ffffff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    });
  }

  /** Radial mask: visible inside r0 around (cx, cy), fading out to hidden at r1. */
  radialMask<T extends Layer | null>(layer: T, cx: number, cy: number, r0: number, r1: number): T {
    return this.mask(layer, (ctx, W, H) => {
      const g = ctx.createRadialGradient(cx, cy, Math.max(0, r0), cx, cy, Math.max(r0 + 1, r1));
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#000000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    });
  }

  /* ---------------- vector ---------------- */

  text(content: string, t: TextOpts, o: LayerOpts = {}): TextLayer {
    const { x, y, anchor = 'start', fitWidth, maxFontSize, rotation, fontFamily, ...rest } = t;
    const family = resolveFont(fontFamily);
    const props: TextProps = {
      ...DEFAULT_TEXT,
      ...rest,
      content,
      fontFamily: family,
      fontWeight: resolveWeight(family, rest.fontWeight ?? DEFAULT_TEXT.fontWeight),
    };
    if (fitWidth) {
      const w = safeMeasure(props).width;
      props.fontSize = fitFontSize(props.fontSize, w, fitWidth, maxFontSize);
    }
    const size = safeMeasure(props);
    const left = anchor === 'center' ? x - size.width / 2 : anchor === 'end' ? x - size.width : x;
    const layer = makeTextLayer({ name: o.name ?? content.split('\n')[0].slice(0, 32), text: props, x: Math.round(left), y: Math.round(y) });
    if (rotation) layer.transform.rotation = rotation;
    return this.add(layer, o);
  }

  /** Measured box of a text layer (doc px). */
  textBox(layer: TextLayer) {
    const s = safeMeasure(layer.text);
    return { x: layer.transform.x, y: layer.transform.y, width: s.width, height: s.height };
  }

  shape(s: Partial<ShapeProps> & { x: number; y: number; rotation?: number; scaleX?: number; scaleY?: number }, o: LayerOpts = {}): ShapeLayer {
    const { x, y, rotation, scaleX, scaleY, ...shape } = s;
    const layer = makeShapeLayer({ shape, x, y });
    if (rotation) layer.transform.rotation = rotation;
    if (scaleX !== undefined) layer.transform.scaleX = scaleX;
    if (scaleY !== undefined) layer.transform.scaleY = scaleY;
    return this.add(layer, o);
  }

  rect(x: number, y: number, width: number, height: number, fill: Paint | null, o: LayerOpts & { cornerRadius?: number; rotation?: number; stroke?: ShapeProps['stroke'] } = {}) {
    return this.shape({ kind: 'rect', x, y, width, height, fill, cornerRadius: o.cornerRadius ?? 0, rotation: o.rotation, stroke: o.stroke ?? null }, { name: 'Rectangle', ...o });
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, fill: Paint | null, o: LayerOpts & { stroke?: ShapeProps['stroke'] } = {}) {
    return this.shape({ kind: 'ellipse', x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2, fill, stroke: o.stroke ?? null }, { name: 'Ellipse', ...o });
  }

  star(cx: number, cy: number, r: number, points: number, innerRatio: number, fill: Paint | null, o: LayerOpts & { stroke?: ShapeProps['stroke']; rotation?: number } = {}) {
    return this.shape(
      { kind: 'star', x: cx - r, y: cy - r, width: r * 2, height: r * 2, sides: points, innerRatio, fill, stroke: o.stroke ?? null, rotation: o.rotation },
      { name: 'Star', ...o },
    );
  }

  /** SVG path shape in a viewBox, placed in the box (x, y, w, h). */
  path(d: string, viewBox: [number, number, number, number], box: { x: number; y: number; width: number; height: number; rotation?: number }, fill: Paint | null, o: LayerOpts & { stroke?: ShapeProps['stroke'] } = {}) {
    return this.shape(
      { kind: 'path', path: d, viewBox, x: box.x, y: box.y, width: box.width, height: box.height, rotation: box.rotation, fill, stroke: o.stroke ?? null },
      { name: 'Shape', ...o },
    );
  }

  /**
   * Straight line / slash between two points as a rotated thin shape. `taper` draws a spindle
   * (pointed at both ends) — the classic anime/noir slash line.
   */
  segment(x1: number, y1: number, x2: number, y2: number, thickness: number, paint: Paint, o: LayerOpts & { taper?: boolean } = {}) {
    const t = segmentTransform(x1, y1, x2, y2, thickness);
    if (o.taper) {
      return this.shape(
        {
          kind: 'path',
          path: 'M0 50 Q500 0 1000 50 Q500 100 0 50 Z',
          viewBox: [0, 0, 1000, 100],
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
          rotation: t.rotation,
          fill: paint,
          stroke: null,
        },
        { name: 'Slash', ...o },
      );
    }
    return this.shape({ kind: 'rect', x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation, fill: paint, stroke: null }, { name: 'Line', ...o });
  }

  /* ---------------- adjustments, smart filters, effects ---------------- */

  adjustment(filterId: string, params: ParamValues = {}, o: LayerOpts = {}) {
    const def = filters.get(filterId);
    if (!def) {
      console.warn(`[templates] filter "${filterId}" is not registered — adjustment skipped`);
      return null;
    }
    return this.add(makeAdjustmentLayer({ name: o.name ?? def.name, filterId, params: resolveParams(def, params) }), o);
  }

  /** Smart filter on a layer (skipped if not registered). Chainable on null. */
  smartFilter<T extends Layer | null>(layer: T, filterId: string, params: ParamValues = {}, o: { opacity?: number; blendMode?: BlendMode } = {}): T {
    if (!layer) return layer;
    const def = filters.get(filterId);
    if (!def) {
      console.warn(`[templates] filter "${filterId}" is not registered — smart filter skipped`);
      return layer;
    }
    const inst = makeFilterInstance(filterId, resolveParams(def, params));
    if (o.opacity !== undefined) inst.opacity = o.opacity;
    if (o.blendMode) inst.blendMode = o.blendMode;
    layer.filters.push(inst);
    return layer;
  }

  /** Layer effect (skipped if not registered). Chainable on null. */
  effect<T extends Layer | null>(layer: T, effectId: string, params: ParamValues = {}): T {
    if (!layer) return layer;
    const def = effects.get(effectId);
    if (!def) {
      console.warn(`[templates] effect "${effectId}" is not registered — effect skipped`);
      return layer;
    }
    layer.effects.push({ id: uid('lfx_'), effectId, enabled: true, params: resolveParams(def, params) });
    return layer;
  }

  /** Finished document. */
  finish(meta: Record<string, unknown> = {}): Document {
    this.doc.meta = { ...this.doc.meta, ...meta };
    return this.doc;
  }
}

function safeMeasure(t: TextProps): { width: number; height: number } {
  try {
    const m = measureText(t);
    return { width: m.width, height: m.height };
  } catch {
    // No canvas (tests) — rough estimate.
    return { width: t.content.length * t.fontSize * 0.55, height: t.fontSize * t.lineHeight };
  }
}

export const solidPaint = (color: Color): Paint => ({ type: 'solid', color });
