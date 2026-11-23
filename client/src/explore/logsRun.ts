/**
 * The pure parts of an Explore › Logs run (plan #66 Part C §3.8, §4.2, §4.3): the pager input,
 * the layout and what it keeps, the volume and metric frame plans, and the status line.
 */
import type { LogsResult, VolumeResult } from '../data/decode';
import type { FrameData } from '../data/frames';
import type { Diagnostic } from '../editor/lang/types';
import type { VisSpec } from '../engine/api';
import type { LogPagerInput, LogPagerState } from '../logs/logPager';
import type { StatusView } from '../pages/explore/QueryStatus';
import type { FramePlan } from '../vis/framePlan';
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

const NOT_IMPLEMENTED = 'not implemented';

/** Null when `q` is blank, over 128 KB, or the step is unknown. */
export function pagerInput(_a: {
  readonly tenant: string;
  readonly q: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly step: StepWidth | null;
  readonly dir: 'backward' | 'forward';
}): LogPagerInput | null {
  throw new Error(NOT_IMPLEMENTED);
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
  _prev: LastLogsResult | null,
  _tenant: string,
  _s: LogPagerState | null,
): LastLogsResult | null {
  throw new Error(NOT_IMPLEMENTED);
}

/** `streams` / `series` phases decide; `pending`, `failed` and no pager keep `last` (default `streams`). */
export function layoutOf(
  _phase: LogPagerState['phase'] | null,
  _last: LogsLayout | null,
): LogsLayout {
  throw new Error(NOT_IMPLEMENTED);
}

/** Bars: title `explore.logs.volume.title`, unit suffix `explore.logs.volume.unit`, stacking normal,
 *  categoryLabel 'level', categoryOrder VOLUME_STACK; data = the result's series as given. */
export function volumePlan(_v: VolumeResult): { readonly spec: VisSpec; readonly data: FrameData } {
  throw new Error(NOT_IMPLEMENTED);
}

/** `framePlan('line', {kind:'series', source:'range', series, stepMs, completeness}, {isolatedKey:
 *  null, title: t('explore.result.title'), rateApplied: false})`. */
export function metricPlan(_s: SeriesResult): FramePlan {
  throw new Error(NOT_IMPLEMENTED);
}

/** The first page's error: `state.tail.error` when `phase === 'failed'`, else null. */
export function firstPageError(_s: LogPagerState | null): unknown {
  throw new Error(NOT_IMPLEMENTED);
}

export function logsStatusView(_i: {
  readonly runRefusal: Refusal | null;
  readonly draftOver: boolean;
  readonly urlRefusal: 'queryTooLarge' | null;
  readonly runReady: boolean;
  readonly editorLoaded: boolean;
  readonly state: LogPagerState | null;
  readonly dir: 'backward' | 'forward';
  readonly diagnostics: readonly Diagnostic[];
}): StatusView {
  throw new Error(NOT_IMPLEMENTED);
}
