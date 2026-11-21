/** Stub (tests first, plan #63 §5). */
import type { QueryShape } from '../editor/lang/types';

export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown';
export type MetricTypes = Readonly<Record<string, readonly { readonly type: string }[]>>;

export interface RunPlan {
  readonly kind: 'range' | 'instant';
  readonly query: string;
  readonly bytes: number;
  readonly tooLong: boolean;
  readonly rateCandidate: boolean;
  readonly rateApplied: boolean;
  readonly histogram: boolean;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sentStart: number;
}

export const MAX_QUERY_BYTES = 65_536;

export function metricType(_name: string, _meta: MetricTypes): MetricKind {
  return 'unknown';
}

export function planRun(
  text: string,
  _shape: QueryShape,
  _meta: MetricTypes,
  _o: { readonly rate: boolean; readonly stepMs: number | null },
): RunPlan {
  return {
    kind: 'range',
    query: '',
    bytes: 0,
    tooLong: false,
    rateCandidate: false,
    rateApplied: false,
    histogram: false,
    sourceStart: 0,
    sourceEnd: text.length,
    sentStart: 0,
  };
}

export function formatDuration(_ms: number): string {
  return '';
}

export function toSourceIndex(_plan: RunPlan, _sentIndex: number): number | null {
  return null;
}

export function utf8Length(_s: string): number {
  return 0;
}
