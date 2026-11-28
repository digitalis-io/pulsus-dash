/**
 * The StubApi value route (plan #289 §3.5): the variable query read as the server reads it, its
 * selector substituted by the planner mirror's rules (missing and refused references, every macro
 * as written) and the stub's label values. The stub does not parse the selector itself: the
 * server's parser refuses one that is not a metric or stream selector.
 */
import { parseVariableQuery } from '../../boards/variableQuery';
import type { VarValue } from '../types';
import { prepareLogs, isLogsPlanError, type LogsStubPlanError } from './logsPlan';
import { isPlanError, prepare, type StubPlanError } from './plan';

export interface StubVariablePlan {
  readonly label: string;
  readonly match: string | null;
}

/** A refusal of the value route's checks before the selector. */
const NOT_A_VARIABLE_QUERY: StubPlanError = {
  status: 400,
  message: 'a variable query must be label_values(label) or label_values(selector, label)',
  fields: [{ pointer: '/query', messageKey: 'query.invalid' }],
};

/**
 * The planned label and selector of `query`, or the refusal the server gives. The selector is
 * planned as an instant PromQL query (no step: a macro is refused as the server leaves it
 * unparseable) or a LogQL range query at a 1 s step.
 */
export function planVariableQuery(
  lang: string,
  query: string,
  vars: Readonly<Record<string, VarValue>>,
): StubVariablePlan | StubPlanError | LogsStubPlanError {
  const q = parseVariableQuery(lang, query);
  if (q === null) return NOT_A_VARIABLE_QUERY;
  if (q.selector === '') return { label: q.label, match: null };
  if (lang === 'logql') {
    const p = prepareLogs({ query: q.selector, vars, kind: 'range', stepMs: 1_000 });
    if (isLogsPlanError(p)) return p;
    return { label: q.label, match: p.substituted.trim() };
  }
  const p = prepare({ query: q.selector, vars, kind: 'instant', stepMs: 0, rate: false });
  if (isPlanError(p)) return p;
  return { label: q.label, match: p.substituted };
}
