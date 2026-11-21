import { describe, expect, it } from 'vitest';
import { keyHash } from '../dev/keyHash';
import { synthLineValue } from '../dev/synth';
import { seedWith } from '../test/seeds';
import { StubApi, type StubBoard } from './StubApi';
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

const EDGE = 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy';

describe('stub starred and recent', () => {
  it('stub starred and recent', async () => {
    const api = new StubApi();
    const b1 = { uid: 'b-1', title: 'Service overview' };
    expect(await api.listStarred('demo')).toEqual([b1]);
    expect(await api.listStarred('sandbox')).toEqual([b1]);
    await api.setStarred('demo', 'b-3', true);
    await api.setStarred('demo', 'b-3', true);
    expect(await api.listStarred('demo')).toEqual([{ uid: 'b-3', title: EDGE }, b1]);
    expect(localStorage.getItem('pulsus-dash.stub.starred')).toBe('["b-1","b-3"]');
    expect(await kindOf(api.setStarred('demo', 'zzz', true))).toBe('notFound');
    expect(await kindOf(api.setStarred('demo', 'zzz', false))).toBe('resolved');

    await api.recordView('demo', 'b-1', 1);
    await api.recordView('demo', 'b-2', 2);
    await api.recordView('demo', 'b-3', 3);
    await api.recordView('demo', 'b-1', 4);
    const recentUids = async () => (await api.listRecent('demo')).map((r) => r.uid);
    expect(await recentUids()).toEqual(['b-1', 'b-3', 'b-2']);
    // A late, older view does not move the board.
    await api.recordView('demo', 'b-3', 2);
    expect(await recentUids()).toEqual(['b-1', 'b-3', 'b-2']);
    expect(await kindOf(api.recordView('demo', 'zzz', 5))).toBe('notFound');
    const c = new AbortController();
    c.abort();
    expect(await kindOf(api.recordView('demo', 'b-2', 9, c.signal))).toBe('AbortError');
    expect(await recentUids()).toEqual(['b-1', 'b-3', 'b-2']);

    await api.deleteBoard('demo', 'b-3', '1');
    expect(await api.listStarred('demo')).toEqual([b1]);
    expect(await recentUids()).toEqual(['b-1', 'b-2']);
  });

  it('keeps five recent boards of many', async () => {
    const boards: StubBoard[] = Array.from({ length: 7 }, (_, i) => ({
      uid: `b-${String(i + 1)}`,
      title: `Board ${String(i + 1)}`,
      updatedAt: '2026-11-19T12:00:00.000Z',
      spec: { title: `Board ${String(i + 1)}`, panels: [], sections: [] },
    }));
    const api = new StubApi(seedWith({ boards }));
    for (const [i, b] of boards.entries()) await api.recordView('demo', b.uid, i + 1);
    expect((await api.listRecent('demo')).map((r) => r.uid)).toEqual([
      'b-7',
      'b-6',
      'b-5',
      'b-4',
      'b-3',
    ]);
  });

  it('fails a star change as many times as the test hook says', async () => {
    const api = new StubApi();
    localStorage.setItem('pulsus-dash.stub.failStar', '1');
    expect(await kindOf(api.setStarred('demo', 'b-2', true))).toBe('network');
    expect((await api.listStarred('demo')).map((r) => r.uid)).toEqual(['b-1']);
    await api.setStarred('demo', 'b-2', true);
    expect((await api.listStarred('demo')).map((r) => r.uid)).toEqual(['b-2', 'b-1']);
  });

  it('ignores invalid and old stored values', async () => {
    const api = new StubApi();
    localStorage.setItem('pulsus-dash.stub.recent', 'not json');
    expect(await api.listRecent('demo')).toEqual([]);
    localStorage.setItem('pulsus-dash.stub.recent', '["b-1"]');
    expect(await api.listRecent('demo')).toEqual([]);
    localStorage.setItem('pulsus-dash.stub.starred.demo', '[]');
    expect(await api.listStarred('demo')).toEqual([{ uid: 'b-1', title: 'Service overview' }]);
  });
});
