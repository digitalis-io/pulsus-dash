import { describe, expect, it } from 'vitest';
import type { VisSpec } from '../engine/api';
import {
  emptyFrameData,
  seriesName,
  validateFrameData,
  type FrameData,
  type FrameDataIssue,
  type SeriesFrame,
} from './frames';

const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const BARS: VisSpec = {
  kind: 'bars',
  title: 'T',
  unit: { kind: 'none' },
  stacking: 'normal',
  categoryLabel: 'level',
  categoryOrder: ['error', 'info'],
};
const HEAT: VisSpec = {
  kind: 'heatmap',
  title: 'T',
  unit: { kind: 'none' },
  countUnit: { kind: 'none' },
};
const STAT: VisSpec = { kind: 'stat', title: 'T', unit: { kind: 'none' } };

const K1 = '00000000000000a1';
const K2 = '00000000000000b2';

function series(key: string, ts: number[], vs: number[], labels = {}): SeriesFrame {
  return { key, labels, timestamps: new Float64Array(ts), values: new Float64Array(vs) };
}
const lines = (...s: SeriesFrame[]): FrameData => ({ kind: 'series', series: s });
const heat = (ts: number[], bounds: number[], counts: number[]): FrameData => ({
  kind: 'heatmap',
  heatmap: {
    timestamps: new Float64Array(ts),
    bounds: new Float64Array(bounds),
    counts: new Float64Array(counts),
  },
});

describe('unit:frame-validate', () => {
  it.each<[string, VisSpec, FrameData, FrameDataIssue | null]>([
    ['line valid', LINE, lines(series(K1, [1, 2, 3], [1, NaN, 3])), null],
    [
      'bars valid',
      BARS,
      lines(series(K1, [1, 2], [1, 2], { level: 'error' }), series(K2, [1, 2], [3, 4])),
      null,
    ],
    ['heatmap valid', HEAT, heat([1, 2], [1, 2, Infinity], [1, 2, 3, 4, 5, 6]), null],
    ['heatmap [0, +Inf] valid', HEAT, heat([1], [0, Infinity], [1, 2]), null],
    ['stat scalar valid', STAT, { kind: 'scalar', scalar: { value: 1, timestampMs: 0 } }, null],
    ['stat series valid', STAT, lines(series(K1, [1], [1])), null],
    ['kind', LINE, { kind: 'scalar', scalar: { value: 1, timestampMs: 0 } }, { code: 'kind' }],
    ['kind heatmap', HEAT, lines(), { code: 'kind' }],
    ['key', LINE, lines(series('ABC', [1], [1])), { code: 'key', key: 'ABC' }],
    [
      'length',
      LINE,
      lines(series(K1, [1, 2, 3], [1, 2])),
      { code: 'length', key: K1, timestamps: 3, values: 2 },
    ],
    ['order', LINE, lines(series(K1, [1, 1], [1, 2])), { code: 'order', key: K1 }],
    [
      'cells',
      HEAT,
      heat([1, 2], [1, 2], [1, 2, 3]),
      { code: 'cells', columns: 2, buckets: 2, cells: 3 },
    ],
    ['bounds', HEAT, heat([1], [2, 1], [1, 2]), { code: 'bounds' }],
    ['finite', HEAT, heat([1], [Infinity], [1]), { code: 'finite' }],
    [
      'grid',
      BARS,
      lines(series(K1, [1, 2], [1, 2]), series(K2, [1, 3], [3, 4])),
      { code: 'grid', key: K2 },
    ],
  ])('%s', (_name, spec, data, want) => {
    expect(validateFrameData(spec, data)).toEqual(want);
  });

  it('empty data per kind', () => {
    expect(emptyFrameData(LINE)).toEqual({ kind: 'series', series: [] });
    expect(emptyFrameData(BARS)).toEqual({ kind: 'series', series: [] });
    const h = emptyFrameData(HEAT);
    expect(h.kind === 'heatmap' && h.heatmap.counts.length).toBe(0);
    const s = emptyFrameData(STAT);
    expect(s.kind === 'scalar' && Number.isNaN(s.scalar.value)).toBe(true);
  });

  it('names series', () => {
    expect(seriesName({ __name__: 'up', b: '2', a: '1' })).toBe('up{a="1", b="2"}');
    expect(seriesName({})).toBe('{}');
    expect(seriesName({ level: 'error' })).toBe('{level="error"}');
  });
});
