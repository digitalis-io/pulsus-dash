/**
 * The baseline run's window (plan #173 Part 3a §3.8; T22-012): the offset a bar chart's baseline
 * uses, the option else 1 d while the ghost is on, and the Context window shifted back by it. The
 * shifted run itself is `usePanelRun`'s (#173 Part 3b).
 */
import type { VisOptions } from '../api/types';
import type { TimeWindow } from '../engine/api';

export type Offset = NonNullable<VisOptions['baselineOffset']>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Each offset in ms. */
export const OFFSET_MS: Readonly<Record<Offset, number>> = Object.freeze({
  '1h': HOUR,
  '1d': DAY,
  '7d': 7 * DAY,
  '28d': 28 * DAY,
});

/** `o.baselineOffset`, else `1d` with the ghost on, else null (no baseline run). */
export function baselineOffset(o: VisOptions | undefined, ghost: boolean): Offset | null {
  return o?.baselineOffset ?? (ghost ? '1d' : null);
}

/** Both ends of `w` moved back by `off`. */
export function shiftWindow(w: TimeWindow, off: Offset): TimeWindow {
  const d = OFFSET_MS[off];
  return { fromMs: w.fromMs - d, toMs: w.toMs - d };
}
