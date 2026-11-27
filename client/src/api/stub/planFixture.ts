/**
 * Test support: the shared planner fixture `wire/fixtures/plan/promql.json` (plan #112 §3.5),
 * with its `Text` values expanded. Imported by the mirror's tests only.
 */
import raw from '../../../../wire/fixtures/plan/promql.json?raw';
import type { PlannedQuery } from '../../data/decode';
import type { ValueType } from '../../editor/lang/types';
import type { MetricKind } from '../../explore/metricKind';
import type { FieldError, VarValue } from '../types';
import type { ByteShape } from './plan';

/** A JSON string or `{"concat": [string | {"repeat": Text, "count": n}, …]}`. */
export type Text =
  string | { readonly concat: readonly (string | { repeat: Text; count: number })[] };

export function expand(t: Text): string {
  if (typeof t === 'string') return t;
  return t.concat
    .map((p) => (typeof p === 'string' ? p : expand(p.repeat).repeat(p.count)))
    .join('');
}

interface WirePlanned {
  readonly query: Text;
  readonly expanded: Text;
  readonly bytes: number;
  readonly value_type: ValueType;
  readonly rate_candidate: boolean;
  readonly rate_applied: boolean;
  readonly histogram: boolean;
  readonly step_ms?: number;
  readonly rate_window_ms?: number;
}

export interface FixtureCase {
  readonly name: string;
  readonly from: string;
  /** Only the server's probe guard refuses it (plan #289 §3.4): the mirror skips it. */
  readonly server_only?: boolean;
  readonly inputs: {
    readonly query: Text;
    readonly vars: Readonly<Record<string, VarValue>>;
    readonly kind: 'range' | 'instant';
    readonly step_ms: number;
    readonly rate: boolean;
    readonly range_ms?: number;
  };
  readonly types: Readonly<Record<string, MetricKind>>;
  readonly needs_types?: boolean;
  readonly shape?: {
    readonly bare: { readonly metric: Text; readonly from: number; readonly to: number } | null;
    readonly metrics: readonly Text[];
    readonly has_histogram_quantile: boolean;
    readonly value_type: ValueType;
  };
  readonly group?: string;
  readonly classify?: {
    readonly source: string;
    readonly reserved: string[];
    readonly floor_ms: number;
  };
  readonly resolve?: { readonly grid_step_ms: number; readonly step_ms: number };
  readonly planned?: WirePlanned;
  readonly error?: {
    readonly status: 400 | 413;
    readonly message: string;
    readonly fields: readonly { readonly pointer: string; readonly message_key: string }[];
    readonly hint?: { readonly reason: 'processing_cap' };
    readonly planned?: WirePlanned;
  };
  readonly to_source?: readonly (readonly [number, number | null])[];
}

export interface Fixture {
  readonly version: number;
  readonly plan: readonly FixtureCase[];
  readonly kind_of: readonly {
    name: string;
    types: Record<string, MetricKind>;
    want: MetricKind;
  }[];
  readonly from_metadata: readonly {
    metadata: Record<string, { type: string; help: string; unit: string }[]>;
    types: Record<string, MetricKind>;
  }[];
  readonly rate_window: readonly { step_ms: number; window_ms: number; text: string }[];
  readonly durations: readonly { ms: number; text: string }[];
  readonly bytes: readonly { text: Text; bytes: number }[];
  readonly reserved: readonly { text: Text; want: string | null }[];
  readonly functions: readonly {
    name: string;
    arg_types: ValueType[];
    variadic: number;
    return: ValueType;
  }[];
}

export const FIXTURE = JSON.parse(raw) as Fixture;

/** The camel-case `PlannedQuery` of a fixture plan. */
export function plannedOf(p: WirePlanned): PlannedQuery {
  return {
    query: expand(p.query),
    expanded: expand(p.expanded),
    bytes: p.bytes,
    valueType: p.value_type,
    rateCandidate: p.rate_candidate,
    rateApplied: p.rate_applied,
    histogram: p.histogram,
    ...(p.step_ms === undefined ? {} : { stepMs: p.step_ms }),
    ...(p.rate_window_ms === undefined ? {} : { rateWindowMs: p.rate_window_ms }),
  };
}

export function fieldsOf(fs: NonNullable<FixtureCase['error']>['fields']): FieldError[] {
  return fs.map((f) => ({ pointer: f.pointer, messageKey: f.message_key }));
}

export function shapeOf(s: NonNullable<FixtureCase['shape']>): ByteShape {
  return {
    bare:
      s.bare === null ? null : { metric: expand(s.bare.metric), from: s.bare.from, to: s.bare.to },
    metrics: s.metrics.map(expand),
    hasHistogramQuantile: s.has_histogram_quantile,
    valueType: s.value_type,
  };
}

/** The text whose shape a case records: its (or its refused plan's) expanded text. */
export function expandedOf(c: FixtureCase): string | null {
  const p = c.planned ?? c.error?.planned;
  return p === undefined ? null : expand(p.expanded);
}
