/**
 * A board's variables (plan #61 Part C §3.5): spec v1 has no variable definitions, so they are the
 * `$name` / `${name}` references in its panel queries (T09-010 syntax). Macros (`$__…`) and names
 * longer than 64 characters are not variables; `$1` and a trailing `$` never match.
 */
import type { BoardSpec } from '../api/types';

export const VARIABLE_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Distinct variable names in first-reference order: top panels, then each section's panels. */
export function boardVariables(spec: BoardSpec): string[] {
  const seen = new Set<string>();
  const panels = [...spec.panels, ...spec.sections.flatMap((s) => s.panels)];
  for (const p of panels) {
    for (const m of p.query.text.matchAll(VARIABLE_REF)) {
      const name = m[1] ?? m[2];
      if (name === undefined || name.startsWith('__') || !VARIABLE_NAME.test(name)) continue;
      seen.add(name);
    }
  }
  return [...seen];
}
