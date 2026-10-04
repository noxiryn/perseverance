/**
 * Pure brush math (no DOM): dab spacing along a path, curve smoothing, pulled-string stabilizer
 * and per-dab dynamics (pressure, jitter, scatter). Unit-tested in math.test.ts.
 */

export interface InputPoint {
  x: number;
  y: number;
  /** 0..1 */
  pressure: number;
}

export interface DabPoint extends InputPoint {
  /** Stroke direction at this point, radians (0 = +x). */
  direction: number;
}

/** A fully resolved dab in document space. */
export interface Dab {
  x: number;
  y: number;
  /** Diameter in document px. */
  size: number;
  /** Tip rotation in degrees. */
  angle: number;
  /** 0..1 (1 = circle) */
  roundness: number;
  /** Stamp alpha (flow × dynamics), 0..1. */
  alpha: number;
}

/* ------------------------------------------------------------------ */
/* Dab spacing                                                          */
/* ------------------------------------------------------------------ */

/** Minimum distance between two dabs in px (keeps tiny brushes from emitting thousands of dabs). */
export const MIN_DAB_STEP = 0.5;

/**
 * Places dabs at regular intervals along a polyline. The interval may depend on pressure
 * (pressure → size → spacing), and leftover distance is carried across segments so the
 * rhythm stays even regardless of how the input is sampled.
 */
export class DabSpacer {
  private last: InputPoint | null = null;
  /** Distance travelled since the last emitted dab. */
  private carry = 0;
  private dir = 0;

  constructor(private spacingAt: (pressure: number) => number) {}

  get lastPoint(): InputPoint | null {
    return this.last;
  }

  get direction(): number {
    return this.dir;
  }

  /** Begin a stroke: emits one dab at the start point. */
  start(p: InputPoint, direction = 0): DabPoint[] {
    this.last = { ...p };
    this.carry = 0;
    this.dir = direction;
    return [{ ...p, direction }];
  }

  /** Extend the stroke to `p`, returning the dabs placed along the new segment. */
  lineTo(p: InputPoint): DabPoint[] {
    const a = this.last;
    if (!a) return this.start(p);
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      this.last = { ...a, pressure: p.pressure };
      return [];
    }
    this.dir = Math.atan2(dy, dx);
    const out: DabPoint[] = [];
    let pos = 0;
    // Guard against pathological spacing functions.
    for (let guard = 0; guard < 100000; guard++) {
      const t = pos / len;
      const pressure = a.pressure + (p.pressure - a.pressure) * t;
      const step = Math.max(MIN_DAB_STEP, this.spacingAt(pressure));
      const need = step - this.carry;
      if (pos + need > len) {
        this.carry += len - pos;
        break;
      }
      pos += need;
      this.carry = 0;
      const u = pos / len;
      out.push({
        x: a.x + dx * u,
        y: a.y + dy * u,
        pressure: a.pressure + (p.pressure - a.pressure) * u,
        direction: this.dir,
      });
    }
    this.last = { ...p };
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Curve smoothing (quadratic midpoints)                               */
/* ------------------------------------------------------------------ */

function mid(a: InputPoint, b: InputPoint): InputPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, pressure: (a.pressure + b.pressure) / 2 };
}

/** Flatten a quadratic Bézier into points (excluding the start point). */
export function flattenQuad(p0: InputPoint, c: InputPoint, p1: InputPoint, maxStep = 2): InputPoint[] {
  const len = Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y);
  const n = Math.max(1, Math.min(64, Math.ceil(len / maxStep)));
  const out: InputPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
      pressure: mt * mt * p0.pressure + 2 * mt * t * c.pressure + t * t * p1.pressure,
    });
  }
  return out;
}

/**
 * Turns raw pointer samples into a smooth curve: the path runs through the midpoints of the
 * samples with the samples as quadratic control points (no corners on fast strokes).
 * Lags one half-segment behind the pointer; `finish()` flushes to the last sample.
 */
export class CurveSmoother {
  private prev: InputPoint | null = null;
  private lastMid: InputPoint | null = null;

  constructor(private maxStep = 2) {}

  /** Returns new path points to append. The first call returns the start point. */
  push(p: InputPoint): InputPoint[] {
    if (!this.prev) {
      this.prev = { ...p };
      this.lastMid = { ...p };
      return [{ ...p }];
    }
    if (Math.hypot(p.x - this.prev.x, p.y - this.prev.y) < 0.25) {
      this.prev = { ...this.prev, pressure: p.pressure };
      return [];
    }
    const m = mid(this.prev, p);
    const pts = flattenQuad(this.lastMid!, this.prev, m, this.maxStep);
    this.lastMid = m;
    this.prev = { ...p };
    return pts;
  }

  /** Flush the remaining half segment to the last sample. */
  finish(): InputPoint[] {
    if (!this.prev || !this.lastMid) return [];
    const a = this.lastMid;
    const b = this.prev;
    this.lastMid = { ...b };
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return [];
    return [{ ...b }];
  }
}

/* ------------------------------------------------------------------ */
/* Stabilizer (pulled string)                                          */
/* ------------------------------------------------------------------ */

/**
 * "Pulled string" stabilizer: the brush only moves when the pointer gets further than `radius`
 * away, and then it is dragged along the string. Radius 0 = pass-through.
 */
export class Stabilizer {
  private brush: InputPoint | null = null;

  constructor(public radius: number) {}

  /** Returns the new brush position, or null when the brush did not move. */
  push(p: InputPoint): InputPoint | null {
    if (!this.brush || this.radius <= 0) {
      this.brush = { ...p };
      return { ...p };
    }
    const dx = p.x - this.brush.x;
    const dy = p.y - this.brush.y;
    const d = Math.hypot(dx, dy);
    if (d <= this.radius) {
      return null;
    }
    const k = (d - this.radius) / d;
    this.brush = { x: this.brush.x + dx * k, y: this.brush.y + dy * k, pressure: p.pressure };
    return { ...this.brush };
  }

  /** Catch the brush up to the final pointer position (finish stroke end). */
  finish(p: InputPoint): InputPoint | null {
    if (!this.brush) return null;
    if (Math.hypot(p.x - this.brush.x, p.y - this.brush.y) < 0.5) return null;
    this.brush = { ...p };
    return { ...p };
  }
}

/** Stabilizer radius in screen px for a smoothing percentage (0..100). */
export function smoothingRadius(smoothing: number): number {
  const s = Math.max(0, Math.min(100, smoothing)) / 100;
  return s <= 0 ? 0 : Math.pow(s, 1.5) * 64;
}

/* ------------------------------------------------------------------ */
/* Dynamics                                                            */
/* ------------------------------------------------------------------ */

export interface DynamicsSettings {
  /** Base diameter (doc px). */
  size: number;
  flow: number;
  angle: number;
  roundness: number;
  sizeJitter: number;
  angleJitter: number;
  scatter: number;
  opacityJitter: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** Rotate the tip with the stroke direction. */
  followDirection: boolean;
}

/** Smallest fraction of the size a dab reaches at zero pressure. */
export const MIN_PRESSURE_SIZE = 0.06;

/** Map pen pressure to a size factor (soft curve so light strokes taper nicely). */
export function pressureSizeFactor(pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure));
  return MIN_PRESSURE_SIZE + (1 - MIN_PRESSURE_SIZE) * Math.pow(p, 0.8);
}

/** Base size of a dab ignoring random jitter (used for spacing and dirty-rect estimates). */
export function baseDabSize(s: DynamicsSettings, pressure: number): number {
  return s.pressureSize ? s.size * pressureSizeFactor(pressure) : s.size;
}

/** Resolve one dab from a path point, settings and a random source in [0,1). */
export function computeDab(p: DabPoint, s: DynamicsSettings, rand: () => number): Dab {
  let size = baseDabSize(s, p.pressure);
  if (s.sizeJitter > 0) size *= 1 - Math.min(1, s.sizeJitter) * rand();
  size = Math.max(0.5, size);

  let angle = s.angle;
  if (s.followDirection) angle += (p.direction * 180) / Math.PI;
  if (s.angleJitter > 0) angle += (rand() * 2 - 1) * 180 * Math.min(1, s.angleJitter);

  let x = p.x;
  let y = p.y;
  if (s.scatter > 0) {
    // Scatter mostly perpendicular to the stroke (like Photoshop), with a little along it.
    const amount = s.scatter * 2 * size;
    const perp = (rand() * 2 - 1) * amount;
    const along = (rand() * 2 - 1) * amount * 0.35;
    const cos = Math.cos(p.direction);
    const sin = Math.sin(p.direction);
    x += cos * along - sin * perp;
    y += sin * along + cos * perp;
  }

  let alpha = s.flow;
  if (s.pressureOpacity) alpha *= Math.max(0, Math.min(1, p.pressure));
  if (s.opacityJitter > 0) alpha *= 1 - Math.min(1, s.opacityJitter) * rand();

  return { x, y, size, angle, roundness: Math.max(0.02, Math.min(1, s.roundness)), alpha: Math.max(0, Math.min(1, alpha)) };
}

/** Axis-aligned bounds of a dab (rotated ellipse/box of the tip), in the dab's space. */
export function dabBounds(d: Dab): { x: number; y: number; width: number; height: number } {
  // Bounding box of a rotated rectangle of size (size × size*roundness).
  const r = d.size / 2;
  const a = (d.angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const hw = r * c + r * d.roundness * s;
  const hh = r * s + r * d.roundness * c;
  return { x: d.x - hw - 1, y: d.y - hh - 1, width: hw * 2 + 2, height: hh * 2 + 2 };
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/** Photoshop-like '[' / ']' size steps. */
export function nextBrushSize(size: number, dir: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 200 ? 25 : size < 500 ? 50 : 100;
  if (dir > 0) return Math.min(5000, Math.round(size + step));
  // When decreasing, use the step of the band below so 10 → 9, 50 → 45, …
  const downStep = size <= 10 ? 1 : size <= 50 ? 5 : size <= 100 ? 10 : size <= 200 ? 25 : size <= 500 ? 50 : 100;
  return Math.max(1, Math.round(size - downStep));
}

/** Round-tip falloff: alpha at normalized radius r (0 center .. 1 edge) for a hardness 0..1. */
export function roundFalloff(r: number, hardness: number, edgePx = 1, radiusPx = 50): number {
  if (r >= 1) return 0;
  const h = Math.max(0, Math.min(1, hardness));
  if (h >= 0.999) {
    // Hard edge with ~1px anti-aliasing.
    const aa = Math.max(1e-3, edgePx / Math.max(1, radiusPx));
    return r <= 1 - aa ? 1 : Math.max(0, (1 - r) / aa);
  }
  if (r <= h) return 1;
  const t = (r - h) / (1 - h);
  // Smooth bell-ish falloff: soft brushes look airbrushed, mid hardness keeps a crisp core.
  const u = 1 - t;
  return u * u * (3 - 2 * u);
}
