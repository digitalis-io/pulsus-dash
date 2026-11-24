// plan #67 §5.1: the pure parts of a board LogQL panel.
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../api/Api';
import type { LogsRequest, VolumeRequest } from '../api/types';
import type { LogqlPlannedQuery, LogsResult, VolumeResult } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import type { LogPagerState } from '../logs/logPager';
import { EMPTY_COMPLETENESS as EC } from '../test/histogramFixtures';
import { logFrame, pageRows, seriesResult, streamsResult } from '../test/logFrames';
import { fromRange } from '../vis/autovis';
import {
  fetchLogFrame,
  fromLogqlPlanned,
  logPanelPath,
  streamInput,
  streamMeta,
  type StreamRun,
} from './logPanel';

const T0 = 1767225600000;
const T1 = 1767229200000;
const STR = streamsResult(logFrame(pageRows(0, 1)), null);
const SER = seriesResult();
const lvl = (l: string, v: number): SeriesFrame => ({
  key: l,
  labels: { level: l },
  timestamps: Float64Array.of(T0),
  values: Float64Array.of(v),
});
const VOL: VolumeResult = {
  startMs: T0,
  endMs: T1,
  stepMs: 1000,
  series: [lvl('error', 3), lvl('info', 5)],
  completeness: EC,
  planned: STR.planned,
};
const REQ = { query: '{app="x"}', fromMs: T0, toMs: T1, widthPx: 1000, vars: {} };
const P = (p: LogqlPlannedQuery) => ({
  ...p,
  valueType: 'unknown',
  rateCandidate: false,
  rateApplied: false,
  histogram: false,
});

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

const A: StreamRun = {
  input: { tenant: 'demo', ...REQ, direction: 'backward' },
  generation: '0.0.0',
};
const A2: StreamRun = structuredClone(A);
const B: StreamRun = { ...A, input: { ...A.input, toMs: T1 + 1 } };
const G: StreamRun = { ...A, generation: '1.0.0' };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** An api whose two calls return the test's deferreds, with their signals recorded. */
function spies() {
  const logs = deferred<LogsResult>();
  const volume = deferred<VolumeResult>();
  const queryLogs = vi.fn<(t: string, r: LogsRequest, s?: AbortSignal) => Promise<LogsResult>>(
    () => logs.promise,
  );
  const queryVolume = vi.fn<
    (t: string, r: VolumeRequest, s?: AbortSignal) => Promise<VolumeResult>
  >(() => volume.promise);
  const api: Pick<Api, 'queryLogs' | 'queryVolume'> = { queryLogs, queryVolume };
  const logsSignal = () => queryLogs.mock.calls[0]?.[2];
  const volumeSignal = () => queryVolume.mock.calls[0]?.[2];
  return { api, logs, volume, queryLogs, queryVolume, logsSignal, volumeSignal };
}

/** An outer signal whose `removeEventListener('abort', …)` calls are counted. */
function outer() {
  const c = new AbortController();
  const remove = vi.spyOn(c.signal, 'removeEventListener');
  const removed = () => remove.mock.calls.filter((x) => x[0] === 'abort').length;
  return { c, signal: c.signal, removed };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('unit:log-panel-path', () => {
  it('maps the six kinds', () => {
    expect(logPanelPath('auto')).toBe('stream');
    expect(logPanelPath('logs')).toBe('stream');
    expect(logPanelPath('bars')).toBe('logs-bars');
    expect(logPanelPath('line')).toBe('logs-frame');
    expect(logPanelPath('heatmap')).toBe('logs-frame');
    expect(logPanelPath('stat')).toBe('logs-frame');
  });
});

describe('unit:stream-input', () => {
  it('enabled runs next; hidden keeps only the held key and generation', () => {
    expect(streamInput(true, null, A)).toBe(A);
    expect(streamInput(false, A, A2)).toBe(A2);
    expect(streamInput(false, A, B)).toBeNull();
    expect(streamInput(false, A, G)).toBeNull();
    expect(streamInput(false, null, A)).toBeNull();
    expect(streamInput(true, A, null)).toBeNull();
  });
});

describe('unit:fetch-log-frame', () => {
  it('F1 bars: the volume starts before the probe settles; the probe is limit 1', async () => {
    const s = spies();
    const o = outer();
    const done = fetchLogFrame(s.api, 'demo', REQ, true, o.signal);
    expect(s.queryVolume).toHaveBeenCalledTimes(1);
    expect(s.queryVolume.mock.calls[0]?.[0]).toBe('demo');
    expect(s.queryVolume.mock.calls[0]?.[1]).toEqual(REQ);
    expect(s.queryLogs).toHaveBeenCalledTimes(1);
    expect(s.queryLogs.mock.calls[0]?.[0]).toBe('demo');
    const sent = s.queryLogs.mock.calls[0]?.[1];
    expect(sent).toEqual({ ...REQ, limit: 1 });
    expect(sent).not.toHaveProperty('direction');
    expect(sent).not.toHaveProperty('cursor');
    expect(s.logsSignal()).toBeInstanceOf(AbortSignal);
    expect(s.volumeSignal()).toBe(s.logsSignal());
    s.logs.resolve(STR);
    s.volume.resolve(VOL);
    await done;
  });

  it('F2 bars, streams: the volume frame', async () => {
    const s = spies();
    const o = outer();
    const done = fetchLogFrame(s.api, 'demo', REQ, true, o.signal);
    s.logs.resolve(STR);
    s.volume.resolve(VOL);
    expect(await done).toEqual({
      planned: P(STR.planned),
      result: fromRange(VOL),
      logKind: 'streams',
      volume: VOL,
    });
    expect(o.removed()).toBe(1);
  });

  it('F3 frame, streams: an empty series result and no volume', async () => {
    const s = spies();
    const o = outer();
    const done = fetchLogFrame(s.api, 'demo', REQ, false, o.signal);
    s.logs.resolve(STR);
    expect(await done).toEqual({
      planned: P(STR.planned),
      result: { kind: 'series', source: 'range', series: [], stepMs: 1000, completeness: EC },
      logKind: 'streams',
    });
    expect(s.queryVolume).not.toHaveBeenCalled();
    expect(o.removed()).toBe(1);
  });

  it('F4 bars, series: the series; the volume aborts and its rejection is handled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const s = spies();
      const o = outer();
      const done = fetchLogFrame(s.api, 'demo', REQ, true, o.signal);
      s.logs.resolve(SER);
      expect(await done).toEqual({
        planned: P(SER.planned),
        result: fromRange(SER),
        logKind: 'series',
      });
      expect(s.volumeSignal()?.aborted).toBe(true);
      s.volume.reject(new DOMException('aborted', 'AbortError'));
      await tick();
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
      expect(o.removed()).toBe(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('F5 rejections and the outer abort', async () => {
    const E1 = new Error('E1');
    const E2 = new Error('E2');

    const a = spies();
    const oa = outer();
    const da = fetchLogFrame(a.api, 'demo', REQ, true, oa.signal);
    a.logs.reject(E1);
    await expect(da).rejects.toBe(E1);
    expect(a.volumeSignal()?.aborted).toBe(true);
    expect(oa.removed()).toBe(1);

    const b = spies();
    const ob = outer();
    const db = fetchLogFrame(b.api, 'demo', REQ, true, ob.signal);
    b.logs.resolve(STR);
    b.volume.reject(E2);
    await expect(db).rejects.toBe(E2);
    expect(ob.removed()).toBe(1);

    const c = spies();
    const oc = outer();
    const dc = fetchLogFrame(c.api, 'demo', REQ, true, oc.signal);
    oc.c.abort();
    expect(c.logsSignal()?.aborted).toBe(true);
    expect(c.volumeSignal()?.aborted).toBe(true);
    c.logs.reject(new DOMException('aborted', 'AbortError'));
    c.volume.reject(new DOMException('aborted', 'AbortError'));
    await expect(dc).rejects.toMatchObject({ name: 'AbortError' });
    expect(oc.removed()).toBe(1);
  });
});

describe('unit:stream-meta', () => {
  it('planned and completeness by phase', () => {
    const CT = { ...EC, truncated: true };
    expect(streamMeta(null)).toEqual({ planned: null, completeness: null });
    expect(streamMeta(st({}))).toEqual({ planned: null, completeness: null });
    expect(streamMeta(st({ phase: 'streams', planned: STR.planned, completeness: CT }))).toEqual({
      planned: STR.planned,
      completeness: CT,
    });
    expect(streamMeta(st({ phase: 'series', series: SER }))).toEqual({
      planned: SER.planned,
      completeness: SER.completeness,
    });
  });
});

describe('unit:logql-planned', () => {
  it('eight keys, no rate window', () => {
    const p = fromLogqlPlanned(SER.planned);
    expect(p).toStrictEqual(P(SER.planned));
    expect(Object.keys(p)).toHaveLength(8);
    expect(p).not.toHaveProperty('rateWindowMs');
  });
});
