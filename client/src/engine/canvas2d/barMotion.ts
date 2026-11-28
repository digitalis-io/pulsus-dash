/**
 * The bar chart's motion (Canvas 2D): the grow-in from the baseline on the first paint and on a
 * data change (`motion.zoom-open` ms on `easing-spring`), and the hover emphasis, where the bars
 * other than the hovered one ease to `HOVER_DIM` over `motion.hover` ms on `easing-out`. Under
 * reduced motion both land at once. The frame redraws its layer while `animating`.
 */
import { motion } from '../../styles/tokens';

/** The alpha of the bars other than the hovered one. */
export const HOVER_DIM = 0.55;

/** `cubic-bezier(x1, y1, x2, y2)` as a function of progress k ∈ [0, 1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (k: number) => number {
  const bx = (t: number): number => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number): number => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  return (k) => {
    if (!(k > 0)) return 0;
    if (k >= 1) return 1;
    // Bisection on x (monotone for x1, x2 ∈ [0, 1]): 20 steps is below a 1e-6 error.
    let lo = 0;
    let hi = 1;
    for (let n = 0; n < 20; n++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < k) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

/** A motion token's `cubic-bezier(…)` as a function; linear when it does not parse. */
export function easingOf(token: string): (k: number) => number {
  const m = /cubic-bezier\(([^)]*)\)/.exec(token);
  const p = (m?.[1] ?? '').split(',').map((s) => Number(s.trim()));
  const [a, b, c, d] = p;
  if (p.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined)
    return (k) => Math.min(1, Math.max(0, k));
  return cubicBezier(a, b, c, d);
}

const growEase = easingOf(motion['easing-spring']);
const hoverEase = easingOf(motion['easing-out']);
const GROW_MS = motion['zoom-open'];
const HOVER_MS = motion.hover;

interface Fade {
  readonly from: number;
  readonly to: number;
  readonly start: number;
}

export class BarMotion {
  private growStart: number | null = null;
  private hover: string | null = null;
  /** Per key: the hover alpha fade in flight or landed. */
  private readonly fades = new Map<string, Fade>();
  private hoverChanged = -Infinity;

  constructor(private readonly reduced: () => boolean) {}

  /** The first paint or new data: the bars grow from the baseline again. */
  restart(now: number): void {
    this.growStart = this.reduced() ? null : now;
  }

  /** The grow progress at `now`, eased: 1 once landed or under reduced motion. */
  grow(now: number): number {
    if (this.growStart === null) return 1;
    const k = (now - this.growStart) / GROW_MS;
    if (k >= 1) {
      this.growStart = null;
      return 1;
    }
    return growEase(Math.max(0, k));
  }

  /** The hovered key; true when it changed. */
  setHover(key: string | null, keys: readonly string[], now: number): boolean {
    if (key === this.hover) return false;
    const reduced = this.reduced();
    for (const k of keys) {
      const from = reduced ? this.target(k, key) : this.alphaOf(k, now);
      this.fades.set(k, { from, to: this.target(k, key), start: now });
    }
    this.hover = key;
    this.hoverChanged = reduced ? -Infinity : now;
    return true;
  }

  get hovered(): string | null {
    return this.hover;
  }

  /** A bar's hover alpha at `now` (1 with no hover). */
  alphaOf(key: string, now: number): number {
    const f = this.fades.get(key);
    if (f === undefined) return this.target(key, this.hover);
    const k = (now - f.start) / HOVER_MS;
    if (k >= 1 || this.reduced()) return f.to;
    return f.from + (f.to - f.from) * hoverEase(Math.max(0, k));
  }

  /** A grow or a hover fade is still in flight at `now`. */
  animating(now: number): boolean {
    return (
      (this.growStart !== null && now - this.growStart < GROW_MS) ||
      now - this.hoverChanged < HOVER_MS
    );
  }

  private target(key: string, hover: string | null): number {
    return hover === null || key === hover ? 1 : HOVER_DIM;
  }
}
