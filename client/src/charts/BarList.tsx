/**
 * A bar chart's bars for assistive technology (plan #173 Part 2 review r1): a visually hidden list,
 * one item per drawn bar in draw order, with its full name (also when the canvas shortens or hides
 * it), its formatted value and, with thresholds, its state; then `k more not shown` for the rows the
 * cap left out (the meter's `showing X of N`). The canvas names it with `aria-describedby`. It is
 * not focusable: keyboard navigation of the bars is #173 Part 3.
 */
import type { JSX } from 'react';
import type { BarchartSpec, FrameData } from '../engine/api';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { StateEncoding } from '../theme/stateEncoding';
import styles from './ChartFrame.module.css';

const COUNT = new Intl.NumberFormat('en-GB');

export function BarList({
  id,
  spec,
  data,
}: {
  id: string;
  spec: BarchartSpec;
  data: Extract<FrameData, { kind: 'categories' }>;
}): JSX.Element {
  const more = Math.max(0, data.coverage.total - data.coverage.drawn);
  return (
    <ul id={id} className={cx(styles['srOnly'])} data-bar-list="">
      {data.categories.map((r) => {
        const value = Number.isFinite(r.value)
          ? formatValue(r.value, spec.unit)
          : t('chart.bar.noData');
        const state = r.state === null ? null : t(StateEncoding[r.state].label);
        return (
          <li key={r.key}>
            {state === null
              ? t('chart.bar.item', { name: r.name, value })
              : t('chart.bar.itemState', { name: r.name, value, state })}
          </li>
        );
      })}
      {more > 0 && <li>{t('chart.bar.more', { n: COUNT.format(more) })}</li>}
    </ul>
  );
}
