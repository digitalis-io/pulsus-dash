/**
 * The T02-022 inertia spring (plan #234 Part 2 §4.4, INT-003), shared by every camera that flings.
 * A critically damped spring with ω = 0.0194 ms⁻¹ whose initial velocity is the release velocity v:
 * offset(t) = D − (D + (ωD − v)t)e^(−ωt) with D = 2v/ω. It never overshoots (ωD ≥ v), and 2 % of D
 * is left at t ≈ 267 ms, inside T02-022's 300 ± 50 ms; there it snaps to D. Pure.
 */

/** ω, ms⁻¹. */
export const SPRING_OMEGA = 0.0194;
/** A release faster than this (px/ms) flings. */
export const FLING_MIN_SPEED = 0.3;
/** The release velocity is the displacement over this many ms of moves. */
export const VELOCITY_WINDOW_MS = 80;
/** The spring settles when this share of its end offset is left. */
export const SPRING_REST = 0.02;

export interface MoveSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** The end offset of a release at `v` px/ms. */
export const springEnd = (v: number): number => (2 * v) / SPRING_OMEGA;

/**
 * The offset along one axis `tMs` after a release at `v` px/ms; `done` once ≤ 2 % of the end
 * offset is left (the same t for every v), and then the offset is the end offset exactly.
 */
export function spring(v: number, tMs: number): { offset: number; done: boolean } {
  const D = springEnd(v);
  const t = Math.max(0, tMs);
  // ωD − v = v for D = 2v/ω.
  const left = (D + v * t) * Math.exp(-SPRING_OMEGA * t);
  const done = v === 0 || Math.abs(left) <= SPRING_REST * Math.abs(D);
  return { offset: done ? D : D - left, done };
}

/**
 * The release velocity (px/ms per axis) at `nowMs`: the displacement between the first and the last
 * sample of the last 80 ms over their time apart; 0 when fewer than two samples fall in it.
 */
export function releaseVelocity(
  samples: readonly MoveSample[],
  nowMs: number,
): { vx: number; vy: number } {
  let first: MoveSample | null = null;
  let last: MoveSample | null = null;
  for (const s of samples) {
    if (s.t < nowMs - VELOCITY_WINDOW_MS || s.t > nowMs) continue;
    first ??= s;
    last = s;
  }
  if (first === null || last === null || !(last.t > first.t)) return { vx: 0, vy: 0 };
  const dt = last.t - first.t;
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}
