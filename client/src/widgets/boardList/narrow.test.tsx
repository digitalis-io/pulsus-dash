/**
 * `unit:list-coverage` (Narrow; plan #216 Part 2a §4.3, §5; T24-024): a truncated search's meter
 * offers Narrow, which focuses the search field; other modes' meters have no Narrow.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RefPage } from '../../api/types';
import { answerApi, inPanel, listPanel, renderLists } from '../../test/boardListKit';
import { findS } from './fixtures';

const recent51: RefPage = {
  items: Array.from({ length: 50 }, (_, i) => ({
    uid: `v-${String(i)}`,
    title: `View ${String(i)}`,
  })),
  truncated: true,
  applied: {},
};

describe('unit:list-coverage (Narrow)', () => {
  it('search: Narrow focuses the field; recent: no Narrow', async () => {
    const user = userEvent.setup();
    const api = answerApi((m) => (m === 'listBoards' ? findS({ q: 'bulk' }) : recent51));
    renderLists({
      api,
      panels: [
        listPanel('p-1', 'Bulk', { mode: 'search', query: 'bulk' }),
        listPanel('p-2', 'Recent', { mode: 'recent' }),
      ],
    });
    const meter = await waitFor(() =>
      inPanel('p-1').getByRole('button', { name: /^Coverage: truncated/ }),
    );
    await user.click(meter);
    await user.click(await screen.findByRole('button', { name: 'Narrow the time range' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        inPanel('p-1').getByRole('textbox', { name: 'Search boards' }),
      );
    });

    await user.click(inPanel('p-2').getByRole('button', { name: /^Coverage: truncated/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Narrow the time range' })).toBeNull();
  });
});
