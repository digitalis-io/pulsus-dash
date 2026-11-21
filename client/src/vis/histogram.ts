/** Stub (tests first, plan #63 §5). */
import type { HeatmapFrame, SeriesFrame } from '../data/frames';

export function histogramBuckets(_series: readonly SeriesFrame[]): HeatmapFrame | null {
  return null;
}

export function isolateBucket(_series: readonly SeriesFrame[], _key: string): HeatmapFrame | null {
  return null;
}
