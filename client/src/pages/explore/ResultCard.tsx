/**
 * The Result card of Explore › Metrics (plan #63 Part C §3.3, §4.1, C.2): the vis control, the rate
 * chip and the sent query, the completeness notice, the chart host (always mounted, so its width is
 * known before the first Run) with the shimmer, and the series table. An empty query shows only
 * the empty state. With `vis=barchart` the host holds a `CategoryChart` with its meter and table
 * view (Shift+T); a click inspects and never filters (plan #173 Part 3b §4.4).
 */
import { useCallback, useMemo, useState, type JSX, type RefCallback } from 'react';
import { ToggleButton } from 'react-aria-components';
import { CategoryChart } from '../../charts/CategoryChart';
import { ChartFrame } from '../../charts/ChartFrame';
import { SeriesTable } from '../../charts/SeriesTable';
import type { PickEvent } from '../../engine/api';
import {
  TABLE_ROWS,
  type SeriesRow,
  type SortColumn,
  type SortState,
} from '../../explore/seriesRows';
import { useDelayedFlag } from '../../explore/useDelayedFlag';
import type { ExploreRun } from '../../explore/useExploreRun';
import { t } from '../../i18n/t';
import type { InspectOrigin } from '../../inspector/types';
import { useChartInspect } from '../../inspector/useChartInspect';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { Icon } from '../../kit/Icon';
import { SegmentedControl, type SegmentedOption } from '../../kit/SegmentedControl';
import type { BoardFilter } from '../../state/boardParams';
import type { ExploreParams } from '../../state/exploreParams';
import { useTimeContext } from '../../state/useTimeContext';
import type { AutoVis, VisKind, VisParam } from '../../vis/autovis';
import { barAction, type BarContext } from '../../vis/barAction';
import type { BarchartModel } from '../../vis/barchart';
import type { FramePlan } from '../../vis/framePlan';
import { panelUnits } from '../../vis/units';
import pageStyles from '../pages.module.css';
import { CompletenessNotice } from './CompletenessNotice';
import styles from './Explore.module.css';

/** Explore applies no board filters (T25-010). */
const NO_FILTERS: readonly BoardFilter[] = Object.freeze([]);

/** Explore's table columns (plan #64 Part B §3.6). */
const TABLE_COLUMNS = ['last', 'max'] as const;

export interface ResultCardProps {
  readonly q: string;
  readonly params: ExploreParams;
  readonly run: ExploreRun;
  readonly auto: AutoVis | null;
  /** The vis drawn; null only for a string result. */
  readonly vis: VisKind | null;
  readonly plan: FramePlan | null;
  /** The bar chart's model with `vis` barchart and a series or scalar result; else null. */
  readonly model: BarchartModel | null;
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

const VIS: readonly VisKind[] = ['line', 'bars', 'heatmap', 'stat', 'barchart'];

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
    // Explore never chooses a geomap (T24-099 is step 2).
    case 'geomap':
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
  // Explore stores no unit (T22-015): `/s` after the rate rewrite, else none; a heatmap's table
  // rows are its bucket series, in the count unit.
  const units = panelUnits(undefined, p.vis ?? 'line', shown?.planned.rateApplied === true);
  const tableUnit = p.vis === 'heatmap' ? units.count : units.value;
  // The Inspector's origin (T25 §5): Explore's query is `q`.
  const q = p.q;
  const chartUnit = p.plan?.spec?.unit ?? null;
  const origin = useMemo<Omit<InspectOrigin, 'window'>>(
    () => ({
      surface: 'explore',
      panelId: null,
      title: t('explore.result.title'),
      query: q === '' ? null : { lang: 'promql', text: q },
      unit: chartUnit,
    }),
    [q, chartUnit],
  );
  const inspect = useChartInspect(origin);
  const { onInspect, onEmptyClick, onSelect } = inspect;
  // The bar chart (§4.4): its table view, its pick context and the pick's action. Explore never
  // filters: a click inspects, a brush selects, an empty pick clears.
  const [table, setTable] = useState(false);
  const { window: win } = useTimeContext();
  const { fromMs, toMs } = win;
  const context = useMemo<Omit<BarContext, 'model'>>(
    () => ({ surface: 'explore', filters: NO_FILTERS, origin, window: { fromMs, toMs } }),
    [origin, fromMs, toMs],
  );
  const model = p.model;
  const onPick = useCallback(
    (e: PickEvent, returnFocus: HTMLElement | null): void => {
      if (model === null) return;
      const a = barAction(e, { ...context, model });
      if (a.kind === 'click') onInspect?.(a.target, e.source, returnFocus);
      else if (a.kind === 'brush') onSelect?.(a.selection, 'brush');
      else if (a.kind === 'clear') onEmptyClick?.();
    },
    [model, context, onInspect, onSelect, onEmptyClick],
  );
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
        ) : p.vis === 'barchart' && model !== null ? (
          <div className={cx(styles['bars'])}>
            <CategoryChart
              model={model}
              title={t('explore.result.title')}
              onNarrow={p.onNarrow}
              onPick={onPick}
              context={context}
              table={table}
              onTable={setTable}
            />
          </div>
        ) : p.plan === null ? null : p.plan.data !== null ? (
          <ChartFrame
            spec={p.plan.spec}
            data={p.plan.data}
            {...(onInspect === undefined ? {} : { onInspect })}
            {...(onEmptyClick === undefined ? {} : { onEmptyClick })}
          />
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
          unit={tableUnit}
          caption={t('explore.table.caption')}
          columns={TABLE_COLUMNS}
          maxRows={TABLE_ROWS}
          selectPanelId={null}
        />
      )}
    </Card>
  );
}
