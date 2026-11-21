/**
 * The Explore series table (plan #63 Part C §3.3, C.2; SRF-031 subset, D-ISO): one row per series
 * with its last and max, sortable by each column; a row button isolates its series and a second
 * choice restores all. At most `TABLE_ROWS` rows are drawn.
 */
import type { JSX } from 'react';
import type { Unit } from '../../engine/api';
import {
  TABLE_ROWS,
  type SeriesRow,
  type SortColumn,
  type SortState,
} from '../../explore/seriesRows';
import { formatValue } from '../../i18n/format';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import styles from './Explore.module.css';

export interface SeriesTableProps {
  /** Sorted; the first `TABLE_ROWS` are drawn. */
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
}

const COLUMNS: readonly { readonly id: SortColumn; readonly numeric: boolean }[] = [
  { id: 'series', numeric: false },
  { id: 'last', numeric: true },
  { id: 'max', numeric: true },
];

export function SeriesTable(p: SeriesTableProps): JSX.Element {
  const caption = t('explore.table.caption');
  const drawn = p.rows.slice(0, TABLE_ROWS);
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
              {COLUMNS.map((c) => {
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
                  <td className={cx(styles['num'])}>{num(r.last)}</td>
                  <td className={cx(styles['num'])}>{num(r.max)}</td>
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
