// unit:inspect-target (T25-002, T25-005, T25 §4.2, plan #192 §5).
import { describe, expect, it } from 'vitest';
import { seriesName } from '../data/frames';
import type { FrameData, HoverEvent, VisSpec } from '../engine/api';
import type { InspectorTarget } from '../inspector/types';
import { hoverItemOf, selectionOf, statTarget, targetOf } from './inspectTarget';

const K1 = '00000000000000a1';
const NONE = { kind: 'none' } as const;
const series = (labels: Readonly<Record<string, string>>): FrameData => ({
  kind: 'series',
  series: [
    { key: K1, labels, timestamps: new Float64Array([0, 1000]), values: new Float64Array([1, 2]) },
  ],
});

describe('unit:inspect-target', () => {
  it('line: a point named by its series', () => {
    const spec: VisSpec = { kind: 'line', title: 'T', unit: NONE };
    const labels = { job: 'a' };
    const t = targetOf(spec, series(labels), { kind: 'point', key: K1, tMs: 1000, value: 2 });
    expect(t).toEqual({
      type: 'point',
      vis: 'line',
      key: K1,
      labels,
      name: seriesName(labels),
      tMs: 1000,
      value: 2,
    });
    expect(selectionOf(t)).toEqual({ keys: [K1], fromMs: null, toMs: null });
  });

  it('bars: a point named by its category value', () => {
    const spec: VisSpec = {
      kind: 'bars',
      title: 'T',
      unit: NONE,
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: [],
    };
    const t = targetOf(spec, series({ level: 'error' }), {
      kind: 'point',
      key: K1,
      tMs: 0,
      value: 1,
    });
    expect(t).toMatchObject({ type: 'point', vis: 'bars', name: 'error' });
  });

  it('heatmap: bucket bounds and the next column start', () => {
    const spec: VisSpec = {
      kind: 'heatmap',
      title: 'H',
      unit: { kind: 'time', base: 's' },
      countUnit: NONE,
    };
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([0, 30_000, 60_000]),
        bounds: new Float64Array([0.1, 1, Infinity]),
        counts: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      },
    };
    const hover = (tMs: number, key: string, value: number): HoverEvent => ({
      source: 'keyboard',
      tMs,
      xCss: 0,
      yCss: 0,
      rows: [{ key, name: key, colourIndex: null, value }],
    });
    const h1 = hover(30_000, '0', 4);
    const i1 = hoverItemOf(
      spec,
      data,
      h1,
      h1.rows[0] ?? { key: '', name: '', colourIndex: null, value: 0 },
      90_000,
    );
    expect(i1).toEqual({ kind: 'bucket', index: 0, tMs: 30_000, toMs: 60_000, count: 4 });
    const t1 = targetOf(spec, data, i1);
    expect(t1).toMatchObject({
      type: 'bucket',
      index: 0,
      lower: null,
      upper: 0.1,
      toMs: 60_000,
      count: 4,
    });
    const h2 = hover(60_000, '2', 9);
    const i2 = hoverItemOf(
      spec,
      data,
      h2,
      h2.rows[0] ?? { key: '', name: '', colourIndex: null, value: 0 },
      70_000,
    );
    const t2 = targetOf(spec, data, i2);
    expect(t2).toMatchObject({ type: 'bucket', index: 2, lower: 1, upper: Infinity, toMs: 90_000 });
    expect(t2.type === 'bucket' ? t2.countUnit : null).toEqual(NONE);
    expect(selectionOf(t2)).toEqual({ keys: [], fromMs: 60_000, toMs: 90_000 });
  });

  it('line keyboard row: the point at the crosshair', () => {
    const spec: VisSpec = { kind: 'line', title: 'T', unit: NONE };
    const h: HoverEvent = {
      source: 'keyboard',
      tMs: 1000,
      xCss: 0,
      yCss: 0,
      rows: [{ key: K1, name: 'a', colourIndex: 1, value: 2 }],
    };
    const row = h.rows[0] ?? { key: '', name: '', colourIndex: null, value: 0 };
    expect(hoverItemOf(spec, series({}), h, row, 2000)).toEqual({
      kind: 'point',
      key: K1,
      tMs: 1000,
      value: 2,
    });
  });

  it('stat: the scalar, or the first series last finite sample', () => {
    const spec = { kind: 'stat', title: 'S', unit: NONE } as const;
    expect(statTarget(spec, { kind: 'scalar', scalar: { value: 3, timestampMs: 5 } })).toEqual({
      type: 'value',
      key: null,
      labels: {},
      name: 'S',
      value: 3,
      tMs: 5,
      state: null,
    });
    const s: FrameData = {
      kind: 'series',
      series: [
        {
          key: K1,
          labels: {},
          timestamps: new Float64Array([0, 1000]),
          values: new Float64Array([1, NaN]),
        },
      ],
    };
    const v = statTarget(spec, s);
    expect(v).toMatchObject({ type: 'value', key: K1, value: 1, tMs: 0 });
    expect(selectionOf(v)).toEqual({ keys: [K1], fromMs: null, toMs: null });
  });

  it('a log line selects its stream and instant', () => {
    const t: InspectorTarget = {
      type: 'logLine',
      streamKey: 's2',
      labels: {},
      tsNs: 1_500_000_000n,
      level: 'info',
      line: 'l',
      metadata: null,
      parsed: null,
    };
    expect(selectionOf(t)).toEqual({ keys: ['s2'], fromMs: 1500, toMs: 1501 });
  });
});
