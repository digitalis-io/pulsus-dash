import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyHash } from '../dev/keyHash';
import { synthLineValue } from '../dev/synth';
import { seedWith } from '../test/seeds';
import { coverageText } from '../vis/reduce';
import { NOW_MS, S } from '../widgets/boardList/fixtures';
import { boardSnapshot } from '../widgets/boardList/rows';
import { listSetSize } from '../widgets/lists/snapshot';
import {
  STUB_BOARDS_KEY,
  STUB_FAIL_QUERY_KEY,
  STUB_QUERY_DELAY_KEY,
  StubApi,
  type StubBoard,
} from './StubApi';
import { ApiError, BoardConflictError, type BoardSpec, type LogsRequest } from './types';

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
    expect(r.stepMs).toBe(15000);
    expect(r.startMs).toBe(0);
    expect(r.endMs).toBe(3600000);
    expect(r.series).toHaveLength(3);
    r.series.forEach((s, j) => {
      const labels = { __name__: 'stub_metric', series: String(j) };
      expect(s.labels).toEqual(labels);
      expect(s.key).toBe(keyHash(labels));
      expect(s.timestamps).toHaveLength(241);
      s.timestamps.forEach((t, i) => {
        expect(t).toBe(i * 15000);
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

describe('StubApi log completion', () => {
  it('serves the log label names and values (plan #66 Part A §3.2)', async () => {
    const api = new StubApi();
    const r = { fromMs: 0, toMs: 1 };
    expect((await api.logLabels('demo', r)).values).toEqual(['level', 'pod', 'service_name']);
    expect((await api.logLabelValues('demo', 'level', r)).values).toEqual([
      'error',
      'info',
      'warn',
    ]);
    expect((await api.logLabelValues('demo', 'pod', r)).values).toEqual([
      'stub-0',
      'stub-1',
      'stub-2',
    ]);
    expect((await api.logLabelValues('demo', 'x', r)).values).toEqual([]);
    expect((await api.logLabels('demo', r)).completeness.truncated).toBe(false);
    expect(await kindOf(api.logLabels('nope', r))).toBe('notFound');
    expect(await kindOf(api.logLabelValues('nope', 'level', r))).toBe('notFound');
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
});

describe('stub boards from storage (plan #198 Part 3b)', () => {
  afterEach(() => {
    localStorage.removeItem(STUB_BOARDS_KEY);
  });
  const board = (uid: string, title: string): StubBoard => ({
    uid,
    title,
    updatedAt: '2026-11-19T12:00:00.000Z',
    spec: { title, panels: [], sections: [] },
  });

  it('adds the valid boards of pulsus-dash.stub.boards to the seed', async () => {
    localStorage.setItem(
      STUB_BOARDS_KEY,
      JSON.stringify([
        board('b-bench', 'Bench'),
        board('b-1', 'Taken uid'),
        board('b-bad', ''),
        { uid: 'b-shape' },
        board('b-bench', 'Second of a uid'),
      ]),
    );
    const api = new StubApi();
    const uids = (await api.listBoards('demo')).items.map((b) => b.uid).sort();
    expect(uids).toEqual(['b-1', 'b-2', 'b-3', 'b-bench']);
    expect((await api.getBoard('demo', 'b-bench')).title).toBe('Bench');
    expect((await api.getBoard('demo', 'b-1')).title).not.toBe('Taken uid');
  });

  it('HTTP builds never read the key', async () => {
    localStorage.setItem(STUB_BOARDS_KEY, JSON.stringify([board('b-bench', 'Bench')]));
    const get = vi.spyOn(Storage.prototype, 'getItem');
    vi.stubEnv('VITE_API_MODE', 'http');
    try {
      const api = new StubApi();
      expect(get.mock.calls.map(([k]) => k)).not.toContain(STUB_BOARDS_KEY);
      expect((await api.listBoards('demo')).items.map((b) => b.uid)).not.toContain('b-bench');
    } finally {
      vi.unstubAllEnvs();
      get.mockRestore();
    }
  });

  it('adds none for anything but an array', async () => {
    localStorage.setItem(STUB_BOARDS_KEY, '{"uid":"b-x"}');
    expect((await new StubApi().listBoards('demo')).items).toHaveLength(3);
    localStorage.setItem(STUB_BOARDS_KEY, 'not json');
    expect((await new StubApi().listBoards('demo')).items).toHaveLength(3);
  });
});

const EDGE = 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy';

describe('stub starred and recent', () => {
  it('stub starred and recent', async () => {
    const api = new StubApi();
    const b1 = { uid: 'b-1', title: 'Service overview' };
    const page = (items: unknown[]) => ({ items, truncated: false, applied: {} });
    expect(await api.listStarred('demo')).toEqual(page([b1]));
    expect(await api.listStarred('sandbox')).toEqual(page([b1]));
    await api.setStarred('demo', 'b-3', true);
    await api.setStarred('demo', 'b-3', true);
    expect(await api.listStarred('demo')).toEqual(page([{ uid: 'b-3', title: EDGE }, b1]));
    expect(localStorage.getItem('pulsus-dash.stub.starred')).toBe('["b-1","b-3"]');
    expect(await kindOf(api.setStarred('demo', 'zzz', true))).toBe('notFound');
    expect(await kindOf(api.setStarred('demo', 'zzz', false))).toBe('resolved');

    await api.recordView('demo', 'b-1', 1);
    await api.recordView('demo', 'b-2', 2);
    await api.recordView('demo', 'b-3', 3);
    await api.recordView('demo', 'b-1', 4);
    const recentUids = async () => (await api.listRecent('demo')).items.map((r) => r.uid);
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
    expect(await api.listStarred('demo')).toEqual(page([b1]));
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
    expect((await api.listRecent('demo')).items.map((r) => r.uid)).toEqual([
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
    expect((await api.listStarred('demo')).items.map((r) => r.uid)).toEqual(['b-1']);
    await api.setStarred('demo', 'b-2', true);
    expect((await api.listStarred('demo')).items.map((r) => r.uid)).toEqual(['b-2', 'b-1']);
  });

  it('ignores invalid and old stored values', async () => {
    const api = new StubApi();
    localStorage.setItem('pulsus-dash.stub.recent', 'not json');
    expect((await api.listRecent('demo')).items).toEqual([]);
    localStorage.setItem('pulsus-dash.stub.recent', '["b-1"]');
    expect((await api.listRecent('demo')).items).toEqual([]);
    localStorage.setItem('pulsus-dash.stub.starred.demo', '[]');
    expect((await api.listStarred('demo')).items).toEqual([
      { uid: 'b-1', title: 'Service overview' },
    ]);
  });
});

/** Boards of the stub: the six named boards of fixture S, with their tags in the spec. */
function namedBoards(): StubBoard[] {
  return S.slice(0, 6).map((b) => ({
    uid: b.uid,
    title: b.title,
    updatedAt: b.updatedAt,
    spec: {
      title: b.title,
      panels: [],
      sections: [],
      ...(b.tags !== null && b.tags.length > 0 ? { tags: [...b.tags] } : {}),
    },
  }));
}

describe('unit:board-list-source (stub)', () => {
  it('filters as the BFF: q in a title or equal to a tag, tag equal to a tag', async () => {
    const api = new StubApi(seedWith({ boards: namedBoards() }));
    const q = await api.listBoards('demo', undefined, { q: 'CHECKOUT' });
    expect(q.items.map((b) => b.title)).toEqual(['Checkout overview', 'CHECKOUT latency']);
    expect(q.items.map((b) => b.tags)).toEqual([['team:payments'], []]);
    expect(q.applied).toEqual({ q: 'CHECKOUT' });
    expect(q.tagsStale).toBe(0);
    expect(q.truncated).toBe(false);
    const tag = await api.listBoards('demo', undefined, { tag: 'team:payments' });
    expect(tag.items.map((b) => b.uid)).toEqual(['s-1', 's-6']);
    expect(tag.applied).toEqual({ tag: 'team:payments' });
    const both = await api.listBoards('demo', undefined, { q: 'ledger', tag: 'payments' });
    expect(both.items).toEqual([]);
    const byTag = await api.listBoards('demo', undefined, { q: 'FINANCE' });
    expect(byTag.items.map((b) => b.uid)).toEqual(['s-6']);
    const all = await api.listBoards('demo');
    expect(all.items).toHaveLength(6);
    expect(all.applied).toEqual({});
  });

  it('recent: truncated when more views than the limit', async () => {
    const boards: StubBoard[] = Array.from({ length: 60 }, (_, i) => ({
      uid: `b-${String(i + 1)}`,
      title: `Board ${String(i + 1)}`,
      updatedAt: '2026-11-19T12:00:00.000Z',
      spec: { title: `Board ${String(i + 1)}`, panels: [], sections: [] },
    }));
    const api = new StubApi(seedWith({ boards }));
    for (const [i, b] of boards.entries()) await api.recordView('demo', b.uid, i + 1);
    const fifty = await api.listRecent('demo', undefined, 50);
    expect(fifty.items).toHaveLength(50);
    expect(fifty.truncated).toBe(true);
    expect(fifty.applied).toEqual({});
    const sixty = await api.listRecent('demo', undefined, 60);
    expect(sixty.items).toHaveLength(60);
    expect(sixty.truncated).toBe(false);
    expect((await api.listRecent('demo')).truncated).toBe(true);
    const s = boardSnapshot(['recent', 'demo', 50], fifty, {
      mode: 'recent',
      q: '',
      tag: null,
      currentUid: null,
      shown: 10,
      nowMs: NOW_MS,
    }).snapshot;
    expect(coverageText(s.coverage, 'UTC')).toBe('truncated · showing 10 of 50');
    expect(listSetSize(s)).toBe(-1);
  });
});

describe('stub log queries (plan #65 Part B §4.4)', () => {
  const F = 1767225600000;
  const f = BigInt(F) * 1000000n;
  const s = 1000000000n;
  const req = (toMs: number, extra: Partial<LogsRequest> = {}): LogsRequest => ({
    query: '{app="x"}',
    fromMs: F,
    toMs,
    widthPx: 1200,
    ...extra,
  });
  async function streams(r: LogsRequest) {
    const out = await new StubApi().queryLogs('demo', r);
    expect(out.kind).toBe('streams');
    if (out.kind !== 'streams') throw new Error('not a streams result');
    const toNs = BigInt(r.toMs) * 1000000n;
    for (const t of out.frame.tsNs) {
      expect(t > BigInt(r.fromMs) * 1000000n && t <= toNs, `${String(t)} in the window`).toBe(true);
    }
    return out;
  }

  it('serves a synthetic page within the window', async () => {
    const r = await streams(req(F + 3600000));
    expect(r.frame.tsNs).toHaveLength(30);
    expect(r.frame.direction).toBe('backward');
    expect(r.frame.streams.map((x) => x.labels['pod'])).toEqual(['stub-0', 'stub-1', 'stub-2']);
    expect(r.frame.streams.map((x) => x.key)).toEqual(
      [0, 1, 2].map((j) =>
        keyHash({
          service_name: 'stub',
          pod: `stub-${String(j)}`,
          level: ['info', 'warn', 'error'][j] ?? '',
        }),
      ),
    );
    expect(Array.from(r.frame.levels.slice(0, 3))).toEqual([3, 4, 5]);
    expect(r.frame.tsNs[0]).toBe(BigInt(F + 3600000) * 1000000n);
    expect(r.frame.lines[0]).toBe('stub line 0');
    expect(r.cursor).toBeNull();
    expect(r.fromMs).toBe(F);
    expect(r.toMs).toBe(F + 3600000);
    expect(r.stepMs).toBe(5000);

    expect((await streams(req(F + 3600000, { limit: 5 }))).frame.tsNs).toHaveLength(5);
    const fw = await streams(req(F + 3600000, { direction: 'forward' }));
    expect(fw.frame.tsNs[0]).toBe(f + s);
    const ts = Array.from(fw.frame.tsNs);
    expect(ts).toEqual([...ts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('keeps short windows to (from, to]', async () => {
    const ts = async (toMs: number, direction: 'backward' | 'forward') =>
      Array.from((await streams(req(toMs, { direction }))).frame.tsNs);
    expect(await ts(F + 2000, 'backward')).toEqual([f + 2n * s, f + s]);
    expect(await ts(F + 2000, 'forward')).toEqual([f + s, f + 2n * s]);
    expect(await ts(F + 2500, 'backward')).toEqual([
      f + 2500000000n,
      f + 1500000000n,
      f + 500000000n,
    ]);
    expect(await ts(F + 2500, 'forward')).toEqual([f + s, f + 2n * s]);
    const one = await streams(req(F + 1, { direction: 'backward' }));
    expect(Array.from(one.frame.tsNs)).toEqual([f + 1000000n]);
    expect(one.frame.streams.map((x) => x.labels['pod'])).toEqual(['stub-0']);
    const none = await streams(req(F + 1, { direction: 'forward' }));
    expect(none.frame.tsNs).toHaveLength(0);
    expect(none.frame.streams).toEqual([]);
    expect(await ts(F + 999, 'forward')).toEqual([]);
    expect(await ts(F, 'backward')).toEqual([]);
    expect(await ts(F, 'forward')).toEqual([]);
  });

  it('rejects unknown tenants, aborts and a range too long, and serves the volume', async () => {
    const api = new StubApi();
    expect(await kindOf(api.queryLogs('nope', req(F + 1000)))).toBe('notFound');
    const c = new AbortController();
    c.abort();
    expect(await kindOf(api.queryLogs('demo', req(F + 1000), c.signal))).toBe('AbortError');
    expect(await kindOf(api.queryVolume('demo', req(F + 1000), c.signal))).toBe('AbortError');
    expect(
      await kindOf(api.queryLogs('demo', { ...req(1262304000000), fromMs: 0, widthPx: 1 })),
    ).toBe('queryInvalid');
    const v = await api.queryVolume('demo', req(F + 3600000));
    expect(v.series.map((x) => x.labels)).toEqual([
      { level: 'error' },
      { level: 'warn' },
      { level: 'info' },
    ]);
    expect(v.stepMs).toBe(5000);
    expect(v.series[0]?.timestamps).toHaveLength(721);
    expect(v.series[0]?.key).toBe(keyHash({ level: 'error' }));
    const t1 = v.series[1]?.timestamps[1] ?? 0;
    expect(v.series[1]?.values[1]).toBe(Math.round(Math.abs(synthLineValue(65, 1, t1, 20, 10))));
  });
});

describe('StubApi LogQL planning (plan #116 §3.9, A.3)', () => {
  const L: LogsRequest = {
    query: '{app="x"}',
    fromMs: 1767225600000,
    toMs: 1767229200000,
    widthPx: 1200,
  };
  async function errorOf(p: Promise<unknown>): Promise<ApiError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof ApiError) return e;
      throw e;
    }
    throw new Error('the promise resolved');
  }

  it('S1: a page carries the plan of its substituted text', async () => {
    const r = await new StubApi().queryLogs('demo', {
      ...L,
      query: '{app="$a"}',
      vars: { a: 'x' },
    });
    expect(r.planned).toEqual({
      query: '{app="x"}',
      expanded: '{app="x"}',
      bytes: 9,
      stepMs: 5000,
    });
    expect(r.kind === 'streams' && r.frame.tsNs.length).toBe(30);
  });

  it('S2: the volume carries the template', async () => {
    const v = await new StubApi().queryVolume('demo', L);
    expect(v.planned.query).toBe(
      'sum by (level, detected_level) (count_over_time({app="x"}\n| drop __error__ [5s]))',
    );
    expect(v.planned.bytes).toBe(81);
    expect(v.series).toHaveLength(3);
  });

  it('S3, S4: a reserved selector is refused by Classify, then by the byte guard', async () => {
    for (const query of ['{source="pulsus-dash"}', '{app="x"} | source="pulsus-dash"']) {
      const e = await errorOf(new StubApi().queryLogs('demo', { ...L, query }));
      expect(e.kind, query).toBe('queryInvalid');
      expect(e.detail.hint?.['reserved']).toBe('source="pulsus-dash"');
      expect(e.detail.planned).toBeUndefined();
    }
  });

  it('S5: a missing variable', async () => {
    const e = await errorOf(new StubApi().queryLogs('demo', { ...L, query: '{app="$b"}' }));
    expect(e.kind).toBe('invalid');
    expect(e.fields).toEqual([{ pointer: '/vars/b', messageKey: 'variable.missing' }]);
  });

  it('S6: the volume template counts toward the 64 KiB limit', async () => {
    const query = '{app="x"} |= "' + 'a'.repeat(65_485) + '"';
    const e = await errorOf(new StubApi().queryVolume('demo', { ...L, query }));
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.planned?.bytes).toBe(65_572);
    expect((await new StubApi().queryLogs('demo', { ...L, query })).planned.bytes).toBe(65_500);
  });

  it('S7: the processing cap carries no plan', async () => {
    const e = await errorOf(
      new StubApi().queryLogs('demo', {
        ...L,
        query: '$r'.repeat(600),
        vars: { r: 'a'.repeat(4096) },
      }),
    );
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.hint?.['reason']).toBe('processing_cap');
    expect(e.detail.planned).toBeUndefined();
  });

  it('S8: values are written in UTF-8 bytes, not UTF-16 units', async () => {
    for (const [value, query, bytes] of [
      ['x\ny', '{app="x\\ny"}', 12],
      ['x\u0001y', '{app="x\\x01y"}', 14],
      ['ü€😀', '{app="ü€😀"}', 17],
    ] as const) {
      const r = await new StubApi().queryLogs('demo', {
        ...L,
        query: '{app="$a"}',
        vars: { a: value },
      });
      expect(r.planned.query).toBe(query);
      expect(r.planned.bytes).toBe(bytes);
    }
  });

  it('S9: a value that cannot be written where it is referenced', async () => {
    for (const [query, value] of [['{app=`$a`}', 'x`y']] as const) {
      const e = await errorOf(new StubApi().queryLogs('demo', { ...L, query, vars: { a: value } }));
      expect(e.kind, query).toBe('invalid');
      expect(e.fields).toEqual([{ pointer: '/vars/a', messageKey: 'variable.unrepresentable' }]);
    }
  });

  it('S10: a hash is refused with its position (plan #121)', async () => {
    for (const [query, vars, position] of [
      ['# x\r{source = "pulsus-dash"}', {}, 0],
      ['$q', { q: '{app="x"} # c\r{ source = "pulsus-dash" }' }, 0],
      ['{app="x"} # $a', { a: 'z\n{source="pulsus-dash"}' }, 10],
    ] as const) {
      for (const run of [
        (api: StubApi) => api.queryLogs('demo', { ...L, query, vars }),
        (api: StubApi) => api.queryVolume('demo', { ...L, query, vars }),
      ]) {
        const e = await errorOf(run(new StubApi()));
        expect(e.kind, query).toBe('queryInvalid');
        expect(e.message, query).toBe(
          `unexpected '#' at byte ${String(position)}: LogQL has no comments`,
        );
        expect(e.detail.position, query).toBe(position);
        expect(e.detail.planned, query).toBeUndefined();
      }
    }
  });
});

describe('StubApi planning (plan #112 A.7, A.11)', () => {
  const W = { fromMs: 0, toMs: 3_600_000, widthPx: 1000 };
  /** `prom.WarnTypesUnavailable`, the server's text (only StubApi may import the mirror). */
  const WARN_TYPES_UNAVAILABLE =
    'pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)';

  async function errorOf(p: Promise<unknown>): Promise<ApiError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof ApiError) return e;
      throw e;
    }
    throw new Error('the query resolved');
  }

  it('T1: a bare counter is rated without metadata', async () => {
    const api = new StubApi();
    const meta = vi.spyOn(api, 'promMetadata');
    const r = await api.queryRange('demo', { query: 'http_requests_total', ...W });
    expect(r.planned.query).toBe('rate(http_requests_total[1m])');
    expect(r.planned.rateWindowMs).toBe(60000);
    expect(meta).not.toHaveBeenCalled();
  });

  it('T2: a selector that needs types reads the metadata once', async () => {
    const api = new StubApi();
    const meta = vi.spyOn(api, 'promMetadata');
    const r = await api.queryRange('demo', { query: 'up', ...W });
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta.mock.calls[0]?.[1]).toEqual({ limit: 10000 });
    expect(r.planned.query).toBe('up');
  });

  it('T3: a planned text over 64 KiB is queryTooLong', async () => {
    const n19 = 'x_total{a="' + 'b'.repeat(65_517) + '"}';
    const e = await errorOf(new StubApi().queryRange('demo', { query: n19, ...W }));
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.planned?.bytes).toBe(65540);
  });

  it('T4: variables', async () => {
    const api = new StubApi();
    const e = await errorOf(api.queryRange('demo', { query: 'up{r="$r"}', ...W }));
    expect(e.kind).toBe('invalid');
    expect(e.fields).toEqual([{ pointer: '/vars/r', messageKey: 'variable.missing' }]);
    const r = await api.queryRange('demo', { query: 'up{r="$r"}', vars: { r: 'eu' }, ...W });
    expect(r.planned.query).toBe('up{r="eu"}');
  });

  it('T5: a metadata failure plans without types and warns', async () => {
    const api = new StubApi();
    vi.spyOn(api, 'promMetadata').mockRejectedValue(new ApiError('unavailable', 'down'));
    const r = await api.queryRange('demo', { query: 'up', ...W });
    expect(r.completeness.warnings).toEqual([WARN_TYPES_UNAVAILABLE]);
    const i = await errorOf(
      api.queryInstant('demo', { query: 'rate(x[$__rate_interval])', atMs: 1 }),
    );
    expect(i.kind).toBe('invalid');
    expect(i.fields).toEqual([{ pointer: '/step_ms', messageKey: 'field.required' }]);
    const ok = await api.queryInstant('demo', {
      query: 'rate(x[$__rate_interval])',
      atMs: 1,
      stepMs: 15000,
    });
    expect(ok.planned.query).toBe('rate(x[1m])');
  });

  it('T6: a variable that names a virtual source is refused before metadata', async () => {
    const api = new StubApi();
    const meta = vi.spyOn(api, 'promMetadata');
    const e = await errorOf(
      api.queryRange('demo', { query: '$m', vars: { m: 'pulsus_anomaly_score' }, ...W }),
    );
    expect(e.kind).toBe('queryInvalid');
    expect(e.detail.hint?.['reserved']).toBe('pulsus_anomaly_score');
    expect(meta).not.toHaveBeenCalled();
  });

  it('G1–G3: reserved names are refused before metadata', async () => {
    for (const [query, vars] of [
      ['ALERTS{', {}],
      ['up{note="ALERTS"}', {}],
      ['$m', { m: 'ALERTS' }],
    ] as const) {
      const api = new StubApi();
      const meta = vi.spyOn(api, 'promMetadata');
      const e = await errorOf(api.queryRange('demo', { query, vars, ...W }));
      expect(e.kind, query).toBe('queryInvalid');
      expect(e.detail.hint?.['reserved'], query).toBe('ALERTS');
      expect(meta, query).not.toHaveBeenCalled();
    }
  });

  it('the resolved-step cap comes before the metadata read (review r2)', async () => {
    const api = new StubApi();
    const meta = vi.spyOn(api, 'promMetadata');
    const c = '#' + 'a'.repeat(4095);
    const query = '$c'.repeat(510) + '$__interval'.repeat(3000) + '\nx';
    const e = await errorOf(
      api.queryInstant('demo', { query, vars: { c }, atMs: 1, stepMs: 1500 }),
    );
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.hint?.['reason']).toBe('processing_cap');
    expect(e.detail.planned).toBeUndefined();
    expect(meta).not.toHaveBeenCalled();
  });

  it('T7: values in strings (plan #118 §4.2)', async () => {
    const api = new StubApi();
    for (const [query, a, sent, bytes] of [
      ['sum(x{a="$a"})', 'x\ny', 'sum(x{a="x\\ny"})', 16],
      ['sum(x{a="$a"})', 'ü€😀', 'sum(x{a="ü€😀"})', 21],
      ["sum(x{a='$a'})", '"\'\n', "sum(x{a='\"\\'\\n'})", 17],
      ['sum(x{a="$a"})', 'x\ufffdy', 'sum(x{a="x\\ufffdy"})', 20],
      ['# c\rhttp_requests_total{a="$a"}', 'x"y', 'rate(http_requests_total{a="x\\"y"}[1m])', 39],
    ] as const) {
      const r = await api.queryRange('demo', { query, vars: { a }, ...W });
      expect(r.planned.query, query).toBe(sent);
      expect(r.planned.bytes, query).toBe(bytes);
      if (query.startsWith('#')) expect(r.planned.rateApplied, query).toBe(true);
    }
  });

  it('T8: a value that cannot be written where it is referenced (plan #118 §4.3)', async () => {
    const want = [{ pointer: '/vars/a', messageKey: 'variable.unrepresentable' }];
    for (const [query, a, instant] of [
      ['sum(x{a=`$a`})', 'x`y', false],
      ['sum(x) # $a', 'z\ror vector(1)', false],
      ['x{a=`$a`}', 'x\ry', false],
      ['rate(x{a=`$a`}[$__interval])', 'x`y', true],
    ] as const) {
      const api = new StubApi();
      const meta = vi.spyOn(api, 'promMetadata');
      const e = await errorOf(
        instant
          ? api.queryInstant('demo', { query, vars: { a }, atMs: 1 })
          : api.queryRange('demo', { query, vars: { a }, ...W }),
      );
      expect(e.kind, query).toBe('invalid');
      expect(e.fields, query).toEqual(want);
      expect(meta, query).toHaveBeenCalledTimes(0);
    }
  });

  it('G5: over the processing cap is queryTooLong without a plan', async () => {
    const api = new StubApi();
    const meta = vi.spyOn(api, 'promMetadata');
    const c = '#' + 'a'.repeat(4095);
    const e = await errorOf(
      api.queryRange('demo', { query: '$c'.repeat(600) + '\nx_total', vars: { c }, ...W }),
    );
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.hint?.['reason']).toBe('processing_cap');
    expect(e.detail.planned).toBeUndefined();
    expect(meta).not.toHaveBeenCalled();
  });

  it('G6: repeated quoted references over the cap are refused without encoding each one (review r1)', async () => {
    const api = new StubApi();
    const meta = vi.spyOn(api, 'promMetadata');
    // 1 000 references to a 4 096-byte LF value inside "…": 8 192 000 encoded bytes.
    const a = '\n'.repeat(4096);
    const query = 'x{a="' + '$a'.repeat(1000) + '"}';
    const t0 = performance.now();
    const e = await errorOf(api.queryRange('demo', { query, vars: { a }, ...W }));
    const ms = performance.now() - t0;
    expect(e.kind).toBe('queryTooLong');
    expect(e.detail.hint?.['reason']).toBe('processing_cap');
    expect(e.detail.planned).toBeUndefined();
    expect(meta).not.toHaveBeenCalled();
    // A sanity bound only: plan.test.ts counts the memo's computations (review r2).
    expect(ms).toBeLessThan(5000);
  });
});

describe('stub query hooks and buckets (plan #64 §3.10)', () => {
  const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13), widthPx: 1000 };
  const req = { ...W, query: 'node_memory_free_bytes' };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Whether `promise` has settled after `n` macrotask turns. */
  async function settledAfter(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    promise.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return done;
  }

  it('stub query hooks and buckets: delay', async () => {
    expect(STUB_QUERY_DELAY_KEY).toBe('pulsus-dash.stub.queryDelayMs');
    const api = new StubApi();
    performance.clearMarks('stub:query');
    await api.queryRange('demo', req);
    await api.queryInstant('demo', { query: 'scalar(vector(1))', atMs: W.toMs, stepMs: 5000 });
    const marks = performance.getEntriesByName('stub:query') as PerformanceMark[];
    expect(marks.map((m) => m.detail as unknown)).toEqual([
      { kind: 'range', query: 'node_memory_free_bytes' },
      { kind: 'instant', query: 'scalar(vector(1))' },
    ]);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    localStorage.setItem(STUB_QUERY_DELAY_KEY, '400');
    const delayed = api.queryRange('demo', req);
    await vi.advanceTimersByTimeAsync(399);
    expect(await settledAfter(delayed)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await kindOf(delayed)).toBe('resolved');
    expect(localStorage.getItem(STUB_QUERY_DELAY_KEY)).toBe('400');

    const c = new AbortController();
    const aborted = api.queryRange('demo', req, c.signal);
    await vi.advanceTimersByTimeAsync(10);
    c.abort();
    expect(await kindOf(aborted)).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
    expect(performance.getEntriesByName('stub:query')).toHaveLength(4);
  });

  it('stub query hooks and buckets: fail', async () => {
    expect(STUB_FAIL_QUERY_KEY).toBe('pulsus-dash.stub.failQuery');
    const api = new StubApi();
    localStorage.setItem(STUB_FAIL_QUERY_KEY, '1');
    const first = api.queryRange('demo', req);
    await expect(first).rejects.toThrow('stub: query failed');
    expect(await kindOf(api.queryRange('demo', req))).toBe('resolved');
    expect(localStorage.getItem(STUB_FAIL_QUERY_KEY)).toBe('0');
    localStorage.setItem(STUB_FAIL_QUERY_KEY, '1');
    expect(await kindOf(api.queryInstant('demo', { query: 'up', atMs: W.toMs }))).toBe('network');
  });

  it('stub query hooks and buckets: buckets, scalar and truncation', async () => {
    const api = new StubApi();
    const r = await api.queryRange('demo', {
      ...W,
      query: 'sum by (le) (rate(http_request_duration_seconds_bucket[5m]))',
    });
    const les = [
      '0.005',
      '0.01',
      '0.025',
      '0.05',
      '0.1',
      '0.25',
      '0.5',
      '1',
      '2.5',
      '5',
      '10',
      '+Inf',
    ];
    expect(r.series.map((s) => s.labels)).toEqual(
      les.map((le) => ({ __name__: 'stub_bucket', le })),
    );
    const first = r.series[0];
    if (first === undefined) throw new Error('no series');
    for (let i = 0; i < first.values.length; i += 97) {
      const col = r.series.map((s) => s.values[i] ?? NaN);
      for (let k = 1; k < col.length; k++) expect(col[k]).toBeGreaterThanOrEqual(col[k - 1] ?? 0);
      const t = first.timestamps[i] ?? 0;
      expect(col[11]).toBeCloseTo((12 * synthLineValue(62, 0, t, 100, 40)) / 12);
    }
    const plain = await api.queryRange('demo', req);
    expect(plain.series.map((s) => s.labels['__name__'])).toEqual([
      'stub_metric',
      'stub_metric',
      'stub_metric',
    ]);

    const s = await api.queryInstant('demo', { query: 'scalar(vector(1)) / 0', atMs: W.toMs });
    expect(s.kind).toBe('scalar');
    if (s.kind !== 'scalar') throw new Error('not a scalar');
    expect(s.scalar).toEqual({
      value: synthLineValue(62, 0, W.toMs, 100, 40),
      timestampMs: W.toMs,
    });
    expect((await api.queryInstant('demo', { query: 'up', atMs: W.toMs })).kind).toBe('series');

    const top = await api.queryRange('demo', { ...W, query: 'topk(1000, up)' });
    expect(top.completeness.truncated).toBe(true);
    expect(top.completeness.warnings).toEqual(['results truncated due to limit']);
    expect(plain.completeness.truncated).toBe(false);
  });
});
