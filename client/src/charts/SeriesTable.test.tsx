import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SeriesRow } from '../explore/seriesRows';
import { TABLE_ROWS } from '../explore/seriesRows';
import { SeriesTable, type SeriesTableProps } from './SeriesTable';

const row = (i: number): SeriesRow => ({
  key: String(i).padStart(16, '0'),
  name: `up{job="${String(i)}"}`,
  colourIndex: i % 8,
  last: i,
  max: i * 10,
  mean: i * 5,
});
const ROWS = [row(0), row(1), row(2)];
const caption = 'Series. Choose a series to show it alone; choose it again to show all.';

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
    caption,
    columns: ['last', 'max'],
    maxRows: TABLE_ROWS,
    ...o,
  };
}

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

  it('SeriesTable columns, maxRows, cellState', () => {
    const rows = [
      { ...row(1), mean: 1, max: 3, last: 1 },
      { ...row(2), mean: 2.5, max: 2.5, last: 2 },
      { ...row(3), mean: 0.5, max: 1, last: 0.5 },
    ];
    render(
      <SeriesTable
        {...props({
          rows,
          total: 3,
          caption: 'Legend',
          columns: ['mean', 'max', 'last'],
          maxRows: 2,
          cellState: (v) => (v !== null && v >= 2.5 ? 'degraded' : null),
        })}
      />,
    );
    const table = screen.getByRole('table', { name: 'Legend' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Series', 'Mean', 'Max', 'Last']);
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(screen.getByText('Showing the first 2 of 3 series')).toBeInTheDocument();
    const hot = table.querySelectorAll('td[data-state="degraded"]');
    // Row 1's max (3) and row 2's mean and max (2.5).
    expect(hot).toHaveLength(3);
    const first = hot[0] as HTMLElement;
    expect(first.textContent).toContain('◉');
    expect(first.querySelector('[aria-hidden="true"]')?.textContent).toBe('◉');
    expect(within(first).getByText('Degraded')).toBeInTheDocument();
    expect(table.querySelectorAll('td[data-state]')).toHaveLength(3);
  });
});
