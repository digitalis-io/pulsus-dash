/**
 * Seeded synthetic frames for the chart gallery (plan #58 Appendix A §A.1). Pure functions of their
 * arguments: the same seed and window always give the same data, so the gallery is a golden corpus.
 */
import type { HeatmapFrame, SeriesFrame } from '../data/frames';
import { keyHash } from './keyHash';

export const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export const LEVEL_BASE = [5, 20, 200, 80, 30] as const;

/** A hash of the integers in [0, 1). */
export function hash01(...ints: number[]): number {
  let h = 0x9e3779b9;
  for (const n of ints) {
    h = Math.imul(h ^ (n | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return (h >>> 0) / 2 ** 32;
}

/** The value of line series `j` at `tMs`. */
export function synthLineValue(
  seed: number,
  j: number,
  tMs: number,
  base: number,
  amp: number,
): number {
  const b = base * (0.5 + hash01(seed, j, 1));
  const a = amp * (0.5 + hash01(seed, j, 2));
  const period = 600_000 * (1 + Math.floor(6 * hash01(seed, j, 3)));
  const phase = 2 * Math.PI * hash01(seed, j, 4);
  const noise = 0.2 * a * (hash01(seed, j, 5, Math.floor(tMs / 1000)) - 0.5);
  return b + a * Math.sin((2 * Math.PI * tMs) / period + phase) + noise;
}

function isGap(j: number, k: number): boolean {
  if (j === 0) return k >= 300 && k < 360;
  if (j === 1) return k % 97 === 13;
  if (j === 2) return k >= 500 && k < 520 && k !== 510;
  return false;
}

export function synthLines(o: {
  seed: number;
  series: number;
  points: number;
  fromMs: number;
  toMs: number;
  name: string;
  base: number;
  amp: number;
  gaps?: boolean;
}): SeriesFrame[] {
  const step = Math.floor((o.toMs - o.fromMs) / o.points);
  const out: SeriesFrame[] = [];
  for (let j = 0; j < o.series; j++) {
    const labels = { __name__: o.name, pod: `pod-${String(j).padStart(3, '0')}` };
    const timestamps = new Float64Array(o.points);
    const values = new Float64Array(o.points);
    for (let k = 0; k < o.points; k++) {
      const t = o.fromMs + k * step;
      timestamps[k] = t;
      values[k] =
        o.gaps === true && isGap(j, k) ? NaN : synthLineValue(o.seed, j, t, o.base, o.amp);
    }
    out.push({ key: keyHash(labels), labels, timestamps, values });
  }
  return out;
}

export function synthHeatmap(o: {
  seed: number;
  fromMs: number;
  toMs: number;
  columns: number;
  bounds: readonly number[];
}): HeatmapFrame {
  const step = Math.floor((o.toMs - o.fromMs) / o.columns);
  const nb = o.bounds.length;
  const timestamps = new Float64Array(o.columns);
  const counts = new Float64Array(o.columns * nb);
  for (let c = 0; c < o.columns; c++) {
    timestamps[c] = o.fromMs + c * step;
    for (let b = 0; b < nb; b++) {
      counts[c * nb + b] = Math.round(
        1000 * Math.exp(-((b - 4.5) ** 2) / 4) * (0.8 + 0.4 * hash01(o.seed, c, b, 7)),
      );
    }
  }
  return { timestamps, bounds: new Float64Array(o.bounds), counts };
}

export function synthLevels(o: {
  seed: number;
  fromMs: number;
  toMs: number;
  buckets: number;
  levels: readonly string[];
}): SeriesFrame[] {
  const step = Math.floor((o.toMs - o.fromMs) / o.buckets);
  return o.levels.map((level, i) => {
    const labels = { level, service_name: 'checkout' };
    const timestamps = new Float64Array(o.buckets);
    const values = new Float64Array(o.buckets);
    const base = LEVEL_BASE[i] ?? 10;
    for (let k = 0; k < o.buckets; k++) {
      timestamps[k] = o.fromMs + k * step;
      values[k] = Math.round(base * (0.6 + 0.8 * hash01(o.seed, i, k, 9)));
    }
    return { key: keyHash(labels), labels, timestamps, values };
  });
}
