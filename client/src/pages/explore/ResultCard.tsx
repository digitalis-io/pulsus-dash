/**
 * The Result card of Explore › Metrics (plan #63 Part C §3.3, §4.1, C.2): the vis control, the rate
 * chip and the sent query, the completeness notice, the chart host (always mounted, so its width is
 * known before the first Run) with the shimmer, and the series table. An empty query shows only
 * the empty state.
 */
import type { JSX, RefCallback } from 'react';
import { ToggleButton } from 'react-aria-components';
import { ChartFrame } from '../../charts/ChartFrame';
import type { VisKind } from '../../engine/api';
import type { SeriesRow, SortColumn, SortState } from '../../explore/seriesRows';
import { useDelayedFlag } from '../../explore/useDelayedFlag';
import type { ExploreRun } from '../../explore/useExploreRun';
import { t } from '../../i18n/t';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { Icon } from '../../kit/Icon';
import { SegmentedControl, type SegmentedOption } from '../../kit/SegmentedControl';
import type { ExploreParams } from '../../state/exploreParams';
import type { AutoVis, VisParam } from '../../vis/autovis';
import type { FramePlan } from '../../vis/framePlan';
import pageStyles from '../pages.module.css';
import { CompletenessNotice } from './CompletenessNotice';
import styles from './Explore.module.css';
import { SeriesTable } from './SeriesTable';

export interface ResultCardProps {
  readonly q: string;
  readonly params: ExploreParams;
  readonly run: ExploreRun;
  readonly auto: AutoVis | null;
  /** The vis drawn; null only for a string result. */
  readonly vis: VisKind | null;
  readonly plan: FramePlan | null;
  readonly rows: readonly SeriesRow[];
  readonly sort: SortState | null;
  readonly onSort: (column: SortColumn) => void;
  readonly isolatedKey: string | null;
  readonly onIsolate: ((key: string) => void) | null;
  readonly onVis: (v: VisParam) => void;
  readonly onRate: () => void;
  readonly onNarrow: () => void;
  readonly chartRef: RefCallback<HTMLDivElement>;
}

/** The shimmer shows once a request has been running this long (issue #63). */
export const SHIMMER_DELAY_MS = 300;

const VIS: readonly VisKind[] = ['line', 'bars', 'heatmap', 'stat'];

function visOptions(auto: AutoVis | null): SegmentedOption<VisParam>[] {
  const autoLabel =
    auto?.vis == null
      ? t('explore.vis.autoNone')
      : t('explore.vis.auto', { vis: t(`editor.vis.${auto.vis}`) });
  return [
    { id: 'auto', label: autoLabel },
    ...VIS.map((v) => ({ id: v, label: t(`editor.vis.${v}`) })),
  ];
}

function noticeText(p: FramePlan, run: ExploreRun): string {
  switch (p.notice) {
    case 'string': {
      const r = run.shown?.result;
      return t('explore.result.string', { value: r?.kind === 'string' ? r.value : '' });
    }
    case 'noBuckets':
      return t('explore.vis.noBuckets');
    case 'tooManyTimestamps':
      return t('explore.vis.tooManyTimestamps');
    case null:
      return '';
  }
}

export function ResultCard({ chartRef, ...p }: ResultCardProps): JSX.Element {
  const shown = p.run.shown;
  const shimmer = useDelayedFlag(p.run.fetching, SHIMMER_DELAY_MS);
  const empty = p.q === '';
  const rateCandidate = shown?.planned.rateCandidate === true;
  const sent = shown !== null && shown.planned.query !== shown.text ? shown.planned.query : null;
  const unitOf =
    shown?.planned.rateApplied === true
      ? ({ kind: 'suffix', suffix: '/s' } as const)
      : ({ kind: 'none' } as const);
  return (
    <Card title={t('explore.result.card')}>
      {!empty && (
        <>
          <div className={cx(styles['toolbar'])}>
            <SegmentedControl
              label={t('explore.vis.label')}
              options={visOptions(p.auto)}
              value={p.params.vis}
              onChange={p.onVis}
            />
            {rateCandidate && (
              <ToggleButton
                className={cx(styles['chip'])}
                isSelected={p.params.rate !== 'off'}
                onChange={p.onRate}
              >
                {p.params.rate !== 'off' && <Icon name="check" />}
                {t('explore.rate.label')}
              </ToggleButton>
            )}
            <span className={cx(styles['spacer'])} />
            {sent !== null && (
              <span className={cx(styles['sent'])} title={t('explore.sent', { query: sent })}>
                {t('explore.sent', { query: sent })}
              </span>
            )}
          </div>
          {shown !== null && (
            <CompletenessNotice completeness={shown.result.completeness} onNarrow={p.onNarrow} />
          )}
        </>
      )}
      <div ref={chartRef} className={cx(styles['chartHost'])} aria-busy={shimmer}>
        {shimmer && <div className={cx(styles['shimmer'])} aria-hidden="true" data-shimmer="" />}
        {empty ? (
          <EmptyState title={t('explore.metrics.empty')}>
            <p className={cx(pageStyles['muted'])}>{t('explore.metrics.emptyDetail')}</p>
          </EmptyState>
        ) : p.plan === null ? null : p.plan.data !== null ? (
          <ChartFrame spec={p.plan.spec} data={p.plan.data} />
        ) : (
          <p className={cx(pageStyles['muted'])}>{noticeText(p.plan, p.run)}</p>
        )}
      </div>
      {!empty && p.rows.length > 0 && (
        <SeriesTable
          rows={p.rows}
          total={p.rows.length}
          sort={p.sort}
          onSort={p.onSort}
          isolatedKey={p.isolatedKey}
          onIsolate={p.onIsolate}
          swatches={p.vis !== 'heatmap'}
          unit={unitOf}
        />
      )}
    </Card>
  );
}
