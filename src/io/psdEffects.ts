/**
 * Layer styles ↔ Photoshop layer effects (ag-psd `LayerEffectsInfo`). Pure — unit-tested.
 *
 * Mapped both ways: drop-shadow, inner-shadow, outer-glow, inner-glow, bevel, satin, stroke,
 * color-overlay (PSD "solid fill") and gradient-overlay. Photoshop allows several drop/inner
 * shadows, strokes, color and gradient overlays but only ONE outer glow, inner glow, bevel and satin.
 * Everything else (long-shadow, pattern-overlay, extra singleton instances) is reported as
 * unsupported so the exporter can bake that layer's styles into its pixels instead.
 *
 * Conventions: shadow/light angles use the Photoshop convention on both sides (120° = light from
 * the top-left). Gradient angles differ: ours are y-down (90° = top → bottom), Photoshop's are
 * y-up (90° = bottom → top), so the sign flips. Opacities are 0..1 on both sides; our spread/choke
 * are 0..1 while Photoshop stores percentages (0..100).
 */
import type {
  Color as PsdColor,
  EffectSolidGradient,
  LayerEffectsInfo,
  LayerEffectShadow,
  LayerEffectStroke,
  GradientStyle,
  BlendMode as PsdBlendMode,
  VectorContent,
} from 'ag-psd';
import type { BlendMode, FillContent, Gradient, GradientStop, LayerEffect, ParamValues } from '../core/types';
import { parseColor, toHex } from '../core/color';
import { uid } from '../core/ids';
import { fromPsdBlend, normAngle, toPsdBlend } from './math';

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const px = (value: number) => ({ units: 'Pixels' as const, value: Math.max(0, Math.round(value * 100) / 100) });
const unitsOf = (u: { value: number } | undefined, d: number) => (u && Number.isFinite(u.value) ? u.value : d);

function psdBlend(v: unknown, d: BlendMode): PsdBlendMode {
  return toPsdBlend(typeof v === 'string' ? (v as BlendMode) : d) as PsdBlendMode;
}

function ourBlend(v: string | undefined, d: BlendMode): BlendMode {
  if (!v) return d;
  const b = fromPsdBlend(v);
  return b === 'pass-through' ? 'normal' : b;
}

/** '#rrggbb' (alpha ignored) → PSD RGB. */
export function toPsdColor(hex: unknown, d = '#000000'): PsdColor {
  const c = parseColor(str(hex, d));
  return { r: c.r, g: c.g, b: c.b };
}

/** Any PSD color model → '#rrggbb'. */
export function fromPsdColor(c: PsdColor | undefined, d = '#000000'): string {
  if (!c) return d;
  if ('r' in c) return toHex({ r: c.r, g: c.g, b: c.b });
  if ('fr' in c) return toHex({ r: c.fr * 255, g: c.fg * 255, b: c.fb * 255 });
  if ('k' in c && !('c' in c)) return toHex({ r: 255 - c.k * 2.55, g: 255 - c.k * 2.55, b: 255 - c.k * 2.55 });
  if ('c' in c) {
    // Photoshop CMYK descriptor values are percentages.
    const k = 1 - c.k / 100;
    return toHex({ r: 255 * (1 - c.c / 100) * k, g: 255 * (1 - c.m / 100) * k, b: 255 * (1 - c.y / 100) * k });
  }
  if ('h' in c && 's' in c) {
    // HSB: h as 0..1 fraction of 360°, s/b in percent.
    const h = c.h * 360;
    const s = c.s / 100;
    const v = c.b / 100;
    const f = (n: number) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return toHex({ r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 });
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* gradients                                                           */
/* ------------------------------------------------------------------ */

export function toPsdGradient(g: Gradient): EffectSolidGradient {
  const stops = [...(g.stops?.length ? g.stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }])].sort(
    (a, b) => a.offset - b.offset,
  );
  return {
    name: 'Custom',
    type: 'solid',
    smoothness: 1,
    colorStops: stops.map((s) => ({ color: toPsdColor(s.color), location: clamp01(s.offset), midpoint: 0.5 })),
    opacityStops: stops.map((s) => ({ opacity: clamp01(parseColor(s.color).a), location: clamp01(s.offset), midpoint: 0.5 })),
  };
}

function lerpStops<T extends { location: number }>(list: T[], at: number, pick: (s: T) => number[]): number[] {
  if (!list.length) return [];
  const sorted = [...list].sort((a, b) => a.location - b.location);
  if (at <= sorted[0].location) return pick(sorted[0]);
  const last = sorted[sorted.length - 1];
  if (at >= last.location) return pick(last);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (at <= b.location) {
      const t = b.location > a.location ? (at - a.location) / (b.location - a.location) : 0;
      const pa = pick(a);
      const pb = pick(b);
      return pa.map((v, k) => v + (pb[k] - v) * t);
    }
  }
  return pick(last);
}

/** PSD solid gradient (separate color / opacity stops) → our stops with alpha in the colors. */
export function fromPsdGradient(
  g: { type?: string; colorStops?: EffectSolidGradient['colorStops']; opacityStops?: EffectSolidGradient['opacityStops'] } | undefined,
  kind: Gradient['kind'] = 'linear',
  angle = 90,
  scale = 1,
  reverse = false,
): Gradient {
  const cs = g?.type === 'solid' && g.colorStops?.length ? g.colorStops : null;
  if (!cs) {
    return { kind, angle, scale, reverse, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
  }
  const os = g?.opacityStops?.length ? g.opacityStops : [{ opacity: 1, location: 0, midpoint: 0.5 }];
  const locs = [...new Set([...cs.map((s) => s.location), ...os.map((s) => s.location)].map((l) => Math.round(clamp01(l) * 1e4) / 1e4))].sort(
    (a, b) => a - b,
  );
  const stops: GradientStop[] = locs.map((loc) => {
    const rgb = lerpStops(cs, loc, (s) => {
      const p = parseColor(fromPsdColor(s.color));
      return [p.r, p.g, p.b];
    });
    const [a] = lerpStops(os, loc, (s) => [s.opacity]);
    return { offset: loc, color: toHex({ r: rgb[0], g: rgb[1], b: rgb[2], a: clamp01(a ?? 1) }, (a ?? 1) < 0.999) };
  });
  return { kind, angle, scale, reverse, stops };
}

const STYLES: GradientStyle[] = ['linear', 'radial', 'angle', 'reflected', 'diamond'];
export const asStyle = (k: unknown): GradientStyle => (STYLES.includes(k as GradientStyle) ? (k as GradientStyle) : 'linear');

function isGradient(v: unknown): v is Gradient {
  return !!v && typeof v === 'object' && Array.isArray((v as Gradient).stops);
}

const DEFAULT_GRADIENT: Gradient = {
  kind: 'linear',
  angle: 90,
  scale: 1,
  stops: [
    { offset: 0, color: '#000000' },
    { offset: 1, color: '#ffffff' },
  ],
};

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

export interface PsdEffectsResult {
  /** Native effects (undefined when there are none). */
  info: LayerEffectsInfo | undefined;
  /** ENABLED effects that have no Photoshop equivalent (the caller should bake the layer). */
  unsupported: LayerEffect[];
}

function shadowToPsd(p: ParamValues, enabled: boolean, defaults: { distance: number; size: number; spreadKey: 'spread' | 'choke' }): LayerEffectShadow {
  return {
    present: true,
    showInDialog: true,
    enabled,
    color: toPsdColor(p.color),
    blendMode: psdBlend(p.blendMode, 'multiply'),
    opacity: clamp01(num(p.opacity, 0.75)),
    angle: Math.round(normAngle(num(p.angle, 120))),
    useGlobalLight: false,
    distance: px(num(p.distance, defaults.distance)),
    choke: px(clamp01(num(p[defaults.spreadKey], 0)) * 100),
    size: px(num(p.size, defaults.size)),
    antialiased: true,
    layerConceals: true,
  };
}

/** Convert layer styles to Photoshop effects. Disabled effects are kept (unchecked in Photoshop). */
export function effectsToPsd(effects: LayerEffect[] | undefined): PsdEffectsResult {
  const info: LayerEffectsInfo = {};
  const unsupported: LayerEffect[] = [];
  let any = false;
  const reject = (e: LayerEffect) => {
    if (e.enabled) unsupported.push(e);
  };
  for (const e of effects ?? []) {
    const p = e.params ?? {};
    const en = !!e.enabled;
    switch (e.effectId) {
      case 'drop-shadow':
        (info.dropShadow ??= []).push(shadowToPsd(p, en, { distance: 10, size: 12, spreadKey: 'spread' }));
        break;
      case 'inner-shadow':
        (info.innerShadow ??= []).push(shadowToPsd(p, en, { distance: 5, size: 5, spreadKey: 'choke' }));
        break;
      case 'outer-glow':
        if (info.outerGlow) {
          reject(e);
          continue;
        }
        info.outerGlow = {
          present: true,
          showInDialog: true,
          enabled: en,
          color: toPsdColor(p.color, '#ffffff'),
          blendMode: psdBlend(p.blendMode, 'screen'),
          opacity: clamp01(num(p.opacity, 0.75)),
          choke: px(clamp01(num(p.spread, 0)) * 100),
          size: px(num(p.size, 18)),
          antialiased: true,
          range: 0.5,
          noise: 0,
          jitter: 0,
        };
        break;
      case 'inner-glow':
        if (info.innerGlow) {
          reject(e);
          continue;
        }
        info.innerGlow = {
          present: true,
          showInDialog: true,
          enabled: en,
          color: toPsdColor(p.color, '#fff6c2'),
          blendMode: psdBlend(p.blendMode, 'screen'),
          opacity: clamp01(num(p.opacity, 0.75)),
          choke: px(clamp01(num(p.choke, 0)) * 100),
          size: px(num(p.size, 10)),
          source: str(p.source, 'edge') === 'center' ? 'center' : 'edge',
          technique: 'softer',
          antialiased: true,
          range: 0.5,
          noise: 0,
          jitter: 0,
        };
        break;
      case 'bevel':
        if (info.bevel) {
          reject(e);
          continue;
        }
        info.bevel = {
          present: true,
          showInDialog: true,
          enabled: en,
          style: str(p.style, 'inner') === 'emboss' ? 'emboss' : 'inner bevel',
          technique: 'smooth',
          direction: 'up',
          strength: Math.max(0.01, num(p.depth, 1)),
          size: px(num(p.size, 8)),
          soften: px(num(p.soften, 0)),
          angle: Math.round(normAngle(num(p.angle, 120))),
          altitude: Math.round(num(p.altitude, 30)),
          useGlobalLight: false,
          highlightColor: toPsdColor(p.highlightColor, '#ffffff'),
          highlightBlendMode: 'screen',
          highlightOpacity: clamp01(num(p.highlightOpacity, 0.75)),
          shadowColor: toPsdColor(p.shadowColor, '#000000'),
          shadowBlendMode: 'multiply',
          shadowOpacity: clamp01(num(p.shadowOpacity, 0.75)),
        };
        break;
      case 'satin':
        if (info.satin) {
          reject(e);
          continue;
        }
        info.satin = {
          present: true,
          showInDialog: true,
          enabled: en,
          color: toPsdColor(p.color),
          blendMode: psdBlend(p.blendMode, 'multiply'),
          opacity: clamp01(num(p.opacity, 0.5)),
          angle: Math.round(normAngle(num(p.angle, 19))),
          distance: px(num(p.distance, 11)),
          size: px(num(p.size, 14)),
          invert: p.invert !== false,
          antialiased: true,
        };
        break;
      case 'stroke': {
        const gradient = p.fillType === 'gradient' && isGradient(p.gradient) ? p.gradient : null;
        const pos = str(p.position, 'outside');
        const s: LayerEffectStroke = {
          present: true,
          showInDialog: true,
          enabled: en,
          size: px(Math.max(1, num(p.size, 4))),
          position: pos === 'inside' || pos === 'center' ? pos : 'outside',
          fillType: gradient ? 'gradient' : 'color',
          blendMode: psdBlend(p.blendMode, 'normal'),
          opacity: clamp01(num(p.opacity, 1)),
          color: toPsdColor(p.color),
        };
        if (gradient) {
          s.gradient = {
            ...toPsdGradient(gradient),
            style: asStyle(gradient.kind),
            angle: Math.round(normAngle(-num(gradient.angle, 90))),
            scale: Math.max(0.1, num(gradient.scale, 1)),
            reverse: !!gradient.reverse,
          };
        }
        (info.stroke ??= []).push(s);
        break;
      }
      case 'color-overlay':
        (info.solidFill ??= []).push({
          present: true,
          showInDialog: true,
          enabled: en,
          color: toPsdColor(p.color, '#ff2a2a'),
          blendMode: psdBlend(p.blendMode, 'normal'),
          opacity: clamp01(num(p.opacity, 1)),
        });
        break;
      case 'gradient-overlay': {
        const g = isGradient(p.gradient) ? p.gradient : DEFAULT_GRADIENT;
        (info.gradientOverlay ??= []).push({
          present: true,
          showInDialog: true,
          enabled: en,
          blendMode: psdBlend(p.blendMode, 'normal'),
          opacity: clamp01(num(p.opacity, 1)),
          align: true,
          dither: false,
          reverse: !!g.reverse,
          type: asStyle(g.kind),
          angle: Math.round(normAngle(-num(p.angle, num(g.angle, 90)))),
          scale: Math.max(0.1, num(p.scale, num(g.scale, 1))),
          offset: { x: num(g.offsetX, 0), y: num(g.offsetY, 0) },
          gradient: toPsdGradient(g),
        });
        break;
      }
      default:
        reject(e);
        continue;
    }
    any = true;
  }
  return { info: any ? info : undefined, unsupported };
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

function shadowFromPsd(s: LayerEffectShadow, effectId: 'drop-shadow' | 'inner-shadow'): LayerEffect {
  const spreadKey = effectId === 'drop-shadow' ? 'spread' : 'choke';
  return {
    id: uid('ef_'),
    effectId,
    enabled: s.enabled !== false,
    params: {
      color: fromPsdColor(s.color),
      blendMode: ourBlend(s.blendMode, 'multiply'),
      opacity: clamp01(num(s.opacity, 0.75)),
      angle: Math.round(normAngle(num(s.angle, 120))),
      distance: unitsOf(s.distance, effectId === 'drop-shadow' ? 10 : 5),
      [spreadKey]: clamp01(unitsOf(s.choke, 0) / 100),
      size: unitsOf(s.size, effectId === 'drop-shadow' ? 12 : 5),
    },
  };
}

/**
 * Convert Photoshop effects to layer styles. `known` filters effect ids that are not registered
 * (pass `() => true` to keep everything). Returns [] when the whole style is switched off.
 */
export function effectsFromPsd(info: LayerEffectsInfo | undefined, known: (effectId: string) => boolean = () => true): LayerEffect[] {
  if (!info || info.disabled) return [];
  const out: LayerEffect[] = [];
  const push = (e: LayerEffect) => {
    if (known(e.effectId)) out.push(e);
  };
  for (const s of info.dropShadow ?? []) push(shadowFromPsd(s, 'drop-shadow'));
  for (const s of info.innerShadow ?? []) push(shadowFromPsd(s, 'inner-shadow'));
  if (info.outerGlow) {
    const g = info.outerGlow;
    push({
      id: uid('ef_'),
      effectId: 'outer-glow',
      enabled: g.enabled !== false,
      params: {
        color: fromPsdColor(g.color, '#ffffff'),
        blendMode: ourBlend(g.blendMode, 'screen'),
        opacity: clamp01(num(g.opacity, 0.75)),
        spread: clamp01(unitsOf(g.choke, 0) / 100),
        size: unitsOf(g.size, 18),
      },
    });
  }
  if (info.innerGlow) {
    const g = info.innerGlow;
    push({
      id: uid('ef_'),
      effectId: 'inner-glow',
      enabled: g.enabled !== false,
      params: {
        color: fromPsdColor(g.color, '#fff6c2'),
        blendMode: ourBlend(g.blendMode, 'screen'),
        opacity: clamp01(num(g.opacity, 0.75)),
        choke: clamp01(unitsOf(g.choke, 0) / 100),
        size: unitsOf(g.size, 10),
        source: g.source === 'center' ? 'center' : 'edge',
      },
    });
  }
  if (info.bevel) {
    const b = info.bevel;
    push({
      id: uid('ef_'),
      effectId: 'bevel',
      enabled: b.enabled !== false,
      params: {
        style: b.style === 'emboss' || b.style === 'pillow emboss' ? 'emboss' : 'inner',
        depth: Math.max(0.01, Math.min(10, num(b.strength, 1))),
        size: unitsOf(b.size, 8),
        soften: unitsOf(b.soften, 0),
        angle: Math.round(normAngle(num(b.angle, 120))),
        altitude: Math.round(num(b.altitude, 30)),
        highlightColor: fromPsdColor(b.highlightColor, '#ffffff'),
        highlightOpacity: clamp01(num(b.highlightOpacity, 0.75)),
        shadowColor: fromPsdColor(b.shadowColor, '#000000'),
        shadowOpacity: clamp01(num(b.shadowOpacity, 0.75)),
      },
    });
  }
  if (info.satin) {
    const s = info.satin;
    push({
      id: uid('ef_'),
      effectId: 'satin',
      enabled: s.enabled !== false,
      params: {
        color: fromPsdColor(s.color),
        blendMode: ourBlend(s.blendMode, 'multiply'),
        opacity: clamp01(num(s.opacity, 0.5)),
        angle: Math.round(normAngle(num(s.angle, 19))),
        distance: unitsOf(s.distance, 11),
        size: unitsOf(s.size, 14),
        invert: s.invert !== false,
      },
    });
  }
  for (const s of info.stroke ?? []) {
    const params: ParamValues = {
      size: Math.max(1, unitsOf(s.size, 4)),
      position: s.position ?? 'outside',
      blendMode: ourBlend(s.blendMode, 'normal'),
      opacity: clamp01(num(s.opacity, 1)),
      fillType: s.fillType === 'gradient' && s.gradient ? 'gradient' : 'color',
      color: fromPsdColor(s.color),
    };
    if (s.fillType === 'gradient' && s.gradient) {
      const g = s.gradient;
      params.gradient = fromPsdGradient(g, asStyle(g.style), normAngle(-num(g.angle, 90)), num(g.scale, 1), !!g.reverse);
    }
    push({ id: uid('ef_'), effectId: 'stroke', enabled: s.enabled !== false, params });
  }
  for (const f of info.solidFill ?? []) {
    push({
      id: uid('ef_'),
      effectId: 'color-overlay',
      enabled: f.enabled !== false,
      params: { color: fromPsdColor(f.color, '#ff2a2a'), blendMode: ourBlend(f.blendMode, 'normal'), opacity: clamp01(num(f.opacity, 1)) },
    });
  }
  for (const g of info.gradientOverlay ?? []) {
    const angle = normAngle(-num(g.angle, 90));
    const scale = num(g.scale, 1);
    const grad = fromPsdGradient(g.gradient, asStyle(g.type), angle, scale, !!g.reverse);
    if (g.offset) {
      grad.offsetX = num(g.offset.x, 0);
      grad.offsetY = num(g.offset.y, 0);
    }
    push({
      id: uid('ef_'),
      effectId: 'gradient-overlay',
      enabled: g.enabled !== false,
      params: {
        gradient: grad,
        blendMode: ourBlend(g.blendMode, 'normal'),
        opacity: clamp01(num(g.opacity, 1)),
        angle,
        scale: Math.max(0.1, Math.min(1.5, scale)),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* fill layers (Photoshop "Solid Color" / "Gradient" fill layers)       */
/* ------------------------------------------------------------------ */

/** Our fill layer content → PSD vector fill (null for patterns, which stay pixels). */
export function fillToPsd(fill: FillContent): VectorContent | null {
  if (fill.type === 'solid') return { type: 'color', color: toPsdColor(fill.color) };
  if (fill.type === 'gradient') {
    const g = fill.gradient;
    return {
      ...toPsdGradient(g),
      style: asStyle(g.kind),
      angle: Math.round(normAngle(-num(g.angle, 90))),
      scale: Math.max(0.1, num(g.scale, 1)),
      reverse: !!g.reverse,
    };
  }
  return null;
}

/** PSD vector fill → our fill layer content (null when it cannot be represented). */
export function fillFromPsd(v: VectorContent | undefined): FillContent | null {
  if (!v) return null;
  if (v.type === 'color') return { type: 'solid', color: fromPsdColor(v.color) };
  if (v.type === 'solid') {
    const g = fromPsdGradient(v, asStyle(v.style), normAngle(-num(v.angle, 90)), num(v.scale, 1), !!v.reverse);
    return { type: 'gradient', gradient: g };
  }
  return null;
}

/** Human-readable names of unsupported effects (for export warnings). */
export function effectLabel(effectId: string): string {
  const names: Record<string, string> = { 'long-shadow': 'Long Shadow', 'pattern-overlay': 'Pattern Overlay' };
  return names[effectId] ?? effectId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
