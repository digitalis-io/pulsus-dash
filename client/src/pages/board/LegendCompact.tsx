/**
 * The compact legend of a short board panel (plan #64 Part B §3.9, §4.5): one item per series
 * (swatch, name, last value) that isolates it like a table row, and "Legend table", which opens the
 * full table (mean, max, last, sort, isolation, highlights) in a popover dialog. Escape closes it and
 * focus returns to the button. Each item is a chip tinted with its series colour (#282 Part 2a
 * §4.5, `data-series`); a threshold state's value is `text` with its glyph and label, never
 * state-coloured text on the tint.
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
  if (state === null) {
    return <span className={cx(tableStyles['num'], styles['legendValue'])}>{text}</span>;
  }
  const e = StateEncoding[state];
  return (
    <span className={cx(tableStyles['num'], styles['legendValue'], e.className)} data-state={state}>
      <span aria-hidden="true" className={cx(styles['legendGlyph'])}>
        {e.glyph}
      </span>{' '}
      {text} <span className={cx(tableStyles['srOnly'])}>{t(e.label)}</span>
    </span>
  );
}

export function LegendCompact({ table }: { readonly table: SeriesTableProps }): JSX.Element {
  const rows = table.rows.slice(0, table.maxRows);
  const hovered = table.hovered ?? null;
  return (
    <div className={cx(styles['legendCompact'])} data-panel-legend="compact">
      {hovered !== null && (
        <span className={cx(styles['legendAt'])} data-hovered-label="">
          {hovered.label}
        </span>
      )}
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
              <LastValue
                table={table}
                v={hovered === null ? r.last : (hovered.values.get(r.key) ?? null)}
              />
            </>
          );
          return (
            <li key={r.key}>
              {table.onIsolate === null ? (
                <span
                  className={cx(styles['legendItem'])}
                  title={r.name}
                  data-series={r.colourIndex === null ? undefined : r.colourIndex + 1}
                >
                  {content}
                </span>
              ) : (
                <button
                  type="button"
                  className={cx(styles['legendItem'])}
                  data-legend-item=""
                  data-series={r.colourIndex === null ? undefined : r.colourIndex + 1}
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
