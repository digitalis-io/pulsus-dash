/**
 * The Explore bar chart's table view (plan #173 Part 3b §4.4; T22-013, VIZ-066): Shift+T opens and
 * closes it with focus following, also from the `tooSmall` notice.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOTTOM } from '../../engine/canvas2d/layout';
import { BARS_Q, BY_VERSION_RANGE } from '../../test/exploreBarsKit';
import { openExplore, ready, spyRange, url } from '../../test/exploreTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeOf } from '../../test/fakeResizeObserver';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  fakeEditorSource.data = F;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        font: '',
        measureText: (s: string) => ({ width: 6 * Array.from(s).length }),
      }) as unknown as CanvasRenderingContext2D,
  );
});

function shiftT(el: Element): void {
  act(() => {
    fireEvent.keyDown(el, { key: 'T', shiftKey: true });
  });
}

async function cell(): Promise<Element> {
  return waitFor(() => {
    const c = document.querySelector('[data-category-cell]');
    expect(c).not.toBeNull();
    return c as Element;
  });
}

describe('Explore table (#173 Part 3b §4.4)', () => {
  it('Shift+T opens and closes the table; at tooSmall from the notice too', async () => {
    const t = openExplore(url(BARS_Q, '&vis=barchart'));
    spyRange(t.api, [BY_VERSION_RANGE]);
    await ready();
    const c = await cell();
    act(() => {
      resizeOf(c, 600, 240);
    });
    const list = await screen.findByRole('listbox');
    shiftT(list);
    const grid = await screen.findByRole('grid', { name: 'Query result' });
    expect(grid.querySelectorAll('[role=rowgroup]:last-child [role=row]')).toHaveLength(5);
    expect(document.activeElement).toBe(grid);
    shiftT(grid);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('listbox'));
    });

    act(() => {
      resizeOf(c, 600, 20 + 8 + BOTTOM);
    });
    const notice = await screen.findByRole('group', {
      name: 'Query result: panel too small — press Shift+T for the table',
    });
    for (let i = 0; i < 40 && document.activeElement !== notice; i++) await t.user.tab();
    expect(document.activeElement).toBe(notice);
    shiftT(notice);
    const all = await screen.findByRole('grid', { name: 'Query result' });
    expect(all).toHaveAttribute('aria-rowcount', '6');
    shiftT(all);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('group', {
          name: 'Query result: panel too small — press Shift+T for the table',
        }),
      );
    });
  });
});
