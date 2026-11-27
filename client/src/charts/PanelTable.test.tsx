/**
 * `unit:panel-table`, `unit:panel-table-active`, `unit:panel-table-button` (plan #173 Part 3a §3.7;
 * T22-013, VIZ-066): the virtualised read-only grid over `fit.rows`, its keys and its export.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { many } from '../test/categoryFixtures';
import { capMarks, panelCsv, panelRows, type PanelRows } from '../vis/reduce';
import { frameOf } from '../test/geoKit';
import { G, TH } from '../vis/geo/fixtures/series';
import { geoTable } from '../vis/geo/rows';
import { PanelTable } from './PanelTable';

const VIEW_H = 280;
let restoreLayout: () => void = () => undefined;

/** The grid (`[role=grid]`) is 600 × 280 in jsdom; other elements keep 0. */
function installGridLayout(): () => void {
  const names = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const;
  const saved = names.map(
    (n) => [n, Object.getOwnPropertyDescriptor(HTMLElement.prototype, n)] as const,
  );
  for (const n of names) {
    const base = Object.getOwnPropertyDescriptor(HTMLElement.prototype, n);
    Object.defineProperty(HTMLElement.prototype, n, {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.getAttribute('role') === 'grid') return n.endsWith('Width') ? 600 : VIEW_H;
        const v: unknown = base?.get?.call(this);
        return typeof v === 'number' ? v : 0;
      },
    });
  }
  return () => {
    for (const [n, d] of saved) {
      if (d === undefined) Reflect.deleteProperty(HTMLElement.prototype, n);
      else Object.defineProperty(HTMLElement.prototype, n, d);
    }
  };
}

beforeEach(() => {
  installResizeObserver();
  restoreLayout = installGridLayout();
});

afterEach(() => {
  restoreLayout();
  vi.restoreAllMocks();
});

function rows(): PanelRows {
  const all = many();
  return panelRows('barchart', all, capMarks(all, 42).drawn, { kind: 'none' });
}

type OnRow = (key: string, source: 'pointer' | 'keyboard', el: HTMLElement) => void;

function mount(o: { rows?: PanelRows } = {}) {
  const onRow = vi.fn<OnRow>();
  const onClose = vi.fn();
  const r = o.rows ?? rows();
  const view = render(
    <PanelTable
      rows={r}
      title="CPU / host"
      selected={new Set<string>()}
      onRow={onRow}
      onClose={onClose}
    />,
  );
  const grid = screen.getByRole('grid', { name: 'CPU / host' });
  const key = (k: string): void => {
    act(() => {
      fireEvent.keyDown(grid, { key: k });
    });
  };
  const mounted = (): HTMLElement[] =>
    within(grid)
      .getAllByRole('row')
      .filter((e) => e.getAttribute('aria-rowindex') !== '1');
  const active = (): string | null => grid.getAttribute('aria-activedescendant');
  return { view, grid, key, mounted, active, onRow, onClose, rows: r };
}

describe('unit:panel-table', () => {
  it('caption, counts, virtualised rows, End, Enter, a name click and Export', async () => {
    const t = mount();
    expect(screen.getByText('250 rows · 42 drawn')).toBeInTheDocument();
    expect(t.grid).toHaveAttribute('aria-rowcount', '251');
    expect(t.grid).toHaveAttribute('aria-colcount', '6');
    expect(t.grid).toHaveAttribute('tabindex', '0');
    expect(
      within(t.grid)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['name', 'value', 'baseline', 'state', 'drawn', 'shown as']);
    expect(t.mounted().length).toBeGreaterThan(0);
    expect(t.mounted().length).toBeLessThanOrEqual(30);
    t.key('End');
    const last = t.mounted().find((r) => r.getAttribute('aria-rowindex') === '251');
    expect(last).toBeDefined();
    // The cap keeps the minimum (value 1), so the last row is drawn; every mounted row says so.
    expect(last).toHaveAttribute('data-drawn', 'yes');
    for (const r of t.mounted()) {
      const i = Number(r.getAttribute('aria-rowindex')) - 2;
      expect(r).toHaveAttribute('data-drawn', t.rows.rows[i]?.drawn === true ? 'yes' : 'no');
    }
    expect(t.rows.rows.filter((r) => !r.drawn)).toHaveLength(208);
    const lastKey = t.rows.rows[249]?.mark.key;
    expect(last).toHaveAttribute('data-row-key', lastKey);
    t.key('Enter');
    expect(t.onRow).toHaveBeenLastCalledWith(lastKey, 'keyboard', t.grid);

    const first = t.mounted().find((r) => r.getAttribute('aria-rowindex') === '2');
    const button = within(first ?? t.grid).getByRole('button', { name: '250' });
    const user = userEvent.setup();
    await user.click(button);
    expect(t.onRow).toHaveBeenLastCalledWith(t.rows.rows[0]?.mark.key, 'pointer', button);

    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    let download = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      download = this.download;
    });
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(create).toHaveBeenCalledTimes(1);
    const b = blobs[0];
    if (b === undefined) throw new Error('no blob');
    expect(b.type).toBe('text/csv;charset=utf-8');
    expect(await b.text()).toBe(panelCsv(t.rows));
    expect(download).toBe('CPU___host.csv');
    await user.click(screen.getByRole('button', { name: 'Show chart (Shift+T)' }));
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });

  it('an empty table reads 0 rows · 0 drawn', () => {
    mount({ rows: { columns: rows().columns, rows: [] } });
    expect(screen.getByText('0 rows · 0 drawn')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '1');
  });
});

describe('unit:panel-table-active', () => {
  it('the active row names a mounted row and stays mounted when scrolled away', () => {
    const t = mount();
    const id = (i: number): string => {
      const row = t.mounted().find((r) => r.getAttribute('aria-rowindex') === String(i + 2));
      return row?.id ?? 'unmounted';
    };
    expect(t.active()).toBeNull();
    t.key('ArrowDown');
    t.key('ArrowDown');
    t.key('ArrowDown');
    expect(t.active()).toBe(id(2));
    expect(t.active()).toMatch(/-r2$/);
    t.key('End');
    expect(t.active()).toMatch(/-r249$/);
    expect(document.getElementById(t.active() ?? '')).not.toBeNull();
    t.key('Home');
    expect(t.active()).toMatch(/-r0$/);
    act(() => {
      t.grid.scrollTop = 251 * 28 - VIEW_H;
      fireEvent.scroll(t.grid);
    });
    expect(document.getElementById(t.active() ?? '')).not.toBeNull();
    expect(t.active()).toMatch(/-r0$/);
    expect(t.mounted().some((r) => r.getAttribute('aria-rowindex') === '251')).toBe(true);
    t.view.rerender(
      <PanelTable
        rows={rows()}
        title="CPU / host"
        selected={new Set<string>()}
        onRow={t.onRow}
        onClose={t.onClose}
      />,
    );
    expect(t.active()).toBeNull();
  });
});

describe('unit:panel-table-button', () => {
  it("a row button's Enter and Space pick its row once; the grid's active row stays", async () => {
    const t = mount();
    for (let i = 0; i < 4; i++) t.key('ArrowDown');
    expect(t.active()).toMatch(/-r3$/);
    const row7 = t.mounted().find((r) => r.getAttribute('aria-rowindex') === '9');
    if (row7 === undefined) throw new Error('row 7 not mounted');
    const key7 = t.rows.rows[7]?.mark.key;
    const button = within(row7).getByRole('button');
    act(() => {
      button.focus();
    });
    const user = userEvent.setup();
    t.onRow.mockClear();
    await user.keyboard('{Enter}');
    expect(t.onRow).toHaveBeenCalledTimes(1);
    expect(t.onRow).toHaveBeenLastCalledWith(key7, 'keyboard', button);
    await user.keyboard(' ');
    expect(t.onRow).toHaveBeenCalledTimes(2);
    expect(t.onRow).toHaveBeenLastCalledWith(key7, 'keyboard', button);
    expect(t.active()).toMatch(/-r3$/);
  });
});

describe('unit:panel-table (amended, #234 Part 3 §3.3; T25-016)', () => {
  const geoRows = (): PanelRows => geoTable(frameOf(G(), { th: TH }), { kind: 'none' });

  it('a leading aria-pressed toggle "Select ‹name›", an Inspect button, a note on a selected row', async () => {
    const onToggle = vi.fn<(key: string) => void>();
    const onInspectRow = vi.fn<(key: string, el: HTMLElement) => void>();
    const r = geoRows();
    const nameOf = (key: string): string => r.rows.find((x) => x.mark.key === key)?.mark.name ?? '';
    render(
      <PanelTable
        rows={r}
        title="Map"
        selected={new Set(['k10'])}
        toggle={{ label: (key) => `Select ${nameOf(key)}`, onToggle }}
        onInspectRow={onInspectRow}
        rowNote={(key) => (key === 'k10' ? 'Not placed' : null)}
        onClose={() => undefined}
      />,
    );
    const k10 = document.querySelector<HTMLElement>('[data-row-key="k10"]');
    if (k10 === null) throw new Error('no k10 row');
    const toggle = within(k10).getByRole('button', { name: 'Select {lat="91", lon="0"}' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.closest('[role=gridcell]')).toBe(k10.querySelector('[role=gridcell]'));
    const k03 = document.querySelector<HTMLElement>('[data-row-key="k03"]');
    if (k03 === null) throw new Error('no k03 row');
    const other = within(k03).getByRole('button', { name: /^Select / });
    expect(other).toHaveAttribute('aria-pressed', 'false');
    const user = userEvent.setup();
    await user.click(other);
    expect(onToggle).toHaveBeenCalledWith('k03');
    await user.click(within(k10).getByRole('button', { name: 'Inspect' }));
    expect(onInspectRow).toHaveBeenCalledTimes(1);
    expect(onInspectRow.mock.calls[0]?.[0]).toBe('k10');
    expect(k10).toHaveTextContent('Not placed');
    expect(k03).not.toHaveTextContent('Not placed');
  });
});
