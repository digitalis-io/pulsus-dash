import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/types';
import type { RangeResult, VolumeResult } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { VOLUME_STACK } from '../explore/logsRun';
import { LogPager, type LogPagerState } from '../logs/logPager';
import { EMPTY_COMPLETENESS as EC } from '../test/histogramFixtures';
import { logFrame, pageRows, seriesResult, streamsResult } from '../test/logFrames';
import { fromInstant, fromRange } from '../vis/autovis';
import { R_A, R_H1 } from '../test/rangeFixtures';
import { fromLogqlPlanned } from './logPanel';
import { BY_VERSION, instant, range as catRange } from '../test/categoryFixtures';
import { fitBarchart } from '../vis/barchart';
import type { ExploreResult } from '../vis/autovis';
import {
  categoryView,
  panelFrame,
  positionText,
  panelIdleKey,
  panelRunKey,
  panelView,
  PANEL_KEY_HEAD,
  sameExceptWindow,
  sameKey,
} from './panelRun';
import type { PanelRun } from './usePanelRun';

const W = { fromMs: 1, toMs: 2 };
const R = { text: 'up', vars: '[]' };

describe('panelRunKey and sameExceptWindow', () => {
  it('panelRunKey and sameExceptWindow', () => {
    const k = panelRunKey('demo', 'p-1', R, 'range', 5000, W, null);
    expect(k).toEqual(['data', 'panel', 'demo', 'p-1', 'up', '[]', 'range', 5000, 1, 2, null]);
    expect(PANEL_KEY_HEAD).toBe(7);
    expect(panelIdleKey('demo', 'p-1', 'up')).toEqual(['data', 'panel', 'demo', 'p-1', 'up', null]);
    const heads = [
      panelRunKey('other', 'p-1', R, 'range', 5000, W, null),
      panelRunKey('demo', 'p-2', R, 'range', 5000, W, null),
      panelRunKey('demo', 'p-1', { ...R, text: 'x' }, 'range', 5000, W, null),
      panelRunKey('demo', 'p-1', { ...R, vars: '[["a","b"]]' }, 'range', 5000, W, null),
      panelRunKey('demo', 'p-1', R, 'instant', 5000, W, null),
    ];
    for (const h of heads) {
      expect(sameExceptWindow(k, h)).toBe(false);
      expect(sameKey(k, h)).toBe(false);
    }
    const windows = [
      panelRunKey('demo', 'p-1', R, 'range', 30000, W, null),
      panelRunKey('demo', 'p-1', R, 'range', 5000, { fromMs: 0, toMs: 2 }, null),
      panelRunKey('demo', 'p-1', R, 'range', 5000, { fromMs: 1, toMs: 3 }, null),
      // A ghost toggle (#173 Part 3b §4.2): the previous outcome is the placeholder.
      panelRunKey('demo', 'p-1', R, 'range', 5000, W, 86_400_000),
    ];
    for (const w of windows) {
      expect(sameExceptWindow(k, w)).toBe(true);
      expect(sameKey(k, w)).toBe(false);
    }
    const idle = panelIdleKey('demo', 'p-1', 'up');
    expect(sameExceptWindow(k, idle)).toBe(false);
    expect(sameExceptWindow(idle, idle)).toBe(false);
    expect(sameKey(k, panelRunKey('demo', 'p-1', R, 'range', 5000, W, null))).toBe(true);
    const ghost = panelRunKey('demo', 'p-1', R, 'range', 5000, W, 86_400_000);
    expect(ghost).toHaveLength(11);
    expect(ghost[10]).toBe(86_400_000);
  });
});

const BASE: PanelRun = {
  text: 'up{',
  blocked: null,
  missing: [],
  refusal: null,
  ready: true,
  outcome: null,
  error: null,
  diagnostics: [],
  fetching: false,
  stepMs: 5000,
  expanded: null,
  stream: null,
};

function outcome(r: RangeResult, facts: { rateApplied?: boolean } = {}) {
  return {
    key: [],
    planned: { ...r.planned, ...facts },
    result: fromRange(r),
  };
}

describe('panelView', () => {
  it('blocked states', () => {
    const msg = (run: Partial<PanelRun>) => panelView({ ...BASE, ...run }, { kind: 'auto' }, 'T');
    expect(msg({ blocked: 'logs' })).toEqual({
      kind: 'message',
      state: 'logs',
      text: 'A metric query has no log lines. Choose Auto or a chart.',
    });
    expect(msg({ blocked: 'empty' })).toEqual({
      kind: 'message',
      state: 'empty',
      text: 'Add a query',
    });
    expect(msg({ blocked: 'variable', missing: ['a', 'b'] })).toEqual({
      kind: 'message',
      state: 'variable',
      text: 'Set a value for $a, $b to run this panel',
    });
    expect(msg({ blocked: 'langFailed' })).toEqual({
      kind: 'message',
      state: 'langFailed',
      text: 'PromQL support could not be loaded. Reload the page.',
    });
    expect(msg({ blocked: 'refused', refusal: 'queryTooLarge' })).toMatchObject({
      kind: 'message',
      state: 'refused',
    });
    const big = msg({ blocked: 'refused', refusal: 'queryTooLarge' });
    const long = msg({ blocked: 'refused', refusal: 'tooLong' });
    expect(big).not.toEqual(long);
  });

  it('error, loading and results', () => {
    const e = new ApiError('queryInvalid', 'bad', { detail: { position: 3 } });
    expect(
      panelView(
        {
          ...BASE,
          error: e,
          diagnostics: [{ from: 2, to: 3, message: 'bad', positionKnown: true }],
        },
        { kind: 'auto' },
        'T',
      ),
    ).toEqual({ kind: 'error', text: 'bad', detail: 'bad (line 1, column 3)', narrow: false });
    const multi = panelView(
      {
        ...BASE,
        text: 'ab\ncd',
        error: e,
        diagnostics: [{ from: 4, to: 5, message: 'bad', positionKnown: true }],
      },
      { kind: 'auto' },
      'T',
    );
    // The diagnostics index the text the run had.
    expect(multi).toMatchObject({ kind: 'error', detail: 'bad (line 2, column 2)' });
    const broad = panelView(
      { ...BASE, error: new ApiError('tooBroad', 'wide') },
      { kind: 'auto' },
      'T',
    );
    expect(broad).toMatchObject({ kind: 'error', text: 'wide', narrow: true });
    expect(panelView(BASE, { kind: 'auto' }, 'T')).toEqual({ kind: 'loading' });

    const line = panelView({ ...BASE, outcome: outcome(R_A) }, { kind: 'auto' }, 'T');
    expect(line).toMatchObject({ kind: 'frame', vis: 'line', spec: { kind: 'line', title: 'T' } });
    const heat = panelView({ ...BASE, outcome: outcome(R_H1) }, { kind: 'auto' }, 'T');
    expect(heat).toMatchObject({ kind: 'frame', vis: 'heatmap' });
    const stat = panelView({ ...BASE, outcome: outcome(R_A) }, { kind: 'stat' }, 'T');
    expect(stat).toMatchObject({ kind: 'frame', vis: 'stat' });
    const rate = panelView(
      { ...BASE, outcome: outcome(R_A, { rateApplied: true }) },
      { kind: 'auto' },
      'T',
    );
    expect(rate).toMatchObject({ kind: 'frame', spec: { unit: { kind: 'suffix', suffix: '/s' } } });
    const noBuckets = panelView({ ...BASE, outcome: outcome(R_A) }, { kind: 'heatmap' }, 'T');
    expect(noBuckets).toMatchObject({ kind: 'message', state: 'noBuckets' });
    const str = panelView(
      {
        ...BASE,
        outcome: {
          key: [],
          planned: { ...R_A.planned, valueType: 'string' },
          result: fromInstant({
            planned: R_A.planned,
            kind: 'string',
            value: 'hi',
            timestampMs: 1,
            atMs: 1,
            completeness: R_A.completeness,
          }),
        },
      },
      { kind: 'auto' },
      'T',
    );
    expect(str).toEqual({ kind: 'message', state: 'string', text: 'String result: hi' });
  });

  it('position text in lines and code points', () => {
    expect(positionText('up{', [{ from: 2, to: 3, message: 'm', positionKnown: true }])).toBe(
      ' (line 1, column 3)',
    );
    expect(positionText('ab\ncd', [{ from: 4, to: 5, message: 'm', positionKnown: true }])).toBe(
      ' (line 2, column 2)',
    );
    expect(positionText('😀x', [{ from: 2, to: 3, message: 'm', positionKnown: true }])).toBe(
      ' (line 1, column 2)',
    );
    expect(positionText('x', [{ from: 0, to: 1, message: 'm', positionKnown: false }])).toBe('');
    expect(positionText('x', [])).toBe('');
  });
});

describe('panelView thresholds (#64 Part B §4.1)', () => {
  it('heatmap ignores thresholds', () => {
    const vis = {
      kind: 'heatmap' as const,
      thresholds: {
        direction: 'above' as const,
        steps: [{ value: 2, state: 'degraded' as const, label: '' }],
      },
    };
    const view = panelView({ ...BASE, outcome: outcome(R_H1) }, vis, 'T');
    expect(view).toMatchObject({ kind: 'frame', vis: 'heatmap' });
    if (view.kind !== 'frame') throw new Error('not a frame');
    expect('thresholds' in view.spec).toBe(false);
  });
});

// unit:panel-view (plan #67 §3.4): the LogQL rows.
const T0 = 1767225600000;
const T1 = 1767229200000;
const lvl = (l: string, v: number): SeriesFrame => ({
  key: l,
  labels: { level: l },
  timestamps: Float64Array.of(T0),
  values: Float64Array.of(v),
});
const STR = streamsResult(logFrame(pageRows(0, 1)), null);
const SER = { ...seriesResult(), series: [lvl('a', 1)] };
const VOL: VolumeResult = {
  startMs: T0,
  endMs: T1,
  stepMs: 1000,
  series: [lvl('error', 3), lvl('info', 5)],
  completeness: EC,
  planned: STR.planned,
};
const TH = {
  direction: 'above' as const,
  steps: [{ value: 2, state: 'degraded' as const, label: '' }],
};

function st(o: Partial<LogPagerState>): LogPagerState {
  return {
    version: 1,
    phase: 'pending',
    series: null,
    planned: null,
    completeness: null,
    head: { status: 'idle', error: null },
    tail: { status: 'idle', error: null },
    firstOrd: 0,
    endOrd: 0,
    atStart: true,
    atEnd: false,
    total: null,
    ...o,
  };
}

const PAGER = new LogPager(
  { queryLogs: () => Promise.reject(new Error('not called')) },
  {
    tenant: 'demo',
    query: '{app="x"}',
    fromMs: T0,
    toMs: T1,
    widthPx: 1000,
    direction: 'backward',
  },
);

function streamRun(pager: LogPager | null, state: LogPagerState | null): PanelRun {
  return {
    ...BASE,
    text: '{app="x"}',
    stream: {
      pager,
      state,
      wrap: false,
      setWrap: () => undefined,
      setDirection: () => undefined,
      rerun: () => undefined,
    },
  };
}

function frameRun(o: {
  logKind: 'streams' | 'series';
  result: ReturnType<typeof fromRange>;
  volume?: VolumeResult;
}): PanelRun {
  return {
    ...BASE,
    text: '{app="x"}',
    outcome: {
      key: [],
      planned: fromLogqlPlanned(o.logKind === 'series' ? SER.planned : STR.planned),
      result: o.result,
      logKind: o.logKind,
      ...(o.volume === undefined ? {} : { volume: o.volume }),
    },
  };
}

describe('unit:panel-view LogQL', () => {
  it('stream path', () => {
    expect(panelView(streamRun(null, null), { kind: 'auto' }, 'S')).toEqual({ kind: 'loading' });
    expect(panelView(streamRun(PAGER, st({})), { kind: 'auto' }, 'S')).toEqual({
      kind: 'loading',
    });
    const streams = streamRun(PAGER, st({ phase: 'streams', planned: STR.planned }));
    const v = panelView(streams, { kind: 'auto' }, 'S');
    expect(v.kind).toBe('stream');
    if (v.kind !== 'stream') throw new Error('not a stream');
    expect(v.stream.pager).toBe(PAGER);
    expect(panelView(streams, { kind: 'logs' }, 'S').kind).toBe('stream');

    const series = streamRun(PAGER, st({ phase: 'series', series: SER }));
    const line = panelView(series, { kind: 'auto' }, 'S');
    expect(line).toMatchObject({ kind: 'frame', vis: 'line', spec: { kind: 'line', title: 'S' } });
    // The same series state: the same result object (WeakMap-cached).
    const again = panelView(series, { kind: 'auto' }, 'S');
    if (line.kind !== 'frame' || again.kind !== 'frame') throw new Error('not a frame');
    expect(again.result).toBe(line.result);
    expect(line.result).toEqual(fromRange(SER));
    expect(panelView(series, { kind: 'logs' }, 'S')).toEqual({
      kind: 'message',
      state: 'logs',
      text: 'A metric query has no log lines. Choose Auto or a chart.',
    });
  });

  it('frame path', () => {
    expect(panelView({ ...BASE, text: '{app="x"}' }, { kind: 'bars' }, 'V')).toEqual({
      kind: 'loading',
    });
    const vol = frameRun({ logKind: 'streams', result: fromRange(VOL), volume: VOL });
    const bars = panelView(vol, { kind: 'bars', thresholds: TH }, 'V');
    expect(bars).toMatchObject({
      kind: 'frame',
      vis: 'bars',
      volume: true,
      legend: 'table',
      thresholds: TH,
      spec: {
        kind: 'bars',
        categoryLabel: 'level',
        categoryOrder: VOLUME_STACK,
        unit: { kind: 'suffix', suffix: 'lines' },
      },
    });
    if (bars.kind !== 'frame') throw new Error('not a frame');
    expect(bars.spec.kind === 'bars' && bars.spec.thresholds?.length).toBe(1);
    expect(bars.data).toEqual({ kind: 'series', series: VOL.series });
    const isolated = panelFrame(bars, 'error');
    expect(isolated.spec).toBe(bars.spec);
    expect(isolated.data).toEqual({ kind: 'series', series: [lvl('error', 3)] });
    // Cached per data and key.
    expect(panelFrame(bars, 'error').data).toBe(isolated.data);
    expect(panelFrame(bars, null)).toBe(bars);

    const metric = frameRun({ logKind: 'series', result: fromRange(SER) });
    for (const vis of ['bars', 'line', 'stat'] as const) {
      const fv = panelView(metric, { kind: vis }, 'M');
      expect(fv, vis).toMatchObject({ kind: 'frame', vis, spec: { kind: vis } });
      expect(fv).not.toHaveProperty('volume');
    }

    const empty = { kind: 'series' as const, source: 'range' as const, series: [], stepMs: 1000 };
    const notMetric = frameRun({ logKind: 'streams', result: { ...empty, completeness: EC } });
    for (const vis of ['line', 'heatmap', 'stat'] as const) {
      expect(panelView(notMetric, { kind: vis }, 'N'), vis).toEqual({
        kind: 'message',
        state: 'notMetric',
        text: 'Line, Heatmap and Stat draw metric queries. Choose Auto, Logs or Bars for log lines.',
      });
    }
  });
});

describe('barchart boundary (#173 Part 2)', () => {
  it('a board `auto` panel with a reducer over 5 range series stays a line', () => {
    const five: RangeResult = {
      ...R_A,
      series: [1, 2, 3, 4, 5].map((i) => ({
        key: i.toString(16).padStart(16, '0'),
        labels: { version: `2.${String(i)}` },
        timestamps: R_A.series[0]?.timestamps ?? new Float64Array(0),
        values: new Float64Array([i, i + 1, i + 2]),
      })),
    };
    const view = panelView(
      { ...BASE, outcome: outcome(five) },
      { kind: 'auto', options: { reducer: 'max' } },
      'T',
    );
    expect(view).toMatchObject({ kind: 'frame', vis: 'line', spec: { kind: 'line' } });
  });
});

/** `byVersion` on a range grid: each series constant at its value (T22 §10.2). */
const rangeByVersion = (scale = 1): ExploreResult =>
  catRange(
    BY_VERSION.map((v) => ({ labels: v.labels, values: [1, 2, 3].map(() => v.value * scale) })),
  );

function catOutcome(result: ExploreResult, baseline?: ExploreResult | 'failed') {
  return {
    key: [],
    planned: { ...R_A.planned, rateApplied: false, histogram: false },
    result,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

describe('unit:autovis-table (surfaces, #173 Part 3b)', () => {
  it('a board `auto` panel keeps the default set: never a category view', () => {
    const ranged = panelView(
      { ...BASE, outcome: catOutcome(rangeByVersion()) },
      { kind: 'auto', options: { reducer: 'max' } },
      'T',
    );
    expect(ranged).toMatchObject({ kind: 'frame', vis: 'line' });
    const inst = panelView(
      { ...BASE, outcome: catOutcome(instant(BY_VERSION)) },
      { kind: 'auto' },
      'T',
    );
    expect(inst).toMatchObject({ kind: 'frame', vis: 'line' });
  });
});

describe('unit:panel-view-category', () => {
  it('a saved bar chart is a category view, with its baseline', () => {
    const r = rangeByVersion();
    const v = panelView({ ...BASE, outcome: catOutcome(r) }, { kind: 'barchart' }, 'T');
    expect(v).toMatchObject({ kind: 'category', baselineFailed: false, lang: 'promql' });
    if (v.kind !== 'category') throw new Error('not a category view');
    expect(v.model.all.map((x) => x.name)).toEqual(['2.31', '2.29', '2.33', '2.30', '2.32']);
    expect(v.model.baseline).toBeNull();

    const half = rangeByVersion(0.5);
    const b = panelView({ ...BASE, outcome: catOutcome(r, half) }, { kind: 'barchart' }, 'T');
    if (b.kind !== 'category') throw new Error('not a category view');
    expect(b.model.all.find((x) => x.name === '2.31')?.baseline).toBe(60);
    expect(b.baselineFailed).toBe(false);

    const failed = panelView(
      { ...BASE, outcome: catOutcome(r, 'failed') },
      { kind: 'barchart' },
      'T',
    );
    expect(failed).toMatchObject({ kind: 'category', baselineFailed: true });
    if (failed.kind !== 'category') throw new Error('not a category view');
    expect(failed.model.all.every((x) => x.baseline === null)).toBe(true);
  });

  it('LogQL: the series phase and a series answer are category views', () => {
    const series = streamRun(PAGER, st({ phase: 'series', series: SER }));
    expect(panelView(series, { kind: 'barchart' }, 'S')).toMatchObject({
      kind: 'category',
      lang: 'logql',
      baselineFailed: false,
    });
    const frame = frameRun({ logKind: 'series', result: fromRange(SER) });
    expect(panelView(frame, { kind: 'barchart' }, 'S')).toMatchObject({
      kind: 'category',
      lang: 'logql',
    });
  });

  it('a stored pie stays unavailable', () => {
    expect(panelView({ ...BASE, blocked: 'kindUnavailable' }, { kind: 'pie' }, 'T')).toMatchObject({
      kind: 'message',
      state: 'kindUnavailable',
    });
  });
});

describe('model cache (unit:panel-view-category)', () => {
  it('every model input is in the cache key', () => {
    const r = rangeByVersion() as Exclude<ExploreResult, { kind: 'string' }>;
    const o = {
      rateApplied: false,
      panelVis: { kind: 'barchart' } as const,
      lang: 'promql' as const,
      baseline: undefined,
    };
    const modelOf = (title: string, panelVis: Parameters<typeof categoryView>[1]['panelVis']) => {
      const v = categoryView(r, { ...o, title, panelVis });
      expect(v.kind).toBe('category');
      if (v.kind !== 'category') throw new Error('not a category view');
      return v.model;
    };
    const a = modelOf('A', o.panelVis);
    const b = modelOf('B', o.panelVis);
    expect(b).not.toBe(a);
    expect(b.spec.title).toBe('B');
    const fit = fitBarchart(b, { width: 600, height: 240 }, (x) => 6 * x.length);
    expect(fit.facts.subject).toBe('B');
    const th = {
      kind: 'barchart' as const,
      thresholds: {
        direction: 'above' as const,
        steps: [{ value: 50, state: 'watch' as const, label: '' }],
      },
    };
    const c = modelOf('B', th);
    expect(c).not.toBe(b);
    expect(modelOf('B', th)).toBe(c);
  });
});
