/**
 * Multi-click counter (pure). Chromium reports `detail = 0` on pointerdown, so the type tool counts
 * clicks itself: a press within `ms` and `px` (screen) of the previous one increments the count
 * (1 = caret, 2 = word, 3 = line/paragraph, 4 = all; a 5th press starts over), anything else
 * restarts at 1.
 */
export class ClickCounter {
  private last: { t: number; x: number; y: number; count: number } | null = null;

  constructor(
    private readonly ms = 500,
    private readonly px = 4,
    private readonly max = 4,
  ) {}

  /** Register a press at a screen point and return its click count. */
  press(x: number, y: number, now: number): number {
    const p = this.last;
    const near = !!p && now - p.t >= 0 && now - p.t <= this.ms && Math.abs(x - p.x) <= this.px && Math.abs(y - p.y) <= this.px;
    const count = near && p ? (p.count >= this.max ? 1 : p.count + 1) : 1;
    this.last = { t: now, x, y, count };
    return count;
  }

  /** Forget the sequence (the next press counts as a single click). */
  reset() {
    this.last = null;
  }
}
