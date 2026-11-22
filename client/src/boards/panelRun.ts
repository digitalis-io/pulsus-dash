/**
 * The board panel run's query key and what a panel shows (plan #64 §3.1, §4.2). The key carries the
 * inputs the panel sends (ADR-0021: never a planned text) and, outside its head, the step and the
 * resolved window, so a time change, a zoom or a relative refresh is a new key whose placeholder is
 * the previous result (§4.3). A frame view carries the panel's thresholds (as seam lines on line and
 * bars, ADR-0022) and legend mode, and its result for the legend rows and local isolation (plan
 * #64 Part B §3.8).
 */
import type { PanelSpec } from '../api/types';
import type { FrameData } from '../data/frames';
import type { Diagnostic } from '../editor/lang/types';
import type { VisKind, VisSpec } from '../engine/api';
import { seriesRows, type SeriesRow } from '../explore/seriesRows';
import { errorView, refusalText } from '../explore/statusText';
import { t } from '../i18n/t';
import { autoVis, chooseVis, type ExploreResult } from '../vis/autovis';
import { framePlan, type FramePlan } from '../vis/framePlan';
import { thresholdLines, type Thresholds } from '../vis/thresholds';
import type { PanelRun } from './usePanelRun';

export interface Resolved {
  /** The panel text as saved (or the editor's run text, §4.4); sent raw. */
  readonly text: string;
  /** JSON of `panelVars(text, vars)`: `[name, value]` pairs sorted by name. */
  readonly vars: string;
}

export type PanelView =
  | { readonly kind: 'message'; readonly state: PanelState; readonly text: string }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'error';
      readonly text: string;
      readonly detail: string;
      readonly narrow: boolean;
    }
  | {
      readonly kind: 'frame';
      /** Line and bars: with `thresholds` = `thresholdLines(…, spec.unit)` when the panel has them. */
      readonly spec: VisSpec;
      readonly data: FrameData;
      readonly vis: VisKind;
      /** For the legend rows and local isolation. */
      readonly result: ExploreResult;
      readonly rateApplied: boolean;
      /** `panel.vis.thresholds ?? null`. */
      readonly thresholds: Thresholds | null;
      /** `panel.vis.legend?.mode ?? 'table'`. */
      readonly legend: 'table' | 'hidden';
    };

/** The most rows a panel legend shows (plan #64 Part B §4.5). */
export const LEGEND_ROWS = 50;

export type PanelState =
  | 'empty'
  | 'variable'
  | 'unsupported'
  | 'logs'
  | 'refused'
  | 'langFailed'
  | 'noBuckets'
  | 'tooManyTimestamps'
  | 'string';

/** The head: indices 0–6 (through `kind`). */
export const PANEL_KEY_HEAD = 7;
const RUN_KEY_LENGTH = 10;

/** `['data', 'panel', tenant, id, text, vars, kind, step, fromMs, toMs]`. */
export function panelRunKey(
  tenant: string,
  id: string,
  r: Resolved,
  kind: 'range' | 'instant',
  stepMs: number,
  w: { readonly fromMs: number; readonly toMs: number },
): readonly unknown[] {
  return ['data', 'panel', tenant, id, r.text, r.vars, kind, stepMs, w.fromMs, w.toMs];
}

/** The key while nothing can be sent (no request): `['data', 'panel', tenant, id, text, null]`. */
export function panelIdleKey(tenant: string, id: string, text: string): readonly unknown[] {
  return ['data', 'panel', tenant, id, text, null];
}

/** Equal heads (`===` per element) and both are run keys (length 10). */
export function sameExceptWindow(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== RUN_KEY_LENGTH || b.length !== RUN_KEY_LENGTH) return false;
  for (let i = 0; i < PANEL_KEY_HEAD; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Equal length and `===` per element. */
export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * ` (line {line}, column {column})` of the first diagnostic when it has a position: 1-based, lines
 * split on `\n`, the column in code points of `text`, at `from`; otherwise ''.
 */
export function positionText(text: string, diagnostics: readonly Diagnostic[]): string {
  const d = diagnostics[0];
  if (d === undefined || !d.positionKnown) return '';
  const before = text.slice(0, d.from);
  const start = before.lastIndexOf('\n') + 1;
  let line = 1;
  for (const c of before) if (c === '\n') line += 1;
  const column = Array.from(before.slice(start)).length + 1;
  return t('panel.errorAt', { line, column });
}

/**
 * `framePlan` per result, vis, rate and isolated series (a heatmap's buckets are not cheap): a
 * panel's remounts (the Edit grid, full screen) and the preview reuse the plan of the same result.
 * The title is the spec's only per-call part.
 */
const plans = new WeakMap<ExploreResult, Map<string, FramePlan>>();

function cachedPlan(
  vis: VisKind,
  r: ExploreResult,
  rateApplied: boolean,
  title: string,
  isolatedKey: string | null = null,
): FramePlan {
  let byVis = plans.get(r);
  if (byVis === undefined) {
    byVis = new Map();
    plans.set(r, byVis);
  }
  const k = `${vis}|${String(rateApplied)}|${isolatedKey ?? ''}`;
  let plan = byVis.get(k);
  if (plan === undefined) {
    plan = framePlan(vis, r, { isolatedKey, title: '', rateApplied });
    byVis.set(k, plan);
  }
  return plan.spec === null ? plan : { ...plan, spec: { ...plan.spec, title } };
}

/** The panel's threshold lines on a line or bars spec (ADR-0022); other specs as they are. */
function withThresholds(spec: VisSpec, t: Thresholds | null): VisSpec {
  if (t === null || (spec.kind !== 'line' && spec.kind !== 'bars')) return spec;
  return { ...spec, thresholds: thresholdLines(t, spec.unit) };
}

type FrameView = Extract<PanelView, { kind: 'frame' }>;

/**
 * The frame with `key` isolated (framePlan's isolation, cached per result, vis, rate and key);
 * `view` itself when key is null. Thresholds are carried over.
 */
export function panelFrame(
  v: FrameView,
  key: string | null,
): { readonly spec: VisSpec; readonly data: FrameData } {
  if (key === null) return v;
  const plan = cachedPlan(v.vis, v.result, v.rateApplied, v.spec.title, key);
  if (plan.spec === null || plan.data === null) return v;
  return { spec: withThresholds(plan.spec, v.thresholds), data: plan.data };
}

const rowsOf = new WeakMap<ExploreResult, readonly SeriesRow[]>();

/** seriesRows(result), cached per result (WeakMap). */
export function legendRows(r: ExploreResult): readonly SeriesRow[] {
  let rows = rowsOf.get(r);
  if (rows === undefined) {
    rows = seriesRows(r);
    rowsOf.set(r, rows);
  }
  return rows;
}

const message = (state: PanelState, text: string): PanelView => ({
  kind: 'message',
  state,
  text,
});

/**
 * Pure: §4.2's table, first match. `panelVis` is the panel's `vis` (its kind, thresholds and
 * legend); `title` is the panel title (`panelTitle`).
 */
export function panelView(run: PanelRun, panelVis: PanelSpec['vis'], title: string): PanelView {
  const vis = panelVis.kind;
  switch (run.blocked) {
    case 'unsupported':
      return message('unsupported', t('panel.noRoute.logql'));
    case 'logs':
      return message('logs', t('panel.noVis'));
    case 'empty':
      return message('empty', t('panel.empty'));
    case 'variable':
      return message(
        'variable',
        t('panel.variable', { names: run.missing.map((n) => `$${n}`).join(', ') }),
      );
    case 'langFailed':
      return message('langFailed', t('panel.langFailed'));
    case 'refused':
      return message('refused', refusalText(run.refusal ?? 'queryTooLarge'));
    default:
      break;
  }
  if (run.error !== null) {
    const ev = errorView(run.error, run.diagnostics) ?? { text: t('error.generic'), narrow: false };
    return {
      kind: 'error',
      text: ev.text,
      detail: ev.text + positionText(run.text, run.diagnostics),
      narrow: ev.narrow,
    };
  }
  const o = run.outcome;
  if (o === null) return { kind: 'loading' };
  const r = o.result;
  if (r.kind === 'string') return message('string', t('explore.result.string', { value: r.value }));
  const auto = autoVis({
    histogram: o.planned.histogram,
    rateApplied: o.planned.rateApplied,
    result: r,
  });
  // `logs` is blocked above; any other saved kind overrides the auto vis.
  const chosen = chooseVis(vis === 'auto' || vis === 'logs' ? 'auto' : vis, auto) ?? 'line';
  const plan = cachedPlan(chosen, r, o.planned.rateApplied, title);
  if (plan.notice === 'noBuckets') return message('noBuckets', t('explore.vis.noBuckets'));
  if (plan.notice === 'tooManyTimestamps') {
    return message('tooManyTimestamps', t('explore.vis.tooManyTimestamps'));
  }
  if (plan.notice === 'string') return message('string', t('explore.result.string', { value: '' }));
  const thresholds = panelVis.thresholds ?? null;
  return {
    kind: 'frame',
    spec: withThresholds(plan.spec, thresholds),
    data: plan.data,
    vis: chosen,
    result: r,
    rateApplied: o.planned.rateApplied,
    thresholds,
    legend: panelVis.legend?.mode ?? 'table',
  };
}
