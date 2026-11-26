/**
 * The board list calls of HttpApi (plan #216 Part 1 §4.2): `unit:board-list-mixed` (an old server's
 * answer, without `applied`) and `unit:board-list-source` (the request URLs).
 */
import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import { coverageText } from '../vis/reduce';
import { B, findS, NOW_MS, oldServer, S, wireOf } from '../widgets/boardList/fixtures';
import { boardSnapshot } from '../widgets/boardList/rows';
import { listSetSize } from '../widgets/lists/snapshot';
import type { Api } from './Api';
import type { paths } from './gen/schema';
import { HttpApi } from './HttpApi';

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

describe('unit:board-list-mixed (API)', () => {
  const at = (body: unknown) => api(() => Promise.resolve(json(200, body)));
  const snap = (
    page: Parameters<typeof boardSnapshot>[1],
    mode: 'starred' | 'search' | 'tag',
    q = '',
    tag: string | null = null,
  ) => boardSnapshot(['k'], page, { mode, q, tag, currentUid: null, shown: 10, nowMs: NOW_MS });

  it('an old server: applied null, no tagsStale, tags unknown, truncated false', async () => {
    const boards = await at(oldServer(findS({ q: 'check' }))).api.listBoards('demo');
    expect(boards.applied).toBeNull();
    expect(boards.tagsStale).toBe(0);
    expect(boards.items.map((b) => b.tags)).toEqual([null, null]);
    const starred = await at({ items: B.items }).api.listStarred('demo');
    expect(starred).toEqual({ items: B.items, truncated: false, applied: null });
    const recent = await at({ items: B.items, truncated: true }).api.listRecent('demo');
    expect(recent.truncated).toBe(true);
    expect(recent.applied).toBeNull();
  });

  it('a new server: as sent', async () => {
    const page = { ...findS({ q: 'check' }), tagsStale: 2 };
    expect(await at(wireOf(page)).api.listBoards('demo')).toEqual(page);
    expect(await at(wireOf(B)).api.listStarred('demo')).toEqual(B);
    const truncated = { ...B, truncated: true };
    expect(await at(wireOf(truncated)).api.listRecent('demo', undefined, 12)).toEqual(truncated);
  });

  it('old starred, search and tag snapshots', async () => {
    const starred = await at(oldServer(B)).api.listStarred('demo');
    const s = snap(starred, 'starred').snapshot;
    expect(coverageText(s.coverage, 'UTC')).toBe('coverage unknown · showing 10 of 12');
    expect(listSetSize(s)).toBe(-1);

    const all = await at(oldServer(findS({}))).api.listBoards('demo', undefined, {
      q: 'check',
    });
    const check = snap(all, 'search', 'check');
    expect(check.snapshot.rows.map((r) => [r.title, r.tags])).toEqual([
      ['Checkout overview', null],
      ['CHECKOUT latency', null],
    ]);
    expect(coverageText(check.snapshot.coverage, 'UTC')).toBe('coverage unknown');
    expect(snap(all, 'search', 'zzz').snapshot.rows).toEqual([]);
    expect(snap(all, 'search', '').snapshot.rows).toHaveLength(1000);

    const tagged = snap(all, 'tag', '', 'team:payments');
    expect(tagged.snapshot.rows).toEqual([]);
    expect(tagged.notice).toBe('tagNeedsServer');
    expect(coverageText(tagged.snapshot.coverage, 'UTC')).toBe('coverage unknown');
    expect(S.length).toBe(1008);
  });
});

describe('unit:board-list-source (API)', () => {
  const line = (r: Request | undefined) =>
    r === undefined ? '' : `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`;

  it('sends q only when non-empty, tag when given, and the recent limit', async () => {
    const boards = api(() => Promise.resolve(json(200, wireOf(findS({})))));
    await boards.api.listBoards('demo', undefined, { q: 'Checkout' });
    await boards.api.listBoards('demo', undefined, { q: '' });
    await boards.api.listBoards('demo', undefined, { tag: 'a' });
    await boards.api.listBoards('demo', undefined, { q: 'x', tag: 'a' });
    await boards.api.listBoards('demo');
    expect(boards.requests.map(line)).toEqual([
      'GET /api/dash/v1/boards?q=Checkout',
      'GET /api/dash/v1/boards',
      'GET /api/dash/v1/boards?tag=a',
      'GET /api/dash/v1/boards?q=x&tag=a',
      'GET /api/dash/v1/boards',
    ]);
    const recent = api(() => Promise.resolve(json(200, wireOf(B))));
    await recent.api.listRecent('demo', undefined, 50);
    await recent.api.listRecent('demo');
    expect(recent.requests.map(line)).toEqual([
      'GET /api/dash/v1/me/recent-boards?limit=50',
      'GET /api/dash/v1/me/recent-boards?limit=5',
    ]);
  });
});
