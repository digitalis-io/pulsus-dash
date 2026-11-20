/**
 * The chart tooltip (DOM, not canvas; plan #58 §3.5): the time and a 20-row window of the sorted
 * rows. Hidden from assistive technology: the crosshair slider's value text reads the same data.
 */
import type { Ref } from 'react';
import type { HoverEvent, PlotRect, Unit } from '../engine/api';
import { formatTime, formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import styles from './ChartFrame.module.css';
import { pointerWindowStart, rowWindow, sortedRows, TOOLTIP_ROWS } from './chartText';

export interface ChartTooltipProps {
  readonly hover: HoverEvent | null;
  readonly selected: number;
  readonly plot: PlotRect | null;
  readonly unit: Unit;
  readonly timeZone: string;
  readonly ref?: Ref<HTMLDivElement>;
}

export function ChartTooltip({ hover, selected, plot, unit, timeZone, ref }: ChartTooltipProps) {
  const rows = hover === null ? [] : sortedRows(hover.rows);
  const n = rows.length;
  const keyboard = hover?.source === 'keyboard';
  let start: number;
  let end: number;
  if (keyboard) [start, end] = rowWindow(n, selected);
  else {
    start = plot === null || hover === null ? 0 : pointerWindowStart(n, hover.yCss, plot);
    end = Math.min(n, start + TOOLTIP_ROWS);
  }
  return (
    <div
      ref={ref}
      className={cx(styles['tooltip'])}
      data-chart-tooltip=""
      aria-hidden="true"
      hidden={hover === null}
    >
      {hover !== null && (
        <>
          <div className={cx(styles['time'])} data-time="">
            {formatTime(hover.tMs, timeZone)}
          </div>
          {rows.slice(start, end).map((r, k) => (
            <div
              key={r.key}
              className={cx(styles['row'])}
              data-row=""
              data-selected={keyboard && start + k === selected ? '' : undefined}
            >
              <span
                className={cx(
                  styles['swatch'],
                  r.colourIndex === null ? undefined : styles[`s${String(r.colourIndex + 1)}`],
                )}
              />
              <span className={cx(styles['name'])} data-name="">
                {r.name}
              </span>
              <span className={cx(styles['value'])} data-value="">
                {formatValue(r.value, unit)}
              </span>
            </div>
          ))}
          {n > TOOLTIP_ROWS && (
            <div className={cx(styles['range'])} data-range="">
              {t('chart.tooltip.range', { from: start + 1, to: end, total: n })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
