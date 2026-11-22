/**
 * The series table (plan #63 Part C §3.3, C.2; SRF-031 subset, D-ISO), shared by Explore and the
 * board legend (#64 Part B §3.6): one row per series with the caller's value columns (Explore: last
 * and max; the legend: mean, max and last), sortable by each; a row button isolates its series and
 * a second choice restores all. At most `maxRows` rows are drawn. With `cellState`, a value beyond
 * a threshold shows its state colour, glyph and hidden state name (VIZ-067, T02-003).
 */
import type { JSX } from 'react';
import type { ThresholdState, Unit } from '../engine/api';
import type { SeriesRow, SortColumn, SortState } from '../explore/seriesRows';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { Icon } from '../kit/Icon';
import { StateEncoding } from '../theme/stateEncoding';
import styles from './SeriesTable.module.css';

export type ValueColumn = 'mean' | 'last' | 'max';

export interface SeriesTableProps {
  /** Sorted; the first `maxRows` are drawn. */
  readonly rows: readonly SeriesRow[];
  /** All rows of the result. */
  readonly total: number;
  readonly sort: SortState | null;
  readonly onSort: (column: SortColumn) => void;
  readonly isolatedKey: string | null;
  /** Null when the vis cannot isolate a series: names are plain text. */
  readonly onIsolate: ((key: string) => void) | null;
  readonly swatches: boolean;
  /** The frame's value unit. */
  readonly unit: Unit;
  /** The table's caption and the scroll region's name. */
  readonly caption: string;
  /** The value columns after Series, in order. */
  readonly columns: readonly ValueColumn[];
  readonly maxRows: number;
  /** The threshold state of a value; absent = no highlight. */
  readonly cellState?: (v: number | null) => ThresholdState | null;
}

/** A value cell: highlighted with its state's colour, glyph and hidden name when it has one. */
function ValueCell({ text, state }: { text: string; state: ThresholdState | null }) {
  if (state === null) return <td className={cx(styles['num'])}>{text}</td>;
  const e = StateEncoding[state];
  return (
    <td className={cx(styles['num'], styles['stateCell'], e.className)} data-state={state}>
      <span aria-hidden="true">{e.glyph}</span> {text}{' '}
      <span className={cx(styles['srOnly'])}>{t(e.label)}</span>
    </td>
  );
}

export function SeriesTable(p: SeriesTableProps): JSX.Element {
  const { caption } = p;
  const columns: readonly { readonly id: SortColumn; readonly numeric: boolean }[] = [
    { id: 'series', numeric: false },
    ...p.columns.map((id) => ({ id, numeric: true })),
  ];
  const drawn = p.rows.slice(0, p.maxRows);
  const isolating = p.isolatedKey !== null && drawn.some((r) => r.key === p.isolatedKey);
  const num = (v: number | null): string => (v === null ? '—' : formatValue(v, p.unit));
  return (
    <>
      {/* A scrolling region must be reachable by keyboard (WCAG 2.1.1). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className={cx(styles['tableWrap'])} tabIndex={0} role="region" aria-label={caption}>
        <table className={cx(styles['table'])}>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = p.sort?.column === c.id ? p.sort.direction : null;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={sorted ?? 'none'}
                    className={cx(c.numeric && styles['numeric'])}
                  >
                    <button
                      type="button"
                      className={cx(styles['sortButton'])}
                      onClick={() => {
                        p.onSort(c.id);
                      }}
                    >
                      {t(`explore.table.${c.id}`)}
                      <Icon
                        name="chevron-down"
                        className={cx(
                          sorted === null && styles['unsorted'],
                          sorted === 'ascending' && styles['ascending'],
                        )}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {drawn.map((r) => {
              const swatch =
                p.swatches && r.colourIndex !== null ? (
                  <span
                    aria-hidden="true"
                    data-swatch=""
                    className={cx(styles[`swatch${String(r.colourIndex + 1)}`])}
                  />
                ) : null;
              return (
                <tr key={r.key} data-dimmed={isolating && r.key !== p.isolatedKey ? '' : undefined}>
                  <td className={cx(styles['seriesCell'])}>
                    {p.onIsolate === null ? (
                      <span className={cx(styles['rowText'])}>
                        {swatch}
                        <span className={cx(styles['rowName'])}>{r.name}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={cx(styles['rowButton'])}
                        aria-pressed={r.key === p.isolatedKey}
                        onClick={() => {
                          p.onIsolate?.(r.key);
                        }}
                      >
                        {swatch}
                        <span className={cx(styles['rowName'])}>{r.name}</span>
                      </button>
                    )}
                  </td>
                  {p.columns.map((c) => (
                    <ValueCell key={c} text={num(r[c])} state={p.cellState?.(r[c]) ?? null} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {p.total > drawn.length && (
        <p className={cx(styles['footer'])}>
          {t('explore.table.more', { shown: drawn.length, total: p.total })}
        </p>
      )}
    </>
  );
}
