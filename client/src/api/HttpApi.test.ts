import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import type { Api } from './Api';
import type { paths } from './gen/schema';
import { HttpApi } from './HttpApi';
import { ApiError, isApiError } from './types';

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
  return new Response(JSON.stringify(body), {
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
