/**
 * The upstream PromQL parser's stable functions (plan #112 §3.7, A.9): argument types, variadic
 * count and return type, equal to the `functions` section of `wire/fixtures/plan/promql.json`
 * (written by `go test ./internal/pulsusdb/prom -run TestFunctionTable -update` from the parser
 * release the server pins). The stub type check reads it; `promShape.test.ts` checks the two
 * agree. Experimental functions are absent: the server's parser refuses them.
 */
import type { ValueType } from '../../editor/lang/types';

export interface StableFunction {
  readonly argTypes: readonly ValueType[];
  /** 0: exactly the listed arguments; n > 0: up to n more of the last type; -1: any number more. */
  readonly variadic: number;
  readonly returns: ValueType;
}

export const STABLE_FUNCTIONS: Readonly<Record<string, StableFunction>> = Object.freeze({
  abs: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  absent: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  absent_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  acos: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  acosh: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  asin: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  asinh: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  atan: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  atanh: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  avg_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  ceil: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  changes: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  clamp: { argTypes: ['vector', 'scalar', 'scalar'], variadic: 0, returns: 'vector' },
  clamp_max: { argTypes: ['vector', 'scalar'], variadic: 0, returns: 'vector' },
  clamp_min: { argTypes: ['vector', 'scalar'], variadic: 0, returns: 'vector' },
  cos: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  cosh: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  count_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  day_of_month: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  day_of_week: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  day_of_year: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  days_in_month: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  deg: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  delta: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  deriv: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  exp: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  first_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  floor: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  histogram_avg: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  histogram_count: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  histogram_fraction: { argTypes: ['scalar', 'scalar', 'vector'], variadic: 0, returns: 'vector' },
  histogram_quantile: { argTypes: ['scalar', 'vector'], variadic: 0, returns: 'vector' },
  histogram_stddev: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  histogram_stdvar: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  histogram_sum: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  hour: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  idelta: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  increase: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  irate: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  label_join: {
    argTypes: ['vector', 'string', 'string', 'string'],
    variadic: -1,
    returns: 'vector',
  },
  label_replace: {
    argTypes: ['vector', 'string', 'string', 'string', 'string'],
    variadic: 0,
    returns: 'vector',
  },
  last_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  ln: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  log10: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  log2: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  max_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  min_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  minute: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  month: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
  pi: { argTypes: [], variadic: 0, returns: 'scalar' },
  predict_linear: { argTypes: ['matrix', 'scalar'], variadic: 0, returns: 'vector' },
  present_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  quantile_over_time: { argTypes: ['scalar', 'matrix'], variadic: 0, returns: 'vector' },
  rad: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  rate: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  resets: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  round: { argTypes: ['vector', 'scalar'], variadic: 1, returns: 'vector' },
  scalar: { argTypes: ['vector'], variadic: 0, returns: 'scalar' },
  sgn: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  sin: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  sinh: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  sort: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  sort_desc: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  sqrt: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  stddev_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  stdvar_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  sum_over_time: { argTypes: ['matrix'], variadic: 0, returns: 'vector' },
  tan: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  tanh: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  time: { argTypes: [], variadic: 0, returns: 'scalar' },
  timestamp: { argTypes: ['vector'], variadic: 0, returns: 'vector' },
  vector: { argTypes: ['scalar'], variadic: 0, returns: 'vector' },
  year: { argTypes: ['vector'], variadic: 1, returns: 'vector' },
});
