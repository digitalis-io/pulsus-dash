import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { StubApi } from '../../../api/StubApi';
import { ApiError } from '../../../api/types';
import type { PromValues } from '../../../data/decode';
import { flush } from '../../../test/viewIn';
import { SuggestCache, windowBucket } from '../../suggestCache';
import { createLogSource, LOG_LOOKUP_LIMIT } from './logSource';

// Appendix A.4 (Source) of plan #66 Part A.
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
const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 10, 19, h, m, s, ms);
const W = { fromMs: at(12, 0, 30, 500), toMs: at(13, 0, 10) };
const MINUTES = { fromMs: at(12, 0), toMs: at(13, 1) };

let api: StubApi;
let cache: SuggestCache;
let labels: Mock<StubApi['logLabels']>;
let values: Mock<StubApi['logLabelValues']>;
let unhandled: Mock;

beforeEach(() => {
  api = new StubApi();
  cache = new SuggestCache({ now: () => 0 });
  labels = vi.spyOn(api, 'logLabels');
  values = vi.spyOn(api, 'logLabelValues');
  unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
});
afterEach(async () => {
  await flush();
  process.off('unhandledRejection', unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});

const source = (tenant = 'demo') =>
  createLogSource({ api, queryClient: new QueryClient(), tenant, window: () => W, cache });

/** A call held until the test resolves it; it records its signal and honours it. */
function held<T>() {
  let resolve: (v: T) => void = () => undefined;
  let signal: AbortSignal | undefined;
  const impl = (s?: AbortSignal) => {
    signal = s;
    return new Promise<T>((res, rej) => {
      resolve = res;
      s?.addEventListener('abort', () => {
        rej(new DOMException('Aborted', 'AbortError'));
      });
    });
  };
  return {
    impl,
    resolve: (v: T) => {
      resolve(v);
    },
    signal: () => signal,
  };
}

describe('unit:log-source', () => {
  it('S1: label names over the minute window, limit 1 000, no query', async () => {
    labels.mockResolvedValue(V('app'));
    expect(await source().labelNames(null)).toEqual(['app']);
    expect(LOG_LOOKUP_LIMIT).toBe(1000);
    expect(labels).toHaveBeenCalledTimes(1);
    const [tenant, req] = labels.mock.calls[0] ?? [];
    expect(tenant).toBe('demo');
    expect(req).toStrictEqual({ ...MINUTES, limit: 1000 });
  });

  it('S2: the selector is sent exactly as given', async () => {
    labels.mockResolvedValue(V('app'));
    await source().labelNames('{app="web"}');
    expect(labels.mock.calls[0]?.[1]).toStrictEqual({
      ...MINUTES,
      query: '{app="web"}',
      limit: 1000,
    });
  });

  it('S3: the same call twice is one request', async () => {
    labels.mockResolvedValue(V('app'));
    const s = source();
    await Promise.all([s.labelNames(null), s.labelNames(null)]);
    expect(await s.labelNames(null)).toEqual(['app']);
    expect(labels).toHaveBeenCalledTimes(1);
  });

  it('S4: a failed lookup resolves []', async () => {
    labels.mockRejectedValue(new ApiError('timeout', 't'));
    expect(await source().labelNames(null)).toEqual([]);
  });

  it('S5: another tenant ends the generation: the held call resolves [] and is aborted', async () => {
    const h = held<PromValues>();
    values.mockImplementation((_t, _n, _r, signal) => h.impl(signal));
    const p = source().labelValues('pod', null);
    await flush();
    source('other');
    expect(await p).toEqual([]);
    expect(h.signal()?.aborted).toBe(true);
  });

  it('S6: a LogQL and a PromQL lookup of the same parts do not abort each other', async () => {
    // The PromQL lookup as promSource makes it (lang/logql may not import lang/promql, ADR-0018):
    // the same cache, tenant, kind, label, selector and bucket, with lang 'promql'.
    const prom = held<readonly string[]>();
    const logs = held<PromValues>();
    values.mockImplementation((_t, _n, _r, signal) => logs.impl(signal));
    const s = source();
    const g = cache.retainTenant('demo');
    const parts = { tenant: 'demo', kind: 'values' as const, label: 'pod', selector: null };
    const a = cache.get(g, { ...parts, lang: 'promql', bucket: windowBucket(W.toMs) }, prom.impl);
    const b = s.labelValues('pod', null);
    await flush();
    expect(prom.signal()?.aborted).toBe(false);
    expect(logs.signal()?.aborted).toBe(false);
    expect(values).toHaveBeenCalledTimes(1);
    prom.resolve(['p']);
    logs.resolve(V('l'));
    expect(await a).toEqual(['p']);
    expect(await b).toEqual(['l']);
  });

  it("S7: the caller's signal reaches the request", async () => {
    const h = held<PromValues>();
    labels.mockImplementation((_t, _r, signal) => h.impl(signal));
    const c = new AbortController();
    const p = source().labelNames(null, c.signal);
    await flush();
    expect(h.signal()?.aborted).toBe(false);
    c.abort();
    expect(h.signal()?.aborted).toBe(true);
    expect(await p).toEqual([]);
  });

  it('S8: a refused reserved scope resolves [] and logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    values.mockRejectedValue(new ApiError('queryInvalid', 'reserved'));
    expect(await source().labelValues('app', '{source="pulsus-dash"}')).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});
