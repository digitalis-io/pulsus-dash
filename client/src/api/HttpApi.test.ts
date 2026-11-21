import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import counterRaw from '../../../wire/fixtures/json/promql-range-counter.json?raw';
import gaugeRaw from '../../../wire/fixtures/json/promql-instant-gauge.json?raw';
import type { Api } from './Api';
import type { paths } from './gen/schema';
import { HttpApi } from './HttpApi';
import {
  ApiError,
  BoardConflictError,
  isApiError,
  type PanelSpec,
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

const PANEL: PanelSpec = {
  id: 'p-1',
  title: 'P',
  grid: { x: 0, y: 0, w: 6, h: 8 },
  query: { lang: 'promql', text: 'up' },
  vis: { kind: 'line' },
};

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

    const none = api(() => Promise.reject(new Error('no request expected')));
    const window = { fromMs: 0, toMs: 1 };
    expect(await none.api.panelData('demo', PANEL, window)).toEqual({
      kind: 'noRoute',
      lang: 'promql',
    });
    expect(
      await none.api.panelData(
        'demo',
        { ...PANEL, query: { lang: 'logql', text: '{a="b"}' }, vis: { kind: 'auto' } },
        window,
      ),
    ).toEqual({ kind: 'noRoute', lang: 'logql' });
    expect(await none.api.panelData('demo', { ...PANEL, vis: { kind: 'logs' } }, window)).toEqual({
      kind: 'noVis',
    });
    expect(none.requests).toEqual([]);
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
