/**
 * The bar chart's plan (ADR-0028, plan #173 Part 2 §3.4): `barchartModel` computes every row once
 * per result and options, without a size; `fitBarchart` caps them for the measured cell at the
 * category extent every engine lays out (`categoryExtent`), and degrades names, then value labels,
 * then the frame (`tooSmall`) while the value axis is too short.
 */
import type { VisOptions } from '../api/types';
import { barchartOptions } from '../boards/options';
import type { Completeness } from '../data/decode';
import type { CategoryRow, Coverage, FrameData } from '../data/frames';
import type { BarchartSpec, SummaryFacts, Unit, ValueRange } from '../engine/api';
import { barLayout, minPlotPx } from '../engine/canvas2d/barLayout';
import { categoryExtent } from '../engine/canvas2d/layout';
import type { ExploreResult } from './autovis';
import {
  barCap,
  capMarks,
  categoryCoverage,
  categoryRows,
  outsideCount,
  panelRows,
  resolveBounds,
  summaryFacts,
  tooSmallText,
  type Capped,
  type PanelRows,
} from './reduce';
import { thresholdLines, type Thresholds } from './thresholds';

export interface BarchartModel {
  /** `valueRange` unset here; the title is set per call. */
  readonly spec: BarchartSpec;
  /** `categoryRows(…).rows`, sorted. */
  readonly all: readonly CategoryRow[];
  readonly label: string | null;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly query: Completeness;
  /** The baseline run's completeness; null without a baseline run. */
  readonly baseline: Completeness | null;
  readonly min: number | undefined;
  readonly max: number | undefined;
  /** The input, kept for `summaryFacts`. */
  readonly result: Exclude<ExploreResult, { kind: 'string' }>;
}

export type BarchartFit =
  | {
      readonly notice: null;
      readonly cap: number;
      readonly spec: BarchartSpec;
      readonly data: Extract<FrameData, { kind: 'categories' }>;
      readonly coverage: Coverage;
      readonly rows: PanelRows;
      readonly facts: SummaryFacts;
      /**
       * The labels the fit took away (step 7): names first, so this fit never gives `values`
       * alone; the plan's contract keeps it for an engine whose names cost no value-axis room.
       */
      readonly hidden: 'none' | 'names' | 'namesValues' | 'values';
    }
  | {
      readonly notice: 'tooSmall';
      readonly cap: number;
      readonly text: string;
      readonly coverage: Coverage;
      readonly rows: PanelRows;
      readonly facts: SummaryFacts;
    };

/**
 * The rows of `r` once per result and options (plan §3.4): `barchartOptions`, the unit (`/s` after a
 * rate rewrite), the spec (thresholds as seam lines when the panel has them; ghost and anomaly off:
 * `CategoryChart` sets them, Part 3a §3.6), and `categoryRows` with the reducer, label, sort and
 * thresholds. `base`, the baseline run's result (Part 3a §3.8), sets each row's baseline by key and
 * the model's `baseline` completeness.
 */
export function barchartModel(
  r: Exclude<ExploreResult, { kind: 'string' }>,
  o: {
    readonly title: string;
    readonly rateApplied: boolean;
    readonly options: VisOptions | undefined;
    readonly thresholds: Thresholds | null;
    readonly base?: Exclude<ExploreResult, { kind: 'string' }> | null;
  },
): BarchartModel {
  const b = barchartOptions(o.options);
  const unit: Unit = o.rateApplied ? { kind: 'suffix', suffix: '/s' } : { kind: 'none' };
  const spec: BarchartSpec = {
    kind: 'barchart',
    title: o.title,
    unit,
    orientation: b.orientation,
    valueLabels: b.valueLabels,
    ...(o.thresholds === null ? {} : { thresholds: thresholdLines(o.thresholds, unit) }),
    ghost: false,
    anomaly: false,
  };
  const base = o.base ?? null;
  const c = categoryRows(r, base, {
    reducer: b.reducer,
    categoryBy: b.categoryBy,
    sort: b.sort,
    thresholds: o.thresholds,
  });
  return {
    spec,
    all: c.rows,
    label: c.label,
    duplicates: c.duplicates,
    conflicts: c.conflicts,
    query: r.completeness,
    baseline: base?.completeness ?? null,
    min: b.min,
    max: b.max,
    result: r,
  };
}

const NOTHING_KEPT = Object.freeze({ min: false, max: false, worst: 0 });

/** [min(0, drawn finite, thresholds), max(0, …)]: the auto range `options.min`/`max` resolve over. */
function autoRange(spec: BarchartSpec, drawn: readonly CategoryRow[]): ValueRange {
  let min = 0;
  let max = 0;
  const values = [...drawn.map((r) => r.value), ...(spec.thresholds ?? []).map((l) => l.value)];
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { min, max };
}

/**
 * The fit of `m` in a `size` cell (plan §3.4): the cap at the category extent (`categoryExtent`,
 * `barCap`); `tooSmall` below a cap of 2 (1 for a single row); the capped rows, the fixed range
 * and the coverage; then, while the plot is shorter than `minPlotPx` along the value axis (the
 * shared `barLayout`), the names are hidden, then the value labels, then `tooSmall`. Every
 * `tooSmall` draws nothing: its coverage and rows count no row as drawn. `measure` is the axis
 * font's text width.
 */
export function fitBarchart(
  m: BarchartModel,
  size: { readonly width: number; readonly height: number },
  measure: (text: string) => number,
): BarchartFit {
  const { width, height } = size;
  const unit = m.spec.unit;
  const n = m.all.length;
  const cap = barCap(categoryExtent(m.spec, width, height));
  const facts = summaryFacts('barchart', m.spec.title, m.result, m.all, unit, m.baseline);
  const coverageOf = (drawn: Capped<CategoryRow>, outside: number): Coverage =>
    categoryCoverage({
      all: m.all,
      capped: drawn,
      query: m.query,
      baseline: m.baseline,
      outside,
      duplicates: m.duplicates,
      conflicts: m.conflicts,
    });
  const tooSmall = (): BarchartFit => ({
    notice: 'tooSmall',
    cap,
    text: tooSmallText(m.all, unit),
    coverage: coverageOf({ drawn: [], kept: NOTHING_KEPT }, 0),
    rows: panelRows('barchart', m.all, [], unit),
    facts,
  });
  if ((n >= 2 && cap < 2) || (n === 1 && cap < 1)) return tooSmall();
  const capped = capMarks(m.all, cap);
  const drawn = capped.drawn;
  const valueRange =
    m.min === undefined && m.max === undefined
      ? undefined
      : resolveBounds(m.min, m.max, autoRange(m.spec, drawn));
  const coverage = coverageOf(capped, outsideCount(drawn, valueRange ?? null));
  let spec: BarchartSpec = valueRange === undefined ? m.spec : { ...m.spec, valueRange };
  const least = minPlotPx(measure);
  const along = (s: BarchartSpec): number => {
    const p = barLayout(s, drawn, width, height, measure).plot;
    return s.orientation === 'horizontal' ? p.width : p.height;
  };
  let hidden: Extract<BarchartFit, { notice: null }>['hidden'] = 'none';
  if (along(spec) < least) {
    spec = { ...spec, names: 'hidden' };
    hidden = 'names';
    if (along(spec) < least && spec.valueLabels) {
      spec = { ...spec, valueLabels: false };
      hidden = 'namesValues';
    }
    if (along(spec) < least) return tooSmall();
  }
  return {
    notice: null,
    cap,
    spec,
    data: { kind: 'categories', categories: drawn, coverage },
    coverage,
    rows: panelRows('barchart', m.all, drawn, unit),
    facts,
    hidden,
  };
}
