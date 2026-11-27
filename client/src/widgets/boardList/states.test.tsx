/**
 * The Board list view (plan #216 Part 2a §4, §5): `unit:board-list-states`, `unit:list-table-csv`
 * (view), `unit:board-list-rows` (view), `unit:board-list-switch`, `unit:board-list-limit` and
 * `unit:list-meter-table` (T24-022 to T24-027, T22-013, §4.5).
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type BoardListItem, type BoardPage, type RefPage } from '../../api/types';
import {
  answerApi,
  deferredApi,
  inPanel,
  listPanel,
  listRoot,
  meterText,
  panelEl,
  renderLists,
  rowLinks,
  rowNames,
  summaryText,
  tick,
} from '../../test/boardListKit';
import { installGridLayout } from '../../test/fakeLayout';
import { listCsv } from '../lists/table';
import { B, findS, NOW_MS } from './fixtures';
import { boardListTable, boardSnapshot } from './rows';

const T0 = Date.parse('2026-11-26T12:30:00Z');
let restore: () => void = () => undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  restore = installGridLayout();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const refs = (n: number): RefPage => ({
  items: Array.from({ length: n }, (_, i) => ({
    uid: `r-${String(i)}`,
    title: `Board ${String(i)}`,
  })),
  truncated: false,
  applied: {},
});

/** Shift+T on the list's root. */
function shiftT(id: string): void {
  const root = listRoot(id);
  if (root === null) throw new Error('no list');
  act(() => {
    fireEvent.keyDown(root, { key: 'T', shiftKey: true });
  });
}

/** Presses Export CSV in `id` and returns the file's text. */
async function exportCsv(id: string): Promise<string> {
  const blobs: Blob[] = [];
  Object.assign(URL, {
    createObjectURL: (b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    },
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  act(() => {
    fireEvent.click(inPanel(id).getByRole('button', { name: 'Export CSV' }));
  });
  const b = blobs[0];
  if (b === undefined) throw new Error('no export');
  return b.text();
}

const csvRows = (csv: string): number => csv.split('\r\n').filter((l) => l !== '').length - 1;

describe('unit:board-list-states', () => {
  it('pending, ok, a failed refresh, Retry', async () => {
    const { api, calls } = deferredApi();
    const h = renderLists({ api, panels: [listPanel('p-1', 'Starred boards')] });
    await tick(299);
    expect(inPanel('p-1').queryByText('Loading…')).toBeNull();
    await tick(1);
    expect(inPanel('p-1').getByText('Loading…')).toBeInTheDocument();
    expect(meterText('p-1')).toBe('loading');
    expect(summaryText('p-1')).toBe('');
    calls[0]?.resolve(B);
    await tick();
    expect(rowNames('p-1')).toHaveLength(10);
    expect(summaryText('p-1')).toBe('Starred: 12 boards');
    expect(meterText('p-1')).toBe('showing 10 of 12');

    vi.setSystemTime(Date.parse('2026-11-26T12:31:05Z'));
    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['starred'] });
    });
    await tick();
    calls[1]?.reject(new ApiError('network', 'down'));
    await tick();
    expect(rowNames('p-1')).toHaveLength(10);
    expect(
      inPanel('p-1').getByText("Couldn't refresh: showing boards from 12:30:00"),
    ).toBeInTheDocument();
    expect(meterText('p-1')).toBe('showing 10 of 12 · stale (12:31:05)');
    expect(summaryText('p-1')).toBe('Starred: 12 boards (stale)');
    shiftT('p-1');
    expect(csvRows(await exportCsv('p-1'))).toBe(12);
    shiftT('p-1');

    act(() => {
      fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Retry' }));
    });
    await tick();
    const items = B.items
      .filter((r) => r.uid !== 'orders')
      .map((r) => (r.uid === 'edge' ? { ...r, title: 'Edge v2' } : r));
    calls[2]?.resolve({ ...B, items });
    await tick();
    expect(rowNames('p-1')).toContain('Edge v2');
    expect(rowNames('p-1')).not.toContain('Orders');
    expect(summaryText('p-1')).toBe('Starred: 11 boards');
    expect(inPanel('p-1').queryByText(/Couldn't refresh/)).toBeNull();
  });

  it('errors without rows: the store, any other', async () => {
    const { api, calls } = deferredApi();
    renderLists({
      api,
      panels: [listPanel('p-1', 'Starred'), listPanel('p-2', 'Recent', { mode: 'recent' })],
    });
    await tick();
    calls.find((c) => c.method === 'listStarred')?.reject(new ApiError('unavailable', 'HTTP 503'));
    calls.find((c) => c.method === 'listRecent')?.reject(new ApiError('unknown', 'x'));
    await tick();
    expect(inPanel('p-1').getByText('The configuration store is unavailable')).toBeInTheDocument();
    expect(meterText('p-1')).toBe('unavailable');
    expect(inPanel('p-1').getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(inPanel('p-2').getByText("Couldn't load boards")).toBeInTheDocument();
    expect(meterText('p-2')).toBe('unavailable');
  });

  it('empty texts: recent, tag', async () => {
    const api = answerApi((m) => (m === 'listRecent' ? refs(0) : findS({ tag: 'none' })));
    renderLists({
      api,
      panels: [
        listPanel('p-1', 'Recent', { mode: 'recent' }),
        listPanel('p-2', 'Tagged', { mode: 'tag', tag: 'none' }),
      ],
    });
    await tick();
    expect(inPanel('p-1').getByText('No recently viewed boards')).toBeInTheDocument();
    expect(meterText('p-1')).toBe('100 %');
    expect(summaryText('p-1')).toBe('Recent: 0 boards');
    shiftT('p-1');
    expect(await exportCsv('p-1')).toBe('title,uid,tags,updated_at\r\n');
    expect(inPanel('p-2').getByText('No boards tagged none')).toBeInTheDocument();
  });
});

describe('unit:list-table-csv (view)', () => {
  it('Shift+T shows the table; CSV; Show list; Shift+T in the field types', async () => {
    const api = answerApi(() => findS({ q: 'checkout' }));
    renderLists({ api, panels: [listPanel('p-1', 'Find', { mode: 'search', query: 'checkout' })] });
    await tick();
    expect(rowNames('p-1')).toHaveLength(2);
    shiftT('p-1');
    const grid = inPanel('p-1').getByRole('grid');
    expect(document.activeElement).toBe(grid);
    expect(grid).toHaveAttribute('aria-rowcount', '3');
    expect(inPanel('p-1').getByText('2 boards · 2 shown')).toBeInTheDocument();
    const s = boardSnapshot(['x'], findS({ q: 'checkout' }), {
      mode: 'search',
      q: 'checkout',
      tag: null,
      currentUid: null,
      shown: 10,
      nowMs: NOW_MS,
    }).snapshot;
    expect(await exportCsv('p-1')).toBe(listCsv(boardListTable(s)));
    // The field, the meter and the summary stay.
    expect(inPanel('p-1').getByRole('textbox', { name: 'Search boards' })).toBeInTheDocument();
    expect(meterText('p-1')).toBe('100 %');
    act(() => {
      fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Show list (Shift+T)' }));
    });
    expect(inPanel('p-1').queryByRole('grid')).toBeNull();
    expect(document.activeElement).toBe(rowLinks('p-1')[0]);
    const field = inPanel('p-1').getByRole('textbox', { name: 'Search boards' });
    act(() => {
      field.focus();
    });
    const e = new KeyboardEvent('keydown', {
      key: 'T',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      field.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(inPanel('p-1').queryByRole('grid')).toBeNull();
  });
});

describe('unit:board-list-rows (view)', () => {
  it('names, this board, chips, the time, hrefs and the ranking caption', async () => {
    const many: BoardListItem = {
      uid: 'tags-5',
      title: 'Tagged five',
      version: 1,
      updatedAt: '2026-11-26T12:00:00Z',
      updatedBy: 'Ada',
      tags: ['a', 'b', 'c', 'd', 'e'],
    };
    const five: BoardPage = {
      items: [many],
      truncated: false,
      applied: { q: 'five' },
      tagsStale: 0,
    };
    const api = answerApi((m, arg) => {
      if (m === 'listStarred') return B;
      const q = (arg as { q?: string }).q;
      return q === 'five' ? five : findS({ q: q ?? '' });
    });
    renderLists({
      api,
      uid: 'pay',
      panels: [
        listPanel('p-1', 'Starred', { limit: 12 }),
        listPanel('p-2', 'Ledger', { mode: 'search', query: 'ledger' }),
        listPanel('p-3', 'Five', { mode: 'search', query: 'five' }),
        listPanel('p-4', 'Checkout', { mode: 'search', query: 'checkout' }),
        listPanel('p-5', 'Ranked', { sort: 'incidents', limit: 12 }),
      ],
    });
    await tick();
    expect(rowNames('p-1')[0]).toBe('Checkout · ck-1');
    const pay = rowLinks('p-1').find(
      (a) => a.getAttribute('aria-label') === 'Payments, this board',
    );
    expect(pay).toHaveAttribute('aria-current', 'page');
    expect(rowLinks('p-1').filter((a) => a.hasAttribute('aria-current'))).toHaveLength(1);
    const href = new URL(pay?.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe('/t/demo/board/pay');
    expect(href.searchParams.get('from')).toBe('2026-11-26T11:00:00.000Z');
    expect(href.searchParams.get('to')).toBe('2026-11-26T12:00:00.000Z');
    expect(panelEl('p-2').querySelectorAll('[data-board-list-chip]')).toHaveLength(2);
    const chips = [...panelEl('p-3').querySelectorAll('[data-board-list-chip]')].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(['a', 'b', 'c', '+2']);
    expect(inPanel('p-4').getByText('updated 26 Nov 12:00')).toBeInTheDocument();
    expect(rowNames('p-5')).toEqual(rowNames('p-1'));
    expect(
      inPanel('p-5').getByText(
        'Ranking by use during incidents is available with investigations (M-UI4)',
      ),
    ).toBeInTheDocument();
    expect(inPanel('p-1').queryByText(/Ranking by use/)).toBeNull();
  });
});

describe('unit:board-list-switch', () => {
  it('mode and validity changes swap the body without a hook-order error', async () => {
    const errors = vi.spyOn(console, 'error');
    const api = answerApi((m) => (m === 'listBoards' ? findS({ q: 'x' }) : B));
    const h = renderLists({ api, panels: [listPanel('p-1', 'L')] });
    const field = () =>
      inPanel('p-1').queryByRole<HTMLInputElement>('textbox', { name: 'Search boards' });
    const steps: [Parameters<typeof listPanel>[2], 'search' | 'fixed' | 'invalid', string?][] = [
      [{}, 'fixed'],
      [{ mode: 'search', query: 'x' }, 'search', 'x'],
      [{ mode: 'recent' }, 'fixed'],
      [{ mode: 'tag' }, 'invalid'],
      [{ mode: 'tag', tag: 'a' }, 'fixed'],
      [{ mode: 'search' }, 'search', ''],
    ];
    for (const [options, kind, value] of steps) {
      h.setPanels([listPanel('p-1', 'L', options)]);
      await tick();
      const invalid = panelEl('p-1').querySelector('[data-board-list-invalid]');
      expect(invalid !== null, JSON.stringify(options)).toBe(kind === 'invalid');
      expect(listRoot('p-1') !== null, JSON.stringify(options)).toBe(kind !== 'invalid');
      expect(field()?.value, JSON.stringify(options)).toBe(kind === 'search' ? value : undefined);
    }
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('unit:board-list-limit', () => {
  it('Show more grows the shown rows; a refresh clamps them', async () => {
    let answer = refs(20);
    const api = answerApi(() => answer);
    const h = renderLists({
      api,
      panels: [listPanel('p-1', 'Recent', { mode: 'recent', limit: 5 })],
    });
    await tick();
    expect(rowNames('p-1')).toHaveLength(5);
    for (let i = 0; i < 3; i++) {
      act(() => {
        fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Show more' }));
      });
    }
    expect(rowNames('p-1')).toHaveLength(20);
    expect(inPanel('p-1').queryByRole('button', { name: 'Show more' })).toBeNull();
    const refetch = async (next: RefPage) => {
      answer = next;
      act(() => {
        void h.queryClient.invalidateQueries({ queryKey: ['recent'] });
      });
      await tick();
    };
    await refetch(refs(3));
    expect(rowNames('p-1')).toHaveLength(3);
    expect(inPanel('p-1').queryByRole('button', { name: 'Show more' })).toBeNull();
    await refetch(refs(20));
    expect(rowNames('p-1')).toHaveLength(3);
    act(() => {
      fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Show more' }));
    });
    expect(rowNames('p-1')).toHaveLength(8);
    // An empty answer keeps no shown rows: the next answer starts again at the limit.
    await refetch(refs(0));
    expect(rowNames('p-1')).toHaveLength(0);
    await refetch(refs(20));
    expect(rowNames('p-1')).toHaveLength(5);
    expect(inPanel('p-1').getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });
});

describe('unit:list-meter-table', () => {
  it('the meter, notice and Retry stay with the table open', async () => {
    const { api, calls } = deferredApi();
    const h = renderLists({ api, panels: [listPanel('p-1', 'Starred')] });
    await tick();
    shiftT('p-1');
    expect(panelEl('p-1').querySelector('[data-panel-table]')).not.toBeNull();
    expect(inPanel('p-1').getByText('Loading…')).toBeInTheDocument();
    expect(meterText('p-1')).toBe('loading');
    calls[0]?.reject(new ApiError('unavailable', 'HTTP 503'));
    await tick();
    expect(meterText('p-1')).toBe('unavailable');
    expect(inPanel('p-1').getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    act(() => {
      fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Retry' }));
    });
    await tick();
    calls[1]?.resolve(B);
    await tick();
    expect(meterText('p-1')).toBe('showing 10 of 12');
    vi.setSystemTime(Date.parse('2026-11-26T12:31:05Z'));
    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['starred'] });
    });
    await tick();
    calls[2]?.reject(new ApiError('network', 'x'));
    await tick();
    expect(meterText('p-1')).toBe('showing 10 of 12 · stale (12:31:05)');
    expect(inPanel('p-1').getByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(inPanel('p-1').getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    act(() => {
      fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Retry' }));
    });
    await tick();
    calls[3]?.resolve({ ...B, applied: null });
    await tick();
    expect(meterText('p-1')).toBe('coverage unknown · showing 10 of 12');
    shiftT('p-1');
    expect(inPanel('p-1').queryByRole('grid')).toBeNull();
    expect(meterText('p-1')).toBe('coverage unknown · showing 10 of 12');
  });
});
