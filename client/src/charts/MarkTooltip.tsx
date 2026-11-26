/**
 * The bar chart's tooltip (DOM, not canvas; plan #173 Part 2 §4.4, Part 3a §3.5): the full name of
 * the bar under the pointer or the keyboard focus, its value in the unit (`no data` when not
 * finite), its state glyph and label, then either `baseline <v>` (the ghost on and a finite
 * baseline) or, when the caller gives them, its `lines` (`CategoryChart.markLines`: the baseline or
 * what the baseline run lacks, the filter hint, the reduced window and the anomaly note), each a
 * `data-line`. Hidden from assistive technology: the listbox and the table view read the same
 * rows. `ChartFrame` places it beside the mark.
 */
import type { JSX, Ref } from 'react';
import type { CategoryRow, MarkEvent, Unit } from '../engine/api';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { StateEncoding } from '../theme/stateEncoding';
import styles from './ChartFrame.module.css';

export function MarkTooltip({
  mark,
  row,
  unit,
  ghost,
  lines,
  ref,
}: {
  mark: MarkEvent | null;
  row: CategoryRow | undefined;
  unit: Unit;
  ghost: boolean;
  lines?: readonly string[];
  ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  const shown = mark !== null && row !== undefined;
  return (
    <div
      ref={ref}
      className={cx(styles['tooltip'])}
      data-mark-tooltip=""
      aria-hidden="true"
      hidden={!shown}
    >
      {shown && (
        <>
          <div className={cx(styles['name'])} data-name="">
            {row.name}
          </div>
          <div className={cx(styles['value'])} data-value="">
            {Number.isFinite(row.value) ? formatValue(row.value, unit) : t('chart.bar.noData')}
          </div>
          {row.state !== null && (
            <div data-state="">
              {`${StateEncoding[row.state].glyph} ${t(StateEncoding[row.state].label)}`}
            </div>
          )}
          {lines === undefined &&
            ghost &&
            row.baseline !== null &&
            Number.isFinite(row.baseline) && (
              <div data-baseline="">
                {t('chart.bar.baseline', { value: formatValue(row.baseline, unit) })}
              </div>
            )}
          {lines?.map((l) => (
            <div key={l} data-line="">
              {l}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
