import { describe, expect, it } from 'vitest';
import { keyHash } from '../dev/keyHash';
import { synthLineValue } from '../dev/synth';
import { StubApi } from './StubApi';
import { ApiError } from './types';

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof ApiError ? e.kind : e instanceof DOMException ? e.name : 'other';
  }
}

describe('stub api', () => {
  it('serves the default seed', async () => {
    const api = new StubApi();
    const s = await api.getSession();
    expect(s.user.name).toBe('Ada Admin');
    expect(s.org.name).toBe('Demo Org');
    expect(s.tenants.map((x) => x.slug)).toEqual(['demo', 'sandbox']);
    const boards = await api.listBoards('demo');
    expect(boards.map((b) => b.title)).toEqual([
      'Service overview',
      'Checkout latency',
      'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy',
    ]);
    expect(boards[2]?.uid).toBe('b-3');
  });

  it('rejects unknown tenants and aborted requests', async () => {
    const api = new StubApi();
    expect(await kindOf(api.listBoards('x'))).toBe('notFound');
    const c = new AbortController();
    c.abort();
    expect(await kindOf(api.listBoards('demo', c.signal))).toBe('AbortError');
  });

  it('keeps starred boards per tenant in localStorage', async () => {
    const api = new StubApi();
    expect(await api.listStarred('demo')).toEqual(['b-1']);
    expect(await api.setStarred('demo', 'b-2', true)).toEqual(['b-1', 'b-2']);
    expect(localStorage.getItem('pulsus-dash.stub.starred.demo')).toBe('["b-1","b-2"]');
  });

  it('fails sign-out as many times as the test hook says', async () => {
    const api = new StubApi();
    localStorage.setItem('pulsus-dash.stub.failSignOut', '1');
    expect(await kindOf(api.signOut())).toBe('network');
    expect(localStorage.getItem('pulsus-dash.stub.failSignOut')).toBe('0');
    expect(await kindOf(api.signOut())).toBe('resolved');
  });
});

describe('stub api queries (plan #62 §4.5)', () => {
  it('serves three synthetic series on the BFF grid', async () => {
    const r = await new StubApi().queryRange('demo', {
      query: 'x',
      fromMs: 0,
      toMs: 3600000,
      widthPx: 1200,
    });
    expect(r.stepMs).toBe(5000);
    expect(r.startMs).toBe(0);
    expect(r.endMs).toBe(3600000);
    expect(r.series).toHaveLength(3);
    r.series.forEach((s, j) => {
      const labels = { __name__: 'stub_metric', series: String(j) };
      expect(s.labels).toEqual(labels);
      expect(s.key).toBe(keyHash(labels));
      expect(s.timestamps).toHaveLength(721);
      s.timestamps.forEach((t, i) => {
        expect(t).toBe(i * 5000);
        expect(s.values[i]).toBe(synthLineValue(62, j, t, 100, 40));
      });
    });
    expect(r.completeness).toEqual({
      truncated: false,
      warnings: [],
      infos: [],
      queryId: null,
      dataAgeMs: null,
      readCache: null,
      readCacheThroughMs: null,
    });
  });

  it('refuses a range too long for the width', async () => {
    const e = await new StubApi()
      .queryRange('demo', { query: 'x', fromMs: 0, toMs: 1262304000000, widthPx: 1 })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).kind).toBe('queryInvalid');
  });

  it('serves an instant vector of the same series', async () => {
    const r = await new StubApi().queryInstant('demo', { query: 'x', atMs: 1000 });
    expect(r.kind).toBe('series');
    if (r.kind !== 'series') return;
    expect(r.resultType).toBe('vector');
    expect(r.series).toHaveLength(3);
    for (const s of r.series) expect(Array.from(s.timestamps)).toEqual([1000]);
  });

  it('rejects unknown tenants and aborted requests, and checks the data source', async () => {
    const api = new StubApi();
    const R = { query: 'x', fromMs: 0, toMs: 3600000, widthPx: 1200 };
    expect(await kindOf(api.queryRange('nope', R))).toBe('notFound');
    expect(await kindOf(api.queryInstant('nope', { query: 'x', atMs: 1 }))).toBe('notFound');
    const c = new AbortController();
    c.abort();
    expect(await kindOf(api.queryRange('demo', R, c.signal))).toBe('AbortError');
    expect(await api.checkDataSource('demo')).toEqual({ state: 'ok', checkedAtMs: 0 });
    expect(await kindOf(api.checkDataSource('nope'))).toBe('notFound');
  });
});

describe('StubApi prom', () => {
  it('serves the completion stub data (plan #63 A.3)', async () => {
    const api = new StubApi();
    const r = { fromMs: 0, toMs: 1 };
    expect((await api.promMetadata('demo', {})).metrics).toEqual({
      http_requests_total: [{ type: 'counter', help: 'Total HTTP requests.', unit: '' }],
      http_request_duration_seconds: [
        { type: 'histogram', help: 'HTTP request duration.', unit: 'seconds' },
      ],
      node_memory_free_bytes: [{ type: 'gauge', help: 'Free memory in bytes.', unit: 'bytes' }],
      up: [{ type: 'gauge', help: 'Target up.', unit: '' }],
    });
    expect((await api.promLabelValues('demo', '__name__', r)).values).toEqual([
      'http_request_duration_seconds_bucket',
      'http_requests_total',
      'node_memory_free_bytes',
      'stub_metric',
      'up',
    ]);
    expect((await api.promLabelValues('demo', 'job', r)).values).toEqual(['a', 'b']);
    expect((await api.promLabels('demo', r)).values).toEqual([
      '__name__',
      'instance',
      'job',
      'le',
      'series',
    ]);
    expect((await api.promSeries('demo', { ...r, match: ['up'] })).series).toEqual([]);
    expect(await kindOf(api.promLabels('x', r))).toBe('notFound');
    expect(await kindOf(api.promMetadata('x', {}))).toBe('notFound');
  });
});
