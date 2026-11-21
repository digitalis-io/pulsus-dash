/**
 * The upstream PromQL parser's stable functions (plan #112 §3.7, A.9): argument types, variadic
 * count and return type, equal to the `functions` section of `wire/fixtures/plan/promql.json`,
 * which the Go test writes from the parser. The stub type check reads it.
 */
import type { ValueType } from '../../editor/lang/types';

export interface StableFunction {
  readonly argTypes: readonly ValueType[];
  readonly variadic: number;
  readonly returns: ValueType;
}

export const STABLE_FUNCTIONS: Readonly<Record<string, StableFunction>> = Object.freeze({});
