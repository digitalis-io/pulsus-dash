/** The baseline run's window (plan #173 Part 3a §3.8). Stub (tests first). */
import type { VisOptions } from '../api/types';
import type { TimeWindow } from '../engine/api';

export type Offset = NonNullable<VisOptions['baselineOffset']>;
export const OFFSET_MS: Readonly<Record<Offset, number>> = { '1h': 0, '1d': 0, '7d': 0, '28d': 0 };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function baselineOffset(o: VisOptions | undefined, ghost: boolean): Offset | null {
  return null;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shiftWindow(w: TimeWindow, off: Offset): TimeWindow {
  return w;
}
