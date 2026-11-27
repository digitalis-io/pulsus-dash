/**
 * `unit:board-list-mixed` (widget legs; plan #216 Part 2a §5; T24-029): the widget over `HttpApi`
 * answering as an old server (no `applied`, no `tagsStale`, no item tags), and a new server's
 * `tagsStale`.
 */
import createClient from 'openapi-fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { paths } from '../../api/gen/schema';
import { HttpApi } from '../../api/HttpApi';
import {
  inPanel,
  listPanel,
  meterText,
  panelEl,
  renderLists,
  rowLinks,
  rowNames,
  tick,
} from '../../test/boardListKit';
import { B, findS, oldServer, wireOf } from './fixtures';

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-26T12:30:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function httpApi(boards: unknown, starred: unknown): HttpApi {
  const client = createClient<paths>({
    baseUrl: 'http://localhost',
    fetch: (req: Request) => {
      const path = new URL(req.url).pathname;
      return Promise.resolve(json(path.endsWith('/starred-boards') ? starred : boards));
    },
  });
  return new HttpApi(client);
}

describe('unit:board-list-mixed', () => {
  it('an old server: unknown coverage, client-side titles, the tag notice', async () => {
    const api = httpApi(oldServer(findS({})), oldServer(B));
    renderLists({
      api,
      panels: [
        listPanel('p-1', 'Starred'),
        listPanel('p-2', 'Check', { mode: 'search', query: 'check' }),
        listPanel('p-3', 'None', { mode: 'search', query: 'zzz' }),
        listPanel('p-4', 'Team', { mode: 'tag', tag: 'team:payments' }),
      ],
    });
    await tick();
    await tick();
    expect(meterText('p-1')).toBe('coverage unknown · showing 10 of 12');
    expect(rowLinks('p-1')[0]?.closest('li')).toHaveAttribute('aria-setsize', '-1');
    expect(rowNames('p-2')).toEqual(['Checkout overview', 'CHECKOUT latency']);
    expect(inPanel('p-2').getAllByText('tags unknown')).toHaveLength(2);
    expect(inPanel('p-3').getByText('No boards match ‘zzz’')).toBeInTheDocument();
    expect(meterText('p-3')).toBe('coverage unknown');
    expect(inPanel('p-4').getByText('Filtering by tag needs a newer server')).toBeInTheDocument();
    expect(rowLinks('p-4')).toHaveLength(0);
    expect(panelEl('p-4').querySelectorAll('[data-board-list-chip]')).toHaveLength(0);
    expect(meterText('p-4')).toBe('coverage unknown');
  });

  it('a new server with stale tags', async () => {
    const api = httpApi(wireOf({ ...findS({ q: 'check' }), tagsStale: 3 }), wireOf(B));
    renderLists({ api, panels: [listPanel('p-1', 'Check', { mode: 'search', query: 'check' })] });
    await tick();
    await tick();
    expect(meterText('p-1')).toBe('tags not yet known for 3 boards');
  });
});
