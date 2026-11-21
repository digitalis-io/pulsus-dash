import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import counterRaw from '../../../wire/fixtures/json/promql-range-counter.json?raw';
import gaugeRaw from '../../../wire/fixtures/json/promql-instant-gauge.json?raw';
import type { Api } from './Api';
import type { paths } from './gen/schema';
import { HttpApi } from './HttpApi';
import { ApiError, isApiError, type RangeRequest } from './types';

/** The bootstrap body of plan #59 §3.5 for the e2e database (one binding, `demo`). */
const BOOTSTRAP = {
  principal: { id: 'local', name: 'Local user', email: '', role: 'admin' },
  org: { slug: 'default', name: 'Default organisation' },
  tenants: [{ slug: 'demo', name: 'demo', datasource: { state: 'not_checked' } }],
  default_tenant: 'demo',
  server: { version: '0.1.0-dev', commit: 'abc' },
  can_sign_out: false,
};

function json(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An HttpApi whose fetch is `fake`; it records the requests. */
function api(fake: (req: Request) => Promise<Response>): { api: Api; requests: Request[] } {
  const requests: Request[] = [];
  const client = createClient<paths>({
    baseUrl: 'http://localhost',
    fetch: (req: Request) => {
      requests.push(req);
      return fake(req);
    },
  });
  return { api: new HttpApi(client), requests };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('the promise resolved');
}

describe('HttpApi (A1)', () => {
  it('maps the bootstrap body to the session', async () => {
    const { api: a, requests } = api(() => Promise.resolve(json(200, BOOTSTRAP)));
    expect(await a.getSession()).toEqual({
      user: { id: 'local', name: 'Local user', email: '', role: 'admin' },
      org: { name: 'Default organisation' },
      tenants: [{ slug: 'demo', name: 'demo', dataSource: { state: 'notChecked' } }],
      defaultTenant: 'demo',
      server: { version: '0.1.0-dev', commit: 'abc' },
      canSignOut: false,
    });
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/dash/v1/bootstrap',
    ]);
  });

  it('has no boards API until #61', async () => {
    const { api: a, requests } = api(() => Promise.reject(new Error('no request expected')));
    expect(await a.listBoards('demo')).toEqual([]);
    expect(await a.listStarred('demo')).toEqual([]);
    expect(isApiError(await rejection(a.getBoard('demo', 'b-1')), 'notFound')).toBe(true);
    expect(isApiError(await rejection(a.setStarred('demo', 'b-1', true)), 'notImplemented')).toBe(
      true,
    );
    await expect(a.signOut()).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('maps transport and HTTP errors', async () => {
    const net = api(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(isApiError(await rejection(net.api.getSession()), 'network')).toBe(true);

    const internal = api(() =>
      Promise.resolve(json(500, { error: { code: 'internal', message: 'internal error' } })),
    );
    const e = await rejection(internal.api.getSession());
    expect(isApiError(e, 'unknown')).toBe(true);
    expect((e as ApiError).message).toBe('internal error');

    const missing = api(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'not found' } })),
    );
    expect(isApiError(await rejection(missing.api.getSession()), 'notFound')).toBe(true);
  });

  it('re-throws an abort unchanged', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { api: a } = api((req) =>
      req.signal.aborted
        ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
        : Promise.resolve(json(200, BOOTSTRAP)),
    );
    const e = await rejection(a.getSession(ctrl.signal));
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe('AbortError');
  });
});

/** A.10 of plan #62: the query and check methods of HttpApi. */
const R: RangeRequest = { query: 'up', fromMs: 1, toMs: 2, widthPx: 3 };

function envelope(status: number, error: Record<string, unknown>): () => Promise<Response> {
  return () => Promise.resolve(json(status, { error }));
}

describe('HttpApi queries (A.10)', () => {
  it('1-2: sends the range request and decodes the body', async () => {
    const { api: a, requests } = api(() => Promise.resolve(json(200, counterRaw)));
    const r = await a.queryRange('demo', R);
    expect(r.stepMs).toBe(5000);
    expect(r.series).toHaveLength(2);
    const req = requests[0];
    expect(req?.method).toBe('POST');
    expect(req === undefined ? '' : new URL(req.url).pathname + new URL(req.url).search).toBe(
      '/api/dash/v1/query/promql/range?tenant=demo',
    );
    expect(await req?.text()).toBe('{"query":"up","from":1,"to":2,"width_px":3}');

    const t = api(() => Promise.resolve(json(200, counterRaw)));
    await t.api.queryRange('demo', { ...R, timeoutMs: 500 });
    expect(await t.requests[0]?.text()).toBe(
      '{"query":"up","from":1,"to":2,"width_px":3,"timeout_ms":500}',
    );
  });

  const cases: [number, () => Promise<Response>, string, string | null, object][] = [
    [
      3,
      envelope(400, {
        code: 'invalid',
        message: '1:4: parse error: x',
        fields: [{ pointer: '/query', message_key: 'query.invalid' }],
        hint: { position: { offset: 3 } },
        query_id: 'q1',
      }),
      'queryInvalid',
      '1:4: parse error: x',
      { position: 3, queryId: 'q1' },
    ],
    [
      4,
      envelope(400, {
        code: 'invalid',
        message: '1:4: parse error: x',
        fields: [{ pointer: '/query', message_key: 'query.invalid' }],
      }),
      'queryInvalid',
      '1:4: parse error: x',
      {},
    ],
    [
      5,
      envelope(400, {
        code: 'virtual_unsupported',
        message: 'm',
        fields: [{ pointer: '/query', message_key: 'query.reserved' }],
        hint: { reserved: 'ALERTS' },
      }),
      'queryInvalid',
      null,
      { hint: { reserved: 'ALERTS' } },
    ],
    [
      6,
      envelope(400, {
        code: 'invalid',
        message: 'bad',
        fields: [{ pointer: '/to', message_key: 'field.range' }],
      }),
      'unknown',
      'bad',
      {},
    ],
    [
      7,
      envelope(413, { code: 'invalid', message: 'body too large' }),
      'unknown',
      'body too large',
      {},
    ],
    [8, envelope(404, { code: 'not_found', message: 'unknown tenant' }), 'notFound', null, {}],
    [
      9,
      envelope(422, { code: 'too_broad', message: 'm', hint: { action: 'narrow' } }),
      'tooBroad',
      null,
      { hint: { action: 'narrow' } },
    ],
    [10, envelope(429, { code: 'budget_exhausted', message: 'm' }), 'busy', null, {}],
    [
      11,
      envelope(502, {
        code: 'unavailable',
        message: 'm',
        hint: { reason: 'upstream_unreachable' },
      }),
      'unavailable',
      null,
      { hint: { reason: 'upstream_unreachable' } },
    ],
    [12, envelope(503, { code: 'unavailable', message: 'm' }), 'unavailable', null, {}],
    [13, envelope(504, { code: 'unavailable', message: 'm' }), 'timeout', null, {}],
  ];
  for (const [n, response, kind, message, detail] of cases) {
    it(`${String(n)}: maps the envelope to ${kind}`, async () => {
      const { api: a } = api(response);
      const e = await rejection(a.queryRange('demo', R));
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).kind).toBe(kind);
      if (message !== null) expect((e as ApiError).message).toBe(message);
      expect((e as ApiError).detail).toEqual(detail);
    });
  }

  it('14: rejects a body the decoder refuses', async () => {
    const body = JSON.parse(counterRaw) as { frames: { key: string }[] };
    const f = body.frames[0];
    if (f !== undefined) f.key = 'ABC';
    const { api: a } = api(() => Promise.resolve(json(200, body)));
    const e = await rejection(a.queryRange('demo', R));
    expect((e as ApiError).kind).toBe('badResponse');
    expect((e as ApiError).message).toContain('/frames/0/key');
  });

  it('15-16: maps transport failures and re-throws aborts', async () => {
    const net = api(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(((await rejection(net.api.queryRange('demo', R))) as ApiError).kind).toBe('network');
    const ctrl = new AbortController();
    ctrl.abort();
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const ab = api(() => Promise.reject(abort));
    expect(await rejection(ab.api.queryRange('demo', R, ctrl.signal))).toBe(abort);
  });

  it('17: sends the instant request', async () => {
    const { api: a, requests } = api(() => Promise.resolve(json(200, gaugeRaw)));
    const r = await a.queryInstant('demo', { query: 'q', atMs: 5 });
    expect(r.kind).toBe('series');
    expect(r.kind === 'series' ? r.series : []).toHaveLength(2);
    const req = requests[0];
    expect(req === undefined ? '' : new URL(req.url).pathname + new URL(req.url).search).toBe(
      '/api/dash/v1/query/promql/instant?tenant=demo',
    );
    expect(await req?.text()).toBe('{"query":"q","at":5}');
  });

  it('18-19: checks the data source', async () => {
    const { api: a, requests } = api(() =>
      Promise.resolve(json(200, { state: 'unreachable', checked_at: 7 })),
    );
    expect(await a.checkDataSource('demo')).toEqual({ state: 'unreachable', checkedAtMs: 7 });
    const req = requests[0];
    expect(
      req === undefined
        ? ''
        : `${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`,
    ).toBe('GET /api/dash/v1/datasource/check?tenant=demo');
    const nc = api(() => Promise.resolve(json(200, { state: 'not_checked' })));
    expect(await nc.api.checkDataSource('demo')).toEqual({ state: 'notChecked' });
  });
});

describe('HttpApi prom routes', () => {
  const C = { truncated: false, warnings: [], infos: [] };
  const target = (r: Request | undefined) =>
    r === undefined ? '' : `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`;

  it('sends the four GETs with repeated match', async () => {
    const values = { values: ['a'], completeness: C };
    const { api: a, requests } = api((req) => {
      const p = new URL(req.url).pathname;
      if (p.endsWith('/series')) return Promise.resolve(json(200, { series: [], completeness: C }));
      if (p.endsWith('/metadata'))
        return Promise.resolve(json(200, { metrics: {}, completeness: C }));
      return Promise.resolve(json(200, values));
    });
    expect(
      (await a.promLabels('demo', { fromMs: 1, toMs: 2, match: ['a', 'b'], limit: 1000 })).values,
    ).toEqual(['a']);
    expect(
      (await a.promLabelValues('demo', '__name__', { fromMs: 1, toMs: 2, match: [] })).values,
    ).toEqual(['a']);
    expect((await a.promSeries('demo', { fromMs: 1, toMs: 2, match: ['up'] })).series).toEqual([]);
    expect((await a.promMetadata('demo', { limit: 10000 })).metrics).toEqual({});
    expect(requests.map(target)).toEqual([
      'GET /api/dash/v1/prom/labels?tenant=demo&from=1&to=2&match=a&match=b&limit=1000',
      'GET /api/dash/v1/prom/label/__name__/values?tenant=demo&from=1&to=2',
      'GET /api/dash/v1/prom/series?tenant=demo&from=1&to=2&match=up',
      'GET /api/dash/v1/prom/metadata?tenant=demo&limit=10000',
    ]);
  });

  it('maps errors and re-throws aborts', async () => {
    const broad = api(envelope(422, { code: 'too_broad', message: 'm' }));
    await expect(broad.api.promLabels('demo', { fromMs: 1, toMs: 2 })).rejects.toSatisfy(
      (e: unknown) => isApiError(e, 'tooBroad'),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const ab = api(() => Promise.reject(abort));
    await expect(
      ab.api.promLabelValues('demo', 'job', { fromMs: 1, toMs: 2 }, ctrl.signal),
    ).rejects.toBe(abort);
  });
});
