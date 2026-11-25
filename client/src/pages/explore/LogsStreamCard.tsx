/**
 * The Log lines card of Explore › Logs (plan #66 Part C §3.9; SRF-036 subset): the merged
 * completeness of the pages read, and `LogStream` (order, wrap, the virtualised list) at a fixed
 * height, or a loading note until the pager of the current run exists.
 */
import { useMemo, type JSX } from 'react';
import { t } from '../../i18n/t';
import type { InspectOrigin } from '../../inspector/types';
import { useChartInspect } from '../../inspector/useChartInspect';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import { LogStream } from '../../logs/LogStream';
import type { LogPager, LogPagerState } from '../../logs/logPager';
import { CompletenessNotice } from './CompletenessNotice';
import styles from './Explore.module.css';

export interface LogsStreamCardProps {
  /** Explore's query: the Inspector's origin (T25 §5). */
  readonly q: string;
  readonly pager: LogPager | null;
  readonly state: LogPagerState | null;
  readonly wrap: boolean;
  readonly onWrapChange: (wrap: boolean) => void;
  readonly onDirectionChange: (d: 'backward' | 'forward') => void;
  readonly onRerun: () => void;
  readonly onNarrow: () => void;
}

export function LogsStreamCard(p: LogsStreamCardProps): JSX.Element {
  const completeness = p.state?.completeness ?? null;
  const q = p.q;
  const origin = useMemo<Omit<InspectOrigin, 'window'>>(
    () => ({
      surface: 'explore',
      panelId: null,
      title: t('explore.logs.stream.card'),
      query: q === '' ? null : { lang: 'logql', text: q },
      unit: null,
    }),
    [q],
  );
  const { onInspect } = useChartInspect(origin);
  return (
    <Card title={t('explore.logs.stream.card')}>
      {completeness !== null && (
        <CompletenessNotice completeness={completeness} onNarrow={p.onNarrow} />
      )}
      {p.pager !== null ? (
        <div className={cx(styles['streamHost'])}>
          <LogStream
            pager={p.pager}
            label={t('explore.logs.stream.label')}
            wrap={p.wrap}
            onWrapChange={p.onWrapChange}
            onDirectionChange={p.onDirectionChange}
            onRerun={p.onRerun}
            {...(onInspect === undefined ? {} : { onInspect })}
          />
        </div>
      ) : (
        <p role="status">{t('logs.loading')}</p>
      )}
    </Card>
  );
}
