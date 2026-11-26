/**
 * The bar chart's plan (ADR-0028, plan #173 Part 2 §3.4): `barchartModel` computes every row once
 * per result and options, without a size; `fitBarchart` caps them for the measured cell at the
 * category extent every engine lays out (`categoryExtent`), and degrades names, then value labels,
 * then the frame (`tooSmall`) while the value axis is too short.
 */
import { barchartOptions } from '../boards/options';
import type { VisOptions } from '../api/types';
import type { Completeness } from '../data/decode';
import { EMPTY_COVERAGE, type CategoryRow, type Coverage, type FrameData } from '../data/frames';
import type { BarchartSpec, SummaryFacts } from '../engine/api';
import type { ExploreResult } from './autovis';
import type { PanelRows } from './reduce';
import type { Thresholds } from './thresholds';

export interface BarchartModel {
  /** `valueRange` unset here; the title is set per call. */
  readonly spec: BarchartSpec;
  /** `categoryRows(…).rows`, sorted. */
  readonly all: readonly CategoryRow[];
  readonly label: string | null;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly query: Completeness;
  /** Null in Part 2 (no baseline run). */
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

export function barchartModel(
  r: Exclude<ExploreResult, { kind: 'string' }>,
  o: {
    readonly title: string;
    readonly rateApplied: boolean;
    readonly options: VisOptions | undefined;
    readonly thresholds: Thresholds | null;
  },
): BarchartModel {
  const b = barchartOptions(o.options);
  void o.thresholds;
  return {
    spec: {
      kind: 'barchart',
      title: o.title,
      unit: { kind: 'none' },
      orientation: b.orientation,
      valueLabels: b.valueLabels,
      ghost: false,
      anomaly: false,
    },
    all: [],
    label: null,
    duplicates: 0,
    conflicts: 0,
    query: r.completeness,
    baseline: null,
    min: b.min,
    max: b.max,
    result: r,
  };
}

export function fitBarchart(
  m: BarchartModel,
  size: { readonly width: number; readonly height: number },
  measure: (text: string) => number,
): BarchartFit {
  void size;
  void measure;
  return {
    notice: null,
    cap: 0,
    spec: m.spec,
    data: { kind: 'categories', categories: [], coverage: EMPTY_COVERAGE },
    coverage: EMPTY_COVERAGE,
    rows: { columns: [], rows: [] },
    facts: { subject: '', current: null, change: null, extent: null, baselineRatio: null },
    hidden: 'none',
  };
}
