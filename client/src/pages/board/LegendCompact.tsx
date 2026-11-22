/**
 * The compact legend of a short board panel (plan #64 Part B §3.9, §4.5): one item per series
 * (swatch, name, last value) that isolates it like a table row, and "Legend table", which opens the
 * full table (mean, max, last, sort, isolation, highlights) in a popover dialog. Escape closes it and
 * focus returns to the button.
 */
import type { JSX } from 'react';
import { DialogTrigger } from 'react-aria-components';
import { SeriesTable, type SeriesTableProps } from '../../charts/SeriesTable';
import tableStyles from '../../charts/SeriesTable.module.css';
import { formatValue } from '../../i18n/format';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Dialog } from '../../kit/Dialog';
import { Popover } from '../../kit/Popover';
import { StateEncoding } from '../../theme/stateEncoding';
import styles from './Board.module.css';

function LastValue({ table, v }: { table: SeriesTableProps; v: number | null }) {
  const text = v === null ? '—' : formatValue(v, table.unit);
  const state = table.cellState?.(v) ?? null;
  if (state === null) return <span className={cx(tableStyles['num'])}>{text}</span>;
  const e = StateEncoding[state];
  return (
    <span
      className={cx(tableStyles['num'], tableStyles['stateCell'], e.className)}
      data-state={state}
    >
      <span aria-hidden="true">{e.glyph}</span> {text}{' '}
      <span className={cx(tableStyles['srOnly'])}>{t(e.label)}</span>
    </span>
  );
}

export function LegendCompact({ table }: { readonly table: SeriesTableProps }): JSX.Element {
  const rows = table.rows.slice(0, table.maxRows);
  return (
    <div className={cx(styles['legendCompact'])} data-panel-legend="compact">
      <ul className={cx(styles['legendList'])} aria-label={table.caption}>
        {rows.map((r) => {
          const content = (
            <>
              {table.swatches && r.colourIndex !== null && (
                <span
                  aria-hidden="true"
                  data-swatch=""
                  className={cx(tableStyles[`swatch${String(r.colourIndex + 1)}`])}
                />
              )}
              <span className={cx(styles['legendName'])}>{r.name}</span>
              <LastValue table={table} v={r.last} />
            </>
          );
          return (
            <li key={r.key}>
              {table.onIsolate === null ? (
                <span className={cx(styles['legendItem'])} title={r.name}>
                  {content}
                </span>
              ) : (
                <button
                  type="button"
                  className={cx(styles['legendItem'])}
                  data-legend-item=""
                  aria-pressed={r.key === table.isolatedKey}
                  title={r.name}
                  onClick={() => {
                    table.onIsolate?.(r.key);
                  }}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <DialogTrigger>
        <Button variant="ghost" data-legend-table="">
          {t('panel.legend.table')}
        </Button>
        <Popover placement="bottom end">
          <Dialog aria-label={table.caption} className={cx(styles['legendPopover'])}>
            <SeriesTable {...table} />
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
