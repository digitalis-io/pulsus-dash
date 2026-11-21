/**
 * The StubApi planner mirror (plan #112 §3.7, ADR-0021 §4): the server's `prom.Plan` rules for
 * `npm run dev` and the tests, run against the shared fixture `wire/fixtures/plan/promql.json`.
 * Only `StubApi` imports it (an ESLint rule forbids other importers): in http mode the server
 * plans and the client reads `planned`.
 */
import type { PlannedQuery } from '../../data/decode';
import type { QueryShape, ValueType } from '../../editor/lang/types';
import type { MetricKind } from '../../explore/metricKind';
import type { PromMetadata } from '../../data/decode';
import type { FieldError } from '../types';

export const MAX_RAW_BYTES = 131_072,
  MAX_SENT_BYTES = 65_536,
  MAX_VARS = 64,
  MAX_VALUE_BYTES = 4_096;
/** The Go constant `prom.WarnTypesUnavailable`, byte for byte. */
export const WARN_TYPES_UNAVAILABLE =
  'pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)';

export interface PlanInputs {
  readonly query: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly kind: 'range' | 'instant';
  readonly stepMs: number;
  readonly rate: boolean;
}

export type MetricTypes = Readonly<Record<string, MetricKind>>;

/** A shape in UTF-8 byte offsets. */
export interface ByteShape {
  readonly bare: { readonly metric: string; readonly from: number; readonly to: number } | null;
  readonly metrics: readonly string[];
  readonly hasHistogramQuantile: boolean;
  readonly valueType: ValueType;
}

export interface StubPlanned {
  readonly planned: PlannedQuery;
  toSource(sentByte: number): number | null;
}

/** A refusal, as the gateway's `planError` writes it (A.11). */
export interface StubPlanError {
  readonly status: 400 | 413;
  readonly message: string;
  readonly fields: readonly FieldError[];
  readonly hint?: { readonly reason: 'processing_cap' };
  readonly planned?: PlannedQuery;
}

export interface StubClass {
  readonly source: 'pulsus_db' | 'virtual' | 'mixed';
  readonly reserved: readonly string[];
  readonly floorMs: number;
}

export interface Prepared {
  readonly substituted: string;
  needsTypes(s: ByteShape): boolean;
  classify(s: ByteShape): StubClass;
  expandedAt(stepMs: number): string | StubPlanError;
  plan(stepMs: number, s: ByteShape, t: MetricTypes): StubPlanned | StubPlanError;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** The server's byte guard (`pulsusdb.reservedIn`), byte for byte. */
export function reservedIn(_text: string): string | null {
  return notImplemented();
}

export function floorStep(_stepMs: number, _floorMs: number): number {
  return notImplemented();
}

export function prepare(_i: PlanInputs): Prepared | StubPlanError {
  return notImplemented();
}

export function isPlanError(x: unknown): x is StubPlanError {
  return typeof x === 'object' && x !== null && 'status' in x && 'message' in x;
}

/** A Lezer shape (UTF-16 offsets) in UTF-8 byte offsets. */
export function byteShape(_text: string, _s: QueryShape): ByteShape {
  return notImplemented();
}

export function rateWindowMs(_stepMs: number): number {
  return notImplemented();
}

export function formatDuration(_ms: number): string {
  return notImplemented();
}

export function kindOf(_name: string, _t: MetricTypes): MetricKind {
  return notImplemented();
}

export function typesFromMetadata(_m: PromMetadata['metrics']): MetricTypes {
  return notImplemented();
}

/** UTF-8 bytes of `s`; a lone surrogate counts 3 (as `TextEncoder`'s U+FFFD). */
export function utf8Length(_s: string): number {
  return notImplemented();
}
