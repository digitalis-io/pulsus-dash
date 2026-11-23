import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { StubApi } from '../../../api/StubApi';
import { ApiError, type PromMatchRequest } from '../../../api/types';
import type { PromMetadata, PromValues } from '../../../data/decode';
import { flush } from '../../../test/viewIn';
import { SuggestCache } from '../../suggestCache';
import { createPromSource } from './promSource';

// B.4.4 of plan #63 Part B.
const C0 = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};
const V = (...xs: string[]): PromValues => ({ values: xs, completeness: C0 });
const R = { fromMs: 3_600_000, toMs: 7_200_000 };
const abortError = () => new DOMException('Aborted', 'AbortError');

let api: StubApi;
let qc: QueryClient;
let cache: SuggestCache;
let W: { fromMs: number; toMs: number };
let unhandled: Mock;
let labelValues: Mock<StubApi['promLabelValues']>;
let labels: Mock<StubApi['promLabels']>;
let series: Mock<StubApi['promSeries']>;
let metadata: Mock<StubApi['promMetadata']>;

beforeEach(() => {
  api = new StubApi();
  qc = new QueryClient();
  cache = new SuggestCache();
  W = { ...R };
  labelValues = vi.spyOn(api, 'promLabelValues');
  labels = vi.spyOn(api, 'promLabels');
  series = vi.spyOn(api, 'promSeries');
  metadata = vi.spyOn(api, 'promMetadata');
  unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
});
afterEach(async () => {
  await flush();
  process.off('unhandledRejection', unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});

const source = (tenant = 'demo', c: SuggestCache = cache) =>
  createPromSource({ api, queryClient: qc, tenant, window: () => W, cache: c });

/** A call that settles only when the test settles it, deaf to its signal. */
function deafCall<T>() {
  let resolve: (v: T) => void = () => undefined;
  let signal: AbortSignal | undefined;
  const promise = (s?: AbortSignal) => {
    signal = s;
    return new Promise<T>((r) => {
      resolve = r;
    });
  };
  return {
    promise,
    resolve: (v: T) => {
      resolve(v);
    },
    signal: () => signal,
  };
}

function settled<T>(p: Promise<T>): { done: boolean; value: T | undefined } {
  const box: { done: boolean; value: T | undefined } = { done: false, value: undefined };
  void p.then((v) => {
    box.done = true;
    box.value = v;
  });
  return box;
}

const SECRET: PromMetadata = {
  metrics: { secret: [{ type: 'gauge', help: 's', unit: '' }] },
  completeness: C0,
};

describe('unit:prom-source', () => {
  it('S1: metric names: one request for the window, shared', async () => {
    labelValues.mockResolvedValue(V('a_total', 'b'));
    const s = source();
    const [a, b] = await Promise.all([s.metricNames(), s.metricNames()]);
    expect(labelValues).toHaveBeenCalledTimes(1);
    expect(labelValues).toHaveBeenCalledWith(
      'demo',
      '__name__',
      { ...R, limit: 10_000 },
      expect.any(AbortSignal),
    );
    expect(a).toEqual(['a_total', 'b']);
    expect(b).toEqual(['a_total', 'b']);
  });

  it('S2: keyed by the 15-min window bucket', async () => {
    labelValues.mockResolvedValue(V('a_total', 'b'));
    const s = source();
    await s.metricNames();
    W.toMs = 7_299_999;
    await s.metricNames();
    expect(labelValues).toHaveBeenCalledTimes(1);
    W = { fromMs: 4_500_000, toMs: 8_100_000 };
    await s.metricNames();
    expect(labelValues).toHaveBeenCalledTimes(2);
    expect(labelValues.mock.calls[1]?.[2]).toEqual({
      fromMs: 4_500_000,
      toMs: 8_100_000,
      limit: 10_000,
    });
  });

  it('S3: a lookup of another key does not abort; the caller signal does', async () => {
    let first: AbortSignal | undefined;
    labelValues.mockImplementation((_t, _n, req: PromMatchRequest, signal?: AbortSignal) => {
      if (req.match?.[0] === 'up') {
        first = signal;
        return new Promise((_r, reject) => {
          signal?.addEventListener('abort', () => {
            reject(abortError());
          });
        });
      }
      return Promise.resolve(V('n1'));
    });
    const s = source();
    const c1 = new AbortController();
    const p1 = s.labelValues('job', 'up', c1.signal);
    const p2 = s.labelValues('job', 'node', new AbortController().signal);
    expect(first?.aborted).toBe(false);
    c1.abort();
    expect(first?.aborted).toBe(true);
    expect(await p1).toEqual([]);
    expect(await p2).toEqual(['n1']);
    expect(labelValues).toHaveBeenLastCalledWith(
      'demo',
      'job',
      { ...R, match: ['node'], limit: 1_000 },
      expect.any(AbortSignal),
    );
  });

  it('S15: every lookup passes the caller signal', async () => {
    const held = <T>() =>
      vi.fn(
        (...args: unknown[]) =>
          new Promise<T>((_r, reject) => {
            const signal = args.at(-1) as AbortSignal | undefined;
            signal?.addEventListener('abort', () => {
              reject(abortError());
            });
          }),
      );
    const names = held<PromValues>();
    const lbls = held<PromValues>();
    const sers = held<Awaited<ReturnType<StubApi['promSeries']>>>();
    labelValues.mockImplementation(names);
    labels.mockImplementation(lbls);
    series.mockImplementation(sers);
    const s = source();
    let sig = new AbortController();
    const calls: [string, () => Promise<readonly unknown[]>, Mock][] = [
      ['metricNames', () => s.metricNames(sig.signal), names],
      ['labelNames', () => s.labelNames('up', sig.signal), lbls],
      ['series', () => s.series('up', sig.signal), sers],
    ];
    for (const [name, run, spy] of calls) {
      sig = new AbortController();
      const p = run();
      const signal = spy.mock.calls.at(-1)?.at(-1) as AbortSignal | undefined;
      expect(signal?.aborted, name).toBe(false);
      sig.abort();
      expect(signal?.aborted, name).toBe(true);
      expect(await p, name).toEqual([]);
    }
  });

  it('S4: label names with and without a selector', async () => {
    labels.mockResolvedValue(V('job'));
    const s = source();
    await s.labelNames(null);
    await s.labelNames('up');
    expect(labels.mock.calls.map((c) => c[1])).toEqual([
      { ...R, limit: 1_000 },
      { ...R, match: ['up'], limit: 1_000 },
    ]);
    expect(Object.keys(labels.mock.calls[0]?.[1] ?? {})).not.toContain('match');
  });

  it('S5: a failed lookup resolves [] and is not kept', async () => {
    labels.mockRejectedValue(new ApiError('timeout', 't'));
    const s = source();
    expect(await s.labelNames('x')).toEqual([]);
    expect(await s.labelNames('x')).toEqual([]);
    expect(labels).toHaveBeenCalledTimes(2);
  });

  it('S6: series', async () => {
    series.mockResolvedValue({
      series: [{ key: '0123456789abcdef', labels: { job: 'a' } }],
      completeness: C0,
    });
    const s = source();
    expect(await s.series('')).toEqual([]);
    expect(series).not.toHaveBeenCalled();
    expect(await s.series('up{job="a"}')).toEqual([{ job: 'a' }]);
    expect(series).toHaveBeenCalledWith(
      'demo',
      { ...R, match: ['up{job="a"}'], limit: 1_000 },
      expect.any(AbortSignal),
    );
  });

  it('S7, S12: a source for another tenant drops the cache; the old source sends nothing', async () => {
    labelValues.mockResolvedValue(V('a'));
    const s = source();
    await s.metricNames();
    const s2 = source('other');
    expect(cache.size).toBe(0);
    await s2.metricNames();
    expect(labelValues).toHaveBeenLastCalledWith(
      'other',
      '__name__',
      expect.anything(),
      expect.any(AbortSignal),
    );
    const n = labelValues.mock.calls.length;
    expect(await s.metadata()).toEqual({});
    expect(await s.labelValues('job', null)).toEqual([]);
    expect(metadata).not.toHaveBeenCalled();
    expect(labelValues).toHaveBeenCalledTimes(n);
  });

  it('S8 (a): metadata from the page query', async () => {
    qc.setQueryData(['prom', 'demo', 'metadata'], {
      metrics: { up: [{ type: 'gauge', help: 'Target up.', unit: '' }] },
      completeness: C0,
    });
    expect(await source().metadata()).toEqual({ up: [{ type: 'gauge', help: 'Target up.' }] });
    expect(metadata).not.toHaveBeenCalled();
  });

  it('S8 (b), (c): metadata fetched once; a failure is {}', async () => {
    metadata.mockResolvedValue({
      metrics: { up: [{ type: 'gauge', help: 'Target up.', unit: '' }] },
      completeness: C0,
    });
    expect(await source().metadata()).toEqual({ up: [{ type: 'gauge', help: 'Target up.' }] });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith('demo', { limit: 10_000 }, expect.any(AbortSignal));
    qc = new QueryClient();
    metadata.mockRejectedValue(new ApiError('unavailable', 'm'));
    expect(await source().metadata()).toEqual({});
  });

  it('S10: metadata of a tenant switched away from is never delivered', async () => {
    const d = deafCall<PromMetadata>();
    metadata.mockImplementation((_t, _r, signal) => d.promise(signal));
    const p = source().metadata();
    const box = settled(p);
    source('other');
    await flush();
    expect(box.done).toBe(true);
    expect(box.value).toEqual({});
    d.resolve(SECRET);
    await flush();
    expect(await p).toEqual({});
    expect(qc.getQueryData(['prom', 'demo', 'metadata'])).toEqual(SECRET);
    expect(qc.getQueryData(['prom', 'other', 'metadata'])).toBeUndefined();
  });

  it('S11: nor after clear(), with the request stuck', async () => {
    const d = deafCall<PromMetadata>();
    metadata.mockImplementation((_t, _r, signal) => d.promise(signal));
    const box = settled(source().metadata());
    cache.clear();
    await flush();
    expect(box.done).toBe(true);
    expect(box.value).toEqual({});
    expect(metadata).toHaveBeenCalledTimes(1);
  });

  it('S13 (a): after clear() the old source sends nothing; a new one does', async () => {
    labelValues.mockResolvedValue(V('a'));
    metadata.mockResolvedValue(SECRET);
    const s = source();
    await s.metricNames();
    cache.clear();
    expect(await s.labelValues('job', null)).toEqual([]);
    expect(await s.metadata()).toEqual({});
    expect(labelValues).toHaveBeenCalledTimes(1);
    expect(metadata).not.toHaveBeenCalled();
    const s3 = source('demo');
    await s3.labelValues('job', null);
    expect(labelValues).toHaveBeenCalledTimes(2);
    expect(labelValues).toHaveBeenLastCalledWith(
      'demo',
      'job',
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('S13 (b): a → b → a: the first a source sends nothing', async () => {
    labelValues.mockResolvedValue(V('a'));
    const sa = source('a');
    source('b');
    const sa2 = source('a');
    expect(await sa.metricNames()).toEqual([]);
    expect(labelValues).not.toHaveBeenCalled();
    await sa2.metricNames();
    expect(labelValues).toHaveBeenCalledTimes(1);
    expect(labelValues.mock.calls[0]?.[0]).toBe('a');
  });

  it('S9: an evicted in-flight lookup is not delivered after a switch', async () => {
    const small = new SuggestCache({ maxKeys: 1 });
    const d = deafCall<PromValues>();
    labelValues.mockImplementation((_t, _n, _r, signal) => d.promise(signal));
    labels.mockResolvedValue(V('job'));
    const s = source('demo', small);
    const p = s.labelValues('job', 'up');
    await s.labelNames(null);
    source('other', small);
    d.resolve(V('secret'));
    expect(d.signal()?.aborted).toBe(true);
    expect(await p).toEqual([]);
  });

  it('S14: lookup windows are whole minutes, series windows whole seconds', async () => {
    labelValues.mockResolvedValue(V('a'));
    labels.mockResolvedValue(V('job'));
    series.mockResolvedValue({ series: [], completeness: C0 });
    W = { fromMs: 3_601_500, toMs: 7_198_500 };
    const s = source();
    await s.metricNames();
    await s.labelNames(null);
    await s.labelValues('job', 'up');
    await s.series('up');
    const minutes = { fromMs: 3_600_000, toMs: 7_200_000 };
    expect(labelValues.mock.calls[0]?.[2]).toEqual({ ...minutes, limit: 10_000 });
    expect(labels.mock.calls[0]?.[1]).toEqual({ ...minutes, limit: 1_000 });
    expect(labelValues.mock.calls[1]?.[2]).toEqual({ ...minutes, match: ['up'], limit: 1_000 });
    expect(series.mock.calls[0]?.[1]).toEqual({
      fromMs: 3_601_000,
      toMs: 7_199_000,
      match: ['up'],
      limit: 1_000,
    });
    W = { fromMs: 9_000_000, toMs: 9_000_000 };
    await s.labelNames('x');
    expect(labels.mock.calls[1]?.[1]).toEqual({
      fromMs: 9_000_000,
      toMs: 9_060_000,
      match: ['x'],
      limit: 1_000,
    });
  });
});
