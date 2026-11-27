/**
 * `unit:board-list-source` (plan #216 Part 2a §3.1, §3.2, §5; T24-021): one react-query key and one
 * route per mode, the trimmed search committed 250 ms after the last key, Cc text committing
 * nothing, and a new `query` option resetting the field.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../../api/Api';
import {
  deferredApi,
  inPanel,
  listPanel,
  renderLists,
  rowNames,
  tick,
} from '../../test/boardListKit';
import { installGridLayout } from '../../test/fakeLayout';
import { B, findS } from './fixtures';
import { boardListOptions } from './options';
import { boardListFetch, boardListKey, RECENT_WIDGET_LIMIT } from './source';

let restore: () => void = () => undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-26T12:30:00Z') });
  restore = installGridLayout();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function spyApi() {
  const calls: unknown[][] = [];
  const api = {
    listStarred: (...a: unknown[]) => {
      calls.push(['listStarred', ...a]);
      return Promise.resolve(B);
    },
    listRecent: (...a: unknown[]) => {
      calls.push(['listRecent', ...a]);
      return Promise.resolve(B);
    },
    listBoards: (...a: unknown[]) => {
      calls.push(['listBoards', ...a]);
      return Promise.resolve(findS({}));
    },
  } as unknown as Api;
  return { api, calls };
}

describe('unit:board-list-source', () => {
  it('one key and one route per mode', async () => {
    const o = (v: Parameters<typeof boardListOptions>[0]) => boardListOptions(v);
    expect(RECENT_WIDGET_LIMIT).toBe(50);
    expect(boardListKey('demo', o({}), '')).toEqual(['starred', 'demo']);
    expect(boardListKey('demo', o({ mode: 'recent' }), '')).toEqual(['recent', 'demo', 50]);
    expect(boardListKey('demo', o({ mode: 'search' }), 'Checkout')).toEqual([
      'boards',
      'demo',
      'find',
      'Checkout',
      null,
    ]);
    expect(boardListKey('demo', o({ mode: 'tag', tag: 'team:payments' }), 'x')).toEqual([
      'boards',
      'demo',
      'find',
      null,
      'team:payments',
    ]);

    const s = new AbortController().signal;
    const { api, calls } = spyApi();
    await boardListFetch(api, 'demo', o({}), '', s);
    await boardListFetch(api, 'demo', o({ mode: 'recent' }), '', s);
    await boardListFetch(api, 'demo', o({ mode: 'search' }), 'Checkout', s);
    await boardListFetch(api, 'demo', o({ mode: 'search' }), '', s);
    await boardListFetch(api, 'demo', o({ mode: 'tag', tag: 'team:payments' }), '', s);
    expect(calls).toEqual([
      ['listStarred', 'demo', s],
      ['listRecent', 'demo', s, 50],
      ['listBoards', 'demo', s, { q: 'Checkout' }],
      ['listBoards', 'demo', s, {}],
      ['listBoards', 'demo', s, { tag: 'team:payments' }],
    ]);
  });

  it('the trimmed field commits 250 ms after the last key; old rows stay until then', async () => {
    const { api, calls } = deferredApi();
    renderLists({ api, panels: [listPanel('p-1', 'Find', { mode: 'search', query: '' })] });
    await tick();
    expect(calls.map((c) => [c.method, c.arg])).toEqual([['listBoards', {}]]);
    calls[0]?.resolve(findS({}));
    await tick();
    expect(rowNames('p-1')).toHaveLength(10);
    const field = inPanel('p-1').getByRole('textbox', { name: 'Search boards' });
    act(() => {
      fireEvent.change(field, { target: { value: '  C' } });
    });
    await tick(100);
    act(() => {
      fireEvent.change(field, { target: { value: '  Che' } });
    });
    await tick(100);
    act(() => {
      fireEvent.change(field, { target: { value: '  Checkout ' } });
    });
    // 200 ms: the last key; the old rows stay until the commit at 450 ms.
    await tick(249);
    expect(calls).toHaveLength(1);
    expect(rowNames('p-1')).toHaveLength(10);
    await tick(1);
    expect(calls.map((c) => [c.method, c.arg])).toEqual([
      ['listBoards', {}],
      ['listBoards', { q: 'Checkout' }],
    ]);
    expect(rowNames('p-1')).toHaveLength(0);
  });

  it('Cc text shows its error and commits nothing', async () => {
    const { api, calls } = deferredApi();
    renderLists({ api, panels: [listPanel('p-1', 'Find', { mode: 'search', query: '' })] });
    await tick();
    const field = inPanel('p-1').getByRole('textbox', { name: 'Search boards' });
    act(() => {
      fireEvent.change(field, { target: { value: 'a\tb' } });
    });
    await tick(1000);
    expect(
      inPanel('p-1').getByText('Search text cannot contain control characters'),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it('a new query option resets the field', async () => {
    const { api, calls } = deferredApi();
    const h = renderLists({
      api,
      panels: [listPanel('p-1', 'Find', { mode: 'search', query: 'pay' })],
    });
    await tick();
    const field = () =>
      inPanel('p-1').getByRole<HTMLInputElement>('textbox', { name: 'Search boards' });
    expect(field().value).toBe('pay');
    act(() => {
      fireEvent.change(field(), { target: { value: 'payx' } });
    });
    h.setPanels([listPanel('p-1', 'Find', { mode: 'search', query: 'ledger' })]);
    await tick(300);
    expect(field().value).toBe('ledger');
    expect(calls.map((c) => c.arg)).toEqual([{ q: 'pay' }, { q: 'ledger' }]);
  });
});
