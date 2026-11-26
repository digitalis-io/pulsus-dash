/**
 * A bar chart's mirror listbox (ADR-0029, plan #173 Part 3a §3.2; Part 2 review r1): visually
 * hidden, one option per drawn bar in draw order, with its full name (also when the canvas shortens
 * or hides it), its formatted value and, with thresholds, its state. It is the frame's key target:
 * the engine moves the focus band on its keys, and `aria-activedescendant` names the option of a
 * keyboard `mark`. An option is selected while its key is in the page selection. `k more not shown`
 * (the meter's `showing X of N`) is a sibling the listbox names as its description. The canvas names
 * the listbox with `aria-describedby`. `data-escape-ladder` lets Escape reach the T25 ladder
 * (T25-007).
 */
import { forwardRef } from 'react';
import type { BarchartSpec, FrameData } from '../engine/api';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { StateEncoding } from '../theme/stateEncoding';
import styles from './ChartFrame.module.css';

const COUNT = new Intl.NumberFormat('en-GB');

export interface BarListProps {
  id: string;
  spec: BarchartSpec;
  data: Extract<FrameData, { kind: 'categories' }>;
  /** The draw index of a keyboard `mark`; null otherwise. */
  active: number | null;
  /** The keys of the page selection. */
  selected: ReadonlySet<string>;
}

export const BarList = forwardRef<HTMLDivElement, BarListProps>(function BarList(
  { id, spec, data, active, selected },
  ref,
) {
  const more = Math.max(0, data.coverage.total - data.coverage.drawn);
  const moreId = `${id}-more`;
  return (
    <>
      <div
        ref={ref}
        id={id}
        role="listbox"
        tabIndex={0}
        aria-multiselectable="true"
        aria-label={t('chart.bar.label', {
          title: spec.title,
          count: COUNT.format(data.categories.length),
        })}
        {...(active === null || data.categories[active] === undefined
          ? {}
          : { 'aria-activedescendant': `${id}-${String(active)}` })}
        {...(more > 0 ? { 'aria-describedby': moreId } : {})}
        className={cx(styles['srOnly'])}
        data-escape-ladder=""
        data-bar-list=""
      >
        {data.categories.map((r, i) => {
          const value = Number.isFinite(r.value)
            ? formatValue(r.value, spec.unit)
            : t('chart.bar.noData');
          const state = r.state === null ? null : t(StateEncoding[r.state].label);
          return (
            <div
              key={r.key}
              role="option"
              id={`${id}-${String(i)}`}
              aria-selected={selected.has(r.key)}
            >
              {state === null
                ? t('chart.bar.item', { name: r.name, value })
                : t('chart.bar.itemState', { name: r.name, value, state })}
            </div>
          );
        })}
      </div>
      {more > 0 && (
        <p id={moreId} className={cx(styles['srOnly'])}>
          {t('chart.bar.more', { n: COUNT.format(more) })}
        </p>
      )}
    </>
  );
});
