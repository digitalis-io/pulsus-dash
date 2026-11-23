import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import counterRaw from '../../../wire/fixtures/json/promql-range-counter.json?raw';
import gaugeRaw from '../../../wire/fixtures/json/promql-instant-gauge.json?raw';
import logStreamsRaw from '../../../wire/fixtures/json/logql-streams-backward-1.json?raw';
import logMetricRaw from '../../../wire/fixtures/json/logql-metric.json?raw';
import logVolumeRaw from '../../../wire/fixtures/json/logql-volume.json?raw';
import type { Api } from './Api';
import type { paths } from './gen/schema';
import { HttpApi } from './HttpApi';
import {
  ApiError,
  BoardConflictError,
  isApiError,
  type LogsRequest,
  type RangeRequest,
} from './types';

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

describe('HttpApi log completion', () => {
  // Plan #66 Part A §3.2.
  const C = { truncated: false, warnings: [], infos: [] };
  const target = (r: Request | undefined) =>
    r === undefined ? '' : `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`;

  it('sends the two GETs; query only when non-empty, limit only when given', async () => {
    const { api: a, requests } = api(() =>
      Promise.resolve(json(200, { values: ['x'], completeness: C })),
    );
    const c = new AbortController();
    const r = await a.logLabels('demo', { fromMs: 1, toMs: 2 }, c.signal);
    expect(r.values).toEqual(['x']);
    expect(r.completeness.truncated).toBe(false);
    await a.logLabels('demo', { fromMs: 1, toMs: 2, query: '{app="a"}', limit: 5 });
    await a.logLabels('demo', { fromMs: 1, toMs: 2, query: '' });
    await a.logLabelValues('demo', 'a b', { fromMs: 1, toMs: 2, query: '{app="a"}' });
    expect(requests.map(target)).toEqual([
      'GET /api/dash/v1/logs/labels?tenant=demo&from=1&to=2',
      'GET /api/dash/v1/logs/labels?tenant=demo&from=1&to=2&query=%7Bapp%3D%22a%22%7D&limit=5',
      'GET /api/dash/v1/logs/labels?tenant=demo&from=1&to=2',
      'GET /api/dash/v1/logs/label/a%20b/values?tenant=demo&from=1&to=2&query=%7Bapp%3D%22a%22%7D',
    ]);
    expect(requests[0]?.signal.aborted).toBe(false);
    c.abort();
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it('maps a refused reserved scope and a bad selector to queryInvalid', async () => {
    const reserved = api(
      envelope(400, {
        code: 'virtual_unsupported',
        message: 'm',
        fields: [{ pointer: '/query', message_key: 'query.reserved' }],
      }),
    );
    expect(
      isApiError(
        await rejection(reserved.api.logLabels('demo', { fromMs: 1, toMs: 2 })),
        'queryInvalid',
      ),
    ).toBe(true);
    const bad = api(
      envelope(400, {
        code: 'invalid',
        message: 'm',
        fields: [{ pointer: '/query', message_key: 'query.invalid' }],
      }),
    );
    expect(
      isApiError(
        await rejection(bad.api.logLabelValues('demo', 'app', { fromMs: 1, toMs: 2 })),
        'queryInvalid',
      ),
    ).toBe(true);
  });
});

const AUTHOR = { kind: 'local', name: 'Local user' };
const SPEC = { title: 'Board', panels: [], sections: [] };

function boardBody(etag: string) {
  return {
    uid: 'k3v9x0q2m7a1zp',
    title: 'Board',
    version: Number(etag),
    updated_at: '2026-11-19T12:00:00Z',
    updated_by: AUTHOR,
    etag,
    schema_version: 1,
    spec: SPEC,
  };
}

describe('http boards', () => {
  it('http boards', async () => {
    const list = api(() =>
      Promise.resolve(
        json(200, {
          items: [
            {
              uid: 'u1',
              title: 'One',
              version: 3,
              updated_at: '2026-11-19T12:00:00Z',
              updated_by: AUTHOR,
            },
          ],
          truncated: true,
        }),
      ),
    );
    expect(await list.api.listBoards('demo')).toEqual({
      items: [
        {
          uid: 'u1',
          title: 'One',
          version: 3,
          updatedAt: '2026-11-19T12:00:00Z',
          updatedBy: 'Local user',
        },
      ],
      truncated: true,
    });
    expect(list.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/dash/v1/boards',
    ]);

    const save = api(() => Promise.resolve(json(200, { board: boardBody('4'), changed: true })));
    const saved = await save.api.saveBoard('demo', 'k3v9x0q2m7a1zp', '3', SPEC);
    expect(saved.changed).toBe(true);
    expect(saved.board.etag).toBe('4');
    const put = save.requests[0];
    expect(put?.method).toBe('PUT');
    expect(put?.headers.get('If-Match')).toBe('"3"');
    expect(await put?.clone().text()).toBe(JSON.stringify({ spec: SPEC }));

    const conflict = api(() =>
      Promise.resolve(
        json(409, {
          error: { code: 'conflict', message: 'board changed since it was read' },
          current: boardBody('4'),
        }),
      ),
    );
    const c = await rejection(conflict.api.saveBoard('demo', 'k3v9x0q2m7a1zp', '3', SPEC));
    expect(c).toBeInstanceOf(BoardConflictError);
    expect((c as BoardConflictError).current.etag).toBe('4');

    const invalid = api(() =>
      Promise.resolve(
        json(400, {
          error: {
            code: 'invalid',
            message: 'invalid board',
            fields: [{ pointer: '/title', message_key: 'board.title.required' }],
          },
        }),
      ),
    );
    const i = await rejection(invalid.api.createBoard('demo', SPEC));
    expect(isApiError(i, 'invalid')).toBe(true);
    expect((i as ApiError).fields[0]?.messageKey).toBe('board.title.required');

    const missing = api(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'board not found' } })),
    );
    expect(isApiError(await rejection(missing.api.getBoard('demo', 'x')), 'notFound')).toBe(true);
    expect(isApiError(await rejection(missing.api.deleteBoard('demo', 'x', '1')), 'notFound')).toBe(
      true,
    );

    const net = api(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(isApiError(await rejection(net.api.listBoards('demo')), 'network')).toBe(true);

    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = api(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    const e = await rejection(aborted.api.getBoard('demo', 'x', ctrl.signal));
    expect((e as DOMException).name).toBe('AbortError');
  });
});

describe('http starred and recent', () => {
  /** An HttpApi whose fetch serves the bootstrap, then `fake` for every other request. */
  async function signedIn(fake: (req: Request) => Promise<Response>) {
    const r = api((req) =>
      new URL(req.url).pathname === '/api/dash/v1/bootstrap'
        ? Promise.resolve(json(200, BOOTSTRAP))
        : fake(req),
    );
    await r.api.getSession();
    r.requests.length = 0;
    return r;
  }
  const line = (r: Request | undefined) =>
    r === undefined ? '' : `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`;
  const noContent = () => Promise.resolve(new Response(null, { status: 204 }));

  it('http starred and recent', async () => {
    const list = await signedIn(() =>
      Promise.resolve(json(200, { items: [{ uid: 'a', title: 'A' }] })),
    );
    expect(await list.api.listStarred('demo')).toEqual([{ uid: 'a', title: 'A' }]);
    expect(line(list.requests[0])).toBe('GET /api/dash/v1/me/starred-boards');
    expect(await list.api.listRecent('demo')).toEqual([{ uid: 'a', title: 'A' }]);
    expect(line(list.requests[1])).toBe('GET /api/dash/v1/me/recent-boards?limit=5');

    const set = await signedIn(noContent);
    await expect(set.api.setStarred('demo', 'a', true)).resolves.toBeUndefined();
    await expect(set.api.setStarred('demo', 'a', false)).resolves.toBeUndefined();
    expect(set.requests.map(line)).toEqual([
      'PUT /api/dash/v1/me/starred-boards/a',
      'DELETE /api/dash/v1/me/starred-boards/a',
    ]);

    const missing = await signedIn(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'board not found' } })),
    );
    expect(isApiError(await rejection(missing.api.setStarred('demo', 'a', true)), 'notFound')).toBe(
      true,
    );

    const view = await signedIn(noContent);
    const ctrl = new AbortController();
    await expect(
      view.api.recordView('demo', 'a', 1700000000000, ctrl.signal),
    ).resolves.toBeUndefined();
    expect(line(view.requests[0])).toBe('PUT /api/dash/v1/me/recent-boards/a?at=1700000000000');

    const aborted = await signedIn((req) =>
      req.signal.aborted
        ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
        : noContent(),
    );
    const gone = new AbortController();
    gone.abort();
    const e = await rejection(aborted.api.recordView('demo', 'a', 1, gone.signal));
    expect((e as DOMException).name).toBe('AbortError');
    expect(aborted.requests).toHaveLength(1);

    const down = await signedIn(() =>
      Promise.resolve(json(503, { error: { code: 'unavailable', message: 'store down' } })),
    );
    expect(isApiError(await rejection(down.api.recordView('demo', 'a', 1)), 'unknown')).toBe(true);
    const net = await signedIn(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(isApiError(await rejection(net.api.listRecent('demo')), 'network')).toBe(true);

    const none = await signedIn(() => Promise.reject(new Error('no request expected')));
    expect(isApiError(await rejection(none.api.listStarred('x')), 'notFound')).toBe(true);
    expect(isApiError(await rejection(none.api.recordView('x', 'a', 1)), 'notFound')).toBe(true);
    await expect(none.api.signOut()).resolves.toBeUndefined();
    expect(none.requests).toEqual([]);
  });
});

/** Plan #65 Part B §4.4: the LogQL query methods. */
const L: LogsRequest = { query: '{app="x"}', fromMs: 1, toMs: 2, widthPx: 3 };

/** H2's planned object (plan #116 A.3): every mocked LogQL body carries one. */
const LOG_PLANNED = { query: '{app="x"}', expanded: '{app="x"}', bytes: 9, step_ms: 5000 };
const LOG_PLANNED_TS = { query: '{app="x"}', expanded: '{app="x"}', bytes: 9, stepMs: 5000 };

const LOG_PAGE = {
  kind: 'streams',
  planned: LOG_PLANNED,
  start: 1,
  end: 2,
  step: 1000,
  direction: 'backward',
  streams: [
    {
      key: '0123456789abcdef',
      labels: { pod: 'a' },
      entries: [{ ts_ns: '1500000', line: 'x', level: 'info' }],
    },
  ],
  cursor: 'c'.repeat(48),
  completeness: { truncated: false, warnings: [], infos: [] },
};

describe('HttpApi log queries (plan #65 Part B)', () => {
  it('sends the range request with only the given options and decodes the page', async () => {
    const { api: a, requests } = api(() => Promise.resolve(json(200, LOG_PAGE)));
    const r = await a.queryLogs('demo', L);
    expect(r.kind).toBe('streams');
    if (r.kind === 'streams') {
      expect(Array.from(r.frame.tsNs)).toEqual([1500000n]);
      expect(r.cursor).toBe('c'.repeat(48));
    }
    const req = requests[0];
    expect(req?.method).toBe('POST');
    expect(req === undefined ? '' : new URL(req.url).pathname + new URL(req.url).search).toBe(
      '/api/dash/v1/query/logql/range?tenant=demo',
    );
    expect(await req?.text()).toBe('{"query":"{app=\\"x\\"}","from":1,"to":2,"width_px":3}');

    const all = api(() => Promise.resolve(json(200, LOG_PAGE)));
    await all.api.queryLogs('demo', {
      ...L,
      limit: 5,
      direction: 'forward',
      cursor: 'k'.repeat(48),
      timeoutMs: 500,
    });
    expect(JSON.parse((await all.requests[0]?.text()) ?? '{}')).toEqual({
      query: '{app="x"}',
      from: 1,
      to: 2,
      width_px: 3,
      limit: 5,
      direction: 'forward',
      cursor: 'k'.repeat(48),
      timeout_ms: 500,
    });
  });

  it('sends the volume request', async () => {
    const empty = {
      planned: LOG_PLANNED,
      start: 0,
      end: 1000,
      step: 1000,
      frames: [],
      completeness: LOG_PAGE.completeness,
    };
    const { api: a, requests } = api(() => Promise.resolve(json(200, empty)));
    const r = await a.queryVolume('demo', { ...L, timeoutMs: 700 });
    expect(r.series).toHaveLength(0);
    const req = requests[0];
    expect(req === undefined ? '' : new URL(req.url).pathname).toBe(
      '/api/dash/v1/query/logql/volume',
    );
    expect(await req?.text()).toBe(
      '{"query":"{app=\\"x\\"}","from":1,"to":2,"width_px":3,"timeout_ms":700}',
    );
  });

  it('passes the signal and re-throws an abort', async () => {
    const seen: (AbortSignal | null)[] = [];
    const ctrl = new AbortController();
    const { api: a } = api((req) => {
      seen.push(req.signal);
      return Promise.resolve(json(200, LOG_PAGE));
    });
    await a.queryLogs('demo', L, ctrl.signal);
    expect(seen[0]?.aborted).toBe(false);
    ctrl.abort();
    expect(seen[0]?.aborted).toBe(true);
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const ab = api(() => Promise.reject(abort));
    expect(await rejection(ab.api.queryLogs('demo', L, ctrl.signal))).toBe(abort);
    expect(await rejection(ab.api.queryVolume('demo', L, ctrl.signal))).toBe(abort);
  });

  const logCases: [string, () => Promise<Response>, string, object][] = [
    [
      'a position',
      envelope(400, {
        code: 'invalid',
        message: "unexpected end of query at byte 8: expected '}'",
        fields: [{ pointer: '/query', message_key: 'query.invalid' }],
        hint: { position: { offset: 8 } },
      }),
      'queryInvalid',
      { position: 8 },
    ],
    [
      'a cursor error',
      envelope(400, {
        code: 'invalid',
        message: 'm',
        fields: [{ pointer: '/cursor', message_key: 'cursor.mismatch' }],
      }),
      'unknown',
      {},
    ],
    ['too broad', envelope(422, { code: 'too_broad', message: 'm' }), 'tooBroad', {}],
    ['a timeout', envelope(504, { code: 'unavailable', message: 'm' }), 'timeout', {}],
  ];
  for (const [what, response, kind, detail] of logCases) {
    it(`maps ${what} to ${kind}`, async () => {
      for (const call of [
        (x: Api) => x.queryLogs('demo', L),
        (x: Api) => x.queryVolume('demo', L),
      ]) {
        const e = await rejection(call(api(response).api));
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).kind).toBe(kind);
        expect((e as ApiError).detail).toEqual(detail);
      }
    });
  }

  it('refuses a 200 body the decoder refuses', async () => {
    const { api: a } = api(() => Promise.resolve(json(200, { ...LOG_PAGE, direction: 'up' })));
    const e = await rejection(a.queryLogs('demo', L));
    expect((e as ApiError).kind).toBe('badResponse');
    expect((e as ApiError).message).toContain('/direction');
    const v = api(() =>
      Promise.resolve(json(200, { planned: LOG_PLANNED, start: 1, end: 2, step: 1, frames: 3 })),
    );
    expect(((await rejection(v.api.queryVolume('demo', L))) as ApiError).kind).toBe('badResponse');
  });
});

describe('HttpApi LogQL planning (plan #116 §3.8, A.3)', () => {
  it('H1: the log bodies carry vars only when given', async () => {
    const calls: [(x: Api, r: LogsRequest) => Promise<unknown>, string][] = [
      [(x, r) => x.queryLogs('demo', r), JSON.stringify(LOG_PAGE)],
      [(x, r) => x.queryVolume('demo', r), logVolumeRaw],
    ];
    for (const [call, body] of calls) {
      const { api: a, requests } = api(() => Promise.resolve(json(200, body)));
      await call(a, L);
      await call(a, { ...L, vars: { a: 'x' } });
      const first = JSON.parse((await requests[0]?.text()) ?? '{}') as Record<string, unknown>;
      const second = JSON.parse((await requests[1]?.text()) ?? '{}') as Record<string, unknown>;
      expect('vars' in first).toBe(false);
      expect(second['vars']).toEqual({ a: 'x' });
    }
  });

  it('H2: a streams golden decodes its planned', async () => {
    const r = await api(() => Promise.resolve(json(200, logStreamsRaw))).api.queryLogs('demo', L);
    expect(r.kind).toBe('streams');
    expect(r.planned).toEqual(LOG_PLANNED_TS);
  });

  it('H3: a metric golden decodes its planned', async () => {
    const r = await api(() => Promise.resolve(json(200, logMetricRaw))).api.queryLogs('demo', L);
    expect(r.kind).toBe('series');
    expect(r.planned.query).toBe('sum by (level) (count_over_time({app="x"}[1m]))');
  });

  it('H4: the volume golden decodes its planned', async () => {
    const r = await api(() => Promise.resolve(json(200, logVolumeRaw))).api.queryVolume('demo', L);
    expect(r.planned.bytes).toBe(81);
    expect(r.planned.expanded).toBe('{app="x"}');
  });

  it('H5: a LogQL error carries the decoded LogqlPlannedQuery', async () => {
    const e = await rejection(
      api(
        envelope(400, {
          code: 'invalid',
          message: 'parse error at byte 3',
          fields: [{ pointer: '/query', message_key: 'query.invalid' }],
          hint: { position: { offset: 3 } },
          planned: LOG_PLANNED,
        }),
      ).api.queryLogs('demo', L),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).kind).toBe('queryInvalid');
    expect((e as ApiError).detail.planned).toEqual(LOG_PLANNED_TS);
  });

  it('H6: a volume 413 is queryTooLong with its plan', async () => {
    const e = await rejection(
      api(
        envelope(413, {
          code: 'invalid',
          message: 'the planned query is over 65536 bytes',
          fields: [{ pointer: '/query', message_key: 'query.sent_too_large' }],
          planned: { query: 'q', expanded: 'q', bytes: 65572, step_ms: 5000 },
        }),
      ).api.queryVolume('demo', L),
    );
    expect((e as ApiError).kind).toBe('queryTooLong');
    expect((e as ApiError).detail.planned?.bytes).toBe(65572);
  });
});

describe('HttpApi planning (plan #112 A.7, A.11)', () => {
  const PLANNED = {
    query: 'rate(x_total{job="a"}[1m])',
    expanded: 'x_total{job="a"}',
    bytes: 26,
    value_type: 'vector',
    rate_candidate: true,
    rate_applied: true,
    histogram: false,
    step_ms: 5000,
    rate_window_ms: 60000,
  };
  const PLANNED_TS = {
    query: 'rate(x_total{job="a"}[1m])',
    expanded: 'x_total{job="a"}',
    bytes: 26,
    valueType: 'vector',
    rateCandidate: true,
    rateApplied: true,
    histogram: false,
    stepMs: 5000,
    rateWindowMs: 60000,
  };

  it('H1: the range body carries vars and rate only when given', async () => {
    const { api: a, requests } = api(() => Promise.resolve(json(200, counterRaw)));
    await a.queryRange('demo', {
      query: 'x_total',
      fromMs: 1,
      toMs: 2,
      widthPx: 1200,
      rate: false,
      vars: { a: '1' },
    });
    expect(await requests[0]?.text()).toBe(
      '{"query":"x_total","from":1,"to":2,"width_px":1200,"vars":{"a":"1"},"rate":false}',
    );
    const b = api(() => Promise.resolve(json(200, counterRaw)));
    await b.api.queryRange('demo', { query: 'x_total', fromMs: 1, toMs: 2, widthPx: 1200 });
    expect(await b.requests[0]?.text()).toBe('{"query":"x_total","from":1,"to":2,"width_px":1200}');
  });

  it('H2: the instant body carries step_ms', async () => {
    const { api: a, requests } = api(() => Promise.resolve(json(200, gaugeRaw)));
    await a.queryInstant('demo', { query: 'q', atMs: 5, stepMs: 15000 });
    expect(await requests[0]?.text()).toBe('{"query":"q","at":5,"step_ms":15000}');
  });

  it('H3: the range golden decodes planned', async () => {
    const { api: a } = api(() => Promise.resolve(json(200, counterRaw)));
    const r = await a.queryRange('demo', R);
    expect(r.planned.query).toBe('sum by (job, instance) (rate(http_requests_total[5m]))');
    expect(r.planned.bytes).toBe(54);
    expect(r.planned.stepMs).toBe(5000);
    expect(r.planned.rateWindowMs).toBeUndefined();
  });

  it('H4: 413 sent_too_large is queryTooLong with the plan', async () => {
    const { api: a } = api(
      envelope(413, {
        code: 'invalid',
        message: 'the planned query is over 65536 bytes',
        fields: [{ pointer: '/query', message_key: 'query.sent_too_large' }],
        planned: { ...PLANNED, bytes: 65540 },
      }),
    );
    const e = (await rejection(a.queryRange('demo', R))) as ApiError;
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.planned?.bytes).toBe(65540);
  });

  it('H5: 400 variable.missing is invalid with the fields', async () => {
    const { api: a } = api(
      envelope(400, {
        code: 'invalid',
        message: 'no value for variable $r',
        fields: [{ pointer: '/vars/r', message_key: 'variable.missing' }],
      }),
    );
    const e = (await rejection(a.queryRange('demo', R))) as ApiError;
    expect(e.kind).toBe('invalid');
    expect(e.fields).toEqual([{ pointer: '/vars/r', messageKey: 'variable.missing' }]);
    expect(e.detail.planned).toBeUndefined();
  });

  it('H6: 502 with planned is unavailable with the plan and the hint', async () => {
    const { api: a } = api(
      envelope(502, {
        code: 'unavailable',
        message: 'm',
        hint: { reason: 'upstream_unreachable' },
        planned: PLANNED,
      }),
    );
    const e = (await rejection(a.queryRange('demo', R))) as ApiError;
    expect(e.kind).toBe('unavailable');
    expect(e.detail).toEqual({ hint: { reason: 'upstream_unreachable' }, planned: PLANNED_TS });
  });

  it('H7: a raw-byte position and the plan; a bad plan is left out', async () => {
    const body = {
      code: 'invalid',
      message: 'bad',
      fields: [{ pointer: '/query', message_key: 'query.invalid' }],
      hint: { position: { offset: 14 } },
      planned: PLANNED,
    };
    const e = (await rejection(api(envelope(400, body)).api.queryRange('demo', R))) as ApiError;
    expect(e.kind).toBe('queryInvalid');
    expect(e.detail.position).toBe(14);
    expect(e.detail.planned).toEqual(PLANNED_TS);
    const bad = { ...body, planned: { ...PLANNED, bytes: 'x' } };
    const e2 = (await rejection(api(envelope(400, bad)).api.queryRange('demo', R))) as ApiError;
    expect(e2.kind).toBe('queryInvalid');
    expect(e2.detail.position).toBe(14);
    expect(e2.detail.planned).toBeUndefined();
  });

  it('H8: 413 processing_cap is queryTooLong without a plan', async () => {
    const { api: a } = api(
      envelope(413, {
        code: 'invalid',
        message: 'm',
        fields: [{ pointer: '/query', message_key: 'query.too_large_to_plan' }],
        hint: { reason: 'processing_cap' },
      }),
    );
    const e = (await rejection(a.queryRange('demo', R))) as ApiError;
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.hint?.['reason']).toBe('processing_cap');
    expect(e.detail.planned).toBeUndefined();
  });
});
