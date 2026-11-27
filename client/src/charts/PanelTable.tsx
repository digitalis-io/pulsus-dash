/**
 * A panel's table view (T22-013, VIZ-066; plan #173 Part 3a §3.7): a read-only grid over a fit's
 * `PanelRows`, every row of the result (drawn or not), virtualised at one `table-row` per row. The
 * bar above it holds the caption (`n rows · d drawn`), Export CSV and the way back to the chart.
 *
 * Keys on the grid (only when the grid itself has focus; a row's name button keeps its own Enter
 * and Space): the first arrow, Home or End sets the active row, which ↑/↓, Home/End and
 * PageUp/PageDown move, each scrolling it into view; Enter picks it. `aria-activedescendant` names
 * the active row, which the range extractor keeps mounted when it is scrolled away; new rows clear
 * it. Positions are set through CSSOM (no inline styles: CSP style-src, T01-010).
 *
 * A geomap's table (plan #234 Part 3 §3.3, T25-016) adds a leading 24 px `aria-pressed` select
 * toggle and an Inspect button in each row's first cell, and a visible note on a selected row the
 * caller names ("Not placed").
 */
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { cx } from '../kit/cx';
import { size } from '../styles/tokens';
import { csvFileName, panelCsv, type PanelRows } from '../vis/reduce';
import styles from './PanelTable.module.css';

const ROW_PX = size['table-row'];
const OVERSCAN = 10;
const COUNT = new Intl.NumberFormat('en-GB');

const px = (n: number): string => `${String(n)}px`;

export interface PanelTableProps {
  rows: PanelRows;
  title: string;
  /** The keys of the page selection: their rows are `aria-selected`. */
  selected: ReadonlySet<string>;
  /** A row was chosen (its name button, or Enter on the grid); absent: names are plain text. */
  onRow?: (key: string, source: 'pointer' | 'keyboard', el: HTMLElement) => void;
  onClose: () => void;
  /** A leading 24 px `aria-pressed` select toggle per row (T25-016; plan #234 Part 3 §3.3). */
  toggle?: { readonly label: (key: string) => string; readonly onToggle: (key: string) => void };
  /** An "Inspect" button per row. */
  onInspectRow?: (key: string, el: HTMLElement) => void;
  /** A visible note on a highlighted row ("Not placed"); null for none. */
  rowNote?: (key: string) => string | null;
  /** Focus the first row's toggle once its row is mounted, else the grid (the geomap's Show table). */
  focusFirstToggle?: boolean;
}

/** Downloads `rows` as `csvFileName(title)`; the object URL is revoked on the next task. */
function exportCsv(rows: PanelRows, title: string): void {
  const url = URL.createObjectURL(new Blob([panelCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName(title);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function PanelTable({
  rows,
  title,
  selected,
  onRow,
  onClose,
  toggle,
  onInspectRow,
  rowNote,
  focusFirstToggle = false,
}: PanelTableProps): JSX.Element {
  const tableId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const n = rows.rows.length;
  const drawn = rows.rows.reduce((k, r) => (r.drawn ? k + 1 : k), 0);
  // The active row belongs to the rows it was set on: new rows read as none.
  const [state, setState] = useState<{ rows: PanelRows; index: number } | null>(null);
  const active = state !== null && state.rows === rows && state.index < n ? state.index : null;

  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const out = defaultRangeExtractor(range);
      if (active === null || out.includes(active)) return out;
      return [...out, active].sort((a, b) => a - b);
    },
    [active],
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- the build has no React Compiler; nothing memoises the virtualiser's functions
  const virtualizer = useVirtualizer({
    count: n,
    getScrollElement: () => gridRef.current,
    estimateSize: () => ROW_PX,
    overscan: OVERSCAN,
    rangeExtractor,
    // The sticky header row sits above the rows inside the scroller.
    scrollMargin: ROW_PX,
    scrollPaddingStart: ROW_PX,
  });
  const items = virtualizer.getVirtualItems();
  const totalPx = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    body.style.height = px(totalPx);
    const byIndex = new Map(items.map((it) => [it.index, it]));
    for (const el of body.children) {
      if (!(el instanceof HTMLElement)) continue;
      const it = byIndex.get(Number(el.dataset['index']));
      if (it !== undefined) el.style.transform = `translateY(${px(it.start - ROW_PX)})`;
    }
  });

  const moveTo = (i: number): void => {
    const next = Math.min(n - 1, Math.max(0, i));
    setState({ rows, index: next });
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // A row's name button keeps its own keys.
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || n === 0) return;
    const page = Math.max(1, Math.floor(e.currentTarget.clientHeight / ROW_PX));
    switch (e.key) {
      case 'ArrowDown':
        moveTo(active === null ? 0 : active + 1);
        break;
      case 'ArrowUp':
        moveTo(active === null ? 0 : active - 1);
        break;
      case 'PageDown':
        moveTo(active === null ? 0 : active + page);
        break;
      case 'PageUp':
        moveTo(active === null ? 0 : active - page);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(n - 1);
        break;
      case 'Enter': {
        const key = active === null ? undefined : rows.rows[active]?.mark.key;
        if (key === undefined || onRow === undefined) return;
        onRow(key, 'keyboard', e.currentTarget);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  // More columns than the bar chart's six: a wider grid that scrolls sideways (CSSOM, T01-010).
  const wide = rows.columns.length > 6;
  useLayoutEffect(() => {
    gridRef.current?.style.setProperty('--table-cols', String(rows.columns.length - 1));
  }, [rows.columns.length]);

  // Show table (T24 §4.12): the first toggle once the virtualiser has mounted its row.
  const pendingFocus = useRef(focusFirstToggle);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const grid = gridRef.current;
    const toggle = grid?.querySelector<HTMLElement>('[data-row-toggle]');
    if (toggle !== null && toggle !== undefined) {
      pendingFocus.current = false;
      toggle.focus();
    } else if (n === 0) {
      pendingFocus.current = false;
      grid?.focus();
    }
  });

  const rowId = (i: number): string => `${tableId}-r${String(i)}`;
  return (
    <div className={cx(styles['root'])} data-panel-table="">
      <div className={cx(styles['bar'])}>
        <p className={cx(styles['caption'])}>
          {t('table.caption', { n: COUNT.format(n), d: COUNT.format(drawn) })}
        </p>
        <Button
          variant="secondary"
          onPress={() => {
            exportCsv(rows, title);
          }}
        >
          {t('table.export')}
        </Button>
        <Button variant="secondary" onPress={onClose}>
          {t('table.close')}
        </Button>
      </div>
      <div
        ref={gridRef}
        role="grid"
        tabIndex={0}
        aria-label={title}
        aria-rowcount={n + 1}
        aria-colcount={rows.columns.length}
        aria-readonly="true"
        {...(active === null ? {} : { 'aria-activedescendant': rowId(active) })}
        className={cx(styles['grid'], wide ? styles['wide'] : undefined)}
        onKeyDown={onKeyDown}
      >
        <div role="rowgroup" className={cx(styles['head'])}>
          <div role="row" aria-rowindex={1} className={cx(styles['row'])}>
            {rows.columns.map((c, k) => (
              <div key={c} role="columnheader" aria-colindex={k + 1} className={cx(styles['cell'])}>
                {c}
              </div>
            ))}
          </div>
        </div>
        <div ref={bodyRef} role="rowgroup" className={cx(styles['body'])}>
          {items.map((it) => {
            const r = rows.rows[it.index];
            if (r === undefined) return null;
            const key = r.mark.key;
            const note = selected.has(key) ? (rowNote?.(key) ?? null) : null;
            return (
              <div
                key={key}
                id={rowId(it.index)}
                role="row"
                aria-rowindex={it.index + 2}
                aria-selected={selected.has(key)}
                data-index={it.index}
                data-row-key={key}
                data-drawn={r.drawn ? 'yes' : 'no'}
                data-active={it.index === active ? '' : undefined}
                className={cx(styles['row'], styles['bodyRow'])}
              >
                {r.cells.map((c, k) => (
                  <div
                    key={rows.columns[k] ?? k}
                    role="gridcell"
                    aria-colindex={k + 1}
                    className={cx(styles['cell'])}
                  >
                    {k === 0 && toggle !== undefined && (
                      <button
                        type="button"
                        className={cx(styles['toggle'])}
                        aria-pressed={selected.has(key)}
                        aria-label={toggle.label(key)}
                        data-row-toggle=""
                        onClick={() => {
                          toggle.onToggle(key);
                        }}
                      />
                    )}
                    {k === 0 && onRow !== undefined ? (
                      <button
                        type="button"
                        className={cx(styles['name'])}
                        onClick={(e) => {
                          onRow(key, e.detail === 0 ? 'keyboard' : 'pointer', e.currentTarget);
                        }}
                      >
                        {c}
                      </button>
                    ) : (
                      c
                    )}
                    {k === 0 && onInspectRow !== undefined && (
                      <button
                        type="button"
                        className={cx(styles['inspect'])}
                        data-row-inspect=""
                        onClick={(e) => {
                          onInspectRow(key, e.currentTarget);
                        }}
                      >
                        {t('geo.table.inspect')}
                      </button>
                    )}
                    {k === 0 && note !== null && (
                      <span className={cx(styles['note'])} data-row-note="">
                        {note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
