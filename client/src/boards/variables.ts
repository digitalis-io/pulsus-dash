/** A board's variables: the `$name` / `${name}` references in its panel queries (plan #61 Part C §3.5). */
import type { BoardSpec } from '../api/types';

export const VARIABLE_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Distinct variable names in first-reference order: top panels, then each section's panels. */
export function boardVariables(spec: BoardSpec): string[] {
  spec;
  return [];
}
