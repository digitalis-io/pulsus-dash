/**
 * `unit:board-list-key` (plan #216 Part 2a §4.1, §5; T24-024, T24 §4.5): only the current key's
 * snapshot renders; a key change unsubscribes, and the request is aborted only when no observer
 * is left; a tenant change never shows the previous tenant's rows.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/types';
import {
  deferredApi,
  inPanel,
  LIST_TIME,
  listPanel,
  listRoot,
  liveText,
  meterText,
  renderLists,
  rowNames,
  summaryText,
  tick,
} from '../../test/boardListKit';
import { installGridLayout } from '../../test/fakeLayout';
import { findS } from './fixtures';

let restore: () => void = () => undefined;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-26T12:30:00Z') });
  restore = installGridLayout();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function shiftT(id: string): void {
  const root = listRoot(id);
  if (root === null) throw new Error('no list');
  act(() => {
    fireEvent.keyDown(root, { key: 'T', shiftKey: true });
  });
}

describe('unit:board-list-key', () => {
  it('a key change hides the old rows; the shared request lives while observed', async () => {
    const { api, calls } = deferredApi();
    const search = { mode: 'search', query: 'check' } as const;
    const w1 = listPanel('p-1', 'One', search);
    const w2 = listPanel('p-2', 'Two', search);
    const h = renderLists({ api, tenant: 'acme', panels: [w1, w2] });
    await tick();
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(findS({ q: 'check' }));
    await tick();
    expect(rowNames('p-1')).toHaveLength(2);
    expect(rowNames('p-2')).toHaveLength(2);

    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['boards'] });
    });
    await tick();
    const refetch = calls[1];
    expect(refetch?.arg).toEqual({ q: 'check' });
    shiftT('p-1');
    const field = inPanel('p-1').getByRole('textbox', { name: 'Search boards' });
    act(() => {
      fireEvent.change(field, { target: { value: 'pa' } });
    });
    await tick(100);
    act(() => {
      fireEvent.change(field, { target: { value: 'pay' } });
    });
    await tick(250);
    expect(inPanel('p-1').queryByText('Checkout overview')).toBeNull();
    expect(inPanel('p-1').getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(summaryText('p-1')).toBe('');
    expect(refetch?.signal?.aborted).toBe(false);
    h.setPanels([w1]);
    await tick();
    expect(refetch?.signal?.aborted).toBe(true);
    refetch?.resolve(findS({ q: 'check' }));
    await tick();
    expect(inPanel('p-1').queryByText('Checkout overview')).toBeNull();
    shiftT('p-1');

    const seen: string[] = [];
    const mo = new MutationObserver(() => {
      for (const a of document.querySelectorAll('a[href]')) seen.push(a.getAttribute('href') ?? '');
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    await act(async () => {
      await h.router.navigate(`/t/beta/board/pay?${LIST_TIME}`);
    });
    await tick();
    const beta = calls.at(-1);
    expect(beta?.tenant).toBe('beta');
    expect(beta?.arg).toEqual({ q: 'pay' });
    beta?.reject(new ApiError('unknown', 'x'));
    await tick();
    mo.disconnect();
    expect(seen.filter((s) => s.includes('/t/acme/'))).toEqual([]);
    expect(inPanel('p-1').getByText("Couldn't load boards")).toBeInTheDocument();
    expect(meterText('p-1')).toBe('unavailable');
  });

  it('a tenant change after a typed search announces nothing', async () => {
    const { api, calls } = deferredApi();
    const h = renderLists({
      api,
      tenant: 'acme',
      panels: [listPanel('p-1', 'One', { mode: 'search', query: '' })],
    });
    await tick();
    calls[0]?.resolve(findS({}));
    await tick();
    const field = inPanel('p-1').getByRole('textbox', { name: 'Search boards' });
    act(() => {
      fireEvent.change(field, { target: { value: 'check' } });
    });
    await tick(250);
    calls.at(-1)?.resolve(findS({ q: 'check' }));
    await tick();
    expect(liveText('p-1')).toBe('2 boards');
    await tick(3000);
    await act(async () => {
      await h.router.navigate(`/t/beta/board/pay?${LIST_TIME}`);
    });
    await tick();
    const beta = calls.at(-1);
    expect(beta?.tenant).toBe('beta');
    beta?.resolve(findS({ q: 'ledger' }));
    await tick(3000);
    expect(rowNames('p-1')).toHaveLength(1);
    expect(liveText('p-1')).toBe('2 boards');
  });
});
