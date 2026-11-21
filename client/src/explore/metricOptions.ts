/** Stub (tests first, plan #63 Part C §3.2). */
import type { PromMetadata } from '../data/decode';

export const PICKER_OPTIONS = 100;
export interface MetricOption {
  readonly name: string;
  readonly description: string;
}
export function metricOptions(
  _names: readonly string[],
  _meta: PromMetadata['metrics'],
  _filter: string,
): { readonly options: MetricOption[]; readonly total: number } {
  throw new Error('not implemented');
}
