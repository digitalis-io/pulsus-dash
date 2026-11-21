import { describe, expect, it } from 'vitest';
import { StubApi } from './StubApi';
import { ApiError, BoardConflictError, type BoardSpec, type PanelSpec } from './types';

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
    const boards = (await api.listBoards('demo')).items;
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

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('the promise resolved');
}

describe('stub boards', () => {
  it('stub boards', async () => {
    const api = new StubApi();
    const demo = await api.listBoards('demo');
    expect(demo.items).toHaveLength(3);
    expect(await api.listBoards('sandbox')).toEqual(demo);
    expect(await kindOf(api.listBoards('nope'))).toBe('notFound');

    const spec: BoardSpec = { title: 'Latency', panels: [], sections: [] };
    const created = await api.createBoard('demo', spec);
    expect(created.uid).toBe('b-4');
    expect(created.etag).toBe('1');

    const changed: BoardSpec = { ...spec, title: 'Latency 2' };
    const saved = await api.saveBoard('demo', 'b-4', '1', changed);
    expect(saved.changed).toBe(true);
    expect(saved.board.version).toBe(2);
    expect(saved.board.etag).toBe('2');
    const same = await api.saveBoard('demo', 'b-4', '2', changed);
    expect(same.changed).toBe(false);
    expect(same.board.etag).toBe('2');

    const stale = await rejection(api.saveBoard('demo', 'b-4', '1', spec));
    expect(stale).toBeInstanceOf(BoardConflictError);
    expect((stale as BoardConflictError).current.version).toBe(2);

    const invalid = await rejection(api.saveBoard('demo', 'b-4', '2', { ...spec, title: '' }));
    expect((invalid as ApiError).kind).toBe('invalid');
    expect((invalid as ApiError).fields).toEqual([
      { pointer: '/title', messageKey: 'board.title.required' },
    ]);

    await api.deleteBoard('demo', 'b-4', '2');
    expect(await kindOf(api.getBoard('demo', 'b-4'))).toBe('notFound');

    localStorage.setItem('pulsus-dash.stub.failSave', '1');
    expect(await kindOf(api.saveBoard('demo', 'b-1', '1', spec))).toBe('network');
    localStorage.setItem('pulsus-dash.stub.conflictSave', '1');
    const conflict = await rejection(api.saveBoard('demo', 'b-1', '1', spec));
    expect(conflict).toBeInstanceOf(BoardConflictError);
    expect((conflict as BoardConflictError).current.etag).toBe('2');
    expect((await api.saveBoard('demo', 'b-1', '2', spec)).changed).toBe(true);
  });

  it('stub panel data', async () => {
    const api = new StubApi();
    const window = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };
    const p: PanelSpec = {
      id: 'p-1',
      title: 'Request rate',
      grid: { x: 0, y: 0, w: 6, h: 8 },
      query: { lang: 'promql', text: 'sum(rate(http_requests_total[5m]))' },
      vis: { kind: 'line' },
    };
    const a = await api.panelData('demo', p, window);
    const b = await api.panelData('demo', p, window);
    expect(a).toEqual(b);
    expect(a.kind).toBe('frame');
    if (a.kind !== 'frame' || a.data.kind !== 'series') throw new Error('not a series frame');
    expect(a.spec.kind).toBe('line');
    expect(a.data.series).toHaveLength(3);
    expect(a.data.series.map((s) => s.values.length)).toEqual([360, 360, 360]);

    const logs = await api.panelData(
      'demo',
      { ...p, query: { lang: 'logql', text: '{app="api"}' }, vis: { kind: 'auto' } },
      window,
    );
    expect(logs.kind === 'frame' ? logs.spec.kind : logs.kind).toBe('bars');
    expect((await api.panelData('demo', { ...p, vis: { kind: 'logs' } }, window)).kind).toBe(
      'noVis',
    );
  });
});
