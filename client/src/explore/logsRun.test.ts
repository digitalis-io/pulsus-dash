// unit:logs-run (plan #66 Part C §3.8, §4.2, §5.1; SRF-033, PRF-031, T09-015).
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/types';
import type { LogsResult, VolumeResult } from '../data/decode';
import { validateFrameData } from '../data/frames';
import type { LogPagerState } from '../logs/logPager';
import { EMPTY_COMPLETENESS, fkey } from '../test/histogramFixtures';
import {
  firstPageError,
  layoutOf,
  logsStatusView,
  metricPlan,
  nextLast,
  pagerInput,
  VOLUME_STACK,
  volumePlan,
} from './logsRun';

const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };
const STEP = { stepMs: 5000, widthPx: 960 };
type Series = Extract<LogsResult, { kind: 'series' }>;

function series(n = 1): Series {
  return {
    kind: 'series',
    planned: { query: 'q', expanded: 'q', bytes: 1, stepMs: 5000 },
    startMs: W.fromMs,
    endMs: W.toMs,
    stepMs: 5000,
    series: Array.from({ length: n }, (_, i) => ({
      key: fkey(i + 1),
      labels: { level: 'error', n: String(i) },
      timestamps: Float64Array.of(W.fromMs, W.fromMs + 5000),
      values: Float64Array.of(1, 2),
    })),
    completeness: EMPTY_COMPLETENESS,
  };
}

function state(p: Partial<LogPagerState> = {}): LogPagerState {
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
    ...p,
  };
}

const PENDING = state();
const STREAMS = state({ phase: 'streams', completeness: EMPTY_COMPLETENESS });
const failed = (error: unknown): LogPagerState =>
  state({ phase: 'failed', tail: { status: 'error', error } });

describe('unit:logs-run', () => {
  it('pagerInput: null without a runnable query, else the raw text and the run inputs', () => {
    const base = {
      tenant: 'demo',
      q: '{app="a"}',
      window: W,
      step: STEP,
      dir: 'backward' as const,
    };
    expect(pagerInput({ ...base, q: '  ' })).toBeNull();
    expect(pagerInput({ ...base, q: '{a="' + 'x'.repeat(131_072) + '"}' })).toBeNull();
    expect(pagerInput({ ...base, step: null })).toBeNull();
    const i = pagerInput({ ...base, dir: 'forward' });
    expect(i).toEqual({
      tenant: 'demo',
      query: '{app="a"}',
      fromMs: W.fromMs,
      toMs: W.toMs,
      widthPx: 960,
      direction: 'forward',
    });
    expect(i !== null && 'limit' in i).toBe(false);
  });

  it('nextLast keeps the last answer of this tenant', () => {
    const s = series();
    const streams = nextLast(null, 't', STREAMS);
    expect(streams).toEqual({ tenant: 't', layout: 'streams', series: null });
    const last = nextLast(streams, 't', state({ phase: 'series', series: s }));
    expect(last).toEqual({ tenant: 't', layout: 'series', series: s });
    expect(last?.series).toBe(s);
    expect(nextLast(last, 't', PENDING)).toBe(last);
    expect(nextLast(last, 't', failed(new Error('x')))).toBe(last);
    expect(nextLast(last, 't', null)).toBe(last);
    expect(nextLast(last, 't', state({ phase: 'series', series: s }))).toBe(last);
    expect(nextLast(streams, 't', STREAMS)).toBe(streams);
    expect(nextLast(last, 'u', PENDING)).toBeNull();
    expect(nextLast(last, 'u', failed(new Error('x')))).toBeNull();
    expect(nextLast(last, 'u', null)).toBeNull();
    expect(nextLast(last, 'u', STREAMS)).toEqual({ tenant: 'u', layout: 'streams', series: null });
  });

  it('layoutOf: §4.2', () => {
    expect(layoutOf(null, null)).toBe('streams');
    expect(layoutOf('pending', null)).toBe('streams');
    expect(layoutOf('pending', 'streams')).toBe('streams');
    expect(layoutOf('pending', 'series')).toBe('series');
    expect(layoutOf('failed', null)).toBe('streams');
    expect(layoutOf('failed', 'series')).toBe('series');
    expect(layoutOf(null, 'series')).toBe('series');
    expect(layoutOf('streams', 'series')).toBe('streams');
    expect(layoutOf('series', 'streams')).toBe('series');
    expect(layoutOf('series', null)).toBe('series');
  });

  it('volumePlan: stacked bars by level', () => {
    const v: VolumeResult = { ...series(0), series: [] };
    const levels = ['error', 'info'].map((level, i) => ({
      key: fkey(i + 1),
      labels: { level },
      timestamps: Float64Array.of(W.fromMs, W.fromMs + 5000),
      values: Float64Array.of(i, i + 1),
    }));
    const p = volumePlan({ ...v, series: levels });
    expect(p.spec).toEqual({
      kind: 'bars',
      title: 'Log volume',
      unit: { kind: 'suffix', suffix: 'lines' },
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: VOLUME_STACK,
    });
    expect(p.data).toEqual({ kind: 'series', series: levels });
    expect(validateFrameData(p.spec, p.data)).toBeNull();
    expect(VOLUME_STACK).toEqual([
      'critical',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
      'unknown',
    ]);
  });

  it('metricPlan: a line of the series', () => {
    const s = series(2);
    const p = metricPlan(s);
    expect(p.spec).toEqual({ kind: 'line', title: 'Query result', unit: { kind: 'none' } });
    expect(p.data).toEqual({ kind: 'series', series: s.series });
  });

  it('firstPageError: the tail error of a failed first page only', () => {
    const e = new Error('x');
    expect(firstPageError(null)).toBeNull();
    expect(firstPageError(PENDING)).toBeNull();
    expect(firstPageError(failed(e))).toBe(e);
    expect(firstPageError(state({ phase: 'streams', tail: { status: 'error', error: e } }))).toBe(
      null,
    );
  });

  describe('logsStatusView: one case per row of §3.8', () => {
    const base = {
      runRefusal: null,
      draftOver: false,
      urlRefusal: null,
      runReady: true,
      editorLoaded: true,
      state: null,
      dir: 'backward' as const,
      diagnostics: [],
    };
    const TOO_LARGE =
      'This query is over 128 KB. Completion is paused, and it cannot be run until it is shorter.';

    it('1 runRefusal', () => {
      expect(
        logsStatusView({
          ...base,
          runRefusal: 'queryTooLarge',
          draftOver: true,
          urlRefusal: 'queryTooLarge',
        }),
      ).toEqual({ kind: 'refused', text: TOO_LARGE });
    });
    it('2 draftOver', () => {
      expect(logsStatusView({ ...base, draftOver: true, urlRefusal: 'queryTooLarge' })).toEqual({
        kind: 'limit',
        text: TOO_LARGE,
      });
    });
    it('3 urlRefusal', () => {
      expect(logsStatusView({ ...base, urlRefusal: 'queryTooLarge', runReady: false })).toEqual({
        kind: 'refused',
        text: TOO_LARGE,
      });
    });
    it('4 waiting', () => {
      expect(logsStatusView({ ...base, runReady: false, state: STREAMS })).toEqual({
        kind: 'waiting',
        text: 'Run is available once the chart has a size.',
      });
    });
    it('5 error, with narrow and the diagnostic', () => {
      expect(
        logsStatusView({ ...base, state: failed(new ApiError('tooBroad', 'too broad')) }),
      ).toEqual({ kind: 'error', text: 'too broad', narrow: true });
      expect(
        logsStatusView({
          ...base,
          state: failed(new ApiError('queryInvalid', 'bad', { detail: { position: 8 } })),
          diagnostics: [{ from: 8, to: 9, message: 'expected }', positionKnown: true }],
        }),
      ).toEqual({ kind: 'error', text: 'expected }', narrow: false });
    });
    it('6 all lines', () => {
      expect(
        logsStatusView({ ...base, state: state({ ...STREAMS, atEnd: true, total: 3 }) }),
      ).toEqual({ kind: 'ok', text: '3 log lines · newest first' });
    });
    it('7 streams', () => {
      expect(logsStatusView({ ...base, dir: 'forward', state: STREAMS })).toEqual({
        kind: 'ok',
        text: 'Log lines · oldest first',
      });
    });
    it('8 series', () => {
      expect(
        logsStatusView({ ...base, state: state({ phase: 'series', series: series(2) }) }),
      ).toEqual({ kind: 'ok', text: '2 series · step 5 s' });
    });
    it('9 none', () => {
      expect(logsStatusView({ ...base, state: PENDING })).toEqual({ kind: 'none' });
      expect(logsStatusView(base)).toEqual({ kind: 'none' });
    });
  });
});
