/**
 * The Volume card of Explore › Logs (plan #66 Part C §3.9, §4.3; SRF-033): the completeness notice,
 * the volume's own error (only while the stream answered, so one failure is not told twice), and
 * the stacked bars by level through `<ChartFrame>`, whose brush sets the Context window.
 */
import { useMemo, type JSX } from 'react';
import { ChartFrame } from '../../charts/ChartFrame';
import { volumePlan } from '../../explore/logsRun';
import { errorView } from '../../explore/statusText';
import { useDelayedFlag } from '../../explore/useDelayedFlag';
import type { LogsVolume } from '../../explore/useLogsVolume';
import { t } from '../../i18n/t';
import type { InspectOrigin } from '../../inspector/types';
import { useChartInspect } from '../../inspector/useChartInspect';
import { Button } from '../../kit/Button';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import { CompletenessNotice } from './CompletenessNotice';
import styles from './Explore.module.css';
import { SHIMMER_DELAY_MS } from './ResultCard';

export interface LogsVolumeCardProps {
  /** Explore's query: the Inspector's origin (T25 §5). */
  readonly q: string;
  readonly volume: LogsVolume;
  /** True only while the pager's phase is `streams` (§4.3). */
  readonly showError: boolean;
  readonly onNarrow: () => void;
}

export function LogsVolumeCard({
  q,
  volume,
  showError,
  onNarrow,
}: LogsVolumeCardProps): JSX.Element {
  const shown = volume.shown;
  const shimmer = useDelayedFlag(volume.fetching, SHIMMER_DELAY_MS);
  const plan = useMemo(() => (shown === null ? null : volumePlan(shown)), [shown]);
  const view = showError ? errorView(volume.error, []) : null;
  const title = plan?.spec.title ?? t('explore.logs.volume.card');
  const unit = plan?.spec.unit ?? null;
  const origin = useMemo<Omit<InspectOrigin, 'window'>>(
    () => ({
      surface: 'explore',
      panelId: null,
      title,
      query: q === '' ? null : { lang: 'logql', text: q },
      unit,
    }),
    [q, title, unit],
  );
  const inspect = useChartInspect(origin);
  return (
    <Card title={t('explore.logs.volume.card')}>
      {shown !== null && (
        <CompletenessNotice completeness={shown.completeness} onNarrow={onNarrow} />
      )}
      {view !== null && (
        <p role="alert" className={cx(styles['cardAlert'])}>
          <Icon name="info" />
          <span>{t('explore.logs.volume.failed', { message: view.text })}</span>
          {view.narrow && (
            <Button variant="ghost" onPress={onNarrow}>
              {t('explore.narrow')}
            </Button>
          )}
        </p>
      )}
      <div className={cx(styles['chartHost'])} aria-busy={shimmer}>
        {shimmer && <div className={cx(styles['shimmer'])} aria-hidden="true" data-shimmer="" />}
        {plan !== null && <ChartFrame spec={plan.spec} data={plan.data} {...inspect} />}
      </div>
    </Card>
  );
}
