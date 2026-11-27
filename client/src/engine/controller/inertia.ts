/**
 * The T02-022 inertia spring (plan #234 Part 2 §4.4, INT-003), shared by every camera that flings:
 * a critically damped spring whose initial velocity is the release velocity. Pure.
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

/** The offset along one axis `tMs` after a release at `v` px/ms; `done` once it has settled. */
export function spring(v: number, tMs: number): { offset: number; done: boolean } {
  void v;
  void tMs;
  return { offset: 0, done: true };
}

/** The release velocity (px/ms per axis) of `samples` at `nowMs`. */
export function releaseVelocity(
  samples: readonly MoveSample[],
  nowMs: number,
): { vx: number; vy: number } {
  void samples;
  void nowMs;
  return { vx: 0, vy: 0 };
}
