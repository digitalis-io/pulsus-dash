/**
 * The T22-003 merge of the series of one key (plan #173 Part 1 §4.1; moved from
 * `transforms/histogram.ts`, T21 parity): the histogram and the categorical rows both read it, so
 * they count the same conflicts.
 */
import type { SeriesFrame } from '../data/frames';

/**
 * The merged finite samples of one key and its ±∞ samples, counted before the merge.
 * - **range:** a single series passes through (its finite samples). Otherwise finite samples are
 *   joined by timestamp, ascending, the max on a shared one; each timestamp shared by two or more
 *   samples is one conflict.
 * - **instant:** each series' latest finite sample; the latest timestamp wins, the max on a tie,
 *   and only a tie at that latest timestamp is a conflict. One sample, or none.
 */
export function mergeKey(
  series: readonly SeriesFrame[],
  source: 'instant' | 'range',
): { timestamps: number[]; values: number[]; conflicts: number; infinite: number } {
  let infinite = 0;
  for (const s of series)
    for (const v of s.values) if (v === Infinity || v === -Infinity) infinite += 1;
  if (source === 'instant') {
    let at = -Infinity;
    let value: number | null = null;
    let tied = false;
    for (const s of series) {
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i] ?? NaN;
        if (!Number.isFinite(v)) continue;
        const ts = s.timestamps[i] ?? NaN;
        if (value === null || ts > at) {
          at = ts;
          value = v;
          tied = false;
        } else if (ts === at) {
          tied = true;
          value = Math.max(value, v);
        }
        break;
      }
    }
    return value === null
      ? { timestamps: [], values: [], conflicts: 0, infinite }
      : { timestamps: [at], values: [value], conflicts: tied ? 1 : 0, infinite };
  }
  const only = series.length === 1 ? series[0] : undefined;
  if (only !== undefined) {
    const timestamps: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < only.values.length; i++) {
      const v = only.values[i] ?? NaN;
      if (!Number.isFinite(v)) continue;
      timestamps.push(only.timestamps[i] ?? NaN);
      values.push(v);
    }
    return { timestamps, values, conflicts: 0, infinite };
  }
  const byTs = new Map<number, { v: number; shared: boolean }>();
  for (const s of series) {
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i] ?? NaN;
      if (!Number.isFinite(v)) continue;
      const ts = s.timestamps[i] ?? NaN;
      const was = byTs.get(ts);
      if (was === undefined) byTs.set(ts, { v, shared: false });
      else byTs.set(ts, { v: Math.max(was.v, v), shared: true });
    }
  }
  const timestamps = [...byTs.keys()].sort((a, b) => a - b);
  let conflicts = 0;
  const values: number[] = [];
  for (const ts of timestamps) {
    const x = byTs.get(ts);
    if (x === undefined) continue;
    values.push(x.v);
    if (x.shared) conflicts += 1;
  }
  return { timestamps, values, conflicts, infinite };
}
