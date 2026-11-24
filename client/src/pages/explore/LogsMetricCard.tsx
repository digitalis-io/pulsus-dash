/**
 * The Result card of Explore › Logs (plan #66 Part C §3.9, §4.2; Q-C4): a LogQL metric query drawn
 * as a line chart through `<ChartFrame>`. It keeps this tenant's last series while a rerun is
 * pending (with the shimmer) or failed; the status line carries the error.
 */
import { useMemo, type JSX } from 'react';
import { ChartFrame } from '../../charts/ChartFrame';
import type { LogsResult } from '../../data/decode';
import { metricPlan } from '../../explore/logsRun';
import { useDelayedFlag } from '../../explore/useDelayedFlag';
import { t } from '../../i18n/t';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import { CompletenessNotice } from './CompletenessNotice';
import styles from './Explore.module.css';
import { SHIMMER_DELAY_MS } from './ResultCard';

export interface LogsMetricCardProps {
  /** `last.series` (§4.2): this tenant's last series answer; null before the first one. */
  readonly series: Extract<LogsResult, { kind: 'series' }> | null;
  /** state null or phase `pending`. */
  readonly fetching: boolean;
  readonly onNarrow: () => void;
}

export function LogsMetricCard({ series, fetching, onNarrow }: LogsMetricCardProps): JSX.Element {
  const shimmer = useDelayedFlag(fetching, SHIMMER_DELAY_MS);
  const plan = useMemo(() => (series === null ? null : metricPlan(series)), [series]);
  return (
    <Card title={t('explore.result.card')}>
      {series !== null && (
        <CompletenessNotice completeness={series.completeness} onNarrow={onNarrow} />
      )}
      <div className={cx(styles['chartHost'])} aria-busy={shimmer}>
        {shimmer && <div className={cx(styles['shimmer'])} aria-hidden="true" data-shimmer="" />}
        {plan !== null && plan.spec !== null && plan.data !== null && (
          <ChartFrame spec={plan.spec} data={plan.data} />
        )}
      </div>
    </Card>
  );
}
