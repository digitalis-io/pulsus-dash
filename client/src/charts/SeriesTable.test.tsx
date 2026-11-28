import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SeriesRow } from '../explore/seriesRows';
import { InspectorApiContext, SelectionContext, type InspectorHostApi } from '../inspector/host';
import type { Selection } from '../inspector/types';
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
  it('shows the hovered values under a Value at header while hovering', () => {
    const k = (i: number): string => ROWS[i]?.key ?? '';
    const hovered = {
      label: 'Value at 10:40',
      values: new Map([
        [k(0), 7],
        [k(2), 9],
      ]),
    };
    const { rerender } = render(<SeriesTable {...props({ hovered })} />);
    const table = screen.getByRole('table', { name: caption });
    expect(within(table).getByRole('button', { name: 'Value at 10:40' })).toBeInTheDocument();
    const lastCol = (): string[] =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.querySelectorAll('td')[1]?.textContent ?? '');
    expect(lastCol()).toEqual(['7', '—', '9']);
    rerender(<SeriesTable {...props({ hovered: null })} />);
    expect(within(table).getByRole('button', { name: 'Last' })).toBeInTheDocument();
    expect(lastCol()).toEqual(['0', '1', '2']);
    cleanup();
  });

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

describe('unit:series-select', () => {
  function hosted(p: SeriesTableProps, sel: Selection | null, api: Partial<InspectorHostApi>) {
    const host: InspectorHostApi = {
      inspect: vi.fn(),
      select: vi.fn(),
      registerMembers: vi.fn(() => () => undefined),
      resolveMembers: vi.fn(() => null),
      registerEscape: vi.fn(() => () => undefined),
      ...api,
    };
    return (
      <InspectorApiContext.Provider value={host}>
        <SelectionContext.Provider value={sel}>
          <SeriesTable {...p} />
        </SelectionContext.Provider>
      </InspectorApiContext.Provider>
    );
  }

  it('a leading "Select <name>" toggle writes the selection; the name still isolates', () => {
    const select = vi.fn();
    const p = props({ selectPanelId: 'p1' });
    const k1 = ROWS[1]?.key ?? '';
    const view = render(hosted(p, null, { select }));
    const toggle = screen.getByRole('button', { name: 'Select up{job="1"}' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(select).toHaveBeenCalledWith(
      { keys: [k1], fromMs: null, toMs: null },
      { kind: 'tableRow', panelId: 'p1' },
    );
    view.rerender(hosted(p, { keys: [k1], fromMs: null, toMs: null }, { select }));
    const pressed = screen.getByRole('button', { name: 'Select up{job="1"}' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pressed);
    expect(select).toHaveBeenLastCalledWith(null, { kind: 'tableRow', panelId: 'p1' });
    fireEvent.click(screen.getByRole('button', { name: 'up{job="1"}' }));
    expect(p.onIsolate).toHaveBeenCalledWith(k1);
  });

  it('no host, or no selectPanelId: no toggle column', () => {
    render(<SeriesTable {...props({ selectPanelId: 'p1' })} />);
    expect(screen.queryByRole('button', { name: /^Select / })).toBeNull();
    cleanup();
    render(hosted(props(), null, {}));
    expect(screen.queryByRole('button', { name: /^Select / })).toBeNull();
  });
});
