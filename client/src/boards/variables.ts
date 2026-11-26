/**
 * A board's variables (plan #61 Part C §3.5): spec v1 has no variable definitions, so they are the
 * `$name` / `${name}` references in its panel queries (T09-010 syntax). Macros (`$__…`) and names
 * longer than 64 characters are not variables; `$1` and a trailing `$` never match. Widgets have no
 * query, so they have no variables (plan #198 Part 1 §4.2).
 */
import type { BoardSpec } from '../api/types';
import { isDataPanel } from '../widgets/spec';
import { referencedVariables } from './variableRefs';

export { VARIABLE_NAME, VARIABLE_REF } from './variableRefs';

/** Distinct variable names in first-reference order: top panels, then each section's panels. */
export function boardVariables(spec: BoardSpec): string[] {
  const seen = new Set<string>();
  const panels = [...spec.panels, ...spec.sections.flatMap((s) => s.panels)].filter(isDataPanel);
  for (const p of panels) for (const name of referencedVariables(p.query.text)) seen.add(name);
  return [...seen];
}
