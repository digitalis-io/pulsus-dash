/**
 * The variables one panel text references (plan #64 §3.3): the client's hint for the "Set a value"
 * state, a key input, and the values a panel sends. The server substitutes them and is the
 * authority (ADR-0021, #112): its 400 `variable.missing` gives the same panel state.
 */

/** `$name` or `${name}` (T09-010 syntax). */
export const VARIABLE_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Distinct names matching `VARIABLE_REF` that pass `VARIABLE_NAME` and do not start with `__`
 * (macros), in first-reference order: the rule of #61's `boardVariables`, applied to one text.
 */
export function referencedVariables(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(VARIABLE_REF)) {
    const name = m[1] ?? m[2];
    if (name === undefined || name.startsWith('__') || !VARIABLE_NAME.test(name)) continue;
    seen.add(name);
  }
  return [...seen];
}

/** The `[name, value]` pairs of `referencedVariables(text)` that `vars` holds, sorted by name. */
export function panelVars(
  text: string,
  vars: ReadonlyMap<string, string>,
): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const name of referencedVariables(text)) {
    const value = vars.get(name);
    if (value !== undefined) out.push([name, value]);
  }
  // `<` compares UTF-16 code units, as the URL's own key order does.
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
