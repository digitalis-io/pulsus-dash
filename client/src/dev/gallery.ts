/** The chart gallery's entries (plan #58 Appendix A §A.1): one per chart kind and stress case. */
import type { EventMarker, FrameData, TimeWindow, VisSpec } from '../engine/api';
import { t } from '../i18n/t';
import { LEVELS, synthHeatmap, synthLevels, synthLines } from './synth';

export const GALLERY_SEED = 20261120;
export type GalleryId =
  | 'line-1'
  | 'line-50'
  | 'line-gaps'
  | 'line-600'
  | 'heatmap'
  | 'bars'
  | 'stat'
  | 'line-thresholds'
  | 'stat-sparkline'
  | 'line-extreme'
  | 'line-events';
export interface GalleryEntry {
  readonly id: GalleryId;
  readonly spec: VisSpec;
  readonly data: FrameData;
  /** Event markers (ADR-0023); absent = none. */
  readonly events?: readonly EventMarker[];
}

const HEATMAP_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity];

/** Each series' finite values mapped onto [−MAX, MAX]: q = (v − lo)/(hi − lo), MAX·(2q − 1); NaN stays; hi === lo → 0. */
function nearLimit(d: FrameData): FrameData {
  if (d.kind !== 'series') return d;
  const series = d.series.map((s) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of s.values) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const values = s.values.map((v) => {
      if (!Number.isFinite(v)) return v;
      if (hi === lo) return 0;
      const q = (v - lo) / (hi - lo);
      return Number.MAX_VALUE * (2 * q - 1);
    });
    return { ...s, values };
  });
  return { kind: 'series', series };
}

/** The `line-events` markers: a deploy at 30 % of the window, a config and a flag change 30 s apart at 70 %. */
function galleryEvents(w: TimeWindow): EventMarker[] {
  const at = (f: number): number => Math.round(w.fromMs + f * (w.toMs - w.fromMs));
  return [
    { id: 'gallery-deploy', atMs: at(0.3), endMs: null, kind: 'deploy', title: 'v2.31' },
    { id: 'gallery-config', atMs: at(0.7), endMs: null, kind: 'config', title: 'pool size 64' },
    { id: 'gallery-flag', atMs: at(0.7) + 30_000, endMs: null, kind: 'flag', title: 'checkout-v2' },
  ];
}

/**
 * The eleven entries in table order; entry `i` uses seed `(seed ?? GALLERY_SEED) + i`. Entries 7
 * and 8 show threshold lines and a stat sparkline (#64 Part B, ADR-0022); entry 9 spans values near
 * the largest finite number (#97); the last has three event markers, two of them gathered into a
 * `+2` chip (#64 Part C, ADR-0023).
 */
export function galleryEntries(w: TimeWindow, seed?: number): GalleryEntry[] {
  const s0 = seed ?? GALLERY_SEED;
  const win = { fromMs: w.fromMs, toMs: w.toMs };
  const lines = (
    i: number,
    series: number,
    points: number,
    name: string,
    base: number,
    amp: number,
    gaps = false,
  ): FrameData => ({
    kind: 'series',
    series: synthLines({ seed: s0 + i, series, points, ...win, name, base, amp, gaps }),
  });
  return [
    {
      id: 'line-1',
      spec: { kind: 'line', title: t('gallery.line1'), unit: { kind: 'suffix', suffix: 'rps' } },
      data: lines(0, 1, 1_440, 'http_requests_per_second', 1200, 300),
    },
    {
      id: 'line-50',
      spec: { kind: 'line', title: t('gallery.line50'), unit: { kind: 'time', base: 'ms' } },
      data: lines(1, 50, 1_440, 'http_request_duration_ms', 180, 40),
    },
    {
      id: 'line-gaps',
      spec: { kind: 'line', title: t('gallery.gaps'), unit: { kind: 'none' } },
      data: lines(2, 3, 1_440, 'queue_depth', 40, 15, true),
    },
    {
      id: 'line-600',
      spec: { kind: 'line', title: t('gallery.line600'), unit: { kind: 'bytes' } },
      data: lines(3, 600, 60, 'container_memory_bytes', 8e8, 2e8),
    },
    {
      id: 'heatmap',
      spec: {
        kind: 'heatmap',
        title: t('gallery.heatmap'),
        unit: { kind: 'time', base: 's' },
        countUnit: { kind: 'none' },
      },
      data: {
        kind: 'heatmap',
        heatmap: synthHeatmap({ seed: s0 + 4, ...win, columns: 60, bounds: HEATMAP_BOUNDS }),
      },
    },
    {
      id: 'bars',
      spec: {
        kind: 'bars',
        title: t('gallery.bars'),
        unit: { kind: 'suffix', suffix: 'lines' },
        stacking: 'normal',
        categoryLabel: 'level',
        categoryOrder: LEVELS,
      },
      data: {
        kind: 'series',
        series: synthLevels({ seed: s0 + 5, ...win, buckets: 60, levels: LEVELS }),
      },
    },
    {
      id: 'stat',
      spec: { kind: 'stat', title: t('gallery.stat'), unit: { kind: 'time', base: 'ms' } },
      data: { kind: 'scalar', scalar: { value: 2843, timestampMs: w.toMs } },
    },
    {
      id: 'line-thresholds',
      spec: {
        kind: 'line',
        title: t('gallery.lineThresholds'),
        unit: { kind: 'time', base: 's' },
        thresholds: [
          { value: 0.25, state: 'watch', label: '≥ 250 ms' },
          { value: 0.3, state: 'failing', label: 'SLO p99 ≤ 300 ms' },
        ],
      },
      data: lines(7, 3, 1_440, 'http_request_duration_seconds', 0.2, 0.06),
    },
    {
      id: 'stat-sparkline',
      spec: { kind: 'stat', title: t('gallery.statSparkline'), unit: { kind: 'time', base: 'ms' } },
      data: lines(8, 1, 120, 'http_request_duration_p99_ms', 280, 60),
    },
    {
      id: 'line-extreme',
      spec: { kind: 'line', title: t('gallery.lineExtreme'), unit: { kind: 'none' } },
      data: nearLimit(lines(9, 1, 1_440, 'near_limit_values', 0, 1)),
    },
    {
      id: 'line-events',
      spec: {
        kind: 'line',
        title: t('gallery.lineEvents'),
        unit: { kind: 'suffix', suffix: 'rps' },
      },
      data: lines(10, 1, 1_440, 'checkout_requests_per_second', 1200, 300),
      events: galleryEvents(win),
    },
  ];
}
