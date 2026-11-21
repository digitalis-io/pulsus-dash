import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SeriesRow } from '../../explore/seriesRows';
import { SeriesTable, type SeriesTableProps } from './SeriesTable';

const row = (i: number): SeriesRow => ({
  key: String(i).padStart(16, '0'),
  name: `up{job="${String(i)}"}`,
  colourIndex: i % 8,
  last: i,
  max: i * 10,
});
const ROWS = [row(0), row(1), row(2)];

function props(o: Partial<SeriesTableProps> = {}): SeriesTableProps {
  return {
    rows: ROWS,
    total: ROWS.length,
    sort: null,
    onSort: vi.fn(),
    isolatedKey: null,
    onIsolate: vi.fn(),
    swatches: true,
    unit: { kind: 'none' },
    ...o,
  };
}

const caption = 'Series. Choose a series to show it alone; choose it again to show all.';

describe('SeriesTable', () => {
  it('sorting, isolation and dimming', () => {
    const p = props({
      sort: { column: 'max', direction: 'descending' },
      isolatedKey: ROWS[1]?.key ?? null,
    });
    render(<SeriesTable {...p} />);
    expect(screen.getByRole('region', { name: caption })).toHaveAttribute('tabindex', '0');
    const table = screen.getByRole('table', { name: caption });
    fireEvent.click(within(table).getByRole('button', { name: 'Max' }));
    expect(p.onSort).toHaveBeenCalledWith('max');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.getAttribute('aria-sort'))).toEqual(['none', 'none', 'descending']);
    const b1 = within(table).getByRole('button', { name: 'up{job="1"}' });
    expect(b1).toHaveAttribute('aria-pressed', 'true');
    expect(within(table).getByRole('button', { name: 'up{job="0"}' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(within(table).getByRole('button', { name: 'up{job="2"}' }));
    expect(p.onIsolate).toHaveBeenCalledWith(ROWS[2]?.key);
    const body = within(table).getAllByRole('row').slice(1);
    expect(body.map((r) => r.hasAttribute('data-dimmed'))).toEqual([true, false, true]);
    expect(
      within(body[2] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['up{job="2"}', '2', '20']);
    expect(table.querySelectorAll('[data-swatch]')).toHaveLength(3);
  });

  it('no isolation: plain names, no swatches', () => {
    render(<SeriesTable {...props({ onIsolate: null, swatches: false })} />);
    const table = screen.getByRole('table');
    expect(within(table).queryByRole('button', { name: /^up/ })).toBeNull();
    expect(within(table).getByText('up{job="0"}')).toBeInTheDocument();
    expect(table.querySelectorAll('[data-swatch]')).toHaveLength(0);
  });

  it('600 rows → 500 and the footer', () => {
    const rows = Array.from({ length: 600 }, (_, i) => row(i));
    render(<SeriesTable {...props({ rows, total: 600 })} />);
    expect(screen.getAllByRole('row')).toHaveLength(501);
    expect(screen.getByText('Showing the first 500 of 600 series')).toBeInTheDocument();
  });
});
