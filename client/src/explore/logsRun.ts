/**
 * The pure parts of an Explore › Logs run (plan #66 Part C §3.8, §4.2, §4.3): the pager input,
 * the layout and what it keeps, the volume and metric frame plans, and the status line.
 */
import type { LogsResult, VolumeResult } from '../data/decode';
import type { FrameData } from '../data/frames';
import type { Diagnostic } from '../editor/lang/types';
import type { VisSpec } from '../engine/api';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import type { LogPagerInput, LogPagerState } from '../logs/logPager';
import type { StatusView } from '../pages/explore/QueryStatus';
import { framePlan, type FramePlan } from '../vis/framePlan';
import { overQueryLimit } from './querySize';
import { errorView, refusalText } from './statusText';
import type { StepWidth } from './stepWidth';
import type { Refusal } from './useExploreRun';

/** Volume stack order, bottom to top. */
export const VOLUME_STACK = [
  'critical',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'unknown',
] as const;

/** Null when `q` is blank, over 128 KB, or the step is unknown. */
export function pagerInput(a: {
  readonly tenant: string;
  readonly q: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly step: StepWidth | null;
  readonly dir: 'backward' | 'forward';
}): LogPagerInput | null {
  const { q, step } = a;
  if (q.trim() === '' || overQueryLimit(q) || step === null) return null;
  return {
    tenant: a.tenant,
    query: q,
    fromMs: a.window.fromMs,
    toMs: a.window.toMs,
    widthPx: step.widthPx,
    direction: a.dir,
  };
}

export type LogsLayout = 'streams' | 'series';
type SeriesResult = Extract<LogsResult, { kind: 'series' }>;

/** The last first-page answer of this tenant: what the layout and the Result card keep (D-RUN). */
export interface LastLogsResult {
  readonly tenant: string;
  readonly layout: LogsLayout;
  /** The series of the last `series` answer; null after a `streams` answer. */
  readonly series: SeriesResult | null;
}

/**
 * phase `streams` → `{tenant, 'streams', null}`; phase `series` → `{tenant, 'series', state.series}`;
 * null state, `pending`, `failed` → `prev` when `prev.tenant === tenant`, else null. Returns `prev`
 * itself when the result would be equal (same tenant, layout and series object).
 */
export function nextLast(
  prev: LastLogsResult | null,
  tenant: string,
  s: LogPagerState | null,
): LastLogsResult | null {
  if (s?.phase === 'streams') {
    return prev?.tenant === tenant && prev.layout === 'streams' && prev.series === null
      ? prev
      : { tenant, layout: 'streams', series: null };
  }
  if (s?.phase === 'series' && s.series !== null) {
    return prev?.tenant === tenant && prev.layout === 'series' && prev.series === s.series
      ? prev
      : { tenant, layout: 'series', series: s.series };
  }
  return prev?.tenant === tenant ? prev : null;
}

/** `streams` / `series` phases decide; `pending`, `failed` and no pager keep `last` (default `streams`). */
export function layoutOf(
  phase: LogPagerState['phase'] | null,
  last: LogsLayout | null,
): LogsLayout {
  if (phase === 'streams' || phase === 'series') return phase;
  return last ?? 'streams';
}

/** Bars: title `explore.logs.volume.title`, unit suffix `explore.logs.volume.unit`, stacking normal,
 *  categoryLabel 'level', categoryOrder VOLUME_STACK; data = the result's series as given. */
export function volumePlan(v: VolumeResult): { readonly spec: VisSpec; readonly data: FrameData } {
  return {
    spec: {
      kind: 'bars',
      title: t('explore.logs.volume.title'),
      unit: { kind: 'suffix', suffix: t('explore.logs.volume.unit') },
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: VOLUME_STACK,
    },
    data: { kind: 'series', series: v.series },
  };
}

/** `framePlan('line', {kind:'series', source:'range', series, stepMs, completeness}, {isolatedKey:
 *  null, title: t('explore.result.title'), rateApplied: false})`. */
export function metricPlan(s: SeriesResult): FramePlan {
  return framePlan(
    'line',
    {
      kind: 'series',
      source: 'range',
      series: s.series,
      stepMs: s.stepMs,
      completeness: s.completeness,
    },
    { isolatedKey: null, title: t('explore.result.title'), rateApplied: false },
  );
}

/** The first page's error: `state.tail.error` when `phase === 'failed'`, else null. */
export function firstPageError(s: LogPagerState | null): unknown {
  return s?.phase === 'failed' ? s.tail.error : null;
}

const NONE: StatusView = { kind: 'none' };

/** The status line (§3.8): the first row that applies. */
export function logsStatusView(i: {
  readonly runRefusal: Refusal | null;
  readonly draftOver: boolean;
  readonly urlRefusal: 'queryTooLarge' | null;
  readonly runReady: boolean;
  readonly editorLoaded: boolean;
  readonly state: LogPagerState | null;
  readonly dir: 'backward' | 'forward';
  readonly diagnostics: readonly Diagnostic[];
}): StatusView {
  if (i.runRefusal !== null) return { kind: 'refused', text: refusalText(i.runRefusal) };
  if (i.draftOver) return { kind: 'limit', text: refusalText('queryTooLarge') };
  if (i.urlRefusal !== null) return { kind: 'refused', text: refusalText(i.urlRefusal) };
  if (i.editorLoaded && !i.runReady) return { kind: 'waiting', text: t('explore.query.waiting') };
  const e = errorView(firstPageError(i.state), i.diagnostics);
  if (e !== null) return { kind: 'error', text: e.text, narrow: e.narrow };
  const s = i.state;
  const order = t(
    i.dir === 'forward' ? 'explore.logs.order.forward' : 'explore.logs.order.backward',
  );
  if (s?.phase === 'streams') {
    return s.atEnd && s.total !== null
      ? { kind: 'ok', text: t('explore.logs.status.all', { count: s.total, order }) }
      : { kind: 'ok', text: t('explore.logs.status.streams', { order }) };
  }
  if (s?.phase === 'series' && s.series !== null) {
    const step = formatValue(s.series.stepMs, { kind: 'time', base: 'ms' });
    return {
      kind: 'ok',
      text: t('explore.logs.status.series', { count: s.series.series.length, step }),
    };
  }
  return NONE;
}
