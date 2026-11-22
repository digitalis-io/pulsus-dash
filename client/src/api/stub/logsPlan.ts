/**
 * The StubApi LogQL planner mirror (plan #116 §3.7). Stub: the failing tests of plan #116 §5
 * compile against it.
 */
import type { LogqlPlannedQuery } from '../../data/decode';
import type { FieldError } from '../types';

export interface LogsPlanInputs {
  readonly query: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly kind: 'range' | 'volume';
  readonly stepMs: number;
}
export interface LogsSelector {
  readonly from: number;
  readonly to: number;
  readonly reserved: boolean;
}
export interface LogsClass {
  readonly source: 'pulsus_db' | 'virtual' | 'mixed';
  readonly reserved: readonly string[];
  readonly selectors: readonly LogsSelector[];
}
export interface LogsStubPlanned {
  readonly planned: LogqlPlannedQuery;
  readonly class: LogsClass;
  toSource(sentByte: number): number | null;
}
export interface LogsStubPlanError {
  readonly status: 400 | 413;
  readonly message: string;
  readonly fields: readonly FieldError[];
  readonly hint?: { readonly reason: 'processing_cap' };
  readonly planned?: LogqlPlannedQuery;
}
export interface LogsPrepared {
  readonly substituted: string;
  readonly class: LogsClass;
  checkCap(stepMs: number): LogsStubPlanError | null;
  plan(stepMs: number): LogsStubPlanned | LogsStubPlanError;
}
export const RESERVED_MATCHER = 'source="pulsus-dash"';
export function prepareLogs(_i: LogsPlanInputs): LogsPrepared | LogsStubPlanError {
  throw new Error('not implemented');
}
export function isLogsPlanError(_x: unknown): _x is LogsStubPlanError {
  throw new Error('not implemented');
}
export function classifyLogs(_text: string): LogsClass {
  throw new Error('not implemented');
}
export function volumeRange(_stepMs: number): string {
  throw new Error('not implemented');
}
export function logsRateWindowMs(_stepMs: number): number {
  throw new Error('not implemented');
}
export function logsFormatDuration(_ms: number): string {
  throw new Error('not implemented');
}
