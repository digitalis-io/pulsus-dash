/**
 * `unit:list-keyboard` (plan #216 Part 2a §4.4, §5; T24-025, T25-007): the roving tab stop, Show
 * more's focus, focus repair after a refresh (only from inside the list), and the search field's
 * Esc step on the page's ladder.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type RefPage } from '../../api/types';
import {
  answerApi,
  inPanel,
  listPanel,
  liveText,
  renderLists,
  rowLinks,
  tick,
} from '../../test/boardListKit';
import { B, findS } from '../boardList/fixtures';

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-26T12:30:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

const focused = (): string => document.activeElement?.getAttribute('aria-label') ?? '';

function key(k: string): void {
  const el = document.activeElement;
  if (el === null) throw new Error('nothing focused');
  act(() => {
    fireEvent.keyDown(el, { key: k });
  });
}

describe('unit:list-keyboard', () => {
  it('arrows, Home, End, PageDown, Show more and focus repair', async () => {
    let answer: RefPage | Error = B;
    const api = answerApi(() => answer);
    const h = renderLists({ api, host: true, panels: [listPanel('p-1', 'Starred')] });
    await tick();
    const links = rowLinks('p-1');
    expect(links.map((a) => a.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    act(() => {
      links[0]?.focus();
    });
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    expect(focused()).toBe('Gateway');
    expect(rowLinks('p-1').filter((a) => a.tabIndex === 0)).toEqual([document.activeElement]);
    key('End');
    expect(focused()).toBe('Search');
    key('Home');
    expect(focused()).toBe('Checkout · ck-1');
    key('PageDown');
    expect(focused()).toBe('Search');
    key('ArrowDown');
    expect(focused()).toBe('Search');
    act(() => {
      fireEvent.click(inPanel('p-1').getByRole('button', { name: 'Show more' }));
    });
    expect(rowLinks('p-1')).toHaveLength(12);
    expect(focused()).toBe('Shipping');

    // Row 4 (Gateway) focused; the refresh drops it: the row at its index takes focus.
    act(() => {
      rowLinks('p-1')[3]?.focus();
    });
    answer = { ...B, items: B.items.filter((r) => r.uid !== 'gateway') };
    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['starred'] });
    });
    await tick();
    expect(focused()).toBe('Inventory');
    expect(liveText('p-1')).toBe('Gateway is no longer listed');

    // Now empty: the empty text takes focus.
    answer = { ...B, items: [] };
    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['starred'] });
    });
    await tick();
    expect(document.activeElement?.textContent).toBe(
      'No starred boards. Star a board with ☆ in its header',
    );

    // Rows again, one focused; then an error with no rows: Retry takes focus.
    answer = B;
    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['starred'] });
    });
    await tick();
    act(() => {
      rowLinks('p-1')[0]?.focus();
    });
    answer = new ApiError('unknown', 'x');
    await act(async () => {
      await h.queryClient.resetQueries({ queryKey: ['starred'] }).catch(() => undefined);
    });
    await tick();
    expect(document.activeElement).toBe(inPanel('p-1').getByRole('button', { name: 'Retry' }));
  });

  it('focus in the field stays; Esc clears the field, then reaches the ladder', async () => {
    let answer = findS({ q: 'check' });
    const api = answerApi(() => answer);
    const h = renderLists({
      api,
      host: true,
      panels: [listPanel('p-1', 'Find', { mode: 'search', query: 'check' })],
    });
    await tick();
    const field = inPanel('p-1').getByRole<HTMLInputElement>('textbox', { name: 'Search boards' });
    expect(field).toHaveAttribute('data-escape-ladder');
    act(() => {
      field.focus();
    });
    answer = { ...answer, items: answer.items.slice(1) };
    act(() => {
      void h.queryClient.invalidateQueries({ queryKey: ['boards'] });
    });
    await tick();
    expect(rowLinks('p-1')).toHaveLength(1);
    expect(document.activeElement).toBe(field);

    act(() => {
      fireEvent.change(field, { target: { value: 'x' } });
    });
    const esc = (): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        field.dispatchEvent(e);
      });
      return e;
    };
    expect(esc().defaultPrevented).toBe(true);
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
    expect(esc().defaultPrevented).toBe(false);
  });
});
