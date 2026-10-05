/**
 * BrushStroke: turns pointer samples into resolved dabs (stabilizer → curve smoothing →
 * spacing → dynamics). Pure logic (no canvas), shared by the live tools and stroke previews.
 */
import { rng } from '../../../core/noise';
import {
  CurveSmoother,
  DabSpacer,
  Stabilizer,
  baseDabSize,
  computeDab,
  type Dab,
  type DabPoint,
  type DynamicsSettings,
  type InputPoint,
} from './math';

export interface StrokeConfig extends DynamicsSettings {
  /** Spacing as a fraction of the diameter. */
  spacing: number;
  /** Pulled-string radius in document px (0 = off). */
  stabilizer: number;
  /** Max curve flattening step in doc px. */
  curveStep?: number;
  seed?: number;
}

export class BrushStroke {
  private spacer: DabSpacer;
  private smoother: CurveSmoother;
  private stab: Stabilizer;
  private rand: () => number;
  /** First point held back until the direction is known (follow-direction tips). */
  private pending: InputPoint | null = null;
  private current: InputPoint | null = null;

  constructor(private cfg: StrokeConfig) {
    this.spacer = new DabSpacer((pressure) => Math.max(0.5, cfg.spacing * baseDabSize(cfg, pressure)));
    this.smoother = new CurveSmoother(cfg.curveStep ?? Math.max(1, Math.min(4, cfg.size * cfg.spacing)));
    this.stab = new Stabilizer(cfg.stabilizer);
    this.rand = rng(cfg.seed ?? (Math.random() * 2 ** 31) | 0);
  }

  /** Last brush position (after stabilization), doc space. */
  get position(): InputPoint | null {
    return this.current;
  }

  get settings(): StrokeConfig {
    return this.cfg;
  }

  private resolve(points: DabPoint[]): Dab[] {
    return points.map((p) => computeDab(p, this.cfg, this.rand));
  }

  begin(p: InputPoint): Dab[] {
    this.current = { ...p };
    this.stab.push(p);
    this.smoother.push(p);
    if (this.cfg.followDirection) {
      this.pending = { ...p };
      this.spacer.start(p);
      return [];
    }
    return this.resolve(this.spacer.start(p));
  }

  /**
   * Start the stroke at `p` WITHOUT stamping there (Shift-click polylines continue from the
   * previous stroke's end point, which already has a dab — stamping it again would leave a
   * darker blob at every joint with soft or low-flow brushes). Follow with lineTo().
   */
  beginAt(p: InputPoint): void {
    this.current = { ...p };
    this.stab.push(p);
    this.smoother.push(p);
    this.pending = null;
    this.spacer.start(p);
  }

  private feed(points: InputPoint[]): Dab[] {
    const out: DabPoint[] = [];
    for (const pt of points) {
      const dabs = this.spacer.lineTo(pt);
      if (this.pending && (dabs.length || Math.hypot(pt.x - this.pending.x, pt.y - this.pending.y) > 0.5)) {
        out.push({ ...this.pending, direction: this.spacer.direction });
        this.pending = null;
      }
      out.push(...dabs);
    }
    return this.resolve(out);
  }

  move(p: InputPoint): Dab[] {
    const b = this.stab.push(p);
    if (!b) return [];
    this.current = { ...b };
    return this.feed(this.smoother.push(b));
  }

  /** Finish the stroke (catch up to the final pointer position). */
  end(p?: InputPoint): Dab[] {
    const pts: InputPoint[] = [];
    if (p) {
      const b = this.stab.finish(p);
      if (b) {
        this.current = { ...b };
        pts.push(...this.smoother.push(b));
      }
    }
    pts.push(...this.smoother.finish());
    const dabs = this.feed(pts);
    if (this.pending) {
      // A click without movement: stamp once with the base angle.
      dabs.push(...this.resolve([{ ...this.pending, direction: 0 }]));
      this.pending = null;
    }
    return dabs;
  }

  /** Straight segment to `p` bypassing smoothing (Shift-click lines). */
  lineTo(p: InputPoint): Dab[] {
    const dabs = this.feed([p]);
    this.current = { ...p };
    this.smoother = new CurveSmoother(this.cfg.curveStep ?? 2);
    this.smoother.push(p);
    this.stab = new Stabilizer(this.cfg.stabilizer);
    this.stab.push(p);
    return dabs;
  }

  /** Airbrush build-up: one extra dab at the current brush position. */
  stationary(): Dab[] {
    if (!this.current) return [];
    return this.resolve([{ ...this.current, direction: this.spacer.direction }]);
  }
}
